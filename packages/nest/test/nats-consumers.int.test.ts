import { setTimeout as sleep } from 'node:timers/promises';

import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type AnyEventEnvelope,
  type DurableConsumerDefinition,
  EVENT_TYPES,
  type FuelReadingRecordedV1,
  STREAMS,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { Injectable, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { nanos } from '@nats-io/transport-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { baseConfigSchema } from '../src/config/index.js';
import { MetricsService } from '../src/metrics/index.js';
import {
  DurableConsumerRunner,
  durableHandlerSettings,
  NatsConsumerRuntime,
} from '../src/internal/index.js';
import type { DurableConsumerRunnerOptions } from '../src/nats/durable-consumer-runner.js';
import {
  type EventContext,
  EventConsumers,
  EventHandler,
  EventPublisher,
  type ExclusiveConsumerEvent,
  type ExclusiveConsumerListener,
  NatsClient,
  NatsHealthIndicator,
  NatsModule,
  StreamManager,
} from '../src/nats/index.js';
import {
  buildTestApp,
  createTestConfig,
  waitFor,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';
import { startTcpLink } from './support/tcp-link.js';

const base = 300_000_000 + Math.floor(Math.random() * 600_000_000);

const reading = (mmsi: number, minutes: number): FuelReadingRecordedV1 => ({
  mmsi,
  time: new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString(),
  periodStart: null,
  fuelMeTon: minutes,
  fuelAeTon: 0,
  deviceId: null,
  source: 'api',
});

const fuelConsumer = (
  name: string,
  mmsi: number,
): DurableConsumerDefinition => ({
  durableName: uniqueName(name),
  stream: 'FUEL',
  filterSubjects: [subjects.fuelReading(mmsi)],
  service: 'emission',
  eventTypes: [EVENT_TYPES.FUEL_READING_RECORDED],
  maxDeliver: 10,
  description: `integration test consumer ${name}`,
});

interface Delivery {
  readonly minute: number;
  readonly deliveryCount: number;
  readonly runner: string;
  /** `performance.now()` when the handler saw the message. */
  readonly at: number;
}

/** The pinned client id of the exclusive consumer group (NATS >= 2.11). */
function pinnedClientId(info: unknown): string | undefined {
  const groups = (info as { priority_groups?: { pinned_client_id?: string }[] })
    .priority_groups;
  return groups?.[0]?.pinned_client_id;
}

@Module({ imports: [NatsModule.forRoot({ streams: ['FUEL'] })] })
class NatsOnlyModule {}

/** A second connection (through a `TcpLink`) with short API timeouts. */
@Module({
  imports: [NatsModule.forRoot({ streams: ['FUEL'], requestTimeoutMs: 2000 })],
})
class LinkedNatsModule {}

const LISTENER_MMSI = base + 8;
const listenerConsumer = fuelConsumer('listener', LISTENER_MMSI);

/** An exclusive `@EventHandler` provider that reloads its state on activation. */
@Injectable()
class ExclusiveProcessor implements ExclusiveConsumerListener {
  readonly log: string[] = [];
  readonly events: ExclusiveConsumerEvent[] = [];

  @EventHandler({
    consumer: listenerConsumer,
    exclusive: { pinnedTtlMs: 30_000 },
  })
  onReading(event: AnyEventEnvelope): void {
    if (event.type === EVENT_TYPES.FUEL_READING_RECORDED)
      this.log.push(`handled:${event.data.fuelMeTon}`);
  }

  async onConsumerActivated(event: ExclusiveConsumerEvent): Promise<void> {
    this.events.push(event);
    await sleep(200); // e.g. reload open alerts
    this.log.push('activated');
  }

  onConsumerDeactivated(event: ExclusiveConsumerEvent): void {
    this.events.push(event);
    this.log.push(`deactivated:${event.reason}`);
  }
}

describe('durable consumers', () => {
  let app: NestFastifyApplication;
  let runtime: NatsConsumerRuntime;
  let publisher: EventPublisher;
  let client: NatsClient;
  const runners: DurableConsumerRunner[] = [];

  /** Starts a runner that records its deliveries and sleeps `delayMs` per message. */
  async function startRunner(
    definition: DurableConsumerDefinition,
    deliveries: Delivery[],
    options: {
      readonly label?: string;
      readonly delayMs?: number;
      readonly ackWaitMs?: number;
      readonly backoffMs?: readonly number[];
      readonly exclusive?: { readonly pinnedTtlMs: number };
      readonly hooks?: DurableConsumerRunnerOptions;
      /** Receives `<label>:handled:<minute>`. */
      readonly log?: string[];
      /** Default: the test app's runtime (direct connection). */
      readonly runtime?: NatsConsumerRuntime;
    } = {},
  ): Promise<DurableConsumerRunner> {
    const label = options.label ?? 'main';
    const runner = new DurableConsumerRunner(
      options.runtime ?? runtime,
      durableHandlerSettings({
        consumer: definition,
        ackWaitMs: options.ackWaitMs,
        backoffMs: options.backoffMs,
        exclusive: options.exclusive,
      }),
      async (event: AnyEventEnvelope, context: EventContext) => {
        if (event.type !== EVENT_TYPES.FUEL_READING_RECORDED) return;
        deliveries.push({
          minute: event.data.fuelMeTon,
          deliveryCount: context.deliveryCount,
          runner: label,
          at: performance.now(),
        });
        options.log?.push(`${label}:handled:${event.data.fuelMeTon}`);
        if (options.delayMs !== undefined) await sleep(options.delayMs);
      },
      'test.handler',
      options.hooks,
    );
    await runner.start();
    runners.push(runner);
    return runner;
  }

  /** Publishes reading `minute` of `mmsi` and returns `performance.now()` before it. */
  async function publishReading(mmsi: number, minute: number): Promise<number> {
    const at = performance.now();
    await publisher.publishEvent(
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(mmsi, minute),
    );
    return at;
  }

  beforeAll(async () => {
    const config = createTestConfig(baseConfigSchema, {
      SERVICE_NAME: 'nats-consumers-test',
      NATS_URL: testInfra().natsUrl,
    });
    app = await buildTestApp(NatsOnlyModule, { config });
    runtime = app.get(NatsConsumerRuntime);
    publisher = app.get(EventPublisher);
    client = app.get(NatsClient);
  });

  afterAll(async () => {
    await Promise.all(runners.map((runner) => runner.stop(2_000)));
    await app.close();
  });

  it('keeps buffered messages alive while slow handlers run: no redelivery, stream order', async () => {
    const mmsi = base;
    const definition = fuelConsumer('slow', mmsi);
    const deliveries: Delivery[] = [];
    // Each handler takes 0.6 × ackWait: without heartbeats from arrival the
    // third buffered message would expire and be redelivered.
    await startRunner(definition, deliveries, {
      ackWaitMs: 1_000,
      delayMs: 600,
    });
    for (let minute = 1; minute <= 6; minute += 1)
      await publisher.publishEvent(
        EVENT_TYPES.FUEL_READING_RECORDED,
        reading(mmsi, minute),
      );

    await waitFor(() => deliveries.length >= 6, { timeoutMs: 20_000 });
    await sleep(1_500); // a late redelivery would show up here
    expect(deliveries.map((d) => d.minute)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(deliveries.every((d) => d.deliveryCount === 1)).toBe(true);
    const info = await client.manager.consumers.info(
      'FUEL',
      definition.durableName,
    );
    expect(info.num_redelivered).toBe(0);
    expect(info.config.max_ack_pending).toBe(16);
  });

  it('recreates a deleted consumer and resumes consuming', async () => {
    const mmsi = base + 1;
    const definition = fuelConsumer('deleted', mmsi);
    const deliveries: Delivery[] = [];
    const runner = await startRunner(definition, deliveries);
    await publisher.publishEvent(
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(mmsi, 1),
    );
    await waitFor(() => deliveries.length === 1);

    await client.manager.consumers.delete('FUEL', definition.durableName);
    await publisher.publishEvent(
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(mmsi, 2),
    );

    await waitFor(() => deliveries.some((d) => d.minute === 2), {
      timeoutMs: 45_000,
    });
    const info = await client.manager.consumers.info(
      'FUEL',
      definition.durableName,
    );
    expect(info.config.durable_name).toBe(definition.durableName);
    expect(runner.health().healthy).toBe(true);
    const metrics = await app.get(MetricsService).registry.metrics();
    expect(metrics).toMatch(
      new RegExp(
        `aisits_events_consumer_recoveries_total\\{stream="FUEL",consumer="${definition.durableName}",outcome="recreated"\\} 1`,
      ),
    );
  }, 60_000);

  it('reports a consumer that cannot recover as not ready', async () => {
    const definition = fuelConsumer('unhealthy', base + 2);
    const runner = await startRunner(definition, []);
    expect(runner.health().healthy).toBe(true);
    const later = Date.now() + 10 * 60_000;
    expect(runner.health(later)).toMatchObject({ healthy: false });
    const indicator = app.get(NatsHealthIndicator);
    expect(indicator.healthKey).toBe('nats');
  });

  it('delivers an exclusive consumer to one instance and fails over to the standby', async () => {
    const mmsi = base + 3;
    const definition = fuelConsumer('exclusive', mmsi);
    const deliveries: Delivery[] = [];
    const exclusive = { pinnedTtlMs: 2_000 };
    const first = await startRunner(definition, deliveries, {
      label: 'a',
      exclusive,
    });
    const second = await startRunner(definition, deliveries, {
      label: 'b',
      exclusive,
    });
    for (let minute = 1; minute <= 10; minute += 1)
      await publisher.publishEvent(
        EVENT_TYPES.FUEL_READING_RECORDED,
        reading(mmsi, minute),
      );
    await waitFor(() => deliveries.length >= 10, { timeoutMs: 20_000 });
    const active = new Set(deliveries.map((d) => d.runner));
    expect(active.size).toBe(1);
    const info = await client.manager.consumers.info(
      'FUEL',
      definition.durableName,
    );
    expect(info.config.priority_policy).toBe('pinned_client');

    const [leader, standby] = active.has('a')
      ? [first, second]
      : [second, first];
    await leader.stop(2_000);
    for (let minute = 11; minute <= 13; minute += 1)
      await publisher.publishEvent(
        EVENT_TYPES.FUEL_READING_RECORDED,
        reading(mmsi, minute),
      );
    await waitFor(() => deliveries.length >= 13, { timeoutMs: 45_000 });
    const failover = deliveries.slice(10).map((d) => d.runner);
    expect(new Set(failover)).toEqual(new Set([active.has('a') ? 'b' : 'a']));
    expect(standby.health().healthy).toBe(true);
  }, 60_000);

  it('re-creates its deleted stream and consumer and resumes consuming (NATS-3)', async () => {
    const mmsi = base + 10;
    const definition: DurableConsumerDefinition = {
      durableName: uniqueName('cii-gone'),
      stream: 'EMISSION',
      filterSubjects: [subjects.ciiUpdated(mmsi)],
      service: 'notification',
      eventTypes: [EVENT_TYPES.EMISSION_CII_UPDATED],
      maxDeliver: 10,
      description: 'integration test consumer of a deleted stream',
    };
    const years: number[] = [];
    const runner = new DurableConsumerRunner(
      runtime,
      durableHandlerSettings({ consumer: definition }),
      (event: AnyEventEnvelope) => {
        if (event.type === EVENT_TYPES.EMISSION_CII_UPDATED)
          years.push(event.data.year);
      },
      'test.cii',
    );
    await runner.start();
    runners.push(runner);
    const cii = (year: number) => ({
      mmsi,
      vesselId: newId(),
      orgId: newId(),
      year,
      asOf: `${year}-11-20T08:30:00.000Z`,
      distanceNm: 61_500,
      fuelMeTon: 5200,
      fuelAeTon: 380,
      co2Ton: 17_376.12,
      attained: 5.4334,
      required: 4.92,
      rating: 1.1044,
      grade: 'D' as const,
      lastMethod: 'first_formula' as const,
    });
    await publisher.publishEvent(EVENT_TYPES.EMISSION_CII_UPDATED, cii(2025));
    await waitFor(() => years.length === 1);

    // Deleting the stream deletes its consumers too.
    await client.manager.streams.delete('EMISSION');
    // This process only consumes EMISSION: the runner re-creates both.
    await waitFor(
      () =>
        client.manager.consumers.info('EMISSION', definition.durableName).then(
          () => true,
          () => false,
        ),
      { timeoutMs: 45_000 },
    );
    await publisher.publishEvent(EVENT_TYPES.EMISSION_CII_UPDATED, cii(2026));
    await waitFor(() => years.includes(2026), { timeoutMs: 45_000 });
    expect(runner.health().healthy).toBe(true);
    const metrics = await app.get(MetricsService).render();
    expect(metrics).toMatch(
      new RegExp(
        `aisits_events_consumer_recoveries_total\\{stream="EMISSION",consumer="${definition.durableName}",outcome="recreated"\\} [1-9]`,
      ),
    );
  }, 90_000);

  it('keeps the pin of an idle exclusive consumer: pulls renew it three times per TTL (NATS-4)', async () => {
    const mmsi = base + 4;
    const definition = fuelConsumer('idle-pin', mmsi);
    const deliveries: Delivery[] = [];
    const runner = await startRunner(definition, deliveries, {
      exclusive: { pinnedTtlMs: 3000 },
    });
    await publishReading(mmsi, 1);
    await waitFor(() => deliveries.length === 1);
    expect(runner.state).toBe('active');
    const pinned = pinnedClientId(
      await client.manager.consumers.info('FUEL', definition.durableName),
    );
    expect(pinned).toBeDefined();
    const states = new Set<string>();
    const idleUntil = Date.now() + 12_000;
    while (Date.now() < idleUntil) {
      states.add(runner.health().state);
      await sleep(200);
    }
    expect([...states]).toEqual(['active']);
    expect(
      pinnedClientId(
        await client.manager.consumers.info('FUEL', definition.durableName),
      ),
    ).toBe(pinned);
    const sentAt = await publishReading(mmsi, 2);
    await waitFor(() => deliveries.length === 2, { timeoutMs: 5000 });
    expect((deliveries[1]?.at ?? Infinity) - sentAt).toBeLessThan(1000);
  }, 40_000);

  it('re-pulls at once when unpinned: the standby takes over and a stale standby never unpins it (NATS-5, NATS-6)', async () => {
    const mmsi = base + 5;
    const definition = fuelConsumer('unpinned', mmsi);
    const deliveries: Delivery[] = [];
    const exclusive = { pinnedTtlMs: 30_000 };
    const a = await startRunner(definition, deliveries, {
      label: 'a',
      exclusive,
    });
    await publishReading(mmsi, 1);
    await waitFor(() => deliveries.length === 1);
    expect(a.state).toBe('active');
    const b = await startRunner(definition, deliveries, {
      label: 'b',
      exclusive,
    });
    await sleep(300);
    // Late-started and never pinned.
    expect(b.state).toBe('starting');

    await client.manager.consumers.unpin(
      'FUEL',
      definition.durableName,
      'active',
    );
    const sentAt = await publishReading(mmsi, 2);
    await waitFor(() => deliveries.length === 2, { timeoutMs: 5000 });
    expect(deliveries[1]?.runner).toBe('b');
    expect((deliveries[1]?.at ?? Infinity) - sentAt).toBeLessThan(1000);
    expect(b.state).toBe('active');
    await waitFor(() => a.state === 'standby', { timeoutMs: 15_000 });
    // a re-subscribed (after about 2 s) as a standby: b keeps the messages.
    await sleep(2500);
    await publishReading(mmsi, 3);
    await waitFor(() => deliveries.length === 3);
    expect(deliveries[2]?.runner).toBe('b');
    expect(a.health()).toMatchObject({
      state: 'standby',
      standby: true,
      healthy: true,
    });

    // Stopping the stale standby leaves b pinned.
    const pinned = pinnedClientId(
      await client.manager.consumers.info('FUEL', definition.durableName),
    );
    await a.stop(2000);
    expect(
      pinnedClientId(
        await client.manager.consumers.info('FUEL', definition.durableName),
      ),
    ).toBe(pinned);
    const lastAt = await publishReading(mmsi, 4);
    await waitFor(() => deliveries.length === 4);
    expect(deliveries[3]?.runner).toBe('b');
    expect((deliveries[3]?.at ?? Infinity) - lastAt).toBeLessThan(1000);
  }, 60_000);

  it('releases the pin on a graceful stop: the standby handles the next message at once (NATS-6)', async () => {
    const mmsi = base + 6;
    const definition = fuelConsumer('handover', mmsi);
    const deliveries: Delivery[] = [];
    // Without the release, b would wait for the full 30 s TTL.
    const exclusive = { pinnedTtlMs: 30_000 };
    const a = await startRunner(definition, deliveries, {
      label: 'a',
      exclusive,
    });
    await publishReading(mmsi, 1);
    await waitFor(() => deliveries.length === 1);
    await startRunner(definition, deliveries, { label: 'b', exclusive });
    await sleep(300);
    await a.stop(2000);
    const sentAt = await publishReading(mmsi, 2);
    await waitFor(() => deliveries.length === 2, { timeoutMs: 5000 });
    expect(deliveries[1]?.runner).toBe('b');
    expect((deliveries[1]?.at ?? Infinity) - sentAt).toBeLessThan(1000);
  }, 30_000);

  it('gates the new active instance on onActivated, retrying a failed hook without losing the message (NATS-7)', async () => {
    const mmsi = base + 7;
    const definition = fuelConsumer('activation', mmsi);
    const deliveries: Delivery[] = [];
    const log: string[] = [];
    const exclusive = { pinnedTtlMs: 30_000 };
    const a = await startRunner(definition, deliveries, {
      label: 'a',
      exclusive,
      log,
      hooks: {
        onDeactivated: (event) => {
          log.push(`a:deactivated:${event.reason}`);
        },
      },
    });
    await publishReading(mmsi, 1);
    await waitFor(() => deliveries.length === 1);
    let attempts = 0;
    await startRunner(definition, deliveries, {
      label: 'b',
      exclusive,
      log,
      backoffMs: [300],
      hooks: {
        onActivated: async (event) => {
          attempts += 1;
          log.push(`b:activating:${attempts}:${event.reason}`);
          await sleep(700); // a slow reload delays dispatch
          if (attempts === 1) throw new Error('state store unavailable');
          log.push('b:activated');
        },
      },
    });
    await sleep(300);
    await a.stop(2000);
    const sentAt = await publishReading(mmsi, 2);
    await waitFor(() => deliveries.length === 2, { timeoutMs: 20_000 });
    expect(log).toEqual([
      'a:handled:1',
      'a:deactivated:stopped',
      'b:activating:1:pinned',
      'b:activating:2:pinned',
      'b:activated',
      'b:handled:2',
    ]);
    // The message waited for two slow hooks and was redelivered once.
    expect(deliveries[1]).toMatchObject({ runner: 'b', deliveryCount: 2 });
    expect((deliveries[1]?.at ?? 0) - sentAt).toBeGreaterThan(1400);
    expect(await app.get(MetricsService).render()).toMatch(
      new RegExp(
        `aisits_events_consumer_activations_total\\{consumer="${definition.durableName}"\\} 2`,
      ),
    );
  }, 40_000);

  it('keeps the pin through handlers slower than the bound while max_ack_pending is reached (K1, no spurious give-up)', async () => {
    const mmsi = base + 10;
    const definition = fuelConsumer('slow-pinned', mmsi);
    const deliveries: Delivery[] = [];
    const reasons: string[] = [];
    // Bound 1.5 s; every handler takes 2.5 s and at most 2 messages are unacknowledged.
    const runner = new DurableConsumerRunner(
      runtime,
      durableHandlerSettings({
        consumer: definition,
        exclusive: { pinnedTtlMs: 3000 },
        maxAckPending: 2,
        concurrency: 2,
        orderBySubject: false,
      }),
      async (event: AnyEventEnvelope, context: EventContext) => {
        if (event.type !== EVENT_TYPES.FUEL_READING_RECORDED) return;
        deliveries.push({
          minute: event.data.fuelMeTon,
          deliveryCount: context.deliveryCount,
          runner: 'slow',
          at: performance.now(),
        });
        await sleep(2500);
      },
      'test.slow',
      {
        onDeactivated: (event) => {
          reasons.push(event.reason);
        },
      },
    );
    await runner.start();
    runners.push(runner);
    for (let minute = 1; minute <= 6; minute += 1)
      await publishReading(mmsi, minute);
    await waitFor(() => deliveries.length === 6, { timeoutMs: 20_000 });
    await sleep(3000);
    expect(reasons).toEqual([]);
    expect(runner.state).toBe('active');
    expect(deliveries.every((d) => d.deliveryCount === 1)).toBe(true);
  }, 40_000);

  it('gives the pin up when cut off from NATS before the server can pin the standby, and is active again only through a new pin (K1)', async () => {
    const link = await startTcpLink(testInfra().natsUrl);
    const linked = await buildTestApp(LinkedNatsModule, {
      config: createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'nats-consumers-linked',
        NATS_URL: link.url,
      }),
    });
    try {
      const mmsi = base + 9;
      const definition = fuelConsumer('cut-off', mmsi);
      const deliveries: Delivery[] = [];
      const hooks: string[] = [];
      // pinnedTtlMs 3000: pull expiry 1 s, heartbeats 0.5 s, bound 1.5 s.
      const exclusive = { pinnedTtlMs: 3000 };
      let aStandbyAt = Infinity;
      let bActiveAt = Infinity;
      const a = await startRunner(definition, deliveries, {
        label: 'a',
        exclusive,
        runtime: linked.get(NatsConsumerRuntime),
        hooks: {
          onActivated: (event) => {
            hooks.push(
              `a:activated:${event.previous === undefined ? 'first' : 'new-pin'}`,
            );
          },
          onDeactivated: (event) => {
            hooks.push(`a:deactivated:${event.reason}`);
          },
          onStateChange: (state) => {
            if (state === 'standby')
              aStandbyAt = Math.min(aStandbyAt, performance.now());
          },
        },
      });
      await publishReading(mmsi, 1);
      await waitFor(() => deliveries.length === 1);
      expect(a.state).toBe('active');
      const b = await startRunner(definition, deliveries, {
        label: 'b',
        exclusive,
        hooks: {
          onStateChange: (state) => {
            if (state === 'active') bActiveAt = performance.now();
          },
        },
      });
      await sleep(300);
      expect(b.state).toBe('starting');

      // a is cut off (its connection stays open, nothing gets through).
      const cutAt = performance.now();
      link.hold();
      await waitFor(() => a.state === 'standby', { timeoutMs: 5000 });
      // Within the bound plus one watchdog interval, before the pinned TTL.
      expect(aStandbyAt - cutAt).toBeGreaterThan(1000);
      expect(aStandbyAt - cutAt).toBeLessThan(2600);
      await waitFor(() => hooks.includes('a:deactivated:contact_lost'));
      // Once the TTL has passed the server pins b with the next message.
      await sleep(Math.max(0, cutAt + 4000 - performance.now()));
      await publishReading(mmsi, 2);
      await waitFor(() => deliveries.length === 2, { timeoutMs: 10_000 });
      expect(deliveries[1]?.runner).toBe('b');
      expect(b.state).toBe('active');
      // a had given its role up before b could become active.
      expect(aStandbyAt).toBeLessThan(bActiveAt);

      // Back in contact: a re-subscribes as a standby, b keeps the pin.
      link.release();
      await sleep(5000);
      expect(a.state).toBe('standby');
      await publishReading(mmsi, 3);
      await waitFor(() => deliveries.length === 3);
      expect(deliveries[2]?.runner).toBe('b');

      // b stops: a is pinned afresh and activated again.
      await b.stop(2000);
      runners.splice(runners.indexOf(b), 1);
      await publishReading(mmsi, 4);
      await waitFor(() => deliveries.length === 4, { timeoutMs: 15_000 });
      expect(deliveries[3]?.runner).toBe('a');
      expect(a.state).toBe('active');
      expect(hooks).toEqual([
        'a:activated:first',
        'a:deactivated:contact_lost',
        'a:activated:new-pin',
      ]);
      expect(
        deliveries.filter((d) => d.runner === 'a').map((d) => d.minute),
      ).toEqual([1, 4]);
    } finally {
      link.release();
      const own = runners.filter((runner) => runner.name.includes('cut-off'));
      await Promise.all(own.map((runner) => runner.stop(2000)));
      for (const runner of own) runners.splice(runners.indexOf(runner), 1);
      await linked.close();
      await link.close();
    }
  }, 60_000);
});

describe('exclusive @EventHandler providers (ExclusiveConsumerListener)', () => {
  it('calls the listener hooks on the provider and reports the consumer state', async () => {
    @Module({
      imports: [NatsModule.forRoot({ streams: ['FUEL'] })],
      providers: [ExclusiveProcessor],
    })
    class ListenerModule {}
    const app = await buildTestApp(ListenerModule, {
      config: createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'nats-listener-test',
        NATS_URL: testInfra().natsUrl,
      }),
    });
    const processor = app.get(ExclusiveProcessor);
    try {
      const consumers = app.get(EventConsumers);
      expect(consumers.state(listenerConsumer.durableName)).toBe('starting');
      expect(consumers.state('no-such-consumer')).toBeUndefined();
      await app
        .get(EventPublisher)
        .publishEvent(
          EVENT_TYPES.FUEL_READING_RECORDED,
          reading(LISTENER_MMSI, 1),
        );
      await waitFor(() => processor.log.includes('handled:1'));
      expect(processor.log).toEqual(['activated', 'handled:1']);
      expect(consumers.state(listenerConsumer.durableName)).toBe('active');
      expect(processor.events[0]).toMatchObject({
        stream: 'FUEL',
        reason: 'pinned',
        previous: undefined,
      });
      expect(processor.events[0]?.consumer).toContain(
        listenerConsumer.durableName,
      );
    } finally {
      await app.close();
    }
    // A graceful stop deactivates (then releases the pin).
    expect(processor.log.at(-1)).toBe('deactivated:stopped');
    expect(processor.events.at(-1)?.pinId).toBe(processor.events[0]?.pinId);
  }, 30_000);
});

