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

    it('lets one relay at a time publish (advisory lock), keeping the order', async () => {
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
        expect(await relay.relayOnce()).toMatchObject({
          skipped: true,
          published: 0,
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
