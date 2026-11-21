import { describe, expect, it } from 'vitest';

import type { BBox } from '../domain/geo.js';
import {
  REALTIME_ALL_TILES_BATCH_INTERVAL_MS,
  REALTIME_MAX_TILES,
  REALTIME_PATH,
  REALTIME_TILE_BATCH_INTERVAL_MS,
  REALTIME_TILE_ZOOM,
} from './constants.js';
import {
  ALL_TILES_ROOM,
  AUTHORITY_ROOM,
  orgRoom,
  parseTileRoom,
  roomForTile,
  roomsForViewport,
  tileRoom,
  tileRoomForPosition,
  userRoom,
  vesselRoom,
} from './rooms.js';
import {
  lonLatToTile,
  tileCount,
  tileRangeForBbox,
  tilesForBbox,
  WEB_MERCATOR_MAX_LATITUDE,
} from './tiles.js';

const JAKARTA = { lon: 106.8456, lat: -6.2088 };
const BATAM = { lon: 104.0305, lat: 1.1301 };

/** Independent slippy-map formula (OSM wiki, asinh form) used as the oracle. */
const referenceTile = (lon: number, lat: number, z: number) => {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n),
    z,
  };
};

describe('realtime constants (spec 9)', () => {
  it('fixes the path, zoom, tile cap and batch intervals', () => {
    expect(REALTIME_PATH).toBe('/ws');
    expect(REALTIME_TILE_ZOOM).toBe(6);
    expect(REALTIME_MAX_TILES).toBe(64);
    expect(REALTIME_TILE_BATCH_INTERVAL_MS).toBe(1000);
    expect(REALTIME_ALL_TILES_BATCH_INTERVAL_MS).toBe(5000);
  });
});