describe('stream ownership (spec §7.2)', () => {
  let app: NestFastifyApplication;
  let streams: StreamManager;
  let client: NatsClient;

  beforeAll(async () => {
    const config = createTestConfig(baseConfigSchema, {
      SERVICE_NAME: 'nats-streams-test',
      NATS_URL: testInfra().natsUrl,
    });
    app = await buildTestApp(NatsOnlyModule, { config });
    streams = app.get(StreamManager);
    client = app.get(NatsClient);
    // A SAFETY stream as a newer producer configured it: an extra subject,
    // 5 messages per subject, one day of retention.
    await client.manager.streams.delete('SAFETY').catch(() => undefined);
    await client.manager.streams.add({
      name: 'SAFETY',
      subjects: ['safety.state.v1.>', 'safety.state.v2.>'],
      retention: STREAMS.SAFETY.retention,
      storage: STREAMS.SAFETY.storage,
      max_msgs_per_subject: 5,
      max_age: nanos(24 * 3_600_000),
      duplicate_window: nanos(STREAMS.SAFETY.duplicateWindowMs),
    });
    for (let index = 0; index < 3; index += 1)
      await client.jetstream.publish(
        'safety.state.v1.525005223',
        `{"n":${index}}`,
      );
  });

  afterAll(async () => {
    await client.manager.streams.delete('SAFETY').catch(() => undefined);
    await app.close();
  });

  it('never changes a stream for a consumer', async () => {
    const outcome = await streams.ensure(['SAFETY'], 'consumer');
    expect(outcome.get('SAFETY')).toBe('drifted');
    const info = await client.manager.streams.info('SAFETY');
    expect(info.config.subjects).toEqual([
      'safety.state.v1.>',
      'safety.state.v2.>',
    ]);
    expect(info.config.max_msgs_per_subject).toBe(5);
    expect(info.state.messages).toBe(3);
  });

  it('lets producers widen but never narrow a stream', async () => {
    const outcome = await new StreamManager(client).ensure(
      ['SAFETY'],
      'producer',
    );
    expect(outcome.get('SAFETY')).toBe('updated');
    const info = await client.manager.streams.info('SAFETY');
    // widened: retention follows the contracts (7 days)
    expect(info.config.max_age).toBe(nanos(STREAMS.SAFETY.maxAgeMs));
    // never narrowed: the extra subject and the larger per-subject limit stay
    expect(info.config.subjects).toEqual([
      'safety.state.v1.>',
      'safety.state.v2.>',
    ]);
    expect(info.config.max_msgs_per_subject).toBe(5);
    expect(info.state.messages).toBe(3);
  });
});
