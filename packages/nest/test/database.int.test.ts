import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GeoJsonGeometry } from '@darmawanweb/ais-its-contracts/domain';
import { Controller, Get, Injectable, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, sql } from 'drizzle-orm';
import { doublePrecision, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
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
  pointGeography,
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
});