describe('lonLatToTile', () => {
  it('finds the known zoom-6 tiles of Jakarta and Batam', () => {
    expect(lonLatToTile(JAKARTA.lon, JAKARTA.lat, 6)).toEqual({
      x: 50,
      y: 33,
      z: 6,
    });
    expect(lonLatToTile(BATAM.lon, BATAM.lat, 6)).toEqual({
      x: 50,
      y: 31,
      z: 6,
    });
    expect(lonLatToTile(JAKARTA.lon, JAKARTA.lat, 10)).toEqual({
      x: 815,
      y: 529,
      z: 10,
    });
    expect(lonLatToTile(0, 0, 1)).toEqual({ x: 1, y: 1, z: 1 });
    expect(lonLatToTile(123.4, 56.7, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('agrees with the reference formula across Indonesian waters', () => {
    for (let index = 0; index < 500; index += 1) {
      const lon = 94 + ((index * 7919) % 4800) / 100;
      const lat = -11 + ((index * 104729) % 1800) / 100;
      for (const z of [0, 4, 6, 12, 18]) {
        expect(lonLatToTile(lon, lat, z)).toEqual(referenceTile(lon, lat, z));
      }
    }
  });

  it('clamps to the world edges and Web Mercator limits', () => {
    expect(WEB_MERCATOR_MAX_LATITUDE).toBeCloseTo(85.0511287798066, 12);
    expect(lonLatToTile(180, 0, 6).x).toBe(63);
    expect(lonLatToTile(-180, 0, 6).x).toBe(0);
    expect(lonLatToTile(0, 90, 6).y).toBe(0);
    expect(lonLatToTile(0, -90, 6).y).toBe(63);
    expect(lonLatToTile(200, 89.99, 6)).toEqual({ x: 63, y: 0, z: 6 });
  });

  it('rejects invalid zoom levels and NaN', () => {
    expect(() => lonLatToTile(0, 0, -1)).toThrow(RangeError);
    expect(() => lonLatToTile(0, 0, 6.5)).toThrow(RangeError);
    expect(() => lonLatToTile(0, 0, 25)).toThrow(RangeError);
    expect(() => lonLatToTile(Number.NaN, 0, 6)).toThrow(RangeError);
  });
});

describe('tilesForBbox', () => {
  it('covers a box from the north-west corner, row by row', () => {
    const strait: BBox = [103.5, -1, 107.5, 1.5];
    expect(tileRangeForBbox(strait, 6)).toEqual({
      z: 6,
      minX: 50,
      maxX: 51,
      minY: 31,
      maxY: 32,
    });
    expect(tilesForBbox(strait, 6)).toEqual([
      { x: 50, y: 31, z: 6 },
      { x: 51, y: 31, z: 6 },
      { x: 50, y: 32, z: 6 },
      { x: 51, y: 32, z: 6 },
    ]);
  });

  it('returns one tile for a point box and for Batam island', () => {
    expect(
      tilesForBbox([BATAM.lon, BATAM.lat, BATAM.lon, BATAM.lat], 6),
    ).toEqual([{ x: 50, y: 31, z: 6 }]);
    expect(tilesForBbox([103.85, 0.95, 104.25, 1.25], 6)).toEqual([
      { x: 50, y: 31, z: 6 },
    ]);
  });

  it('covers the whole world at zoom 6 with 4096 tiles, clamping polar latitudes', () => {
    const world: BBox = [-180, -90, 180, 90];
    expect(tileCount(tileRangeForBbox(world, 6))).toBe(4096);
    expect(tilesForBbox(world, 6)).toHaveLength(4096);
  });

  it('rejects antimeridian-crossing and inverted boxes', () => {
    expect(() => tilesForBbox([170, -10, -170, 10], 6)).toThrow(RangeError);
    expect(() => tilesForBbox([100, 5, 110, -5], 6)).toThrow(RangeError);
  });

  it('refuses to enumerate absurd tile counts', () => {
    expect(() => tilesForBbox([-180, -85, 180, 85], 20)).toThrow(RangeError);
  });
});

describe('rooms', () => {
  it('names tile rooms tile:<z>:<x>:<y> and parses them back', () => {
    expect(tileRoom(50, 33)).toBe('tile:6:50:33');
    expect(roomForTile({ x: 1, y: 2, z: 3 })).toBe('tile:3:1:2');
    expect(tileRoomForPosition(JAKARTA.lon, JAKARTA.lat)).toBe('tile:6:50:33');
    expect(parseTileRoom('tile:6:50:33')).toEqual({ x: 50, y: 33, z: 6 });
    expect(parseTileRoom(ALL_TILES_ROOM)).toBeNull();
    expect(parseTileRoom('tile:6:64:0')).toBeNull();
    expect(parseTileRoom('vessel:525005223')).toBeNull();
    expect(() => tileRoom(64, 0)).toThrow(RangeError);
    expect(() => tileRoom(-1, 0)).toThrow(RangeError);
  });

  it('joins zoom-6 tiles for a regional viewport', () => {
    const indonesia: BBox = [94.5, -11.5, 141.5, 6.5];
    const result = roomsForViewport(indonesia);
    expect(result.mode).toBe('tiles');
    expect(result.rooms).toHaveLength(50);
    expect(result.rooms).toContain('tile:6:50:33');
    expect(result.rooms).toContain('tile:6:50:31');
    expect(new Set(result.rooms).size).toBe(result.rooms.length);
  });

  it('falls back to tile:all above 64 tiles', () => {
    expect(roomsForViewport([80, -20, 150, 20])).toEqual({
      mode: 'all',
      rooms: ['tile:all'],
    });
    expect(roomsForViewport([-180, -90, 180, 90]).mode).toBe('all');
  });

  it('names user, organization, authority and vessel rooms', () => {
    expect(userRoom('u1')).toBe('user:u1');
    expect(orgRoom('o1')).toBe('org:o1');
    expect(AUTHORITY_ROOM).toBe('authority');
    expect(vesselRoom(525005223)).toBe('vessel:525005223');
    expect(() => vesselRoom(5250)).toThrow(RangeError);
  });
});
