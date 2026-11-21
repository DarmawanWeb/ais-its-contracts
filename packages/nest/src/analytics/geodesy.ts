import type { BBox, GeoPoint } from '@darmawanweb/ais-its-contracts/domain';

/**
 * How distances are measured:
 *
 * - `'wgs84'` — geodesic distance on the WGS 84 ellipsoid (Vincenty's inverse
 *   formula). Matches PostGIS `ST_Distance` on `geography` (sub-metre).
 * - `'sphere'` — great-circle distance on a sphere of
 *   {@link MEAN_EARTH_RADIUS_M} (haversine). Matches Turf.js 7 (`@turf/distance`,
 *   `@turf/nearest-point-on-line`), i.e. the legacy MVP rules.
 *
 * Nearest points on lines are found on great-circle arcs in both models, as
 * PostGIS and Turf do.
 */
export type DistanceModel = 'wgs84' | 'sphere';

/** Default {@link DistanceModel} of the SDK. */
export const DEFAULT_DISTANCE_MODEL: DistanceModel = 'wgs84';

/** WGS 84 semi-major axis, metres. */
export const WGS84_SEMI_MAJOR_AXIS_M = 6_378_137;

/** WGS 84 flattening. */
export const WGS84_FLATTENING = 1 / 298.257_223_563;

/** WGS 84 semi-minor axis, metres. */
export const WGS84_SEMI_MINOR_AXIS_M =
  WGS84_SEMI_MAJOR_AXIS_M * (1 - WGS84_FLATTENING);

/** Mean Earth radius (IUGG R1), metres — Turf.js `earthRadius`. */
export const MEAN_EARTH_RADIUS_M = 6_371_008.8;

/** A unit vector on the sphere (`[x, y, z]`). */
type Vector = readonly [number, number, number];

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

const toRadians = (degrees: number): number => degrees * RAD;

/** Turf's `degreesToRadians` (same rounding, for bit-identical legacy distances). */
const turfRadians = (degrees: number): number =>
  ((degrees % 360) * Math.PI) / 180;
const toDegrees = (radians: number): number => radians * DEG;

/**
 * Great-circle distance on a sphere (haversine), metres. Same operations as
 * `@turf/distance` 7 so that legacy thresholds keep their exact behaviour.
 */
