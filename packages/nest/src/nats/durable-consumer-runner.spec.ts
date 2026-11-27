import { setTimeout as sleep } from 'node:timers/promises';

import {
  type DurableConsumerDefinition,
  encodeEnvelope,
  EVENT_TYPES,
  makeEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { Logger } from '@nestjs/common';
import type {
  ConsumeOptions,
  ConsumerMessages,
  ConsumerNotification,
  JsMsg,
} from '@nats-io/jetstream';
import { headers as natsHeaders } from '@nats-io/transport-node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MetricsService } from '../metrics/metrics.service.js';
import { durableConsumerConfig } from './consumer-config.js';
import {
  type ConsumerRuntime,
  DurableConsumerRunner,
  type DurableConsumerRunnerOptions,
  idleHeartbeatMsFor,
  orderingWarning,
  pinContactTimeoutMs,
  pinContactTimeoutMsFor,
  pullExpiresMsFor,
  RETURNED_MESSAGE_DELAY_MS,
} from './durable-consumer-runner.js';
import {
  durableHandlerSettings,
  type DurableHandlerSettings,
  type ExclusiveConsumerEvent,
} from './event-handler.decorator.js';
import type { NatsClient } from './nats-client.js';
import { NatsMetrics } from './nats.metrics.js';
import type { StreamManager } from './stream-manager.js';

const MMSI = 525_005_223;

const definition = (
  filterSubjects: readonly string[] = [subjects.fuelReading(MMSI)],
): DurableConsumerDefinition => ({
  durableName: 'unit-runner',
  stream: 'FUEL',
  filterSubjects,
  service: 'emission',
  eventTypes: [EVENT_TYPES.FUEL_READING_RECORDED],
  maxDeliver: 3,
  description: 'unit test consumer',
});

describe('pullExpiresMsFor', () => {
  const exclusive = (pinnedTtlMs: number): DurableHandlerSettings =>
    durableHandlerSettings({
      consumer: definition(),
      exclusive: { pinnedTtlMs },
    });

  it('keeps 30 s for shared consumers and a third of the pinned TTL for exclusive ones', () => {
    expect(
      pullExpiresMsFor(durableHandlerSettings({ consumer: definition() })),
    ).toBe(30_000);
    expect(pullExpiresMsFor(exclusive(30_000))).toBe(10_000);
    expect(pullExpiresMsFor(exclusive(90_000))).toBe(30_000);
    expect(pullExpiresMsFor(exclusive(200_000))).toBe(30_000);
    expect(pullExpiresMsFor(exclusive(3000))).toBe(1000);
    expect(pullExpiresMsFor(exclusive(4000))).toBe(1333);
    // Clamped to the 1 s minimum of the client.
    expect(pullExpiresMsFor(exclusive(1500))).toBe(1000);
  });
});

describe('orderingWarning', () => {
  const settings = (
    filterSubjects: readonly string[],
    concurrency: number,
    orderBySubject = true,
  ): DurableHandlerSettings =>
    durableHandlerSettings({
      consumer: definition(filterSubjects),
      concurrency,
      orderBySubject,
    });

  it('warns when every message shares one literal subject', () => {
    expect(orderingWarning(settings(['notify.email.v1'], 4))).toBe(
      'concurrency 4 has no effect: all messages share a subject; set orderBySubject: false',
    );
  });

  it('warns when fewer literal subjects than handlers exist', () => {
    expect(
      orderingWarning(settings(['notify.email.v1', 'notify.webhook.v1'], 4)),
    ).toMatch(/concurrency 4 is limited to 2/);
    expect(
      orderingWarning(settings(['a.v1.1', 'a.v1.2', 'a.v1.3', 'a.v1.4'], 4)),
    ).toBeUndefined();
  });

  it('does not warn for wildcards, mixed filters, concurrency 1 or orderBySubject false', () => {
    expect(orderingWarning(settings(['fuel.reading.v1.*'], 4))).toBeUndefined();
    expect(orderingWarning(settings(['safety.state.v1.>'], 4))).toBeUndefined();
    expect(
      orderingWarning(settings(['notify.email.v1', 'alert.v1.*.*'], 4)),
    ).toBeUndefined();
    expect(orderingWarning(settings(['notify.email.v1'], 1))).toBeUndefined();
    expect(
      orderingWarning(settings(['notify.email.v1'], 4, false)),
    ).toBeUndefined();
  });
});

/** A push-driven async iterable. */
class Channel<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((result: IteratorResult<T>) => void)[] = [];
  closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.items.push(item);
    else waiter({ value: item, done: false });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined)
          return Promise.resolve({ value: item, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** One consume() of the fake consumer. */
interface FakeConsume {
  readonly options: ConsumeOptions;
  readonly messages: Channel<JsMsg>;
  readonly statuses: Channel<ConsumerNotification>;
}

interface FakeMessage extends JsMsg {
  readonly settled: string[];
}

let sequence = 0;

function fakeMessage(
  pinId: string | undefined,
  deliveryCount = 1,
): FakeMessage {
  sequence += 1;
  const envelope = makeEnvelope({
    type: EVENT_TYPES.FUEL_READING_RECORDED,
    source: 'unit',
    data: {
      mmsi: MMSI,
      time: new Date(Date.UTC(2026, 0, 1, 0, sequence % 60)).toISOString(),
      periodStart: null,
      fuelMeTon: sequence,
      fuelAeTon: 0,
      deviceId: null,
      source: 'api',
    },
  });
  const headers = natsHeaders();
  if (pinId !== undefined) headers.set('Nats-Pin-Id', pinId);
  const settled: string[] = [];
  const message = {
    seq: sequence,
    subject: subjects.fuelReading(MMSI),
    data: encodeEnvelope(envelope),
    headers,
    time: new Date(),
    info: { deliveryCount, stream: 'FUEL', pending: 0 },
    settled,
    ack: () => settled.push('ack'),
    nak: (delay?: number) => settled.push(`nak:${delay ?? 0}`),
    term: () => settled.push('term'),
    working: () => undefined,
  };
  return message as unknown as FakeMessage;
}

interface Harness {
  readonly runner: DurableConsumerRunner;
  readonly consumes: FakeConsume[];
  readonly handled: number[];
  readonly events: string[];
  /** Every `onStateChange`. */
  readonly states: string[];
  readonly unpin: ReturnType<typeof vi.fn>;
  /** `jetstream.publish` (dead-letter copies). */
  readonly publish: ReturnType<typeof vi.fn>;
  readonly metrics: MetricsService;
  /** Pin reported by `consumers.info()` (for the release on stop). */
  pinned: string | undefined;
}

function harness(
  settings: DurableHandlerSettings,
  options: DurableConsumerRunnerOptions & {
    readonly handler?: (minute: number) => Promise<void>;
  } = {},
): Harness {
  const consumes: FakeConsume[] = [];
  const handled: number[] = [];
  const events: string[] = [];
  const states: string[] = [];
  const metrics = new MetricsService();
  const unpin = vi.fn(() => Promise.resolve(true));
  const publish = vi.fn(() => Promise.resolve({ seq: 1, duplicate: false }));
  const state: { pinned: string | undefined } = { pinned: undefined };
  const manager = {
    consumers: {
      info: () =>
        Promise.resolve({
          config: durableConsumerConfig(settings),
          priority_groups:
            state.pinned === undefined
              ? []
              : [{ group: 'active', pinned_client_id: state.pinned }],
        }),
      unpin,
    },
  };
  const jetstream = {
    publish,
    consumers: {
      get: () =>
        Promise.resolve({
          consume: (consumeOptions: ConsumeOptions) => {
            const messages = new Channel<JsMsg>();
            const statuses = new Channel<ConsumerNotification>();
            consumes.push({ options: consumeOptions, messages, statuses });
            const iterator = {
              [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
              status: () => statuses,
              close: () => {
                messages.close();
                statuses.close();
                return Promise.resolve(undefined);
              },
            };
            return Promise.resolve(iterator as unknown as ConsumerMessages);
          },
        }),
    },
  };
  const runtime: ConsumerRuntime = {
    client: {
      ready: () => Promise.resolve({ jetstream, manager }),
    } as unknown as NatsClient,
    streams: {
      ensure: () => Promise.resolve(new Map()),
    } as unknown as StreamManager,
    metrics: new NatsMetrics(metrics),
    serviceName: 'unit',
    runInLogContext: (fn) => fn(),
  };
  const record =
    (name: string) =>
    async (event: ExclusiveConsumerEvent): Promise<void> => {
      events.push(
        `${name}:${event.reason}:${event.pinId ?? '-'}:${event.previous ?? '-'}`,
      );
      await (
        name === 'activated' ? options.onActivated : options.onDeactivated
      )?.(event);
    };
  const runner = new DurableConsumerRunner(
    runtime,
    settings,
    async (event) => {
      if (event.type !== EVENT_TYPES.FUEL_READING_RECORDED) return;
      events.push(`handled:${event.data.fuelMeTon}`);
      handled.push(event.data.fuelMeTon);
      await options.handler?.(event.data.fuelMeTon);
    },
    'Unit.handler',
    {
      onActivated: record('activated'),
      onDeactivated: record('deactivated'),
      onStateChange: (state) => {
        states.push(state);
        options.onStateChange?.(state);
      },
      clock: options.clock,
    },
  );
  return {
    runner,
    consumes,
    handled,
    events,
    states,
    unpin,
    publish,
    metrics,
    get pinned() {
      return state.pinned;
    },
    set pinned(value) {
      state.pinned = value;
    },
  };
}

const exclusiveSettings = (pinnedTtlMs = 30_000): DurableHandlerSettings =>
  durableHandlerSettings({
    consumer: definition(),
    exclusive: { pinnedTtlMs },
    backoffMs: [100],
  });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(5);
  }
}

describe('DurableConsumerRunner exclusive consumers (fake consume iterator)', () => {
  const running: DurableConsumerRunner[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((runner) => runner.stop(500)));
    vi.restoreAllMocks();
  });

  async function started(h: Harness): Promise<Harness> {
    await h.runner.start();
    running.push(h.runner);
    return h;
  }

  it('pulls with an expiry of a third of the pinned TTL and heartbeats at half of it', async () => {
    const h = await started(harness(exclusiveSettings(9000)));
    expect(h.consumes[0]?.options).toMatchObject({
      expires: 3000,
      idle_heartbeat: 1500,
      group: 'active',
    });
    expect(h.runner.state).toBe('starting');
    expect(h.runner.health().state).toBe('starting');
  });

  it('gates dispatch on the activation hook of a new pin', async () => {
    const gate = deferred();
    const h = await started(
      harness(exclusiveSettings(), { onActivated: () => gate.promise }),
    );
    const consume = h.consumes[0];
    if (consume === undefined) throw new Error('not consuming');
    const first = fakeMessage('pin-1');
    const second = fakeMessage('pin-1');
    consume.messages.push(first);
    consume.messages.push(second);
    await until(() => h.events.length === 1);
    await sleep(50);
    // The hook runs, the messages wait.
    expect(h.events).toEqual(['activated:pinned:pin-1:-']);
    expect(h.handled).toEqual([]);
    expect(h.runner.state).toBe('active');
    gate.resolve();
    await until(() => h.handled.length === 2);
    expect(h.events.slice(1)).toEqual([
      `handled:${first.seq}`,
      `handled:${second.seq}`,
    ]);
    expect(first.settled).toEqual(['ack']);
    // consumer_pinned for the same pin does not activate again.
    consume.statuses.push({ type: 'consumer_pinned', id: 'pin-1' });
    await sleep(20);
    expect(h.events.filter((e) => e.startsWith('activated'))).toHaveLength(1);
    expect(
      await h.metrics.registry.getSingleMetricAsString(
        'aisits_events_consumer_activations_total',
      ),
    ).toMatch(/consumer="unit-runner"\} 1/);
  });

  it('naks the messages of a failed activation and retries the hook on the next message', async () => {
    let calls = 0;
    const h = await started(
      harness(exclusiveSettings(), {
        onActivated: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new Error('store unavailable'))
            : Promise.resolve();
        },
      }),
    );
    const consume = h.consumes[0];
    if (consume === undefined) throw new Error('not consuming');
    const failed = fakeMessage('pin-1');
    consume.messages.push(failed);
    await until(() => failed.settled.length === 1);
    expect(failed.settled).toEqual(['nak:100']);
    expect(h.handled).toEqual([]);
    // The redelivery (or any next message) runs the hook again first.
    const redelivered = fakeMessage('pin-1', 2);
    consume.messages.push(redelivered);
    await until(() => h.handled.length === 1);
    expect(calls).toBe(2);
    expect(redelivered.settled).toEqual(['ack']);
    expect(h.events.filter((e) => e.startsWith('activated'))).toEqual([
      'activated:pinned:pin-1:-',
      'activated:pinned:pin-1:-',
    ]);
  });

  it('dead-letters instead of naking when the hook still fails on the last delivery', async () => {
    const h = await started(
      harness(exclusiveSettings(), {
        onActivated: () => Promise.reject(new Error('still failing')),
      }),
    );
    const consume = h.consumes[0];
    if (consume === undefined) throw new Error('not consuming');
    const last = fakeMessage('pin-1', 3);
    consume.messages.push(last);
    await until(() => last.settled.length === 1);
    expect(last.settled).toEqual(['ack']);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0]?.[0]).toBe('dlq.FUEL.unit-runner');
    expect(h.handled).toEqual([]);
  });

  it('goes standby on unpin, runs onDeactivated after the handlers and re-subscribes without the stale pin', async () => {
    const slow = deferred();
    const inFlight = fakeMessage('pin-1');
    const h = await started(
      harness(exclusiveSettings(), {
        handler: (minute) =>
          minute === inFlight.seq ? slow.promise : Promise.resolve(),
      }),
    );
    const consume = h.consumes[0];
    if (consume === undefined) throw new Error('not consuming');
    consume.messages.push(inFlight);
    await until(() => h.handled.length === 1);
    consume.statuses.push({ type: 'consumer_unpinned' });
    await until(() => h.runner.state === 'standby');
    expect(h.runner.health()).toMatchObject({
      state: 'standby',
      standby: true,
    });
    // The hook waits for the handler of the ended period.
    await sleep(30);
    expect(h.events.some((e) => e.startsWith('deactivated'))).toBe(false);
    slow.resolve();
    await until(() => h.events.some((e) => e.startsWith('deactivated')));
    expect(h.events.at(-1)).toBe('deactivated:unpinned:pin-1:-');
    expect(consume.messages.closed).toBe(true);
    // supervise() re-subscribes after RESUBSCRIBE_DELAY_MS (2 s).
    await until(() => h.consumes.length === 2, 4000);
    expect(h.runner.state).toBe('standby');
    // Pinned again later with a new id: activation with the previous pin.
    const next = h.consumes[1];
    if (next === undefined) throw new Error('not re-subscribed');
    next.messages.push(fakeMessage('pin-2'));
    await until(() => h.handled.length === 2);
    expect(h.events).toContain('activated:pinned:pin-2:pin-1');
    expect(h.runner.state).toBe('active');
  }, 10_000);

  it('releases the pin on stop only while this instance holds it', async () => {
    const h = harness(exclusiveSettings());
    await h.runner.start();
    const consume = h.consumes[0];
    if (consume === undefined) throw new Error('not consuming');
    consume.messages.push(fakeMessage('pin-1'));
    await until(() => h.handled.length === 1);
    h.pinned = 'pin-1';
    await h.runner.stop(500);
    expect(h.unpin).toHaveBeenCalledWith('FUEL', 'unit-runner', 'active');
    expect(h.events.at(-1)).toBe('deactivated:stopped:pin-1:-');

    const stale = harness(exclusiveSettings());
    await stale.runner.start();
    stale.consumes[0]?.messages.push(fakeMessage('pin-old'));
    await until(() => stale.handled.length === 1);
    stale.pinned = 'pin-new'; // another instance is active now
    await stale.runner.stop(500);
    expect(stale.unpin).not.toHaveBeenCalled();
  });

  it('logs the ordering and pinned TTL warnings at start', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const ordered = harness(
      durableHandlerSettings({
        consumer: definition(['notify.email.v1']),
        concurrency: 4,
      }),
    );
    await started(ordered);
    const short = harness(exclusiveSettings(2000));
    await started(short);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages).toContainEqual(
      'Unit.handler: concurrency 4 has no effect: all messages share a subject; set orderBySubject: false',
    );
    expect(
      messages.some((message) => message.includes('pinnedTtlMs 2000')),
    ).toBe(true);
    expect(ordered.runner.state).toBe('shared');
  });
});

