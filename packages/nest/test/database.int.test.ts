import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GeoJsonGeometry } from '@darmawanweb/ais-its-contracts/domain';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  doublePrecision,
  integer,
  pgSchema,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Public } from '../src/auth/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import {
  bboxEnvelope,
  type Database,
  DatabaseModule,
  distanceM,
  geoJsonToGeography,
  geography,
  geographyAsGeoJson,
  geographyIntersectsBBox,
  InjectDb,
  InjectPool,
  isUniqueViolation,
  pointGeography,
  refreshContinuousAggregate,
  rowDate,
  rowDateOrNull,
  sqlStateOf,
  withinM,
  withTransaction,
} from '../src/db/index.js';
import {
  buildTestApp,
  createTestConfig,
  provisionServiceSchema,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

const SCHEMA = uniqueName('geo');
const service = pgSchema(SCHEMA);
const ports = service.table('ports', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  geom: geography('geom', { subtype: 'Point' }).notNull(),
  radiusM: doublePrecision('radius_m').notNull(),
});
const zones = service.table('zones', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  geom: geography('geom', { subtype: 'Geometry' }).notNull(),
});
const counters = service.table('counters', {
  id: text('id').primaryKey(),
  value: integer('value').notNull(),
});
const codes = service.table('codes', { code: text('code').notNull() });
const schema = { ports, zones };

const MIGRATION = `CREATE TABLE ports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  geom geography(Point,4326) NOT NULL,
  radius_m double precision NOT NULL
);
CREATE INDEX ports_geom_idx ON ports USING gist (geom);
CREATE TABLE zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  geom geography(Geometry,4326) NOT NULL
);
`;

@Injectable()
class PortRepository {
  constructor(
    @InjectDb() readonly db: Database<typeof schema>,
    @InjectPool() readonly pool: Pool,
  ) {}
}

@Controller('session')
class SessionController {
  constructor(@InjectPool() private readonly pool: Pool) {}

  @Public()
  @Get()
  async settings(): Promise<Record<string, string>> {
    const { rows } = await this.pool.query<{
      search_path: string;
      statement_timeout: string;
      role: string;
    }>(
      "SELECT current_setting('search_path') AS search_path, current_setting('statement_timeout') AS statement_timeout, current_user AS role",
    );
    return rows[0] ?? {};
  }
}

