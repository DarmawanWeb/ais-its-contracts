import { describe, expect, it } from 'vitest';

import { LEGACY_DISTANCE_CASES } from './__fixtures__/legacy-golden.js';
import {
  type BBox,
  BBoxSchema,
  clampBBox,
  EARTH_RADIUS_NM,
  formatBBox,
  haversineDistance,
  haversineNm,
  METERS_PER_NAUTICAL_MILE,
  parseBBox,
} from './geo.js';
import {
  KNOTS_TO_MS,
  knotsToMs,
  metersToNm,
  msToKnots,
  nmToMeters,
} from './units.js';

describe('haversineDistance (legacy calculateDistance parity)', () => {
  it('uses the legacy constants', () => {
    expect(EARTH_RADIUS_NM).toBe(3438);
    expect(METERS_PER_NAUTICAL_MILE).toBe(1852);
  });

  it.each(LEGACY_DISTANCE_CASES)(
    'reproduces the legacy result bit for bit: $name',
    ({ from, to, nm, meters }) => {
      const distance = haversineDistance(from, to);
      expect(distance.nm).toBe(nm);
      expect(distance.meters).toBe(meters);
      expect(distance.meters).toBe(distance.nm * 1852);
      expect(haversineNm(from, to)).toBe(nm);
    },
  );

  it('is symmetric within floating point noise', () => {
    for (const { from, to } of LEGACY_DISTANCE_CASES) {
      expect(haversineDistance(to, from).nm).toBeCloseTo(
        haversineDistance(from, to).nm,
        9,
      );
    }
  });
});

describe('unit helpers', () => {
  it('converts knots with the legacy factor 0.5144', () => {
    expect(KNOTS_TO_MS).toBe(0.5144);
    expect(knotsToMs(30)).toBe(30 * 0.5144);
    expect(knotsToMs(12.5)).toBe(6.43);
    expect(msToKnots(knotsToMs(17.3))).toBeCloseTo(17.3, 12);
  });

  it('converts nautical miles and meters', () => {
    expect(nmToMeters(1)).toBe(1852);
    expect(metersToNm(3704)).toBe(2);
  });
});

describe('bounding boxes', () => {
  const INDONESIA: BBox = [94.5, -11.5, 141.5, 6.5];

  it('parses and formats the bbox query parameter', () => {
    expect(parseBBox('94.5,-11.5,141.5,6.5')).toEqual(INDONESIA);
    expect(parseBBox(' 94.5, -11.5 ,141.5,6.5')).toEqual(INDONESIA);
    expect(formatBBox(INDONESIA)).toBe('94.5,-11.5,141.5,6.5');
    for (const invalid of [
      '',
      '1,2,3',
      '1,2,3,4,5',
      'a,b,c,d',
      '10,0,5,1',
      '0,10,1,5',
      '-181,0,0,1',
      '0,-91,1,1',
      '1,,2,3',
    ]) {
      expect(parseBBox(invalid), invalid).toBeNull();
    }
  });

  it('rejects antimeridian-crossing boxes in the schema', () => {
    expect(BBoxSchema.safeParse([170, -10, -170, 10]).success).toBe(false);
    expect(BBoxSchema.safeParse(INDONESIA).success).toBe(true);
  });

  it('clamps viewports with world copies', () => {
    expect(clampBBox([-200, -95, 200, 95])).toEqual([-180, -90, 180, 90]);
    expect(clampBBox([110, 5, 100, -5])).toEqual([100, -5, 110, 5]);
    expect(clampBBox([100, -5, Number.POSITIVE_INFINITY, 5])).toEqual([
      100, -5, 180, 5,
    ]);
    expect(() => clampBBox([Number.NaN, 0, 1, 1])).toThrow(RangeError);
  });
});