describe('pinContactTimeoutMsFor', () => {
  const exclusive = (pinnedTtlMs: number): DurableHandlerSettings =>
    durableHandlerSettings({
      consumer: definition(),
      exclusive: { pinnedTtlMs },
    });

  it('is pinnedTtlMs − pull expiry − heartbeat: half the TTL from 3 to 90 s, at least two heartbeats', () => {
    expect(
      pinContactTimeoutMsFor(
        durableHandlerSettings({ consumer: definition() }),
      ),
    ).toBeUndefined();
    expect(idleHeartbeatMsFor(exclusive(30_000))).toBe(5000);
    expect(pinContactTimeoutMsFor(exclusive(30_000))).toBe(15_000);
    expect(pinContactTimeoutMsFor(exclusive(3000))).toBe(1500);
    expect(pinContactTimeoutMsFor(exclusive(9000))).toBe(4500);
    expect(pinContactTimeoutMsFor(exclusive(90_000))).toBe(45_000);
    // Pull expiry capped at 30 s, heartbeats at 15 s.
    expect(pinContactTimeoutMsFor(exclusive(200_000))).toBe(155_000);
    // Below 3 s the bound cannot be kept: two heartbeats at least.
    expect(pinContactTimeoutMsFor(exclusive(2000))).toBe(1000);
    // The public form takes the TTL (default 30 s).
    expect(pinContactTimeoutMs()).toBe(15_000);
    expect(pinContactTimeoutMs(3000)).toBe(1500);
    for (const ttl of [3000, 5000, 30_000, 60_000, 90_000, 300_000]) {
      const settings = exclusive(ttl);
      const bound = pinContactTimeoutMsFor(settings) ?? Infinity;
      // Early enough: the server cannot unpin before ttl − expires after the last contact…
      expect(bound + idleHeartbeatMsFor(settings)).toBeLessThanOrEqual(
        ttl - pullExpiresMsFor(settings),
      );
      // …and never spurious: about three heartbeats missed in a row.
      expect(bound).toBeGreaterThanOrEqual(2 * idleHeartbeatMsFor(settings));
    }
  });
});

