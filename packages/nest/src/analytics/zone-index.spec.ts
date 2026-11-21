import type { GeoJsonGeometry } from '@darmawanweb/ais-its-contracts/domain';
import { describe, expect, it } from 'vitest';

import { makeTestZone } from './detector-test-harness.js';
import { destinationPoint, geodesicDistanceM } from './geodesy.js';
import { CompiledGeometry } from './zone-geometry.js';
import { ZoneIndex } from './zone-index.js';

const square: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [104, 1],
      [104.2, 1],
      [104.2, 1.2],
      [104, 1.2],
      [104, 1],
    ],
    // A hole in the middle.
    [
      [104.08, 1.08],
      [104.12, 1.08],
      [104.12, 1.12],
      [104.08, 1.12],
      [104.08, 1.08],
    ],
  ],
};

const pipeline: GeoJsonGeometry = {
  type: 'LineString',
  coordinates: [
    [104.0, 1.0],
    [104.05, 1.02],
    [104.12, 1.01],
    [104.2, 1.06],
  ],
};

/** A densified line with many vertices (exercises the element index). */
function longLine(vertices: number): GeoJsonGeometry {
  const coordinates: [number, number][] = [];
  for (let index = 0; index < vertices; index += 1) {
    coordinates.push([103 + index * 0.001, 1 + Math.sin(index / 50) * 0.01]);
  }
  return { type: 'LineString', coordinates };
}

describe('CompiledGeometry', () => {
  it('tests containment with holes (even–odd rule)', () => {
    const geometry = new CompiledGeometry(square);
    expect(geometry.contains({ lat: 1.05, lon: 104.05 })).toBe(true);
    expect(geometry.contains({ lat: 1.1, lon: 104.1 })).toBe(false); // in the hole
    expect(geometry.contains({ lat: 1.3, lon: 104.1 })).toBe(false);
    expect(geometry.hasArea).toBe(true);
    expect(
      new CompiledGeometry(pipeline).contains({ lat: 1.01, lon: 104.05 }),
    ).toBe(false);
  });

  it('measures zero inside and the boundary distance outside', () => {
    const geometry = new CompiledGeometry(square);
    expect(
      geometry.distance({ lat: 1.05, lon: 104.05 }, 'wgs84'),
    ).toMatchObject({ distanceM: 0, inside: true });
    const inHole = geometry.distance({ lat: 1.1, lon: 104.1 }, 'wgs84');
    expect(inHole.inside).toBe(false);
    expect(inHole.distanceM).toBeGreaterThan(2_000);
    expect(inHole.distanceM).toBeLessThan(2_300);
    const south = geometry.distance({ lat: 0.99, lon: 104.1 }, 'wgs84');
    expect(south.distanceM).toBeCloseTo(
      geodesicDistanceM({ lat: 0.99, lon: 104.1 }, south.nearest, 'wgs84'),
      6,
    );
    expect(south.distanceM).toBeGreaterThan(1_100);
    expect(south.distanceM).toBeLessThan(1_110);
  });

  it('finds the same nearest element with and without the index', () => {
    const indexed = new CompiledGeometry(longLine(2_000));
    expect(indexed.segmentCount).toBe(1_999);
    const probes = [
      { lat: 1.02, lon: 103.5 },
      { lat: 0.5, lon: 104.5 },
      { lat: 1.0, lon: 102.0 },
      { lat: 3.0, lon: 105.5 },
    ];
    for (const probe of probes) {
      const fast = indexed.distance(probe, 'wgs84');
      // Brute force over the same segments.
      let best = Number.POSITIVE_INFINITY;
      const line = longLine(2_000);
      if (line.type !== 'LineString') throw new Error('unexpected geometry');
      for (let index = 1; index < line.coordinates.length; index += 1) {
        const segment: GeoJsonGeometry = {
          type: 'LineString',
          coordinates: [
            line.coordinates[index - 1] ?? [0, 0],
            line.coordinates[index] ?? [0, 0],
          ],
        };
        best = Math.min(
          best,
          new CompiledGeometry(segment).distance(probe, 'wgs84').distanceM,
        );
      }
      expect(fast.distanceM).toBeCloseTo(best, 6);
    }
  });

  it('answers ST_DWithin-like buffer queries', () => {
    const geometry = new CompiledGeometry(pipeline);
    const near = destinationPoint({ lat: 1.02, lon: 104.05 }, 0, 400);
    expect(geometry.within(near, 500, 'wgs84')).toBe(true);
    expect(geometry.within(near, 300, 'wgs84')).toBe(false);
    expect(geometry.within({ lat: 2, lon: 104 }, 1_000, 'wgs84')).toBe(false);
  });

  it('handles points, multi-geometries and collections', () => {
    const collection = new CompiledGeometry({
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', coordinates: [104, 1] },
        {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [105, 1],
                [105.1, 1],
                [105.1, 1.1],
                [105, 1],
              ],
            ],
          ],
        },
      ],
    });
    expect(collection.pointCount).toBe(1);
    expect(collection.contains({ lat: 1.02, lon: 105.08 })).toBe(true);
    expect(
      collection.distance({ lat: 1, lon: 104.01 }, 'wgs84').distanceM,
    ).toBeCloseTo(1_113.2, 0);
  });
});

