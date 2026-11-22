import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EVENT_TYPES,
  parseEnvelope,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { Injectable, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeTestZone } from '../src/analytics/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import {
  DatabaseModule,
  PG_POOL,
  processedEventsTableSql,
  pruneProcessedEvents,
  withIdempotency,
  withTransaction,
} from '../src/db/index.js';
import { MetricsService } from '../src/metrics/index.js';
import {
  CoreSubscriptionHandler,
  CoreSubscriptions,
  enqueueEvent,
  type Msg,
  NatsClient,
  NatsModule,
  OutboxModule,
  OutboxRelay,
  outboxTableSql,
} from '../src/nats/index.js';
import {
  buildTestApp,
  createTestConfig,
  provisionServiceSchema,
  waitFor,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

const SCHEMA = uniqueName('transport');
const DEVICE_SUBJECT_PREFIX = 'aisits.telemetry.';

/** Records core messages; throws for the device named `broken`. */
@Injectable()
class DeviceMessages {
  readonly received: { subject: string; body: unknown }[] = [];

  @CoreSubscriptionHandler({ subscription: 'telemetry-mqtt', concurrency: 2 })
  onMessage(message: Msg): void {
    if (message.subject.endsWith('.broken'))
      throw new Error('cannot parse device payload');
    this.received.push({ subject: message.subject, body: message.json() });
  }
}

describe('transport patterns: inbox, outbox and core subscriptions', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let migrations: string;

  beforeAll(async () => {
    const url = await provisionServiceSchema(
      testInfra().postgresAdminUrl,
      SCHEMA,
    );
    migrations = await mkdtemp(join(tmpdir(), 'aisits-transport-'));
    await writeFile(
      join(migrations, '0001_transport.sql'),
      `${outboxTableSql()}\n${processedEventsTableSql()}`,
    );

    @Module({
      imports: [
        DatabaseModule.forRoot({ migrationsDir: migrations }),
        NatsModule.forRoot({ streams: ['GEO'] }),
        OutboxModule.forRoot({ autoStart: false, batchSize: 10 }),
      ],
      providers: [DeviceMessages],
    })
    class AppModule {}

    app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'geo',
        DATABASE_URL: url,
        DATABASE_SCHEMA: SCHEMA,
        DB_MIGRATE_ON_BOOT: 'true',
        NATS_URL: testInfra().natsUrl,
      }),
    });
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
    await rm(migrations, { recursive: true, force: true });
  });

  describe('withIdempotency', () => {
    it('runs a handler once per (consumer, event id), records nothing when it fails, and prunes', async () => {
      const eventId = '0192f2a0-0000-7000-8000-00000000a001';
      const key = { consumer: 'geo-test', eventId };
      const runs: number[] = [];
      const first = await withIdempotency(pool, key, () => {
        runs.push(1);
        return Promise.resolve('stored');
      });
      expect(first).toEqual({ duplicate: false, value: 'stored' });
      expect(
        await withIdempotency(pool, key, () => {
          runs.push(2);
          return Promise.resolve('again');
        }),
      ).toEqual({ duplicate: true });
      expect(runs).toEqual([1]);

      const failing = {
        consumer: 'geo-test',
        eventId: '0192f2a0-0000-7000-8000-00000000a002',
      };
      await expect(
        withIdempotency(pool, failing, () =>
          Promise.reject(new Error('db busy')),
        ),
      ).rejects.toThrow('db busy');
      // The failure was rolled back with the inbox row: the redelivery runs.
      expect(
        await withIdempotency(pool, failing, () => Promise.resolve('retried')),
      ).toEqual({ duplicate: false, value: 'retried' });

      // Concurrent deliveries of one event: exactly one runs.
      const concurrent = {
        consumer: 'geo-test',
        eventId: '0192f2a0-0000-7000-8000-00000000a003',
      };
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          withIdempotency(pool, concurrent, async (client) => {
            await client.query('SELECT pg_sleep(0.05)');
            return 'ran';
          }),
        ),
      );
      expect(results.filter((result) => !result.duplicate)).toHaveLength(1);

      expect(
        await pruneProcessedEvents(pool, new Date(Date.now() + 60_000)),
      ).toBe(3);
    });
  });

  describe('outbox', () => {
    const zone = (code: string): ZoneSnapshotV1 =>
      makeTestZone({
        code,
        kind: 'restricted',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [104, 1],
              [104.1, 1],
              [104.1, 1.1],
              [104, 1],
            ],
          ],
        },
      });

    it('publishes committed rows in order with the row id as envelope id, never rolled-back ones', async () => {
      const relay = app.get(OutboxRelay);
      const z1 = zone(uniqueName('z1'));
      const ids = await withTransaction(pool, async (client) => [
        await enqueueEvent(client, EVENT_TYPES.GEO_ZONE_UPSERTED, z1),
        await enqueueEvent(client, EVENT_TYPES.GEO_ZONE_UPSERTED, {
          ...z1,
          name: 'renamed',
        }),
      ]);
      await expect(
        withTransaction(pool, async (client) => {
          await enqueueEvent(
            client,
            EVENT_TYPES.GEO_ZONE_UPSERTED,
            zone('rolled-back'),
          );
          throw new Error('business rule failed');
        }),
      ).rejects.toThrow('business rule failed');

      const result = await relay.relayOnce();
      expect(result).toMatchObject({
        published: 2,
        rejected: 0,
        skipped: false,
        failed: false,
      });
      expect((await relay.relayOnce()).published).toBe(0);

      // GEO keeps the latest message per zone: the second (renamed) snapshot.
      const { jetstream } = await app.get(NatsClient).ready();
      const stored = await jetstream.jetstreamManager().then((manager) =>
        manager.streams.getMessage('GEO', {
          last_by_subj: `geo.zone.v1.${z1.id}`,
        }),
      );
      const envelope = parseEnvelope(stored?.json());
      expect(envelope.success && envelope.envelope.id).toBe(ids[1]);
      expect(envelope.success && envelope.envelope.data).toMatchObject({
        name: 'renamed',
      });
      const metrics = await app.get(MetricsService).render();
      expect(metrics).toMatch(
        /aisits_outbox_relayed_total\{type="geo.zone.upserted.v1",outcome="published"\} 2/,
      );
      expect(metrics).toMatch(/aisits_outbox_pending 0/);
    });

    it('refuses invalid payloads at enqueue time and marks rows that can no longer be published', async () => {
      const relay = app.get(OutboxRelay);
      await expect(
        enqueueEvent(pool, EVENT_TYPES.GEO_ZONE_UPSERTED, {
          ...zone('bad'),
          bufferM: -1,
        }),
      ).rejects.toThrow(/Invalid geo.zone.upserted.v1/);
      // A row written by an older version whose payload no longer validates.
      await pool.query(
        `INSERT INTO outbox (id, type, data) VALUES ('0192f2a0-0000-7000-8000-00000000b001', 'geo.zone.upserted.v1', '{"id": 1}')`,
      );
      const good = await enqueueEvent(
        pool,
        EVENT_TYPES.GEO_ZONE_UPSERTED,
        zone(uniqueName('ok')),
      );
      const result = await relay.relayOnce();
      expect(result).toMatchObject({
        published: 1,
        rejected: 1,
        failed: false,
      });
      const { rows } = await pool.query<{
        id: string;
        failed: boolean;
        published: boolean;
      }>(
        `SELECT id, failed_at IS NOT NULL AS failed, published_at IS NOT NULL AS published FROM outbox WHERE id IN ('0192f2a0-0000-7000-8000-00000000b001', $1) ORDER BY id`,
        [good],
      );
      expect(rows.map((row) => [row.failed, row.published])).toEqual([
        [true, false],
        [false, true],
      ]);
    });

    it('yields to a kit 0.2 serial relay holding the advisory lock (rolling upgrade)', async () => {
      const relay = app.get(OutboxRelay);
      await enqueueEvent(
        pool,
        EVENT_TYPES.GEO_ZONE_UPSERTED,
        zone(uniqueName('lock')),
      );
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT pg_advisory_xact_lock(('x' || substr(encode(sha256('aisits:outbox:outbox'::bytea), 'hex'), 1, 16))::bit(64)::bigint)`,
        );
        // Per-key relays share the lock among themselves only.
        expect(await relay.relayOnce()).toMatchObject({
          skipped: true,
          published: 0,
          mode: 'per-key',
        });
        await holder.query('ROLLBACK');
      } finally {
        holder.release();
      }
      expect((await relay.relayOnce()).published).toBe(1);
    });
  });

  describe('@CoreSubscriptionHandler', () => {
    it('subscribes in the service queue group, isolates failing messages and counts them', async () => {
      expect(app.get(CoreSubscriptions).running).toEqual(['telemetry-mqtt']);
      const { connection } = await app.get(NatsClient).ready();
      const device = uniqueName('dev');
      connection.publish(
        `${DEVICE_SUBJECT_PREFIX}broken`,
        JSON.stringify({ x: 1 }),
      );
      for (let i = 0; i < 5; i += 1)
        connection.publish(
          `${DEVICE_SUBJECT_PREFIX}${device}`,
          JSON.stringify({ i }),
        );
      await connection.flush();
      const handler = app.get(DeviceMessages);
      await waitFor(() => handler.received.length === 5, { timeoutMs: 5_000 });
      expect(handler.received.map((m) => m.body)).toEqual(
        [0, 1, 2, 3, 4].map((i) => ({ i })),
      );
      const metrics = await app.get(MetricsService).render();
      expect(metrics).toMatch(
        /aisits_core_messages_total\{subscription="telemetry-mqtt",outcome="handled"\} 5/,
      );
      expect(metrics).toMatch(
        /aisits_core_messages_total\{subscription="telemetry-mqtt",outcome="failed"\} 1/,
      );
    });
  });
});

/** A valid `RealtimeAlertFanout` (contracts `./realtime`). */
const alertPush = {
  event: 'alert:updated',
  rooms: ['authority'],
  alert: {
    id: '01a1f8c2-54d8-71c4-95cf-ab5eb8908e01',
    type: 'ews',
    domain: 'safety',
    severity: 'critical',
    status: 'open',
    mmsi: 525_005_223,
    relatedMmsi: null,
    title: 'At anchor within 500 m of the pipeline',
    message: 'KM Sinar Batam is predicted at anchor 312 m from the pipeline.',
    lat: -6.8629,
    lon: 112.7166,
    zoneId: null,
    methodId: 'ews.status',
    occurredAt: '2026-11-20T08:31:00.000Z',
    lastOccurredAt: '2026-11-20T08:41:00.000Z',
    occurrences: 3,
    data: { ewsStatus: 0 },
  },
};

/** One notification replica: realtime pushes (fan-out) and device messages (queue). */
@Injectable()
class NotificationReplica {
  readonly pushes: unknown[] = [];
  readonly devices: string[] = [];

  @CoreSubscriptionHandler({ subscription: 'notification-realtime-fanout' })
  onPush(_message: Msg, payload?: unknown): void {
    this.pushes.push(payload);
  }

  @CoreSubscriptionHandler({ subscription: 'telemetry-mqtt' })
  onDevice(message: Msg): void {
    this.devices.push(message.subject);
  }
}

describe('core subscription delivery modes (fan-out and queue)', () => {
  const replicas: NestFastifyApplication[] = [];

  beforeAll(async () => {
    for (let index = 0; index < 2; index += 1) {
      @Module({
        imports: [NatsModule.forRoot({})],
        providers: [NotificationReplica],
      })
      class ReplicaModule {}
      replicas.push(
        await buildTestApp(ReplicaModule, {
          config: createTestConfig(baseConfigSchema, {
            SERVICE_NAME: 'notification',
            NATS_URL: testInfra().natsUrl,
          }),
        }),
      );
    }
  });

  afterAll(async () => {
    await Promise.all(replicas.map((replica) => replica.close()));
  });

  it('delivers every message of a fan-out subscription to every instance and validates it', async () => {
    const [first] = replicas;
    if (first === undefined) throw new Error('no replica');
    const { connection } = await first.get(NatsClient).ready();
    const subject = 'aisits.notification.realtime.v1';
    const raised = { ...alertPush, event: 'alert:raised' };
    connection.publish(subject, JSON.stringify(alertPush));
    connection.publish(subject, 'not json');
    connection.publish(subject, JSON.stringify({ ...alertPush, rooms: [] }));
    connection.publish(subject, JSON.stringify(raised));
    await connection.flush();
    await waitFor(
      () =>
        replicas.every(
          (replica) => replica.get(NotificationReplica).pushes.length === 2,
        ),
      { timeoutMs: 5_000 },
    );
    for (const replica of replicas) {
      expect(replica.get(NotificationReplica).pushes).toEqual([
        alertPush,
        raised,
      ]);
      const metrics = await replica.get(MetricsService).render();
      expect(metrics).toMatch(
        /aisits_core_messages_total\{subscription="notification-realtime-fanout",outcome="invalid"\} 2/,
      );
      expect(metrics).toMatch(
        /aisits_core_messages_total\{subscription="notification-realtime-fanout",outcome="handled"\} 2/,
      );
    }
  });

  it('still delivers each message of a queue subscription to one instance', async () => {
    const [first] = replicas;
    if (first === undefined) throw new Error('no replica');
    const { connection } = await first.get(NatsClient).ready();
    const subject = `${DEVICE_SUBJECT_PREFIX}${uniqueName('queued')}`;
    for (let index = 0; index < 6; index += 1)
      connection.publish(subject, JSON.stringify({ index }));
    await connection.flush();
    const total = (): number =>
      replicas.reduce(
        (sum, replica) => sum + replica.get(NotificationReplica).devices.length,
        0,
      );
    await waitFor(() => total() === 6, { timeoutMs: 5_000 });
    await sleep(300); // a second copy would show up here
    expect(total()).toBe(6);
  });
});