describe('DatabaseModule', () => {
  let app: NestFastifyApplication;
  let repository: PortRepository;
  let migrations: string;

  beforeAll(async () => {
    const url = await provisionServiceSchema(
      testInfra().postgresAdminUrl,
      SCHEMA,
    );
    migrations = await mkdtemp(join(tmpdir(), 'aisits-db-'));
    await writeFile(join(migrations, '0001_init.sql'), MIGRATION);

    @Module({
      imports: [DatabaseModule.forRoot({ schema, migrationsDir: migrations })],
      controllers: [SessionController],
      providers: [PortRepository],
    })
    class AppModule {}

    app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        DATABASE_URL: url,
        DATABASE_SCHEMA: SCHEMA,
        DATABASE_STATEMENT_TIMEOUT_MS: '4000',
        DB_MIGRATE_ON_BOOT: 'true',
      }),
    });
    repository = app.get(PortRepository);
  });

  afterAll(async () => {
    await app.close();
    await rm(migrations, { recursive: true, force: true });
  });

  it('migrates on boot, before the application is ready', async () => {
    const { rows } = await repository.pool.query<{ version: number }>(
      `SELECT version FROM "${SCHEMA}".schema_migrations`,
    );
    expect(rows).toEqual([{ version: 1 }]);
  });

  it('connects as the service role with search_path and statement timeout', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/session',
    });
    expect(response.json()).toEqual({
      search_path: `${SCHEMA},public`,
      statement_timeout: '4s',
      role: `${SCHEMA}_svc`,
    });
  });

  it('reports the database in /health/ready', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      details: { database: { status: 'up' } },
    });
  });

  it('round-trips PostGIS values through the drizzle helpers', async () => {
    const { db } = repository;
    await db.insert(ports).values([
      {
        name: 'Tanjung Priok',
        geom: pointGeography(106.8833, -6.1043),
        radiusM: 3000,
      },
      { name: 'Batu Ampar', geom: pointGeography(104.0, 1.16), radiusM: 2000 },
    ]);
    const rows = await db
      .select({ name: ports.name, location: geographyAsGeoJson(ports.geom) })
      .from(ports)
      .where(geographyIntersectsBBox(ports.geom, [106, -7, 107.5, -5.5]));
    expect(rows).toEqual([
      {
        name: 'Tanjung Priok',
        location: { type: 'Point', coordinates: [106.8833, -6.1043] },
      },
    ]);

    const [distance] = await db
      .select({
        meters: distanceM(ports.geom, pointGeography(106.8833, -6.0943)),
      })
      .from(ports)
      .where(eq(ports.name, 'Tanjung Priok'));
    // 0.01° of latitude ≈ 1.1 km.
    expect(distance?.meters).toBeGreaterThan(1050);
    expect(distance?.meters).toBeLessThan(1150);

    const near = await db
      .select({ name: ports.name })
      .from(ports)
      .where(withinM(ports.geom, pointGeography(104.001, 1.161), 500));
    expect(near).toEqual([{ name: 'Batu Ampar' }]);
  });

  it('stores GeoJSON geometries and builds bbox envelopes', async () => {
    const { db } = repository;
    const polygon: GeoJsonGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [104, 1],
          [104.2, 1],
          [104.2, 1.2],
          [104, 1.2],
          [104, 1],
        ],
      ],
    };
    await db
      .insert(zones)
      .values({ name: 'Batam area', geom: geoJsonToGeography(polygon) });
    const [zone] = await db
      .select({ geometry: geographyAsGeoJson(zones.geom, 6) })
      .from(zones);
    expect(zone?.geometry).toEqual(polygon);
    const [envelope] = await db
      .execute<{ area: number }>(
        sql`SELECT ST_Area(${bboxEnvelope([0, 0, 1, 1])}) AS area`,
      )
      .then((result) => result.rows);
    expect(envelope?.area).toBe(1);
  });

  it('commits, rolls back and retries transactions', async () => {
    const { pool } = repository;
    await withTransaction(pool, async (client) => {
      await client.query(
        "INSERT INTO zones (name, geom) VALUES ('committed', ST_GeogFromText('POINT(1 1)'))",
      );
    });
    await expect(
      withTransaction(pool, async (client) => {
        await client.query(
          "INSERT INTO zones (name, geom) VALUES ('rolled back', ST_GeogFromText('POINT(1 1)'))",
        );
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const names = (
      await pool.query<{ name: string }>(
        "SELECT name FROM zones WHERE name IN ('committed', 'rolled back')",
      )
    ).rows;
    expect(names).toEqual([{ name: 'committed' }]);

    let attempts = 0;
    const result = await withTransaction(
      pool,
      () => {
        attempts += 1;
        if (attempts < 3)
          return Promise.reject(
            Object.assign(new Error('could not serialize access'), {
              code: '40001',
            }),
          );
        return Promise.resolve('done');
      },
      { isolationLevel: 'serializable', retries: 3 },
    );
    expect({ result, attempts }).toEqual({ result: 'done', attempts: 3 });

    const readOnly = await withTransaction(
      pool,
      async (client) => {
        return (
          await client.query<{ ro: string }>(
            "SELECT current_setting('transaction_read_only') AS ro",
          )
        ).rows[0]?.ro;
      },
      { readOnly: true },
    );
    expect(readOnly).toBe('on');
  });

  it('retries a real deadlock between two drizzle transactions (CORE-2)', async () => {
    const { pool } = repository;
    await pool.query(
      'CREATE TABLE counters (id text PRIMARY KEY, value integer NOT NULL)',
    );
    await pool.query("INSERT INTO counters VALUES ('a', 0), ('b', 0)");
    // Both first attempts take their first row lock, then wait for each other.
    let arrived = 0;
    let releaseBarrier = (): void => undefined;
    const bothLocked = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const attempts = { ab: 0, ba: 0 };
    const errors: unknown[] = [];
    const transfer = (key: 'ab' | 'ba', first: string, second: string) =>
      withTransaction(
        pool,
        async (client) => {
          attempts[key] += 1;
          const db = drizzle({ client });
          const bump = (id: string) =>
            db
              .update(counters)
              .set({ value: sql`${counters.value} + 1` })
              .where(eq(counters.id, id));
          try {
            await bump(first);
            if (attempts[key] === 1) {
              arrived += 1;
              if (arrived === 2) releaseBarrier();
              await bothLocked;
            }
            await bump(second);
          } catch (error) {
            errors.push(error);
            throw error;
          }
        },
        { retries: 2, retryDelayMs: 20 },
      );
    await Promise.all([transfer('ab', 'a', 'b'), transfer('ba', 'b', 'a')]);
    // The deadlock victim was a DrizzleQueryError wrapping 40P01, and was re-run.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(DrizzleQueryError);
    expect(sqlStateOf(errors[0])).toBe('40P01');
    expect(attempts.ab + attempts.ba).toBe(3);
    const { rows } = await pool.query<{ id: string; value: number }>(
      'SELECT id, value FROM counters ORDER BY id',
    );
    expect(rows).toEqual([
      { id: 'a', value: 2 },
      { id: 'b', value: 2 },
    ]);
  });

  it('recognizes unique violations of drizzle inserts by constraint name', async () => {
    const { pool, db } = repository;
    await pool.query(
      'CREATE TABLE codes (code text NOT NULL CONSTRAINT codes_code_key UNIQUE)',
    );
    await db.insert(codes).values({ code: 'IDJKT' });
    const error = await db
      .insert(codes)
      .values({ code: 'IDJKT' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DrizzleQueryError);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, 'codes_code_key')).toBe(true);
    expect(isUniqueViolation(error, 'other_key')).toBe(false);
  });

  it('converts the timestamp strings of raw drizzle rows (CORE-17)', async () => {
    const { db, pool } = repository;
    const result = await db.execute<{ t: Date | string; none: null }>(
      sql`SELECT now() AS t, NULL::timestamptz AS none`,
    );
    const row = result.rows[0];
    // drizzle overrides pg's parsers: the "Date" is the text PostgreSQL sent.
    expect(typeof row?.t).toBe('string');
    const parsed = rowDate(row?.t ?? '');
    const viaPg = (
      await pool.query<{ t: Date }>('SELECT $1::timestamptz AS t', [row?.t])
    ).rows[0]?.t;
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed.getTime()).toBe(viaPg?.getTime());
    expect(Math.abs(parsed.getTime() - Date.now())).toBeLessThan(60_000);
    expect(rowDateOrNull(row?.none)).toBeNull();
  });

  it('retries concurrent continuous aggregate refreshes (CORE-18)', async () => {
    const { pool } = repository;
    await pool.query(
      'CREATE TABLE readings (time timestamptz NOT NULL, value double precision NOT NULL)',
    );
    await pool.query(
      "SELECT create_hypertable('readings', by_range('time', INTERVAL '1 day'))",
    );
    await pool.query(
      "INSERT INTO readings SELECT t, random() FROM generate_series(now() - interval '20 days', now(), interval '10 seconds') AS t",
    );
    await pool.query(
      "CREATE MATERIALIZED VIEW readings_hourly WITH (timescaledb.continuous) AS SELECT time_bucket('1 hour', time) AS bucket, avg(value) AS value FROM readings GROUP BY bucket WITH NO DATA",
    );
    const from = new Date(Date.now() - 21 * 86_400_000);
    const to = new Date();
    const retries: number[] = [];
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        refreshContinuousAggregate(pool, 'readings_hourly', from, to, {
          onRetry: (error, retry) => {
            expect(sqlStateOf(error)).toBe('55P03');
            retries.push(retry);
          },
        }),
      ),
    );
    expect(results.every((result) => result.attempts >= 1)).toBe(true);
    // TimescaleDB rejects overlapping refreshes at once: some were retried.
    expect(retries.length).toBeGreaterThan(0);
    const { rows } = await pool.query<{ buckets: string }>(
      'SELECT count(*) AS buckets FROM readings_hourly',
    );
    expect(Number(rows[0]?.buckets)).toBeGreaterThan(400);

    await expect(
      refreshContinuousAggregate(pool, 'no_such_aggregate', from, to),
    ).rejects.toMatchObject({ code: '42P01' });
    await expect(
      refreshContinuousAggregate(pool, 'readings', from, to),
    ).rejects.toSatisfy((error: unknown) => sqlStateOf(error) !== '55P03');
  });
});
