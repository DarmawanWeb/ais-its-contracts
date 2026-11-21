import * as z from 'zod';

import { type BBox, LatitudeSchema, LongitudeSchema } from './geo.js';

/** GeoJSON geometry types (RFC 7946 §3.1). */
export const GEOMETRY_TYPES = [
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
] as const;

/** A GeoJSON geometry type. */
export type GeometryType = (typeof GEOMETRY_TYPES)[number];

/**
 * Zod schema of a GeoJSON position `[lon, lat]` or `[lon, lat, altitude]` in
 * WGS84 degrees (RFC 7946 §3.1.1, at most three elements).
 */
export const GeoJsonPositionSchema = z
  .union([
    z.tuple([LongitudeSchema, LatitudeSchema]),
    z.tuple([LongitudeSchema, LatitudeSchema, z.number()]),
  ])
  .describe('Position [lon, lat] or [lon, lat, altitude] in WGS84 degrees');

/** A GeoJSON position. */
export type GeoJsonPosition = z.infer<typeof GeoJsonPositionSchema>;

const samePosition = (a: GeoJsonPosition, b: GeoJsonPosition): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Zod schema of a closed linear ring: at least four positions, first = last. */
export const GeoJsonLinearRingSchema = z
  .array(GeoJsonPositionSchema)
  .min(4)
  .refine(
    (ring) => {
      const first = ring[0];
      const last = ring.at(-1);
      return first === undefined || last === undefined
        ? true
        : samePosition(first, last);
    },
    {
      message: 'A linear ring must be closed (first position = last position)',
    },
  )
  .describe('Closed linear ring (at least 4 positions, first = last)');

/** Zod schema of a GeoJSON `Point`. */
export const GeoJsonPointSchema = z
  .object({
    type: z.literal('Point'),
    coordinates: GeoJsonPositionSchema,
  })
  .describe('GeoJSON Point');

/** Zod schema of a GeoJSON `MultiPoint` (at least one point). */
export const GeoJsonMultiPointSchema = z
  .object({
    type: z.literal('MultiPoint'),
    coordinates: z.array(GeoJsonPositionSchema).min(1),
  })
  .describe('GeoJSON MultiPoint');

const LineCoordinatesSchema = z.array(GeoJsonPositionSchema).min(2);

/** Zod schema of a GeoJSON `LineString` (at least two positions). */
export const GeoJsonLineStringSchema = z
  .object({
    type: z.literal('LineString'),
    coordinates: LineCoordinatesSchema,
  })
  .describe('GeoJSON LineString');

/** Zod schema of a GeoJSON `MultiLineString` (at least one line). */
export const GeoJsonMultiLineStringSchema = z
  .object({
    type: z.literal('MultiLineString'),
    coordinates: z.array(LineCoordinatesSchema).min(1),
  })
  .describe('GeoJSON MultiLineString');

const PolygonCoordinatesSchema = z.array(GeoJsonLinearRingSchema).min(1);

/** Zod schema of a GeoJSON `Polygon`: exterior ring first, then holes. */
export const GeoJsonPolygonSchema = z
  .object({
    type: z.literal('Polygon'),
    coordinates: PolygonCoordinatesSchema,
  })
  .describe('GeoJSON Polygon');

/** Zod schema of a GeoJSON `MultiPolygon` (at least one polygon). */
export const GeoJsonMultiPolygonSchema = z
  .object({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(PolygonCoordinatesSchema).min(1),
  })
  .describe('GeoJSON MultiPolygon');

/** Zod schema of every geometry except `GeometryCollection`. */
export const GeoJsonSimpleGeometrySchema = z.discriminatedUnion('type', [
  GeoJsonPointSchema,
  GeoJsonMultiPointSchema,
  GeoJsonLineStringSchema,
  GeoJsonMultiLineStringSchema,
  GeoJsonPolygonSchema,
  GeoJsonMultiPolygonSchema,
]);

/**
 * Zod schema of a GeoJSON `GeometryCollection` of simple geometries; nested
 * collections are not accepted (RFC 7946 §3.1.8 advises against them).
 */
export const GeoJsonGeometryCollectionSchema = z
  .object({
    type: z.literal('GeometryCollection'),
    geometries: z.array(GeoJsonSimpleGeometrySchema).min(1),
  })
  .describe('GeoJSON GeometryCollection');

/**
 * Zod schema of a GeoJSON geometry (RFC 7946) in WGS84 degrees. Every
 * geometry is non-empty; members other than `type` and `coordinates` /
 * `geometries` (e.g. `bbox`) are stripped.
 */
export const GeoJsonGeometrySchema = z
  .discriminatedUnion('type', [
    GeoJsonPointSchema,
    GeoJsonMultiPointSchema,
    GeoJsonLineStringSchema,
    GeoJsonMultiLineStringSchema,
    GeoJsonPolygonSchema,
    GeoJsonMultiPolygonSchema,
    GeoJsonGeometryCollectionSchema,
  ])
  .describe('GeoJSON geometry in WGS84 degrees');

/** A GeoJSON geometry other than a collection. */
export type GeoJsonSimpleGeometry = z.infer<typeof GeoJsonSimpleGeometrySchema>;

/** A GeoJSON geometry (assignable to `GeoJSON.Geometry` of `@types/geojson`). */
export type GeoJsonGeometry = z.infer<typeof GeoJsonGeometrySchema>;

/** Every position of a simple geometry, in document order. */
function simplePositions(
  geometry: GeoJsonSimpleGeometry,
): readonly GeoJsonPosition[] {
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates];
    case 'MultiPoint':
    case 'LineString':
      return geometry.coordinates;
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates.flat();
    case 'MultiPolygon':
      return geometry.coordinates.flat(2);
  }
}

/** Every position of a geometry, in document order. */
export function geometryPositions(
  geometry: GeoJsonGeometry,
): readonly GeoJsonPosition[] {
  return geometry.type === 'GeometryCollection'
    ? geometry.geometries.flatMap(simplePositions)
    : simplePositions(geometry);
}

/**
 * Number of positions (vertices) of a geometry, closing positions of rings
 * included; zones are limited to `ZONE_MAX_VERTICES`.
 */
export function countGeometryPositions(geometry: GeoJsonGeometry): number {
  return geometryPositions(geometry).length;
}

/**
 * Bounding box `[minLon, minLat, maxLon, maxLat]` of a geometry. Geometries
 * crossing the antimeridian get the full longitude span between their extreme
 * longitudes (boxes never cross the antimeridian).
 *
 * @throws {RangeError} when the geometry has no position (an empty geometry
 * that {@link GeoJsonGeometrySchema} rejects).
 */
export function geometryBBox(geometry: GeoJsonGeometry): BBox {
  const positions = geometryPositions(geometry);
  if (positions.length === 0) {
    throw new RangeError(`Empty ${geometry.type} has no bounding box`);
  }
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of positions) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}
