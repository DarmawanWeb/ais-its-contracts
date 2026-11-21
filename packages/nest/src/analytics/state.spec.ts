import { describe, expect, it } from 'vitest';

import { destinationPoint, geodesicDistanceM } from './geodesy.js';
import { type PairPoint, PairSearch } from './pair-search.js';
import { TrackBuffer } from './track-buffer.js';
import type { VesselPosition } from './vessel-position.js';
import {
  type VesselState,
  type VesselStateMirror,
  VesselStateStore,
} from './vessel-state-store.js';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

function position(
  mmsi: number,
  seconds: number,
  lat = 1.1,
  lon = 104,
): VesselPosition {
  return {
    mmsi,
    time: at(seconds),
    source: 'primary',
    lat,
    lon,
    sog: 10,
    cog: 90,
    hdg: 90,
    navstatus: 0,
    predictedNavstatus: 0,
    coastDistanceM: null,
    previous: null,
  };
}

describe('PairSearch', () => {
  const point = (
    mmsi: number,
    lat: number,
    lon: number,
    seconds = 0,
  ): PairPoint => ({ mmsi, lat, lon, time: at(seconds) });

  it('finds neighbours within the radius and time window, nearest first, with geodesic distances', () => {
    const search = new PairSearch({
      cellSizeM: 1_000,
      maxAgeMs: 120_000,
      clock: () => at(60),
    });
    const origin = { lat: 1.1, lon: 104 };
    const east = destinationPoint(origin, 90, 500);
    const north = destinationPoint(origin, 0, 2_500);
    const far = destinationPoint(origin, 45, 9_000);
    search.upsert(point(1, origin.lat, origin.lon));
    search.upsert(point(2, east.lat, east.lon));
    search.upsert(point(3, north.lat, north.lon));
    search.upsert(point(4, far.lat, far.lon));
    search.upsert(point(5, north.lat, north.lon, -200)); // outside the 2 min window

    const found = search.neighbours({ ...origin, mmsi: 1 }, { radiusM: 3_000 });
    expect(found.map((neighbour) => neighbour.point.mmsi)).toEqual([2, 3]);
    expect(found[0]?.distanceM).toBeCloseTo(geodesicDistanceM(origin, east), 6);
    expect(
      search.neighbours(origin, { radiusM: 3_000 }).map((n) => n.point.mmsi),
    ).toEqual([1, 2, 3]);
    expect(
      search.neighbours(origin, { radiusM: 10_000, limit: 2 }),
    ).toHaveLength(2);
    expect(
      search
        .neighbours(origin, { radiusM: 3_000, maxAgeMs: 1_000_000 })
        .map((n) => n.point.mmsi),
    ).toContain(5);
  });

  it('moves points between cells, ignores older points and removes vessels', () => {
    const search = new PairSearch({ cellSizeM: 500, clock: () => at(10) });
    search.upsert(point(7, 1.1, 104, 5));
    expect(search.upsert(point(7, 1.3, 104.3, 1))).toBe(false);
    expect(search.upsert(point(7, 1.2, 104.2, 6))).toBe(true);
    expect(
      search.neighbours({ lat: 1.1, lon: 104 }, { radiusM: 1_000 }),
    ).toEqual([]);
    expect(
      search.neighbours({ lat: 1.2, lon: 104.2 }, { radiusM: 1_000 }),
    ).toHaveLength(1);
    expect(search.remove(7)).toBe(true);
    expect(search.size).toBe(0);
  });

  it('lists each close pair once and wraps at the antimeridian', () => {
    const search = new PairSearch({ cellSizeM: 2_000, clock: () => at(0) });
    search.upsert(point(10, -16.5, 179.995));
    search.upsert(point(11, -16.5, -179.995)); // ~1.07 km across the antimeridian
    search.upsert(point(12, -16.5, 179.9));
    const pairs = search.pairs({ radiusM: 2_000 });
    expect(pairs.map((pair) => [pair.a.mmsi, pair.b.mmsi])).toEqual([[10, 11]]);
    expect(pairs[0]?.distanceM).toBeGreaterThan(1_000);
    expect(pairs[0]?.distanceM).toBeLessThan(1_100);
  });

  it('prunes points older than the window', () => {
    const search = new PairSearch({ maxAgeMs: 60_000, clock: () => at(120) });
    search.upsert(point(1, 1, 104, 0));
    search.upsert(point(2, 1, 104, 100));
    expect(search.prune()).toBe(1);
    expect(search.get(2)).toBeDefined();
  });
});