describe('DurableConsumerRunner pin watchdog (contact loss and pauses)', () => {
  const running: DurableConsumerRunner[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map((runner) => runner.stop(500)));
    vi.restoreAllMocks();
  });

  /** A monotonic clock that a test can move forward (a pause of the process). */
  function jumpClock(): { readonly now: () => number; jump(ms: number): void } {
    let offset = 0;
    return {
      now: () => performance.now() + offset,
      jump: (ms) => {
        offset += ms;
      },
    };
  }

  async function activeOn(h: Harness, pinId: string): Promise<FakeConsume> {
    await h.runner.start();
    running.push(h.runner);
    const consume = h.consumes[0];
    if (consume === undefined) throw new Error('not consuming');
    consume.messages.push(fakeMessage(pinId));
    await until(() => h.handled.length === 1);
    expect(h.runner.state).toBe('active');
    h.pinned = pinId;
    return consume;
  }

  /** The hook calls after the first activation. */
  const laterHooks = (h: Harness): string[] =>
    h.events
      .filter((e) => e.startsWith('activated') || e.startsWith('deactivated'))
      .slice(1);

  async function returnedCount(h: Harness): Promise<string> {
    return h.metrics.registry.getSingleMetricAsString(
      'aisits_events_consumed_total',
    );
  }

  it('gives the pin up after the bound without server contact, then activates only through a new pin (K1)', async () => {
    // pinnedTtlMs 3000: pull expiry 1000, heartbeats 500, bound 1500 ms.
    const h = harness(exclusiveSettings(3000));
    const consume = await activeOn(h, 'pin-1');
    const activeAt = performance.now();
    await until(() => h.runner.state === 'standby', 4000);
    const after = performance.now() - activeAt;
    expect(after).toBeGreaterThan(1400);
    expect(after).toBeLessThan(2500);
    // onStateChange hears of it at once; onDeactivated with the reason.
    expect(h.states).toEqual(['active', 'standby']);
    await until(() => h.events.some((e) => e.startsWith('deactivated')));
    expect(h.events.at(-1)).toBe('deactivated:contact_lost:pin-1:-');
    // The subscription with the old pin is given up…
    expect(consume.messages.closed).toBe(true);
    // …a late message of the old pin is returned, never handled…
    // …and supervise() releases the pin it still holds and subscribes afresh.
    await until(() => h.consumes.length === 2, 4000);
    expect(h.unpin).toHaveBeenCalledWith('FUEL', 'unit-runner', 'active');
    const next = h.consumes[1];
    if (next === undefined) throw new Error('not re-subscribed');
    const stale = fakeMessage('pin-1');
    next.messages.push(stale);
    await until(() => stale.settled.length === 1);
    expect(stale.settled).toEqual([`nak:${RETURNED_MESSAGE_DELAY_MS}`]);
    expect(h.runner.state).toBe('standby');
    // A new pin activates it again (activation hook first).
    next.messages.push(fakeMessage('pin-2'));
    await until(() => h.handled.length === 2);
    expect(h.events).toContain('activated:pinned:pin-2:pin-1');
    expect(h.runner.state).toBe('active');
    expect(await returnedCount(h)).toMatch(/outcome="returned"\} 1/);
  }, 10_000);

  it('never gives the pin up while heartbeats arrive, with jitter, slow handlers and short event-loop stalls (K1)', async () => {
    const slow = deferred();
    const h = harness(exclusiveSettings(3000), {
      handler: (minute) =>
        minute % 2 === 0 ? slow.promise : Promise.resolve(),
    });
    const consume = await activeOn(h, 'pin-1');
    const until5s = performance.now() + 5000;
    let beat = 0;
    while (performance.now() < until5s) {
      beat += 1;
      // Heartbeats every 500 ms ± 250 ms; a message now and then.
      await sleep(250 + ((beat * 7919) % 500));
      consume.statuses.push({ type: 'heartbeat' } as ConsumerNotification);
      if (beat % 3 === 0) consume.messages.push(fakeMessage('pin-1'));
      // A GC-like stall of the event loop, well below the bound.
      if (beat % 4 === 0) {
        const stallUntil = performance.now() + 300;
        while (performance.now() < stallUntil) {
          /* busy */
        }
      }
    }
    slow.resolve();
    expect(h.runner.state).toBe('active');
    expect(h.states).toEqual(['active']);
    expect(h.events.filter((e) => e.startsWith('deactivated'))).toEqual([]);
    expect(consume.messages.closed).toBe(false);
  }, 10_000);

  it('after a pause, returns what it buffered and reloads before dispatching while the server still pins it (K2)', async () => {
    const clock = jumpClock();
    let activations = 0;
    const reload = deferred();
    const h = harness(exclusiveSettings(3000), {
      clock: clock.now,
      onActivated: () => {
        activations += 1;
        return activations === 2 ? reload.promise : Promise.resolve();
      },
    });
    const consume = await activeOn(h, 'pin-1');
    // The process did not run for 5 s; then buffered messages of pin-1 arrive.
    clock.jump(5000);
    const buffered = [fakeMessage('pin-1'), fakeMessage('pin-1')];
    for (const message of buffered) consume.messages.push(message);
    consume.statuses.push({ type: 'heartbeat' } as ConsumerNotification);
    await until(() => buffered.every((m) => m.settled.length === 1));
    expect(buffered.map((m) => m.settled)).toEqual([
      [`nak:${RETURNED_MESSAGE_DELAY_MS}`],
      [`nak:${RETURNED_MESSAGE_DELAY_MS}`],
    ]);
    expect(h.handled).toHaveLength(1);
    expect(h.states.slice(0, 2)).toEqual(['active', 'standby']);
    // The server confirmed pin-1: deactivation, then the activation reload.
    await until(() => activations === 2);
    expect(laterHooks(h)).toEqual([
      'deactivated:paused:pin-1:-',
      'activated:pinned:pin-1:pin-1',
    ]);
    expect(h.runner.state).toBe('active');
    // The redeliveries wait for the reload.
    const redelivered = buffered.map(() => fakeMessage('pin-1', 2));
    for (const message of redelivered) consume.messages.push(message);
    await sleep(50);
    expect(h.handled).toHaveLength(1);
    reload.resolve();
    await until(() => h.handled.length === 3);
    expect(redelivered.map((m) => m.settled)).toEqual([['ack'], ['ack']]);
    // The subscription and its pin were kept.
    expect(consume.messages.closed).toBe(false);
    expect(h.consumes).toHaveLength(1);
    const consumed = await returnedCount(h);
    expect(consumed).toMatch(/outcome="returned"\} 2/);
    expect(consumed).not.toMatch(/outcome="nak"/);
  });

  it('after a pause, stays a standby and subscribes afresh when another instance holds the pin (K2)', async () => {
    const clock = jumpClock();
    const h = harness(exclusiveSettings(3000), { clock: clock.now });
    const consume = await activeOn(h, 'pin-1');
    h.pinned = 'pin-other';
    clock.jump(5000);
    const buffered = fakeMessage('pin-1');
    // On its last delivery a returned message is dead-lettered, never dropped.
    const last = fakeMessage('pin-1', 3);
    consume.messages.push(buffered);
    consume.messages.push(last);
    await until(
      () => buffered.settled.length === 1 && last.settled.length === 1,
    );
    expect(buffered.settled).toEqual([`nak:${RETURNED_MESSAGE_DELAY_MS}`]);
    expect(last.settled).toEqual(['ack']);
    expect(h.publish.mock.calls[0]?.[0]).toBe('dlq.FUEL.unit-runner');
    await until(() => consume.messages.closed);
    expect(h.runner.state).toBe('standby');
    expect(laterHooks(h)).toEqual(['deactivated:paused:pin-1:-']);
    expect(h.handled).toHaveLength(1);
    // Never unpins the other instance; re-subscribes as a standby.
    await until(() => h.consumes.length === 2, 4000);
    expect(h.unpin).not.toHaveBeenCalled();
    expect(h.runner.state).toBe('standby');
  }, 10_000);

  it('detects a pause between messages with its watchdog and checks the pin before ticking again (K2)', async () => {
    const clock = jumpClock();
    const h = harness(exclusiveSettings(3000), { clock: clock.now });
    await activeOn(h, 'pin-1');
    clock.jump(4000);
    await until(() => laterHooks(h).length === 2);
    expect(laterHooks(h)).toEqual([
      'deactivated:paused:pin-1:-',
      'activated:pinned:pin-1:pin-1',
    ]);
    expect(h.states).toEqual(['active', 'standby', 'active']);
  });

  it('runs no watchdog for shared consumers', async () => {
    const clock = jumpClock();
    const h = harness(
      durableHandlerSettings({ consumer: definition(), backoffMs: [100] }),
      { clock: clock.now },
    );
    await h.runner.start();
    running.push(h.runner);
    clock.jump(120_000);
    const message = fakeMessage(undefined);
    h.consumes[0]?.messages.push(message);
    await until(() => h.handled.length === 1);
    expect(message.settled).toEqual(['ack']);
    expect(h.runner.state).toBe('shared');
    expect(h.states).toEqual([]);
  });
});
