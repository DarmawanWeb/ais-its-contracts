import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  type AnyEventEnvelope,
  type DurableConsumerDefinition,
  EVENT_TYPES,
  type FuelReadingRecordedV1,
  parseEnvelope,
  subjects,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { Injectable, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestZone } from '../src/analytics/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import { MetricsService } from '../src/metrics/index.js';
import {
  DLQ_HEADERS,
  EVENT_TYPE_HEADER,
  type EventContext,
  EventHandler,
  EventPublisher,
  EventSubjectMismatchError,
  NatsClient,
  NatsModule,
  NonRetryableError,
  OrderedConsumers,
  RetryableError,
  StreamManager,
  StreamReplayer,
} from '../src/nats/index.js';
import {
  buildTestApp,
  createTestConfig,
  waitFor,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

/** MMSIs of this file (9 digits, random to isolate reruns on a shared server). */
const base = 300_000_000 + Math.floor(Math.random() * 600_000_000);
const MMSI = {
  ok: base,
  retry: base + 1,
  term: base + 2,
  dlq: base + 3,
  invalid: base + 4,
} as const;

const fuelConsumer = (
  name: string,
  mmsi: number,
  maxDeliver = 10,
): DurableConsumerDefinition => ({
  durableName: uniqueName(name),
  stream: 'FUEL',
  filterSubjects: [subjects.fuelReading(mmsi)],
  service: 'emission',
  eventTypes: [EVENT_TYPES.FUEL_READING_RECORDED],
  maxDeliver,
  description: `integration test consumer ${name}`,
});

const CONSUMERS = {
  ok: fuelConsumer('ok', MMSI.ok),
  retry: fuelConsumer('retry', MMSI.retry),
  term: fuelConsumer('term', MMSI.term),
  dlq: fuelConsumer('dlq', MMSI.dlq, 3),
  invalid: fuelConsumer('invalid', MMSI.invalid),
};

/** Records every delivery per consumer. */
const received = new Map<
  string,
  { event: AnyEventEnvelope; context: EventContext }[]
>();
function record(
  name: string,
  event: AnyEventEnvelope,
  context: EventContext,
): number {
  const list = received.get(name) ?? [];
  list.push({ event, context });
  received.set(name, list);
  return list.length;
}

@Injectable()
class FuelHandlers {
  @EventHandler({ consumer: CONSUMERS.ok, concurrency: 4 })
  onOk(event: AnyEventEnvelope, context: EventContext): void {
    record('ok', event, context);
  }

  @EventHandler({ consumer: CONSUMERS.retry, backoffMs: [50] })
  onRetry(event: AnyEventEnvelope, context: EventContext): void {
    if (record('retry', event, context) === 1)
      throw new RetryableError('dependency busy', { retryAfterMs: 50 });
  }

  @EventHandler({ consumer: CONSUMERS.term })
  onTerm(event: AnyEventEnvelope, context: EventContext): void {
    record('term', event, context);
    throw new NonRetryableError('unknown vessel, will never exist');
  }

  @EventHandler({ consumer: CONSUMERS.dlq, backoffMs: [50] })
  onDlq(event: AnyEventEnvelope, context: EventContext): void {
    record('dlq', event, context);
    throw new Error('database unavailable');
  }

  @EventHandler({ consumer: CONSUMERS.invalid })
  onInvalid(event: AnyEventEnvelope, context: EventContext): void {
    record('invalid', event, context);
  }
}

const reading = (mmsi: number, minutes = 0): FuelReadingRecordedV1 => ({
  mmsi,
  time: new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString(),
  periodStart: null,
  fuelMeTon: 0.4,
  fuelAeTon: 0.05,
  deviceId: null,
  source: 'api',
});

describe('NATS JetStream kit', () => {
  let app: NestFastifyApplication;
  let publisher: EventPublisher;
  let client: NatsClient;

  beforeAll(async () => {
    @Module({
      imports: [NatsModule.forRoot({ streams: ['FUEL', 'GEO'] })],
      providers: [FuelHandlers],
    })
    class AppModule {}
    app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'nats-test',
        NATS_URL: testInfra().natsUrl,
      }),
    });
    publisher = app.get(EventPublisher);
    client = app.get(NatsClient);
  });

  afterAll(async () => {
    await app.close();
  });

  it('ensures contracts streams idempotently and reports NATS readiness', async () => {
    const streams = app.get(StreamManager);
    const outcomes = await streams.ensure(['FUEL', 'GEO']);
    expect(
      [...outcomes.values()].every(
        (outcome) => outcome === 'created' || outcome === 'unchanged',
      ),
    ).toBe(true);
    const info = await client.manager.streams.info('GEO');
    expect(info.config).toMatchObject({
      subjects: ['geo.zone.v1.>'],
      max_msgs_per_subject: 1,
    });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ok',
      info: { nats: { status: 'up' } },
    });
  });

  it('publishes contracts envelopes with dedup id and headers, and acks handled events', async () => {
    const { envelope, ack } = await publisher.publishEvent(
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(MMSI.ok),
    );
    expect(envelope).toMatchObject({
      type: 'fuel.reading.recorded.v1',
      source: 'nats-test',
      data: { mmsi: MMSI.ok },
    });
    expect(ack.duplicate).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated signature is still supported
    const again = await publisher.publish(
      subjects.fuelReading(MMSI.ok),
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(MMSI.ok),
      {
        msgId: envelope.id,
      },
    );
    expect(again.duplicate).toBe(true);

    const stored = await client.manager.streams.getMessage('FUEL', {
      seq: ack.seq,
    });
    expect(stored?.header.get('Nats-Msg-Id')).toBe(envelope.id);
    expect(stored?.header.get('content-type')).toBe('application/json');
    expect(stored?.header.get(EVENT_TYPE_HEADER)).toBe(
      'fuel.reading.recorded.v1',
    );
    const parsed = parseEnvelope(stored?.data);
    expect(parsed.success && parsed.envelope.id).toBe(envelope.id);

    const deliveries = await waitFor(() => received.get('ok'));
    expect(deliveries[0]?.event.id).toBe(envelope.id);
    expect(deliveries[0]?.context).toMatchObject({
      stream: 'FUEL',
      deliveryCount: 1,
    });
    await waitFor(
      async () =>
        (await client.manager.consumers.info('FUEL', CONSUMERS.ok.durableName))
          .num_ack_pending === 0,
    );
  });

  it('refuses an explicit subject that is not the event subject', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated signature is still supported
      publisher.publish(
        subjects.fuelReading(MMSI.ok + 100),
        EVENT_TYPES.FUEL_READING_RECORDED,
        reading(MMSI.ok),
      ),
    ).rejects.toBeInstanceOf(EventSubjectMismatchError);
  });

  it('publishes many events in input order and reports the first failure', async () => {
    const mmsi = MMSI.invalid + 50;
    const acks = await publisher.publishMany(
      [1, 2, 3].map((minute) => ({
        type: EVENT_TYPES.FUEL_READING_RECORDED,
        data: reading(mmsi, minute),
      })),
    );
    // acks[i] belongs to items[i]
    for (const [index, ack] of acks.entries()) {
      const stored = await client.manager.streams.getMessage('FUEL', {
        seq: ack.seq,
      });
      const parsed = parseEnvelope(stored?.data);
      expect(
        parsed.success &&
          parsed.envelope.type === EVENT_TYPES.FUEL_READING_RECORDED &&
          parsed.envelope.data.time,
      ).toBe(reading(mmsi, index + 1).time);
    }
    await expect(
      publisher.publishMany([
        { type: EVENT_TYPES.FUEL_READING_RECORDED, data: reading(mmsi, 4) },
        {
          type: EVENT_TYPES.FUEL_READING_RECORDED,
          data: { ...reading(mmsi, 5), fuelMeTon: -1 },
        },
      ]),
    ).rejects.toThrow();
  });

  it('refuses payloads that violate the contract before publishing', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the deprecated signature is still supported
      publisher.publish(
        subjects.fuelReading(MMSI.ok),
        EVENT_TYPES.FUEL_READING_RECORDED,
        { ...reading(MMSI.ok), fuelMeTon: -1 },
      ),
    ).rejects.toThrow();
  });

  it('naks retryable failures with backoff and redelivers', async () => {
    await publisher.publishEvent(
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(MMSI.retry),
    );
    const deliveries = await waitFor(
      () => (received.get('retry')?.length ?? 0) >= 2 && received.get('retry'),
      {
        timeoutMs: 10_000,
      },
    );
    expect(
      deliveries.map((delivery) => delivery.context.deliveryCount),
    ).toEqual([1, 2]);
  });

  it('terminates non-retryable failures without dead-lettering them', async () => {
    await publisher.publishEvent(
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(MMSI.term),
    );
    await waitFor(() => received.get('term'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(received.get('term')).toHaveLength(1);
    await expect(
      client.manager.streams.getMessage('DLQ', {
        last_by_subj: subjects.dlq('FUEL', CONSUMERS.term.durableName),
      }),
    ).resolves.toBeNull();
  });

  it('copies messages to the DLQ with error headers after maxDeliver, then acks', async () => {
    const { envelope } = await publisher.publishEvent(
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(MMSI.dlq),
    );
    const dead = await waitFor(
      async () =>
        client.manager.streams
          .getMessage('DLQ', {
            last_by_subj: subjects.dlq('FUEL', CONSUMERS.dlq.durableName),
          })
          .catch(() => undefined),
      { timeoutMs: 15_000 },
    );
    expect(
      received.get('dlq')?.map((delivery) => delivery.context.deliveryCount),
    ).toEqual([1, 2, 3]);
    expect(dead.header.get(DLQ_HEADERS.STREAM)).toBe('FUEL');
    expect(dead.header.get(DLQ_HEADERS.CONSUMER)).toBe(
      CONSUMERS.dlq.durableName,
    );
    expect(dead.header.get(DLQ_HEADERS.DELIVERY_COUNT)).toBe('3');
    expect(dead.header.get(DLQ_HEADERS.ERROR)).toBe('database unavailable');
    expect(dead.header.get(DLQ_HEADERS.SERVICE)).toBe('nats-test');
    const copy = parseEnvelope(dead.data);
    expect(copy.success && copy.envelope.id).toBe(envelope.id);
    await waitFor(
      async () =>
        (await client.manager.consumers.info('FUEL', CONSUMERS.dlq.durableName))
          .num_ack_pending === 0,
    );
  });

  it('terminates invalid messages and counts them', async () => {
    const invalid = {
      id: newId(),
      type: 'fuel.reading.recorded.v1',
      source: 'rogue',
      time: new Date().toISOString(),
      data: { mmsi: 'x' },
    };
    await client.jetstream.publish(
      subjects.fuelReading(MMSI.invalid),
      JSON.stringify(invalid),
    );
    await client.jetstream.publish(
      subjects.fuelReading(MMSI.invalid),
      'not json at all',
    );
    const metrics = app.get(MetricsService);
    await waitFor(async () => {
      const text = await metrics.render();
      return (
        text.includes(
          `aisits_events_invalid_total{stream="FUEL",consumer="${CONSUMERS.invalid.durableName}",reason="invalid_payload"} 1`,
        ) &&
        text.includes(
          `aisits_events_invalid_total{stream="FUEL",consumer="${CONSUMERS.invalid.durableName}",reason="invalid_json"} 1`,
        )
      );
    });
    expect(received.get('invalid')).toBeUndefined();
    const text = await metrics.render();
    expect(text).toContain(
      `aisits_events_consumed_total{stream="FUEL",consumer="${CONSUMERS.ok.durableName}",outcome="ack"}`,
    );
    expect(text).toContain(
      'aisits_events_published_total{type="fuel.reading.recorded.v1",outcome="stored"}',
    );
    expect(text).toContain('aisits_event_handler_duration_seconds_bucket');
  });

  it('delivers the latest message per subject of a compacted stream to ordered consumers, then live changes', async () => {
    const first = makeTestZone({
      geometry: { type: 'Point', coordinates: [104, 1] },
      name: 'v1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const other = makeTestZone({
      geometry: { type: 'Point', coordinates: [105, 1] },
      name: 'other',
    });
    const second: ZoneSnapshotV1 = {
      ...first,
      name: 'v2',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    for (const zone of [first, other, second])
      await publisher.publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, zone);

    const seen: string[] = [];
    const subscription = await app.get(OrderedConsumers).start({
      name: uniqueName('zones'),
      stream: 'GEO',
      filterSubjects: [subjects.geoZone(first.id), subjects.geoZone(other.id)],
      eventTypes: [EVENT_TYPES.GEO_ZONE_UPSERTED, EVENT_TYPES.GEO_ZONE_DELETED],
      deliver: 'last_per_subject',
      handler: (event) => {
        if (event.type === EVENT_TYPES.GEO_ZONE_UPSERTED)
          seen.push(event.data.name);
      },
    });
    await subscription.caughtUp(10_000);
    expect(seen.sort()).toEqual(['other', 'v2']);

    await publisher.publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, {
      ...second,
      name: 'v3',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    await waitFor(() => seen.includes('v3'));
    await subscription.stop();
  });

  it('caught-up resolves immediately for an empty selection', async () => {
    const subscription = await app.get(OrderedConsumers).start({
      name: uniqueName('empty'),
      stream: 'GEO',
      filterSubjects: [subjects.geoZone(newId())],
      eventTypes: [EVENT_TYPES.GEO_ZONE_UPSERTED],
      deliver: 'last_per_subject',
      handler: () => undefined,
    });
    const started = performance.now();
    await expect(subscription.caughtUp(1_000)).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(200);
    await subscription.stop();
  });

  it('replays a stream range with an ephemeral consumer', async () => {
    const mmsi = base + 9;
    const from = new Date();
    for (let minute = 0; minute < 3; minute += 1) {
      await publisher.publishEvent(
        EVENT_TYPES.FUEL_READING_RECORDED,
        reading(mmsi, minute),
      );
    }
    const replayed: number[] = [];
    const report = await app.get(StreamReplayer).replay({
      stream: 'FUEL',
      filterSubjects: [subjects.fuelReading(mmsi)],
      from,
      eventTypes: [EVENT_TYPES.FUEL_READING_RECORDED],
      handler: (event) => {
        if (event.type === EVENT_TYPES.FUEL_READING_RECORDED)
          replayed.push(new Date(event.data.time).getUTCMinutes());
      },
    });
    expect(report).toMatchObject({ handled: 3, invalid: 0, skipped: 0 });
    expect(replayed).toEqual([0, 1, 2]);
  });
});
