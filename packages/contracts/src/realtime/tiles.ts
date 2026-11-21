import type { BBox } from '../domain/geo.js';

/** A slippy-map (XYZ, Web Mercator) tile. */
export interface TileCoord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Inclusive tile index range covering a box at one zoom level. */
export interface TileRange {
  readonly z: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Latitude limit of Web Mercator: `atan(sinh(π))` in degrees. */
export const WEB_MERCATOR_MAX_LATITUDE =
  (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;

/** Highest zoom level accepted by the tile helpers. */
export const MAX_TILE_ZOOM = 24;

/** Most tiles {@link tilesForBbox} enumerates before refusing. */
export const TILE_ENUMERATION_LIMIT = 65_536;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

function assertZoom(z: number): void {
  if (!Number.isInteger(z) || z < 0 || z > MAX_TILE_ZOOM) {
    throw new RangeError(
      `Invalid zoom ${z}: expected an integer 0..${MAX_TILE_ZOOM}`,
    );
  }
}

function assertCoordinate(lon: number, lat: number): void {
  if (Number.isNaN(lon) || Number.isNaN(lat)) {
    throw new RangeError('Invalid coordinate: NaN');
  }
}

/**
 * Tile containing a position. Longitude is clamped to `[-180, 180]` and
 * latitude to the Web Mercator limits (±85.0511°); positions on the east /
 * south edge fall into the last tile.
 *
 * @throws {RangeError} for a non-integer zoom outside `0..24` or `NaN` input.
 *
 * @example lonLatToTile(106.8456, -6.2088, 6) // Jakarta → { x: 50, y: 33, z: 6 }
 */
export function lonLatToTile(lon: number, lat: number, z: number): TileCoord {
  assertZoom(z);
  assertCoordinate(lon, lat);
  const tiles = 2 ** z;
  const clampedLon = clamp(lon, -180, 180);
  const clampedLat = clamp(
    lat,
    -WEB_MERCATOR_MAX_LATITUDE,
    WEB_MERCATOR_MAX_LATITUDE,
  );
  const latRad = (clampedLat * Math.PI) / 180;

  const x = Math.floor(((clampedLon + 180) / 360) * tiles);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      tiles,
  );
  return { x: clamp(x, 0, tiles - 1), y: clamp(y, 0, tiles - 1), z };
}

/**
 * Tile index range covering a box (which must not cross the antimeridian).
 *
 * @throws {RangeError} for an invalid zoom, `NaN` corners or `minLon > maxLon` / `minLat > maxLat`.
 */
export function tileRangeForBbox(bbox: BBox, z: number): TileRange {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  assertCoordinate(minLon, minLat);
  assertCoordinate(maxLon, maxLat);
  if (minLon > maxLon || minLat > maxLat) {
    throw new RangeError(
      'Invalid bbox: expected minLon <= maxLon and minLat <= maxLat (antimeridian-crossing boxes are not supported)',
    );
  }
  // The north-west corner holds the smallest tile indices (y grows southwards).
  const northWest = lonLatToTile(minLon, maxLat, z);
  const southEast = lonLatToTile(maxLon, minLat, z);
  return {
    z,
    minX: northWest.x,
    maxX: southEast.x,
    minY: northWest.y,
    maxY: southEast.y,
  };
}

/** Number of tiles in a range. */
export function tileCount(range: TileRange): number {
  return (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
}

/**
 * Every tile covering a box, row by row from the north-west corner.
 *
 * @throws {RangeError} like {@link tileRangeForBbox}, or when more than
 * {@link TILE_ENUMERATION_LIMIT} tiles would be returned.
 */
export function tilesForBbox(bbox: BBox, z: number): TileCoord[] {
  const range = tileRangeForBbox(bbox, z);
  const count = tileCount(range);
  if (count > TILE_ENUMERATION_LIMIT) {
    throw new RangeError(
      `Box covers ${count} tiles at zoom ${z} (limit ${TILE_ENUMERATION_LIMIT})`,
    );
  }
  const tiles: TileCoord[] = [];
  for (let y = range.minY; y <= range.maxY; y += 1) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      tiles.push({ x, y, z });
    }
  }
  return tiles;
}