export function haversineMeters(
  from: GeoPoint,
  to: GeoPoint,
  radiusM: number = MEAN_EARTH_RADIUS_M,
): number {
  const dLat = turfRadians(to.lat - from.lat);
  const dLon = turfRadians(to.lon - from.lon);
  const lat1 = turfRadians(from.lat);
  const lat2 = turfRadians(to.lat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * radiusM;
}

/**
 * Geodesic distance on the WGS 84 ellipsoid (Vincenty's inverse formula),
 * metres; sub-millimetre agreement with PostGIS/GeographicLib for
 * non-antipodal points. Nearly antipodal points, where the iteration does
 * not converge, fall back to the haversine distance.
 */
export function vincentyMeters(from: GeoPoint, to: GeoPoint): number {
  const a = WGS84_SEMI_MAJOR_AXIS_M;
  const b = WGS84_SEMI_MINOR_AXIS_M;
  const f = WGS84_FLATTENING;
  const L = toRadians(to.lon - from.lon);
  const U1 = Math.atan((1 - f) * Math.tan(toRadians(from.lat)));
  const U2 = Math.atan((1 - f) * Math.tan(toRadians(to.lat)));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 +
        (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0; // coincident points
    const cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    const sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    const cos2Alpha = 1 - sinAlpha * sinAlpha;
    // Equatorial line: cos²α = 0.
    const cos2SigmaM =
      cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const previous = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma +
          C *
            sinSigma *
            (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - previous) < 1e-12) {
      const u2 = (cos2Alpha * (a * a - b * b)) / (b * b);
      const A =
        1 + (u2 / 16_384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
      const B = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
      const deltaSigma =
        B *
        sinSigma *
        (cos2SigmaM +
          (B / 4) *
            (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
              (B / 6) *
                cos2SigmaM *
                (-3 + 4 * sinSigma * sinSigma) *
                (-3 + 4 * cos2SigmaM * cos2SigmaM)));
      return b * A * (sigma - deltaSigma);
    }
  }
  return haversineMeters(from, to);
}

/** Distance between two points in the given model, metres. */
export function geodesicDistanceM(
  from: GeoPoint,
  to: GeoPoint,
  model: DistanceModel = DEFAULT_DISTANCE_MODEL,
): number {
  return model === 'sphere'
    ? haversineMeters(from, to)
    : vincentyMeters(from, to);
}

/** Initial great-circle bearing from `from` to `to`, degrees clockwise from north in `[0, 360)`. */
export function initialBearingDeg(from: GeoPoint, to: GeoPoint): number {
  const lat1 = toRadians(from.lat);
  const lat2 = toRadians(to.lat);
  const dLon = toRadians(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Point at `fraction` (0 … 1) of the great-circle arc from `start` to
 * `end` (spherical linear interpolation). Used to densify long polygon
 * edges so lon/lat containment follows the great circles of PostGIS
 * `geography`.
 */
export function interpolateGreatCircle(
  start: GeoPoint,
  end: GeoPoint,
  fraction: number,
): GeoPoint {
  const lat1 = toRadians(start.lat);
  const lon1 = toRadians(start.lon);
  const lat2 = toRadians(end.lat);
  const lon2 = toRadians(end.lon);
  const a = [Math.cos(lat1) * Math.cos(lon1), Math.cos(lat1) * Math.sin(lon1), Math.sin(lat1)] as const;
  const b = [Math.cos(lat2) * Math.cos(lon2), Math.cos(lat2) * Math.sin(lon2), Math.sin(lat2)] as const;
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-12) return { lat: start.lat, lon: start.lon };
  const wa = Math.sin((1 - fraction) * omega) / Math.sin(omega);
  const wb = Math.sin(fraction * omega) / Math.sin(omega);
  const x = wa * a[0] + wb * b[0];
  const y = wa * a[1] + wb * b[1];
  const z = wa * a[2] + wb * b[2];
  return {
    lat: toDegrees(Math.atan2(z, Math.hypot(x, y))),
    lon: toDegrees(Math.atan2(y, x)),
  };
}

/**
 * Point reached from `origin` after `distanceM` along the great circle with
 * initial bearing `bearingDeg` (sphere of {@link MEAN_EARTH_RADIUS_M}).
 */
export function destinationPoint(
  origin: GeoPoint,
  bearingDeg: number,
  distanceM: number,
): GeoPoint {
  const delta = distanceM / MEAN_EARTH_RADIUS_M;
  const theta = toRadians(bearingDeg);
  const lat1 = toRadians(origin.lat);
  const lon1 = toRadians(origin.lon);
  const sinLat2 =
    Math.sin(lat1) * Math.cos(delta) +
    Math.cos(lat1) * Math.sin(delta) * Math.cos(theta);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * sinLat2,
    );
  return { lat: toDegrees(lat2), lon: ((toDegrees(lon2) + 540) % 360) - 180 };
}

function toVector(point: GeoPoint): Vector {
  const lat = toRadians(point.lat);
  const lon = toRadians(point.lon);
  return [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
}

function toPoint(vector: Vector): GeoPoint {
  const [x, y, z] = vector;
  return {
    lat: toDegrees(Math.asin(Math.max(-1, Math.min(1, z)))),
    lon: toDegrees(Math.atan2(y, x)),
  };
}

function cross(a: Vector, b: Vector): Vector {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vector, b: Vector): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function norm(a: Vector): number {
  return Math.sqrt(dot(a, a));
}

/** Angle between two unit vectors, radians (robust for tiny angles). */
function angleBetween(a: Vector, b: Vector): number {
  return Math.atan2(norm(cross(a, b)), dot(a, b));
}

/**
 * Nearest point to `point` on the great-circle arc from `start` to `end`
 * (the shorter arc), computed on the unit sphere as PostGIS and Turf.js do.
 */
export function nearestPointOnArc(
  point: GeoPoint,
  start: GeoPoint,
  end: GeoPoint,
): GeoPoint {
  const a = toVector(start);
  const b = toVector(end);
  const p = toVector(point);
  const normal = cross(a, b);
  const length = norm(normal);
  if (length < 1e-15) {
    // Degenerate arc (start = end, or antipodal): the closer endpoint.
    return angleBetween(p, a) <= angleBetween(p, b) ? start : end;
  }
  const n: Vector = [
    normal[0] / length,
    normal[1] / length,
    normal[2] / length,
  ];
  const offset = dot(p, n);
  const projected: Vector = [
    p[0] - offset * n[0],
    p[1] - offset * n[1],
    p[2] - offset * n[2],
  ];
  const projectedLength = norm(projected);
  if (projectedLength < 1e-15) {
    // The point is a pole of the arc's great circle: every arc point is equidistant.
    return start;
  }
  const c: Vector = [
    projected[0] / projectedLength,
    projected[1] / projectedLength,
    projected[2] / projectedLength,
  ];
  // c is on the arc when it lies between a and b (same side of both ends).
  if (dot(cross(a, c), n) >= 0 && dot(cross(c, b), n) >= 0) return toPoint(c);
  return angleBetween(p, a) <= angleBetween(p, b) ? start : end;
}

/** Distance from a point to a great-circle arc, with the nearest arc point. */
export interface ArcDistance {
  /** Metres, in the requested {@link DistanceModel}. */
  readonly distanceM: number;
  /** Nearest point of the arc. */
  readonly nearest: GeoPoint;
}

/** Distance from `point` to the great-circle arc `start`–`end`. */
export function distanceToArc(
  point: GeoPoint,
  start: GeoPoint,
  end: GeoPoint,
  model: DistanceModel = DEFAULT_DISTANCE_MODEL,
): ArcDistance {
  const nearest = nearestPointOnArc(point, start, end);
  return { distanceM: geodesicDistanceM(point, nearest, model), nearest };
}

/**
 * Bounding box of a great-circle arc: the box of its ends, extended to the
 * latitude extremum when the arc bulges past it (long east–west edges).
 */
export function arcBBox(start: GeoPoint, end: GeoPoint): BBox {
  let minLat = Math.min(start.lat, end.lat);
  let maxLat = Math.max(start.lat, end.lat);
  const a = toVector(start);
  const b = toVector(end);
  const normal = cross(a, b);
  const length = norm(normal);
  if (length > 1e-15) {
    const n: Vector = [
      normal[0] / length,
      normal[1] / length,
      normal[2] / length,
    ];
    // Highest point of the great circle: the north pole projected on its plane.
    const top: Vector = [-n[2] * n[0], -n[2] * n[1], 1 - n[2] * n[2]];
    const topLength = norm(top);
    if (topLength > 1e-15) {
      const highest: Vector = [
        top[0] / topLength,
        top[1] / topLength,
        top[2] / topLength,
      ];
      const lowest: Vector = [-highest[0], -highest[1], -highest[2]];
      for (const extremum of [highest, lowest]) {
        if (
          dot(cross(a, extremum), n) >= 0 &&
          dot(cross(extremum, b), n) >= 0
        ) {
          const lat = toPoint(extremum).lat;
          minLat = Math.min(minLat, lat);
          maxLat = Math.max(maxLat, lat);
        }
      }
    }
  }
  return [
    Math.min(start.lon, end.lon),
    minLat,
    Math.max(start.lon, end.lon),
    maxLat,
  ];
}

/**
 * Conservative metres per degree of latitude (the smallest meridian degree of
 * WGS 84 and below the spherical value), so that boxes built from it always
 * contain the circle.
 */
const MIN_METERS_PER_DEGREE_LAT = 110_500;

/** Conservative metres per degree of longitude at the equator (both models). */
const MIN_METERS_PER_DEGREE_LON_EQUATOR = 111_000;

/** Latitude beyond which a search box spans every longitude. */
const POLAR_LATITUDE = 89.5;

/**
 * A lon/lat box that contains every point within `radiusM` of `center` (in
 * both distance models), clamped to valid coordinates. Boxes reaching a pole
 * span all longitudes; the box may extend past ±180° in longitude when the
 * circle crosses the antimeridian (callers wrap if they support it).
 */
export function searchBox(center: GeoPoint, radiusM: number): BBox {
  const radius = Math.max(0, radiusM) * 1.01 + 1;
  const dLat = radius / MIN_METERS_PER_DEGREE_LAT;
  const minLat = Math.max(-90, center.lat - dLat);
  const maxLat = Math.min(90, center.lat + dLat);
  const extremeLat = Math.max(Math.abs(minLat), Math.abs(maxLat));
  if (extremeLat >= POLAR_LATITUDE) return [-180, minLat, 180, maxLat];
  const dLon =
    radius /
    (MIN_METERS_PER_DEGREE_LON_EQUATOR * Math.cos(toRadians(extremeLat)));
  if (dLon >= 180) return [-180, minLat, 180, maxLat];
  return [center.lon - dLon, minLat, center.lon + dLon, maxLat];
}

/** `true` when two boxes overlap (edges included). */
export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
