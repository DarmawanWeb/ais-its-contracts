import { describe, expect, it } from 'vitest';

import {
  countGeometryPositions,
  GEOMETRY_TYPES,
  type GeoJsonGeometry,
  GeoJsonGeometrySchema,
  type GeoJsonPosition,
  GeoJsonLinearRingSchema,
  GeoJsonPositionSchema,
  geometryBBox,
  geometryPositions,
} from './geojson.js';
import {
  isZoneKind,
  ZONE_KIND_LABELS,
  ZONE_KINDS,
  ZONE_MAX_VERTICES,
  zoneKindLabel,
} from './zones.js';

const RING: GeoJsonPosition[] = [
  [103.48, 0.62],
  [103.52, 0.69],
  [103.46, 0.64],
  [103.48, 0.62],
];

const PIPELINE: GeoJsonGeometry = {
  type: 'LineString',
  coordinates: [
    [112.719384869178, -6.87197219605424],
    [112.719433852143, -6.86293886272091],
    [112.719446655722, -6.85389719605424],
  ],
};

describe('GeoJSON positions and rings', () => {
  it('accepts [lon, lat] and [lon, lat, altitude] in WGS84 bounds', () => {
    expect(GeoJsonPositionSchema.parse([104.03, 1.13])).toEqual([104.03, 1.13]);
    expect(GeoJsonPositionSchema.parse([104.03, 1.13, -12])).toEqual([
      104.03, 1.13, -12,
    ]);
    for (const invalid of [
      [181, 0],
      [0, -91],
      [104.03],
      [104.03, 1.13, 0, 1],
      ['104.03', '1.13'],
      [Number.NaN, 0],
    ]) {
      expect(GeoJsonPositionSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('requires closed rings of at least four positions', () => {
    expect(GeoJsonLinearRingSchema.parse(RING)).toEqual(RING);
    expect(GeoJsonLinearRingSchema.safeParse(RING.slice(0, 3)).success).toBe(
      false,
    );
    const open = [...RING.slice(0, 3), [103.49, 0.62]];
    const result = GeoJsonLinearRingSchema.safeParse(open);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'A linear ring must be closed (first position = last position)',
    ]);
    expect(
      GeoJsonLinearRingSchema.safeParse([
        [103.48, 0.62, 1],
        ...RING.slice(1, 3),
        [103.48, 0.62],
      ]).success,
    ).toBe(false);
  });
});

describe('GeoJSON geometries', () => {
  const GEOMETRIES: Record<string, unknown> = {
    Point: { type: 'Point', coordinates: [104.03, 1.13] },
    MultiPoint: { type: 'MultiPoint', coordinates: [[104.03, 1.13]] },
    LineString: PIPELINE,
    MultiLineString: {
      type: 'MultiLineString',
      coordinates: [PIPELINE.coordinates],
    },
    Polygon: { type: 'Polygon', coordinates: [RING] },
    MultiPolygon: { type: 'MultiPolygon', coordinates: [[RING], [RING]] },
    GeometryCollection: {
      type: 'GeometryCollection',
      geometries: [PIPELINE, { type: 'Polygon', coordinates: [RING] }],
    },
  };

  it('parses every RFC 7946 geometry type', () => {
    expect(Object.keys(GEOMETRIES)).toEqual([...GEOMETRY_TYPES]);
    for (const [type, geometry] of Object.entries(GEOMETRIES)) {
      expect(GeoJsonGeometrySchema.parse(geometry), type).toEqual(geometry);
    }
  });

  it.each([
    ['empty MultiPoint', { type: 'MultiPoint', coordinates: [] }],
    ['one-position LineString', { type: 'LineString', coordinates: [[1, 1]] }],
    ['empty Polygon', { type: 'Polygon', coordinates: [] }],
    ['empty MultiPolygon', { type: 'MultiPolygon', coordinates: [] }],
    [
      'nested GeometryCollection',
      {
        type: 'GeometryCollection',
        geometries: [{ type: 'GeometryCollection', geometries: [PIPELINE] }],
      },
    ],
    [
      'empty GeometryCollection',
      { type: 'GeometryCollection', geometries: [] },
    ],
    ['Feature instead of a geometry', { type: 'Feature', geometry: PIPELINE }],
    ['coordinates as an object', { type: 'Point', coordinates: { lon: 1 } }],
  ])('rejects %s', (_name, geometry) => {
    expect(GeoJsonGeometrySchema.safeParse(geometry).success).toBe(false);
  });

  it('strips foreign members such as bbox', () => {
    expect(
      GeoJsonGeometrySchema.parse({ ...PIPELINE, bbox: [0, 0, 1, 1] }),
    ).toEqual(PIPELINE);
  });
});

describe('geometry helpers', () => {
  const collection: GeoJsonGeometry = {
    type: 'GeometryCollection',
    geometries: [
      { type: 'Point', coordinates: [104.5, 1.5] },
      PIPELINE,
      { type: 'MultiPolygon', coordinates: [[RING], [RING]] },
    ],
  };

  it('counts positions (closing positions included)', () => {
    expect(countGeometryPositions(PIPELINE)).toBe(3);
    expect(
      countGeometryPositions({ type: 'Polygon', coordinates: [RING, RING] }),
    ).toBe(8);
    expect(countGeometryPositions(collection)).toBe(1 + 3 + 8);
    expect(geometryPositions(collection)[0]).toEqual([104.5, 1.5]);
    expect(ZONE_MAX_VERTICES).toBe(50_000);
  });

  it('computes bounding boxes', () => {
    expect(
      geometryBBox({ type: 'Point', coordinates: [104.03, 1.13] }),
    ).toEqual([104.03, 1.13, 104.03, 1.13]);
    expect(geometryBBox(PIPELINE)).toEqual([
      112.719384869178, -6.87197219605424, 112.719446655722, -6.85389719605424,
    ]);
    expect(geometryBBox(collection)).toEqual([
      103.46, -6.87197219605424, 112.719446655722, 1.5,
    ]);
  });

  it('refuses the bounding box of an empty geometry', () => {
    expect(() =>
      geometryBBox({
        type: 'MultiPoint',
        coordinates: [],
      } as unknown as GeoJsonGeometry),
    ).toThrow(RangeError);
  });
});

describe('zone kinds (spec 7.4)', () => {
  it('declares the kinds of ZoneSnapshotV1 with labels', () => {
    expect(ZONE_KINDS).toEqual([
      'pipeline',
      'transhipment_area',
      'fishing_ground',
      'mpa',
      'restricted',
      'anchorage',
      'port',
      'tss_lane',
      'shallow_water',
      'custom',
    ]);
    expect(Object.keys(ZONE_KIND_LABELS)).toEqual([...ZONE_KINDS]);
    expect(zoneKindLabel('anchorage', 'id')).toBe('Area labuh jangkar');
    expect(zoneKindLabel('tss_lane')).toBe('Traffic separation scheme lane');
    expect(isZoneKind('shallow_water')).toBe(true);
    expect(isZoneKind('wreck')).toBe(false);
  });
});
