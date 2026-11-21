import type { BBox } from '@darmawanweb/seemp-contracts/domain';
import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';

/** GeoJSON geometry types. */
export type GeoJsonGeometryType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon';

/** A GeoJSON geometry object (RFC 7946), WGS 84 longitude/latitude. */
export type GeoJsonGeometry =
  | { readonly type: GeoJsonGeometryType; readonly coordinates: unknown }
  | { readonly type: 'GeometryCollection'; readonly geometries: readonly GeoJsonGeometry[] };

/** A GeoJSON point. */
export interface GeoJsonPoint {
  readonly type: 'Point';
  /** `[longitude, latitude]`. */
  readonly coordinates: readonly [number, number];
}

/** Subtypes of the platform's `geography(<type>,4326)` columns (spec §6). */
export type GeographySubtype = 'Point' | 'LineString' | 'MultiPolygon' | 'Polygon' | 'Geometry';

/**
 * Drizzle column type `geography(<subtype>,4326)` for schema definitions
 * that mirror the SQL migrations. Values are the driver's EWKB hex strings;
 * read them with {@link geographyAsGeoJson} and write them with
 * {@link pointGeography} / {@link geoJsonToGeography}.
 *
 * @example
 * geom: geography('geom', { subtype: 'Point' }).notNull(),
 */
export const geography = customType<{
  data: string;
  driverData: string;
  config: { subtype?: GeographySubtype };
}>({
  dataType(config) {
    return `geography(${config?.subtype ?? 'Geometry'},4326)`;
  },
});

/** `geography(Point,4326)` from longitude/latitude. */
export function pointGeography(lon: number, lat: number): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography`;
}

/** `geography` from a GeoJSON geometry (parsed by PostGIS). */
export function geoJsonToGeography(geometry: GeoJsonGeometry): SQL {
  return sql`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(geometry)}), 4326)::geography`;
}

/**
 * Selects a geography (or geometry) column as a GeoJSON object (the `json`
 * result is parsed by `pg`).
 *
 * @example
 * db.select({ id: zones.id, geometry: geographyAsGeoJson(zones.geom) }).from(zones)
 */
export function geographyAsGeoJson<T extends GeoJsonGeometry = GeoJsonGeometry>(
  column: SQLWrapper,
  maxDecimalDigits = 9,
): SQL<T> {
  const digits = Math.max(0, Math.min(15, Math.trunc(maxDecimalDigits)));
  return sql<T>`ST_AsGeoJSON(${column}, ${sql.raw(String(digits))})::json`;
}

/** `geometry` envelope (SRID 4326) of a `[minLon, minLat, maxLon, maxLat]` box. */
export function bboxEnvelope(bbox: BBox): SQL {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return sql`ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 4326)`;
}

/** `geography` envelope of a bbox. */
export function bboxEnvelopeGeography(bbox: BBox): SQL {
  return sql`${bboxEnvelope(bbox)}::geography`;
}

/** `true` when a geography column intersects the bbox (index-assisted). */
export function geographyIntersectsBBox(column: SQLWrapper, bbox: BBox): SQL<boolean> {
  return sql<boolean>`ST_Intersects(${column}, ${bboxEnvelopeGeography(bbox)})`;
}

/** Geodesic distance between two geographies, in meters. */
export function distanceMeters(from: SQLWrapper, to: SQLWrapper): SQL<number> {
  return sql<number>`ST_Distance(${from}, ${to})`;
}

/** `true` when two geographies are within `meters` (index-assisted `ST_DWithin`). */
export function withinMeters(from: SQLWrapper, to: SQLWrapper, meters: number): SQL<boolean> {
  return sql<boolean>`ST_DWithin(${from}, ${to}, ${meters})`;
}
