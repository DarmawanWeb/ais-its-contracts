import type {
  BBox,
  GeoJsonGeometry,
  GeoJsonPosition,
  GeometryType,
} from '@darmawanweb/ais-its-contracts/domain';
import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';
import { customType } from 'drizzle-orm/pg-core';

/** GeoJSON geometry types (contracts `GEOMETRY_TYPES`). */
export type GeoJsonGeometryType = GeometryType;

/** A GeoJSON geometry (contracts `GeoJsonGeometry`, RFC 7946, WGS 84). */
export type { GeoJsonGeometry };

/** A GeoJSON point. */
export interface GeoJsonPoint {
  readonly type: 'Point';
  /** `[longitude, latitude]`. */
  readonly coordinates: GeoJsonPosition;
}

/** Subtypes of the platform's `geography(<type>,4326)` columns (spec §6). */
export type GeographySubtype =
  'Point' | 'LineString' | 'MultiPolygon' | 'Polygon' | 'Geometry';

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

/**
 * `geography` envelope of a bbox. Beware: as a geography its north and
 * south edges are great-circle arcs, not parallels — they bow towards the
 * poles, by kilometres for country-sized boxes. Filter by bbox with
 * {@link geographyIntersectsBBox}, which compares in lon/lat space.
 */
export function bboxEnvelopeGeography(bbox: BBox): SQL {
  return sql`${bboxEnvelope(bbox)}::geography`;
}

/**
 * `true` when a geography (or geometry) column intersects the
 * `[minLon, minLat, maxLon, maxLat]` box, compared in lon/lat (geometry)
 * space so the box edges are meridians and parallels, exactly what a map
 * viewport or a `?bbox=` query means. Index-assisted by a GiST expression
 * index on the cast: `CREATE INDEX … USING gist ((geom::geometry));`.
 */
export function geographyIntersectsBBox(
  column: SQLWrapper,
  bbox: BBox,
): SQL<boolean> {
  return sql<boolean>`ST_Intersects(${column}::geometry, ${bboxEnvelope(bbox)})`;
}

/** Geodesic distance between two geographies, in meters. */
export function distanceMeters(from: SQLWrapper, to: SQLWrapper): SQL<number> {
  return sql<number>`ST_Distance(${from}, ${to})`;
}

/** `true` when two geographies are within `meters` (index-assisted `ST_DWithin`). */
export function withinMeters(
  from: SQLWrapper,
  to: SQLWrapper,
  meters: number,
): SQL<boolean> {
  return sql<boolean>`ST_DWithin(${from}, ${to}, ${meters})`;
}
