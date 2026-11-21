import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AnyEventEnvelope,
  type DurableConsumerDefinition,
  EVENT_TYPES,
  type FuelReadingRecordedV1,
  STREAMS,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { nanos } from '@nats-io/transport-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { baseConfigSchema } from '../src/config/index.js';
import { MetricsService } from '../src/metrics/index.js';
import {
  DurableConsumerRunner,
  durableHandlerSettings,
  type EventContext,
  EventPublisher,
  NatsClient,
  NatsConsumerRuntime,
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

const fuelConsumer = (name: string, mmsi: number): DurableConsumerDefinition => ({
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
}

@Module({ imports: [NatsModule.forRoot({ streams: ['FUEL'] })] })
class NatsOnlyModule {}

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
      readonly exclusive?: { readonly pinnedTtlMs: number };
    } = {},
  ): Promise<DurableConsumerRunner> {
    const runner = new DurableConsumerRunner(
      runtime,
      durableHandlerSettings({
        consumer: definition,
        ackWaitMs: options.ackWaitMs,
        exclusive: options.exclusive,
      }),
      async (event: AnyEventEnvelope, context: EventContext) => {
        if (event.type !== EVENT_TYPES.FUEL_READING_RECORDED) return;
        deliveries.push({
          minute: event.data.fuelMeTon,
          deliveryCount: context.deliveryCount,
          runner: options.label ?? 'main',
        });
        if (options.delayMs !== undefined) await sleep(options.delayMs);
      },
      'test.handler',
    );
    await runner.start();
    runners.push(runner);
    return runner;
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
    await app?.close();
  });

  it('keeps buffered messages alive while slow handlers run: no redelivery, stream order', async () => {
    const mmsi = base;
    const definition = fuelConsumer('slow', mmsi);
    const deliveries: Delivery[] = [];
    // Each handler takes 0.6 × ackWait: without heartbeats from arrival the
    // third buffered message would expire and be redelivered.
    await startRunner(definition, deliveries, { ackWaitMs: 1_000, delayMs: 600 });
    for (let minute = 1; minute <= 6; minute += 1)
      await publisher.publishEvent(EVENT_TYPES.FUEL_READING_RECORDED, reading(mmsi, minute));

    await waitFor(() => deliveries.length >= 6, { timeoutMs: 20_000 });
    await sleep(1_500); // a late redelivery would show up here
    expect(deliveries.map((d) => d.minute)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(deliveries.every((d) => d.deliveryCount === 1)).toBe(true);
    const info = await client.manager.consumers.info('FUEL', definition.durableName);
    expect(info.num_redelivered).toBe(0);
    expect(info.config.max_ack_pending).toBe(16);
  });

  it('recreates a deleted consumer and resumes consuming', async () => {
    const mmsi = base + 1;
    const definition = fuelConsumer('deleted', mmsi);
    const deliveries: Delivery[] = [];
    const runner = await startRunner(definition, deliveries);
    await publisher.publishEvent(EVENT_TYPES.FUEL_READING_RECORDED, reading(mmsi, 1));
    await waitFor(() => deliveries.length === 1);

    await client.manager.consumers.delete('FUEL', definition.durableName);
    await publisher.publishEvent(EVENT_TYPES.FUEL_READING_RECORDED, reading(mmsi, 2));

    await waitFor(() => deliveries.some((d) => d.minute === 2), { timeoutMs: 45_000 });
    const info = await client.manager.consumers.info('FUEL', definition.durableName);
    expect(info.config.durable_name).toBe(definition.durableName);
    expect(runner.health().healthy).toBe(true);
    const metrics = await app.get(MetricsService).registry.metrics();
    expect(metrics).toMatch(
      new RegExp(`aisits_events_consumer_recoveries_total\\{stream="FUEL",consumer="${definition.durableName}",outcome="recreated"\\} 1`),
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
    const first = await startRunner(definition, deliveries, { label: 'a', exclusive });
    const second = await startRunner(definition, deliveries, { label: 'b', exclusive });
    for (let minute = 1; minute <= 10; minute += 1)
      await publisher.publishEvent(EVENT_TYPES.FUEL_READING_RECORDED, reading(mmsi, minute));
    await waitFor(() => deliveries.length >= 10, { timeoutMs: 20_000 });
    const active = new Set(deliveries.map((d) => d.runner));
    expect(active.size).toBe(1);
    const info = await client.manager.consumers.info('FUEL', definition.durableName);
    expect(info.config.priority_policy).toBe('pinned_client');

    const [leader, standby] = active.has('a') ? [first, second] : [second, first];
    await leader.stop(2_000);
    for (let minute = 11; minute <= 13; minute += 1)
      await publisher.publishEvent(EVENT_TYPES.FUEL_READING_RECORDED, reading(mmsi, minute));
    await waitFor(() => deliveries.length >= 13, { timeoutMs: 45_000 });
    const failover = deliveries.slice(10).map((d) => d.runner);
    expect(new Set(failover)).toEqual(new Set([active.has('a') ? 'b' : 'a']));
    expect(standby.health().healthy).toBe(true);
  }, 60_000);
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
      await client.jetstream.publish('safety.state.v1.525005223', `{"n":${index}}`);
  });

  afterAll(async () => {
    await client?.manager.streams.delete('SAFETY').catch(() => undefined);
    await app?.close();
  });

  it('never changes a stream for a consumer', async () => {
    const outcome = await streams.ensure(['SAFETY'], 'consumer');
    expect(outcome.get('SAFETY')).toBe('drifted');
    const info = await client.manager.streams.info('SAFETY');
    expect(info.config.subjects).toEqual(['safety.state.v1.>', 'safety.state.v2.>']);
    expect(info.config.max_msgs_per_subject).toBe(5);
    expect(info.state.messages).toBe(3);
  });

  it('lets producers widen but never narrow a stream', async () => {
    const outcome = await new StreamManager(client).ensure(['SAFETY'], 'producer');
    expect(outcome.get('SAFETY')).toBe('updated');
    const info = await client.manager.streams.info('SAFETY');
    // widened: retention follows the contracts (7 days)
    expect(info.config.max_age).toBe(nanos(STREAMS.SAFETY.maxAgeMs));
    // never narrowed: the extra subject and the larger per-subject limit stay
    expect(info.config.subjects).toEqual(['safety.state.v1.>', 'safety.state.v2.>']);
    expect(info.config.max_msgs_per_subject).toBe(5);
    expect(info.state.messages).toBe(3);
  });
});
