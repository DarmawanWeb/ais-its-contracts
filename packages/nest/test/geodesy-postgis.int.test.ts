import type {
  GeoJsonGeometry,
  GeoPoint,
} from '@darmawanweb/ais-its-contracts/domain';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CompiledGeometry,
  geodesicDistanceM,
  makeTestZone,
  ZoneIndex,
} from '../src/analytics/index.js';
import { geographyIntersectsBBox, pointGeography } from '../src/db/index.js';
import { testInfra } from './support/infra.js';

/** Sample geometries: a pipeline-like line, a large polygon with long edges, a point. */
const GEOMETRIES: Readonly<Record<string, GeoJsonGeometry>> = {
  pipeline: {
    type: 'LineString',
    coordinates: [
      [103.95, 1.1],
      [104.02, 1.13],
      [104.1, 1.12],
      [104.18, 1.16],
      [104.3, 1.15],
    ],
  },
  // Edges of ~110 km at mid latitudes, where great circles bulge noticeably.
  bigPolygon: {
    type: 'Polygon',
    coordinates: [
      [
        [10, 45],
        [11.5, 45],
        [11.5, 46],
        [10, 46],
        [10, 45],
      ],
    ],
  },
  point: { type: 'Point', coordinates: [104.05, 1.2] },
};

const PROBES: readonly GeoPoint[] = [
  { lat: 1.105, lon: 103.97 },
  { lat: 1.2, lon: 104.06 },
  { lat: 1.0, lon: 104.15 },
  { lat: 1.16, lon: 104.35 },
  { lat: 0.5, lon: 103.0 },
  { lat: 46.02, lon: 10.75 },
  { lat: 44.9, lon: 12.0 },
  { lat: 45.5, lon: 10.75 },
];

describe('geodesic distances vs PostGIS ST_Distance(geography)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: testInfra().postgresAdminUrl });
    await client.connect();
    await client.query(
      'CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public',
    );
  });

  afterAll(async () => {
    await client.end();
  });

  async function postgis(
    geometry: GeoJsonGeometry,
    probe: GeoPoint,
    spheroid: boolean,
  ): Promise<number> {
    const { rows } = await client.query<{ d: number }>(
      `SELECT ST_Distance(
         ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
         ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)::geography,
         $4) AS d`,
      [probe.lon, probe.lat, JSON.stringify(geometry), spheroid],
    );
    const distance = rows[0]?.d;
    if (distance === undefined) throw new Error('no distance');
    return distance;
  }

  it('matches on the WGS 84 spheroid (default model) within 1 cm', async () => {
    let maxError = 0;
    for (const geometry of Object.values(GEOMETRIES)) {
      const compiled = new CompiledGeometry(geometry);
      for (const probe of PROBES) {
        const expected = await postgis(geometry, probe, true);
        const actual = compiled.distance(probe, 'wgs84').distanceM;
        maxError = Math.max(maxError, Math.abs(actual - expected));
        expect(Math.abs(actual - expected)).toBeLessThan(
          0.01 + expected * 1e-9,
        );
      }
    }
    expect(maxError).toBeLessThan(0.01);
  });

  it('matches on the sphere (use_spheroid = false) in the sphere model', async () => {
    for (const geometry of Object.values(GEOMETRIES)) {
      const compiled = new CompiledGeometry(geometry);
      for (const probe of PROBES) {
        const expected = await postgis(geometry, probe, false);
        const actual = compiled.distance(probe, 'sphere').distanceM;
        // PostGIS uses R = 6 371 008.771 m, Turf (and the sphere model) 6 371 008.8 m.
        expect(Math.abs(actual - expected)).toBeLessThan(
          0.01 + expected * 1e-8,
        );
      }
    }
  });

  it('agrees with ST_Covers(geography) on containment near long polygon edges', async () => {
    // 1 100 km edges along parallels: the geodesic edge bows ~10 km north.
    const wide: GeoJsonGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [100, 5],
          [110, 5],
          [110, 0],
          [100, 0],
          [100, 5],
        ],
      ],
    };
    const compiled = new CompiledGeometry(wide);
    const probes: GeoPoint[] = [
      { lon: 105, lat: 5.01 },
      { lon: 105, lat: 5.05 },
      { lon: 105, lat: 5.2 },
      { lon: 101, lat: 5.01 },
      { lon: 109.9, lat: 4.99 },
      { lon: 105, lat: -0.01 },
      { lon: 105, lat: 0.01 },
    ];
    for (const probe of probes) {
      const { rows } = await client.query<{ covers: boolean; d: number }>(
        `SELECT ST_Covers(g, p) AS covers, ST_Distance(g, p) AS d FROM (SELECT
           ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography AS g,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography AS p) q`,
        [JSON.stringify(wide), probe.lon, probe.lat],
      );
      const expected = rows[0];
      expect(compiled.contains(probe), JSON.stringify(probe)).toBe(expected?.covers);
      // Containment and distance tell the same story, within metres of PostGIS.
      const distance = compiled.distance(probe, 'wgs84');
      expect(distance.inside).toBe(expected?.covers);
      expect(Math.abs(distance.distanceM - (expected?.d ?? 0))).toBeLessThan(25);
    }
  });

  it('filters by bbox along meridians and parallels (geographyIntersectsBBox)', async () => {
    const dialect = new PgDialect();
    const hit = async (lon: number, lat: number, bbox: [number, number, number, number]) => {
      const query = dialect.sqlToQuery(
        sql`SELECT ${geographyIntersectsBBox(pointGeography(lon, lat), bbox)} AS hit`,
      );
      const { rows } = await client.query<{ hit: boolean }>(query.sql, query.params);
      return rows[0]?.hit;
    };
    expect(await hit(118, -2.1, [95, -11, 141, -2])).toBe(true);
    expect(await hit(118, 6.3, [95, 1, 141, 6])).toBe(false);
    expect(await hit(118, 5.9, [95, 1, 141, 6])).toBe(true);
  });

  it('agrees on point-to-point distances and ZoneIndex queries', async () => {
    const from = { lat: 1.1, lon: 104 };
    const to = { lat: -6.1, lon: 106.8 };
    const { rows } = await client.query<{ d: number }>(
      'SELECT ST_Distance(ST_MakePoint($1, $2)::geography, ST_MakePoint($3, $4)::geography) AS d',
      [from.lon, from.lat, to.lon, to.lat],
    );
    expect(geodesicDistanceM(from, to)).toBeCloseTo(rows[0]?.d ?? 0, 2);

    const index = new ZoneIndex();
    const pipeline = makeTestZone({
      kind: 'pipeline',
      geometry: GEOMETRIES.pipeline ?? { type: 'Point', coordinates: [0, 0] },
      bufferM: 1_750,
    });
    index.upsert(pipeline);
    const probe = { lat: 1.115, lon: 104.06 };
    const expected = await postgis(pipeline.geometry, probe, true);
    expect(
      index.nearest(probe, { kinds: ['pipeline'] })?.distanceM,
    ).toBeCloseTo(expected, 2);
    const { rows: within } = await client.query<{ within: boolean }>(
      `SELECT ST_DWithin(ST_MakePoint($1, $2)::geography, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)::geography, $4) AS within`,
      [
        probe.lon,
        probe.lat,
        JSON.stringify(pipeline.geometry),
        pipeline.bufferM,
      ],
    );
    expect(index.contains(pipeline.id, probe)).toBe(within[0]?.within);
  });
});
