import * as z from 'zod';

/**
 * Earth radius in nautical miles used by the legacy CII speed calculation
 * (`calculateDistance` in `utils/cii/speed-calculation.ts`). Kept for parity.
 */
export const EARTH_RADIUS_NM = 3438;

/** Meters in one international nautical mile. */
export const METERS_PER_NAUTICAL_MILE = 1852;

/** Zod schema of a WGS84 latitude in degrees, `[-90, 90]`. */
export const LatitudeSchema = z
  .number()
  .min(-90)
  .max(90)
  .describe('WGS84 latitude in degrees');

/** Zod schema of a WGS84 longitude in degrees, `[-180, 180]`. */
export const LongitudeSchema = z
  .number()
  .min(-180)
  .max(180)
  .describe('WGS84 longitude in degrees');

/** A WGS84 position in degrees. */
export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

/** A distance expressed in nautical miles and meters. */
export interface Distance {
  /** Nautical miles. */
  readonly nm: number;
  /** Meters (`nm * 1852`). */
  readonly meters: number;
}

/**
 * Bounding box `[minLon, minLat, maxLon, maxLat]` in WGS84 degrees. Boxes never
 * cross the antimeridian (`minLon <= maxLon`).
 */
export type BBox = readonly [
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
];

/** Zod schema of a {@link BBox}; rejects inverted (or antimeridian-crossing) boxes. */
export const BBoxSchema = z
  .tuple([LongitudeSchema, LatitudeSchema, LongitudeSchema, LatitudeSchema])
  .refine(([minLon, , maxLon]) => minLon <= maxLon, {
    message:
      'minLon must be <= maxLon (antimeridian-crossing boxes are not supported)',
  })
  .refine(([, minLat, , maxLat]) => minLat <= maxLat, {
    message: 'minLat must be <= maxLat',
  })
  .describe('Bounding box [minLon, minLat, maxLon, maxLat] in WGS84 degrees');

const degreesToRadians = (degrees: number): number => degrees * (Math.PI / 180);

/**
 * Great-circle distance with the haversine formula and `R = 3438 nm`.
 *
 * Numerically identical to the legacy `calculateDistance` (same constant and
 * the same order of floating point operations), so CII segment distances keep
 * parity with the MVP.
 *
 * @method geo.haversine_distance
 */
export function haversineDistance(from: GeoPoint, to: GeoPoint): Distance {
  const fromLat = degreesToRadians(from.lat);
  const fromLon = degreesToRadians(from.lon);
  const toLat = degreesToRadians(to.lat);
  const toLon = degreesToRadians(to.lon);
  const deltaLat = toLat - fromLat;
  const deltaLon = toLon - fromLon;

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const nm = EARTH_RADIUS_NM * c;

  return { nm, meters: nm * METERS_PER_NAUTICAL_MILE };
}

/**
 * The legacy CII haversine (`R = 3438 nm`, MVP `calculateDistance`) under an
 * unambiguous name; same function as {@link haversineDistance}. Use it only
 * where legacy numerical parity is required (emission segments); geodesic
 * metres for detectors come from the kit's `geodesicDistanceM`.
 */
export const legacyHaversineDistance = haversineDistance;

/** Shorthand for `haversineDistance(from, to).nm` (legacy CII constant). */
export function haversineNm(from: GeoPoint, to: GeoPoint): number {
  return haversineDistance(from, to).nm;
}

/**
 * Parses the `bbox` query parameter format `minLon,minLat,maxLon,maxLat`.
 *
 * @returns the box, or `null` when the text is not a valid {@link BBox}.
 */
export function parseBBox(value: string): BBox | null {
  const parts = value.split(',');
  if (parts.length !== 4 || parts.some((part) => part.trim() === '')) {
    return null;
  }
  const result = BBoxSchema.safeParse(parts.map(Number));
  return result.success ? result.data : null;
}

/** Formats a box as the `bbox` query parameter (`minLon,minLat,maxLon,maxLat`). */
export function formatBBox(bbox: BBox): string {
  return bbox.join(',');
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Clamps a box to valid WGS84 ranges, e.g. a map viewport that shows world
 * copies (`lon < -180`). Inverted corners are reordered.
 *
 * @throws {RangeError} when a coordinate is `NaN`.
 */
export function clampBBox(bbox: BBox): BBox {
  if (bbox.some(Number.isNaN)) {
    throw new RangeError(`Invalid bbox: ${formatBBox(bbox)}`);
  }
  const [lon1, lat1, lon2, lat2] = bbox;
  return [
    clamp(Math.min(lon1, lon2), -180, 180),
    clamp(Math.min(lat1, lat2), -90, 90),
    clamp(Math.max(lon1, lon2), -180, 180),
    clamp(Math.max(lat1, lat2), -90, 90),
  ];
}
