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
  orderingWarning,
  pullExpiresMsFor,
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
    { onActivated: record('activated'), onDeactivated: record('deactivated') },
  );
  return {
    runner,
    consumes,
    handled,
    events,
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