describe('ZoneIndex', () => {
  const index = new ZoneIndex();
  const area = makeTestZone({ kind: 'transhipment_area', geometry: square });
  const line = makeTestZone({
    kind: 'pipeline',
    geometry: pipeline,
    bufferM: 1_750,
  });
  const inactive = makeTestZone({
    kind: 'restricted',
    geometry: square,
    active: false,
  });
  const otherOrg = makeTestZone({
    kind: 'custom',
    geometry: square,
    orgId: '018f2b5e-0000-7000-8000-000000000001',
  });
  for (const zone of [area, line, inactive, otherOrg]) index.upsert(zone);

  it('finds zones containing a point (polygons, buffers, filters)', () => {
    // Inside the polygons, about 1.1 km from the pipeline (buffer 1 750 m).
    const probe = { lat: 1.03, lon: 104.05 };
    const inside = index.zonesAt(probe);
    expect(inside.map((zone) => zone.id).sort()).toEqual(
      [area.id, line.id, otherOrg.id].sort(),
    );
    expect(
      index.zonesAt(probe, { useBuffer: false }).map((zone) => zone.id),
    ).not.toContain(line.id);
    expect(
      index.zonesAt(probe, { kinds: ['pipeline'] }).map((zone) => zone.id),
    ).toEqual([line.id]);
    expect(index.zonesAt(probe, { includeInactive: true })).toHaveLength(4);
    expect(
      index
        .zonesAt(probe, { orgId: '018f2b5e-0000-7000-8000-000000000002' })
        .map((zone) => zone.id),
    ).not.toContain(otherOrg.id);
  });

  it('measures distances to zones and finds the nearest of a kind', () => {
    const probe = destinationPoint({ lat: 1.02, lon: 104.05 }, 180, 800);
    const measured = index.distance(line.id, probe);
    expect(measured?.distanceM).toBeGreaterThan(700);
    expect(measured?.withinBuffer).toBe(true);
    expect(index.nearest(probe, { kinds: ['pipeline'] })?.zone.id).toBe(
      line.id,
    );
    expect(
      index.nearest(
        { lat: 5, lon: 110 },
        { kinds: ['pipeline'], maxDistanceM: 10_000 },
      ),
    ).toBeUndefined();
    const near = index.near(probe, 5_000);
    expect(near[0]?.distanceM).toBeLessThanOrEqual(
      near[1]?.distanceM ?? Number.POSITIVE_INFINITY,
    );
    expect(index.contains(line.id, probe)).toBe(true);
    expect(index.contains(line.id, probe, { useBuffer: false })).toBe(false);
  });

  it('applies changes in order and ignores older snapshots', () => {
    const zones = new ZoneIndex();
    const first = makeTestZone({
      geometry: square,
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(zones.upsert(first)?.kind).toBe('upserted');
    expect(
      zones.upsert({
        ...first,
        name: 'older',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBeUndefined();
    const moved = {
      ...first,
      geometry: pipeline,
      updatedAt: '2026-01-03T00:00:00.000Z',
    };
    expect(zones.upsert(moved)?.previous?.name).toBe(first.name);
    expect(zones.contains(first.id, { lat: 1.05, lon: 104.05 })).toBe(false);
    expect(zones.remove(first.id)?.kind).toBe('deleted');
    expect(zones.remove(first.id)).toBeUndefined();
    expect(zones.size).toBe(0);
    expect(zones.zonesAt({ lat: 1, lon: 104 })).toEqual([]);
  });
});