describe('TrackBuffer', () => {
  it('keeps the newest points within the point and age limits', () => {
    const tracks = new TrackBuffer<VesselPosition>({
      maxPoints: 3,
      maxAgeMs: 100_000,
    });
    for (const seconds of [0, 10, 20, 30])
      expect(tracks.push(1, position(1, seconds))).toBe(true);
    expect(tracks.points(1).map((p) => p.time.getTime())).toEqual(
      [10, 20, 30].map((s) => at(s).getTime()),
    );
    expect(tracks.push(1, position(1, 30))).toBe(false); // duplicate
    expect(tracks.push(1, position(1, 5))).toBe(false); // out of order
    tracks.push(1, position(1, 200)); // the others are older than 100 s
    expect(tracks.length(1)).toBe(1);
    expect(tracks.last(1)?.time).toEqual(at(200));
  });

  it('filters by time, returns tails and prunes idle vessels', () => {
    const tracks = new TrackBuffer({
      maxPoints: 10,
      maxAgeMs: 60_000,
      maxVessels: 2,
    });
    for (const seconds of [0, 10, 20]) tracks.push(1, { time: at(seconds) });
    expect(tracks.points(1, { since: at(10) })).toHaveLength(2);
    expect(tracks.tail(1, 2).map((p) => p.time)).toEqual([at(10), at(20)]);
    expect(tracks.tail(1, 0)).toEqual([]);
    tracks.push(2, { time: at(100) });
    tracks.push(3, { time: at(100) }); // evicts the least recently updated vessel (1)
    expect(tracks.has(1)).toBe(false);
    expect(tracks.prune(at(200))).toBe(2);
    expect(tracks.vesselCount).toBe(0);
  });
});

describe('VesselStateStore', () => {
  it('keeps the newest state per vessel and reports stale positions', () => {
    const store = new VesselStateStore({
      clock: () => at(100),
      staleAfterMs: 60_000,
    });
    expect(store.upsert(position(1, 10)).outcome).toBe('created');
    expect(store.upsert(position(1, 20)).outcome).toBe('updated');
    expect(store.upsert(position(1, 20)).outcome).toBe('stale');
    expect(store.upsert(position(1, 15)).outcome).toBe('stale');
    expect(store.get(1)?.time).toEqual(at(20));
    expect(store.get(1)?.receivedAt).toEqual(at(100));
    expect(store.isStale(1)).toBe(true); // 80 s old
    expect(store.isStale(1, { maxAgeMs: 90_000 })).toBe(false);
    expect(store.isStale(2)).toBe(true);
    store.upsert(position(2, 95));
    expect(store.fresh().map((state) => state.mmsi)).toEqual([2]);
    expect(store.staleSince().map((state) => state.mmsi)).toEqual([1]);
  });

  it('notifies evictions and deletions, and mirrors writes', async () => {
    const saved: VesselState[] = [];
    const removed: number[] = [];
    const mirror: VesselStateMirror = {
      save: (state) => {
        saved.push(state);
        return Promise.resolve();
      },
      remove: (mmsi) => {
        removed.push(mmsi);
        return Promise.resolve();
      },
      loadAll: () =>
        Promise.resolve([{ ...position(9, 50), receivedAt: at(50) }]),
    };
    const store = new VesselStateStore({
      maxVessels: 2,
      mirror,
      clock: () => at(60),
    });
    const evicted: number[] = [];
    store.onRemoved((state) => evicted.push(state.mmsi));
    store.upsert(position(1, 1));
    store.upsert(position(2, 2));
    store.upsert(position(3, 3));
    expect(evicted).toEqual([1]);
    expect(store.delete(2)).toBe(true);
    expect(evicted).toEqual([1, 2]);
    await store.flush();
    expect(saved.map((state) => state.mmsi)).toEqual([1, 2, 3]);
    expect(removed).toEqual([2]);
    expect(await store.warmUp()).toBe(1);
    expect(store.get(9)?.time).toEqual(at(50));
  });

  it('reports mirror failures without failing upserts', async () => {
    const errors: unknown[] = [];
    const store = new VesselStateStore({
      mirror: {
        save: () => Promise.reject(new Error('down')),
        remove: () => Promise.resolve(),
        loadAll: () => Promise.resolve([]),
      },
      onError: (error) => errors.push(error),
    });
    expect(store.upsert(position(1, 1)).outcome).toBe('created');
    await store.flush();
    expect(errors).toHaveLength(1);
  });
});
