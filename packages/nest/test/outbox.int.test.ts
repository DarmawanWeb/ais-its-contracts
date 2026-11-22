import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  EVENT_TYPES,
  type EventPayload,
  type EventType,
  type FuelReadingRecordedV1,
  parseEnvelope,
  subjects,
  type ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { Logger, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { makeTestZone } from '../src/analytics/index.js';
import {
  APP_CONFIG,
  baseConfigSchema,
  defineConfig,
} from '../src/config/index.js';
import { DatabaseModule, PG_POOL } from '../src/db/index.js';
import { MetricsService } from '../src/metrics/index.js';
import {
  enqueueEvent,
  EventPublisher,
  EventTooLargeError,
  NatsClient,
  NatsModule,
  OutboxConfigError,
  OutboxModule,
  type OutboxModuleOptions,
  OutboxRelay,
  outboxTableSql,
  outboxUpgradeSql,
  type PublishOptions,
} from '../src/nats/index.js';
import {
  buildTestApp,
  createTestConfig,
  provisionServiceSchema,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

const SCHEMA = uniqueName('outbox');
const base = 300_000_000 + Math.floor(Math.random() * 600_000_000);

/** The outbox DDL of kit 0.2 (no seq, no next_attempt_at). */
const legacyOutboxSql = (table: string): string => `
CREATE TABLE ${table} (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  entity_key text,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  published_at timestamptz,
  failed_at timestamptz
);
CREATE INDEX ${table}_pending_idx ON ${table} (created_at, id)
  WHERE published_at IS NULL AND failed_at IS NULL;`;

const reading = (mmsi: number, index: number): FuelReadingRecordedV1 => ({
  mmsi,
  time: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  periodStart: null,
  fuelMeTon: index,
  fuelAeTon: 0,
  deviceId: null,
  source: 'api',
});

/** A valid zone whose snapshot is larger than `minBytes` (about 40 bytes per vertex). */
function oversizedZone(id: string, minBytes: number): ZoneSnapshotV1 {
  const vertices = Math.ceil(minBytes / 30);
  const ring: [number, number][] = [];
  for (let index = 0; index < vertices; index += 1) {
    const angle = (2 * Math.PI * index) / vertices;
    ring.push([104 + 0.1 * Math.cos(angle), 1 + 0.1 * Math.sin(angle)]);
  }
  ring.push(ring[0] ?? [104.1, 1]);
  return makeTestZone({
    id,
    code: `big-${id.slice(-8)}`,
    kind: 'restricted',
    geometry: { type: 'Polygon', coordinates: [ring] },
  });
}

const zone = (id: string, name: string): ZoneSnapshotV1 =>
  makeTestZone({
    id,
    name,
    code: `z-${id.slice(-8)}`,
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

type PublishCall = (
  type: EventType,
  data: EventPayload<EventType>,
  options: PublishOptions,
) => Promise<unknown>;

/** An `EventPublisher` stand-in that delegates to `publish`. */
const publisherLike = (publish: PublishCall): EventPublisher =>
  ({ publishEvent: publish }) as unknown as EventPublisher;

describe('transactional outbox relay', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let publisher: EventPublisher;
  let migrations: string;
  let url: string;
  /** The test server's max_payload. */
  let serverMaxPayload: number;

  const relayFor = (
    publish: EventPublisher,
    options: OutboxModuleOptions,
    metrics: MetricsService = new MetricsService(),
  ): OutboxRelay =>
    new OutboxRelay(pool, publish, { autoStart: false, ...options }, metrics);

  async function pendingCount(table: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${table} WHERE published_at IS NULL AND failed_at IS NULL`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  beforeAll(async () => {
    url = await provisionServiceSchema(testInfra().postgresAdminUrl, SCHEMA);
    migrations = await mkdtemp(join(tmpdir(), 'kit-outbox-'));
    await writeFile(join(migrations, '0001_outbox.sql'), outboxTableSql());

    @Module({
      imports: [
        DatabaseModule.forRoot({ migrationsDir: migrations }),
        NatsModule.forRoot({ streams: ['FUEL', 'GEO'] }),
        OutboxModule.forRoot({ autoStart: false, batchSize: 20 }),
      ],
    })
    class AppModule {}

    app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'outbox-test',
        DATABASE_URL: url,
        DATABASE_SCHEMA: SCHEMA,
        DB_MIGRATE_ON_BOOT: 'true',
        NATS_URL: testInfra().natsUrl,
      }),
    });
    pool = app.get<Pool>(PG_POOL);
    publisher = app.get(EventPublisher);
    serverMaxPayload = app.get(NatsClient).maxPayloadBytes() ?? 1_048_576;
  });

  afterAll(async () => {
    await app.close();
    await rm(migrations, { recursive: true, force: true });
  });

  it('relays a new table per entity key', async () => {
    expect(await app.get(OutboxRelay).mode()).toBe('per-key');
  });

  it('publishes every row exactly once and in seq order per key with two relays and failing publishes', async () => {
    const table = 'outbox_pair';
    await pool.query(outboxTableSql(table));
    const keys = Array.from({ length: 6 }, (_, index) => base + index);
    const total = 60;
    for (let index = 0; index < total; index += 1) {
      const mmsi = keys[index % keys.length] ?? base;
      await enqueueEvent(
        pool,
        EVENT_TYPES.FUEL_READING_RECORDED,
        reading(mmsi, index),
        { table },
      );
    }
    const published = new Map<string, number>();
    const order = new Map<number, number[]>();
    const flaky = publisherLike(async (type, data, options) => {
      if (Math.random() < 0.3) throw new Error('flaky NATS');
      const result = await publisher.publishEvent(type, data, options);
      const id = options.id ?? '';
      published.set(id, (published.get(id) ?? 0) + 1);
      const fuel = data as FuelReadingRecordedV1;
      order.set(fuel.mmsi, [...(order.get(fuel.mmsi) ?? []), fuel.fuelMeTon]);
      return result;
    });
    const options = {
      table,
      batchSize: 7,
      publishConcurrency: 3,
      retry: { baseMs: 10, maxMs: 40 },
    };
    const relays = [relayFor(flaky, options), relayFor(flaky, options)];
    const deadline = Date.now() + 30_000;
    let deferred = 0;
    await Promise.all(
      relays.map(async (relay) => {
        while (Date.now() < deadline && (await pendingCount(table)) > 0) {
          const result = await relay.relayOnce();
          expect(result.mode).toBe('per-key');
          deferred += result.deferred;
          await sleep(Math.random() * 10);
        }
      }),
    );
    expect(await pendingCount(table)).toBe(0);
    expect(published.size).toBe(total);
    expect([...published.values()].every((count) => count === 1)).toBe(true);
    for (const mmsi of keys) {
      const indices = order.get(mmsi) ?? [];
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(indices).toHaveLength(total / keys.length);
    }
    // The stream holds each event once, in key order.
    const { jetstream } = await app.get(NatsClient).ready();
    const consumer = await jetstream.consumers.get('FUEL', {
      filter_subjects: keys.map((mmsi) => subjects.fuelReading(mmsi)),
    });
    const stored = new Map<number, number[]>();
    const messages = await consumer.fetch({
      max_messages: total,
      expires: 5000,
    });
    for await (const message of messages) {
      const envelope = parseEnvelope(message.data);
      if (!envelope.success) throw new Error('invalid stored envelope');
      const data = envelope.envelope.data as FuelReadingRecordedV1;
      stored.set(data.mmsi, [...(stored.get(data.mmsi) ?? []), data.fuelMeTon]);
      if (message.info.pending === 0) break;
    }
    expect(stored).toEqual(order);
    // Informational: passes leave keys whose head the other relay holds.
    expect(deferred).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('retries a failing key only after its next_attempt_at while other keys keep flowing', async () => {
    const table = 'outbox_retry';
    await pool.query(outboxTableSql(table));
    const failing = base + 20;
    const healthy = base + 21;
    let fail = true;
    const attempts: number[] = [];
    const flaky = publisherLike(async (type, data, options) => {
      const fuel = data as FuelReadingRecordedV1;
      attempts.push(fuel.mmsi);
      if (fail && fuel.mmsi === failing)
        throw new Error('stream unavailable for nats://relay:secret@nats');
      return publisher.publishEvent(type, data, options);
    });
    const metrics = new MetricsService();
    const relay = relayFor(
      flaky,
      { table, retry: { baseMs: 1500, maxMs: 1500 } },
      metrics,
    );
    const head = await enqueueEvent(
      pool,
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(failing, 1),
      { table },
    );
    await enqueueEvent(
      pool,
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(healthy, 2),
      { table },
    );
    const second = await enqueueEvent(
      pool,
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(failing, 3),
      { table },
    );
    await enqueueEvent(
      pool,
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(healthy, 4),
      { table },
    );

    expect(await relay.relayOnce()).toMatchObject({
      published: 2,
      rejected: 0,
      failed: true,
      retrying: 1,
      mode: 'per-key',
    });
    const { rows } = await pool.query<{
      id: string;
      attempts: number;
      last_error: string | null;
      wait_ms: number | null;
    }>(
      `SELECT id, attempts, last_error,
              extract(epoch FROM next_attempt_at - now()) * 1000 AS wait_ms
         FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY seq`,
      [[head, second]],
    );
    expect(rows[0]).toMatchObject({
      id: head,
      attempts: 1,
      last_error: 'stream unavailable for nats://***@nats',
    });
    expect(Number(rows[0]?.wait_ms)).toBeGreaterThan(400);
    expect(Number(rows[0]?.wait_ms)).toBeLessThanOrEqual(1600);
    // The key's later row is not attempted.
    expect(rows[1]).toMatchObject({ id: second, attempts: 0, wait_ms: null });
    const rendered = await metrics.render();
    expect(rendered).toMatch(/aisits_outbox_retrying_rows 1/);
    expect(rendered).toMatch(/aisits_outbox_pending 2/);

    // Other keys flow; the failing key is not retried before its time.
    await enqueueEvent(
      pool,
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(healthy, 5),
      { table },
    );
    const before = attempts.filter((mmsi) => mmsi === failing).length;
    expect(await relay.relayOnce()).toMatchObject({
      published: 1,
      failed: false,
    });
    expect(attempts.filter((mmsi) => mmsi === failing).length).toBe(before);

    fail = false;
    await sleep(1600);
    expect(await relay.relayOnce()).toMatchObject({
      published: 2,
      retrying: 0,
    });
    expect(attempts.slice(-2)).toEqual([failing, failing]);
    expect(await metrics.render()).toMatch(/aisits_outbox_retrying_rows 0/);
  });

  it('parks invalid and oversized rows and publishes the later rows of their key', async () => {
    const relay = app.get(OutboxRelay);
    const zoneId = newId();
    // A row written by an older version whose payload no longer validates.
    const poison = newId();
    await pool.query(
      `INSERT INTO outbox (id, type, entity_key, data) VALUES ($1, 'geo.zone.upserted.v1', $2, '{"id": 1}')`,
      [poison, zoneId],
    );
    const big = await enqueueEvent(
      pool,
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      oversizedZone(zoneId, serverMaxPayload * 1.5),
    );
    const after = await enqueueEvent(
      pool,
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      zone(zoneId, 'after the parked rows'),
    );
    expect(await relay.relayOnce()).toMatchObject({
      published: 1,
      rejected: 2,
      failed: false,
    });
    const { rows } = await pool.query<{
      id: string;
      parked: boolean;
      published: boolean;
      last_error: string | null;
    }>(
      `SELECT id, failed_at IS NOT NULL AS parked, published_at IS NOT NULL AS published, last_error
         FROM outbox WHERE id = ANY($1::uuid[]) ORDER BY seq`,
      [[poison, big, after]],
    );
    expect(rows.map((row) => [row.parked, row.published])).toEqual([
      [true, false],
      [true, false],
      [false, true],
    ]);
    expect(rows[1]?.last_error).toMatch(/max_payload/);
    const stored = await app.get(NatsClient).manager.streams.getMessage('GEO', {
      last_by_subj: subjects.geoZone(zoneId),
    });
    const envelope = parseEnvelope(stored?.json());
    expect(envelope.success && envelope.envelope.id).toBe(after);

    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/aisits_outbox_failed_rows 2/);
    expect(metrics).toMatch(
      /aisits_outbox_relayed_total\{type="geo.zone.upserted.v1",outcome="rejected"\} 2/,
    );
  });

  it('refuses an event larger than maxBytes at enqueue time and writes nothing', async () => {
    const id = newId();
    const maxBytes = app.get(NatsClient).maxPayloadBytes();
    expect(maxBytes).toBeGreaterThan(0);
    const error = await enqueueEvent(
      pool,
      EVENT_TYPES.GEO_ZONE_UPSERTED,
      oversizedZone(newId(), serverMaxPayload * 1.5),
      { id, maxBytes },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EventTooLargeError);
    expect(error).toMatchObject({ maxBytes, type: 'geo.zone.upserted.v1' });
    expect((error as EventTooLargeError).sizeBytes).toBeGreaterThan(
      maxBytes ?? 0,
    );
    const { rows } = await pool.query('SELECT 1 FROM outbox WHERE id = $1', [
      id,
    ]);
    expect(rows).toHaveLength(0);
    // A small event passes the same check.
    await expect(
      enqueueEvent(
        pool,
        EVENT_TYPES.GEO_ZONE_UPSERTED,
        zone(newId(), 'small'),
        {
          maxBytes,
        },
      ),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
    await app.get(OutboxRelay).relayOnce();
  });

  it('relays a table created with the kit 0.2 DDL in serial mode, parking poison rows', async () => {
    const table = 'outbox_legacy';
    await pool.query(legacyOutboxSql(table));
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const order: number[] = [];
    const recording = publisherLike(async (type, data, options) => {
      const result = await publisher.publishEvent(type, data, options);
      order.push((data as FuelReadingRecordedV1).fuelMeTon);
      return result;
    });
    const relay = relayFor(recording, { table });
    try {
      expect(await relay.mode()).toBe('serial');
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes(`outboxUpgradeSql('${table}')`),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
    const mmsi = base + 30;
    const t0 = Date.UTC(2026, 0, 2);
    // Rows written by kit 0.2: ordered by created_at, then id.
    for (const [index, offset] of [
      [3, 3000],
      [1, 1000],
      [2, 2000],
    ] as const) {
      await pool.query(
        `INSERT INTO ${table} (id, type, entity_key, data, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [
          newId(),
          EVENT_TYPES.FUEL_READING_RECORDED,
          String(mmsi),
          JSON.stringify(reading(mmsi, index)),
          new Date(t0 + offset),
        ],
      );
    }
    await pool.query(
      `INSERT INTO ${table} (id, type, entity_key, data, created_at) VALUES ($1, 'fuel.reading.recorded.v1', $2, '{"mmsi": "x"}', $3)`,
      [newId(), String(mmsi), new Date(t0 + 1500)],
    );
    expect(await relay.relayOnce()).toMatchObject({
      mode: 'serial',
      published: 3,
      rejected: 1,
      failed: false,
    });
    expect(order).toEqual([1, 2, 3]);
    // An explicit per-key mode refuses a table without the columns.
    await expect(
      relayFor(recording, { table, mode: 'per-key' }).mode(),
    ).rejects.toBeInstanceOf(OutboxConfigError);
  });

  it('upgrades a kit 0.2 table with pending rows in (created_at, id) order and relays it per key', async () => {
    const table = 'outbox_upgrade';
    await pool.query(legacyOutboxSql(table));
    const mmsi = base + 40;
    const t0 = Date.UTC(2026, 0, 3);
    const ids: string[] = [];
    // Physical order 3, 1, 2; one row already published.
    for (const [index, offset, publishedAt] of [
      [3, 3000, null],
      [0, 0, new Date(t0)],
      [1, 1000, null],
      [2, 2000, null],
    ] as const) {
      const id = newId();
      ids[index] = id;
      await pool.query(
        `INSERT INTO ${table} (id, type, entity_key, data, created_at, published_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          id,
          EVENT_TYPES.FUEL_READING_RECORDED,
          String(mmsi),
          JSON.stringify(reading(mmsi, index)),
          new Date(t0 + offset),
          publishedAt,
        ],
      );
    }
    await pool.query(outboxUpgradeSql(table));
    // Idempotent, also on a table created by the current DDL.
    await pool.query(outboxUpgradeSql(table));
    await pool.query(outboxUpgradeSql('outbox'));
    const { rows } = await pool.query<{ id: string; seq: string }>(
      `SELECT id, seq::text AS seq FROM ${table} ORDER BY seq`,
    );
    expect(rows.map((row) => row.id)).toEqual(ids);
    expect(rows.map((row) => row.seq)).toEqual(['1', '2', '3', '4']);
    const fresh = await enqueueEvent(
      pool,
      EVENT_TYPES.FUEL_READING_RECORDED,
      reading(mmsi, 4),
      { table },
    );
    const added = await pool.query<{ seq: string }>(
      `SELECT seq::text AS seq FROM ${table} WHERE id = $1`,
      [fresh],
    );
    expect(added.rows[0]?.seq).toBe('5');

    const order: number[] = [];
    const recording = publisherLike(async (type, data, options) => {
      const result = await publisher.publishEvent(type, data, options);
      order.push((data as FuelReadingRecordedV1).fuelMeTon);
      return result;
    });
    const relay = relayFor(recording, { table });
    expect(await relay.mode()).toBe('per-key');
    expect(await relay.relayOnce()).toMatchObject({
      mode: 'per-key',
      published: 4,
    });
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('builds its options with forRootAsync from the validated configuration', async () => {
    const table = 'outbox_async';
    await pool.query(outboxTableSql(table));
    const schema = defineConfig({
      OUTBOX_TABLE: z.string(),
      OUTBOX_BATCH_SIZE: z.coerce.number().int().positive(),
    });
    type Config = z.infer<typeof schema>;

    @Module({
      imports: [
        DatabaseModule.forRoot({ migrationsDir: migrations }),
        NatsModule.forRoot({ streams: ['FUEL'] }),
        OutboxModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (config: Config) => ({
            table: config.OUTBOX_TABLE,
            batchSize: config.OUTBOX_BATCH_SIZE,
            autoStart: false,
          }),
        }),
      ],
    })
    class AsyncModule {}

    const asyncApp = await buildTestApp(AsyncModule, {
      config: createTestConfig(schema, {
        SERVICE_NAME: 'outbox-async-test',
        DATABASE_URL: url,
        DATABASE_SCHEMA: SCHEMA,
        NATS_URL: testInfra().natsUrl,
        OUTBOX_TABLE: table,
        OUTBOX_BATCH_SIZE: '2',
      }),
    });
    try {
      for (let index = 0; index < 3; index += 1)
        await enqueueEvent(
          pool,
          EVENT_TYPES.FUEL_READING_RECORDED,
          reading(base + 50, index),
          { table },
        );
      const relay = asyncApp.get(OutboxRelay);
      expect(await relay.relayOnce()).toMatchObject({ published: 2 });
      expect(await pendingCount(table)).toBe(1);
    } finally {
      await asyncApp.close();
    }
  });

  it('refuses invalid options', () => {
    expect(() => relayFor(publisher, { batchSize: 0 })).toThrow(
      OutboxConfigError,
    );
    expect(() =>
      relayFor(publisher, { mode: 'parallel' as unknown as 'serial' }),
    ).toThrow(/mode must be/);
  });
});
