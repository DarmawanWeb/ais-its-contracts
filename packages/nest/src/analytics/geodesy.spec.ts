import { distance as turfDistance } from '@turf/distance';
import { lineString, point } from '@turf/helpers';
import { nearestPointOnLine } from '@turf/nearest-point-on-line';
import { describe, expect, it } from 'vitest';

import {
  arcBBox,
  destinationPoint,
  distanceToArc,
  geodesicDistanceM,
  haversineM,
  haversineMeters,
  initialBearingDeg,
  nearestPointOnArc,
  searchBox,
  vincentyM,
  vincentyMeters,
} from './geodesy.js';

describe('geodesic distances', () => {
  it('computes WGS 84 distances with Vincenty (reference values)', () => {
    // Flinders Peak → Buninyong (Vincenty 1975 test line): 54 972.271 m.
    const flinders = {
      lat: -(37 + 57 / 60 + 3.7203 / 3600),
      lon: 144 + 25 / 60 + 29.5244 / 3600,
    };
    const buninyong = {
      lat: -(37 + 39 / 60 + 10.1561 / 3600),
      lon: 143 + 55 / 60 + 35.3839 / 3600,
    };
    expect(vincentyM(flinders, buninyong)).toBeCloseTo(54_972.271, 2);
    // One degree of longitude on the equator: a · π / 180.
    expect(vincentyM({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(
      111_319.491,
      2,
    );
    expect(vincentyM({ lat: 1, lon: 104 }, { lat: 1, lon: 104 })).toBe(0);
  });

  it('falls back to the sphere for antipodal points', () => {
    const distance = vincentyM({ lat: 0, lon: 0 }, { lat: 0, lon: 180 });
    expect(distance).toBeGreaterThan(19_900_000);
    expect(distance).toBeLessThan(20_100_000);
  });

  it('matches @turf/distance in the sphere model', () => {
    const cases = [
      [
        { lat: 1.1, lon: 104.0 },
        { lat: 1.12, lon: 104.03 },
      ],
      [
        { lat: -6.1, lon: 106.8 },
        { lat: -5.9, lon: 106.95 },
      ],
      [
        { lat: 52.5, lon: 13.4 },
        { lat: 48.85, lon: 2.35 },
      ],
    ] as const;
    for (const [from, to] of cases) {
      const expected = turfDistance(
        point([from.lon, from.lat]),
        point([to.lon, to.lat]),
        { units: 'meters' },
      );
      expect(haversineM(from, to)).toBe(expected);
      expect(geodesicDistanceM(from, to, 'sphere')).toBe(expected);
    }
  });

  it('differs from the sphere by well under 1 % near the equator', () => {
    const from = { lat: 1.1, lon: 104 };
    const to = { lat: 1.2, lon: 104.2 };
    const ratio =
      geodesicDistanceM(from, to, 'wgs84') /
      geodesicDistanceM(from, to, 'sphere');
    expect(Math.abs(ratio - 1)).toBeLessThan(0.006);
  });
});

describe('bearings and destinations', () => {
  it('computes initial bearings in [0, 360)', () => {
    expect(
      initialBearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }),
    ).toBeCloseTo(0, 9);
    expect(
      initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }),
    ).toBeCloseTo(90, 9);
    expect(
      initialBearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 }),
    ).toBeCloseTo(180, 9);
    expect(
      initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 }),
    ).toBeCloseTo(270, 9);
  });

  it('round-trips destination points with haversine distances', () => {
    const origin = { lat: 1.15, lon: 104.05 };
    const target = destinationPoint(origin, 45, 1_852);
    expect(haversineM(origin, target)).toBeCloseTo(1_852, 6);
    expect(initialBearingDeg(origin, target)).toBeCloseTo(45, 6);
  });
});

describe('nearest point on a great-circle arc', () => {
  const start = { lat: 1, lon: 104 };
  const end = { lat: 1, lon: 104.1 };

  it('projects onto the arc interior', () => {
    const nearest = nearestPointOnArc({ lat: 1.01, lon: 104.05 }, start, end);
    expect(nearest.lon).toBeCloseTo(104.05, 9);
    expect(nearest.lat).toBeGreaterThan(1); // the great circle bulges poleward
    expect(nearest.lat - 1).toBeLessThan(1e-4);
  });

  it('clamps to the endpoints', () => {
    expect(nearestPointOnArc({ lat: 1, lon: 103.9 }, start, end)).toEqual(
      start,
    );
    expect(nearestPointOnArc({ lat: 1.2, lon: 104.3 }, start, end)).toEqual(
      end,
    );
    expect(nearestPointOnArc({ lat: 2, lon: 5 }, start, start)).toEqual(start);
  });

  it('matches @turf/nearest-point-on-line (legacy EWS) in the sphere model', () => {
    const line = [
      [104.0, 1.0],
      [104.05, 1.02],
      [104.12, 1.01],
      [104.2, 1.06],
    ];
    const probes = [
      { lat: 1.03, lon: 104.06 },
      { lat: 0.99, lon: 104.01 },
      { lat: 1.05, lon: 104.15 },
      { lat: 1.1, lon: 104.25 },
      { lat: 1.0, lon: 103.95 },
    ];
    for (const probe of probes) {
      const turf = nearestPointOnLine(
        lineString(line),
        point([probe.lon, probe.lat]),
        { units: 'meters' },
      );
      let best = Number.POSITIVE_INFINITY;
      for (let index = 1; index < line.length; index += 1) {
        const [a, b] = [line[index - 1], line[index]];
        if (a === undefined || b === undefined) continue;
        const { distanceM } = distanceToArc(
          probe,
          { lon: a[0] ?? 0, lat: a[1] ?? 0 },
          { lon: b[0] ?? 0, lat: b[1] ?? 0 },
          'sphere',
        );
        best = Math.min(best, distanceM);
      }
      expect(best).toBeCloseTo(turf.properties.dist, 6);
    }
  });
});

describe('boxes', () => {
  it('extends arc boxes to the bulge of long east–west edges', () => {
    const box = arcBBox({ lat: 45, lon: 0 }, { lat: 45, lon: 60 });
    expect(box[3]).toBeGreaterThan(48);
    expect(box[1]).toBe(45);
  });

  it('builds search boxes that contain the circle', () => {
    const center = { lat: 1.1, lon: 104 };
    const [minLon, minLat, maxLon, maxLat] = searchBox(center, 10_000);
    for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const edge = destinationPoint(center, bearing, 10_000);
      expect(edge.lon).toBeGreaterThanOrEqual(minLon);
      expect(edge.lon).toBeLessThanOrEqual(maxLon);
      expect(edge.lat).toBeGreaterThanOrEqual(minLat);
      expect(edge.lat).toBeLessThanOrEqual(maxLat);
    }
    expect(searchBox({ lat: 89.9, lon: 0 }, 50_000)).toEqual([
      -180,
      expect.any(Number),
      180,
      90,
    ]);
  });
});

describe('unit-suffixed names (spec §5)', () => {
  it('keeps the former names as deprecated aliases of the …M functions', () => {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- asserting the alias
    expect(haversineMeters).toBe(haversineM);
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- asserting the alias
    expect(vincentyMeters).toBe(vincentyM);
  });
});
