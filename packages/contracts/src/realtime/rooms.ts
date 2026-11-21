import { isValidMmsi } from '../domain/ais.js';
import type { BBox } from '../domain/geo.js';
import { REALTIME_MAX_TILES, REALTIME_TILE_ZOOM } from './constants.js';
import {
  lonLatToTile,
  MAX_TILE_ZOOM,
  type TileCoord,
  tileCount,
  tileRangeForBbox,
  tilesForBbox,
} from './tiles.js';

/** Room receiving `positions` batches for every vessel (every 5 s). */
export const ALL_TILES_ROOM = 'tile:all';

/** Room of users with cross-tenant surveillance access (authority, super_admin). */
export const AUTHORITY_ROOM = 'authority';

/**
 * Room of a tile: `tile:<z>:<x>:<y>`.
 *
 * @throws {RangeError} when the tile indices are outside the zoom level.
 */
export function roomForTile(tile: TileCoord): string {
  const tiles = 2 ** tile.z;
  const valid = (index: number): boolean =>
    Number.isInteger(index) && index >= 0 && index < tiles;
  if (
    !Number.isInteger(tile.z) ||
    tile.z < 0 ||
    tile.z > MAX_TILE_ZOOM ||
    !valid(tile.x) ||
    !valid(tile.y)
  ) {
    throw new RangeError(`Invalid tile ${tile.z}/${tile.x}/${tile.y}`);
  }
  return `tile:${tile.z}:${tile.x}:${tile.y}`;
}

/** Room of a realtime tile at {@link REALTIME_TILE_ZOOM}: `tile:6:<x>:<y>`. */
export function tileRoom(x: number, y: number): string {
  return roomForTile({ x, y, z: REALTIME_TILE_ZOOM });
}

/** Realtime tile room that receives a position. */
export function tileRoomForPosition(lon: number, lat: number): string {
  return roomForTile(lonLatToTile(lon, lat, REALTIME_TILE_ZOOM));
}

const TILE_ROOM_PATTERN = /^tile:(\d{1,2}):(\d{1,8}):(\d{1,8})$/;

/**
 * Parses a tile room name.
 *
 * @returns the tile, or `null` for other rooms (including `tile:all`).
 */
export function parseTileRoom(room: string): TileCoord | null {
  const match = TILE_ROOM_PATTERN.exec(room);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined
  ) {
    return null;
  }
  const tile = {
    z: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
  };
  if (tile.z > MAX_TILE_ZOOM) return null;
  const tiles = 2 ** tile.z;
  return tile.x < tiles && tile.y < tiles ? tile : null;
}

/** Rooms a viewport joins. */
export type ViewportRooms =
  | { readonly mode: 'tiles'; readonly rooms: readonly string[] }
  | { readonly mode: 'all'; readonly rooms: readonly [typeof ALL_TILES_ROOM] };

/**
 * Rooms for a viewport (spec 9): the zoom-6 tiles covering the box, or
 * `tile:all` when more than {@link REALTIME_MAX_TILES} tiles are needed.
 *
 * @throws {RangeError} for an inverted or antimeridian-crossing box.
 */
export function roomsForViewport(bbox: BBox): ViewportRooms {
  const range = tileRangeForBbox(bbox, REALTIME_TILE_ZOOM);
  if (tileCount(range) > REALTIME_MAX_TILES) {
    return { mode: 'all', rooms: [ALL_TILES_ROOM] };
  }
  return {
    mode: 'tiles',
    rooms: tilesForBbox(bbox, REALTIME_TILE_ZOOM).map(roomForTile),
  };
}

/** Personal room of a user: `user:<userId>`. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Room of an organization: `org:<orgId>`. */
export function orgRoom(orgId: string): string {
  return `org:${orgId}`;
}

/**
 * Room of one vessel: `vessel:<mmsi>`.
 *
 * @throws {RangeError} when `mmsi` is not a 9-digit integer.
 */
export function vesselRoom(mmsi: number): string {
  if (!isValidMmsi(mmsi)) {
    throw new RangeError(
      `Invalid MMSI ${mmsi}: expected an integer with 9 digits`,
    );
  }
  return `vessel:${mmsi}`;
}
