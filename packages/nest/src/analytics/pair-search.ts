import type { GeoPoint } from '@darmawanweb/ais-its-contracts/domain';

import {
  DEFAULT_DISTANCE_MODEL,
  type DistanceModel,
  geodesicDistanceM,
  searchBox,
} from './geodesy.js';

/** What the pair search indexes: a vessel's position at a time. */
export interface PairPoint extends GeoPoint {
  readonly mmsi: number;
  readonly time: Date;
}

/** A neighbour found by {@link PairSearch.neighbours}. */
export interface Neighbour<Point extends PairPoint> {
  readonly point: Point;
  /** Metres, in the search's distance model. */
  readonly distanceM: number;
}

/** A pair found by {@link PairSearch.pairs} (`a.mmsi < b.mmsi`). */
export interface Pair<Point extends PairPoint> {
  readonly a: Point;
  readonly b: Point;
  readonly distanceM: number;
}

/** Options of {@link PairSearch}. */
export interface PairSearchOptions {
  /** Grid cell size, metres (about the typical query radius). Default 1 852 (1 nm). */
  readonly cellSizeM?: number | undefined;
  /** Default time window of queries: points further than this from the reference time are ignored, ms. Default 2 min. */
  readonly maxAgeMs?: number | undefined;
  /** Default `'wgs84'`. */
  readonly distanceModel?: DistanceModel | undefined;
  /**
   * Wall clock: only bounds how far ahead of it a point's time may move the
   * index's event time (bogus future timestamps). Default `() => new Date()`.
   */
  readonly clock?: (() => Date) | undefined;
}

/** Options of a neighbour query. */
export interface NeighbourQuery<Point extends PairPoint> {
  /** Search radius, metres. */
  readonly radiusM: number;
  /** Only points seen within this window around the reference time, ms. Default: the search's `maxAgeMs`. */
  readonly maxAgeMs?: number | undefined;
  /**
   * Reference (event) time of the window. Default: the origin's `time` for
   * {@link PairSearch.neighbours}, else the newest indexed time
   * ({@link PairSearch.eventTime}) — never the wall clock, so a backlog is
   * searched as it happened.
   */
  readonly now?: Date | undefined;
  /** Additional predicate (e.g. "is moving"). */
  readonly filter?: ((point: Point) => boolean) | undefined;
  /** Nearest `limit` neighbours only. */
  readonly limit?: number | undefined;
}

const METERS_PER_DEGREE = 111_000;

/** How far ahead of the wall clock a point may move the event time, ms. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Neighbour queries within a radius and a time window over a uniform
 * lon/lat grid (spec §18), for pair detectors such as collision risk and
 * transhipment. Distances are geodesic (`'wgs84'` by default); the grid wraps
 * at the antimeridian and covers the poles.
 *
 * Time is event time: a neighbour query compares point times with the
 * origin's time (or `now`), and pruning keeps what lies within the window
 * of the newest indexed point, so a consumer catching up on a backlog sees
 * the neighbours that existed at the time of each position.
 *
 * @example
 * const pairs = new PairSearch<VesselState>({ cellSizeM: 2_000, maxAgeMs: 2 * 60_000 });
 * pairs.upsert(state);
 * for (const { point, distanceM } of pairs.neighbours({ ...state }, { radiusM: 6 * 1852 })) { … }
 */
export class PairSearch<Point extends PairPoint = PairPoint> {
  /** Grid cell size, metres. */
  readonly cellSizeM: number;
  /** Default time window, ms. */
  readonly maxAgeMs: number;
  /** Distance model of the queries. */
  readonly distanceModel: DistanceModel;
  private readonly cellDegrees: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly clock: () => Date;
  private readonly points = new Map<number, { point: Point; cell: number }>();
  private readonly cells = new Map<number, Set<number>>();
  private latest: number | undefined;

  constructor(options: PairSearchOptions = {}) {
    this.cellSizeM = options.cellSizeM ?? 1852;
    if (!(this.cellSizeM > 0))
      throw new RangeError('cellSizeM must be positive');
    this.maxAgeMs = options.maxAgeMs ?? 2 * 60_000;
    this.distanceModel = options.distanceModel ?? DEFAULT_DISTANCE_MODEL;
    this.clock = options.clock ?? (() => new Date());
    this.cellDegrees = Math.min(90, this.cellSizeM / METERS_PER_DEGREE);
    this.columns = Math.ceil(360 / this.cellDegrees);
    this.rows = Math.ceil(180 / this.cellDegrees);
  }

  /** Number of indexed points. */
  get size(): number {
    return this.points.size;
  }

  /** Newest indexed point time (event time), if any point was indexed. */
  get eventTime(): Date | undefined {
    return this.latest === undefined ? undefined : new Date(this.latest);
  }

  /** Adds or moves a vessel's point (the newest wins; older points are ignored). */
  upsert(point: Point): boolean {
    const existing = this.points.get(point.mmsi);
    if (
      existing !== undefined &&
      existing.point.time.getTime() > point.time.getTime()
    )
      return false;
    const cell = this.cellOf(point.lat, point.lon);
    if (existing !== undefined && existing.cell !== cell)
      this.leave(existing.cell, point.mmsi);
    this.points.set(point.mmsi, { point, cell });
    const time = Math.min(
      point.time.getTime(),
      this.clock().getTime() + MAX_FUTURE_SKEW_MS,
    );
    if (this.latest === undefined || time > this.latest) this.latest = time;
    let members = this.cells.get(cell);
    if (members === undefined) {
      members = new Set();
      this.cells.set(cell, members);
    }
    members.add(point.mmsi);
    return true;
  }

  /** Removes a vessel; `true` when it was indexed. */
  remove(mmsi: number): boolean {
    const existing = this.points.get(mmsi);
    if (existing === undefined) return false;
    this.points.delete(mmsi);
    this.leave(existing.cell, mmsi);
    return true;
  }

  /** The indexed point of a vessel. */
  get(mmsi: number): Point | undefined {
    return this.points.get(mmsi)?.point;
  }

  /**
   * Points within `radiusM` of `origin`, seen within the time window, nearest
   * first. The origin's own MMSI (when given) is excluded.
   */
  neighbours(
    origin: GeoPoint & { readonly mmsi?: number; readonly time?: Date },
    query: NeighbourQuery<Point>,
  ): Neighbour<Point>[] {
    const now = (query.now ?? origin.time ?? this.referenceTime()).getTime();
    const maxAge = query.maxAgeMs ?? this.maxAgeMs;
    const found: Neighbour<Point>[] = [];
    for (const mmsi of this.candidates(origin, query.radiusM)) {
      if (mmsi === origin.mmsi) continue;
      const entry = this.points.get(mmsi);
      if (entry === undefined) continue;
      const { point } = entry;
      if (Math.abs(now - point.time.getTime()) > maxAge) continue;
      if (query.filter !== undefined && !query.filter(point)) continue;
      const distanceM = geodesicDistanceM(origin, point, this.distanceModel);
      if (distanceM <= query.radiusM) found.push({ point, distanceM });
    }
    found.sort((a, b) => a.distanceM - b.distanceM);
    return query.limit === undefined
      ? found
      : found.slice(0, Math.max(0, query.limit));
  }

  /** Every pair of points within `radiusM` of each other (each pair once, `a.mmsi < b.mmsi`). */
  pairs(query: Omit<NeighbourQuery<Point>, 'limit'>): Pair<Point>[] {
    const now = query.now ?? this.referenceTime();
    const maxAge = query.maxAgeMs ?? this.maxAgeMs;
    const pairs: Pair<Point>[] = [];
    for (const { point } of this.points.values()) {
      if (Math.abs(now.getTime() - point.time.getTime()) > maxAge) continue;
      if (query.filter !== undefined && !query.filter(point)) continue;
      for (const neighbour of this.neighbours(point, { ...query, now })) {
        if (point.mmsi < neighbour.point.mmsi) {
          pairs.push({
            a: point,
            b: neighbour.point,
            distanceM: neighbour.distanceM,
          });
        }
      }
    }
    return pairs;
  }

  /**
   * Removes points older than `maxAgeMs` before `now` (default: the newest
   * indexed time, so a backlog keeps its neighbours); returns how many.
   */
  prune(
    now: Date = this.referenceTime(),
    maxAgeMs: number = this.maxAgeMs,
  ): number {
    const expired: number[] = [];
    for (const [mmsi, { point }] of this.points) {
      if (now.getTime() - point.time.getTime() > maxAgeMs) expired.push(mmsi);
    }
    for (const mmsi of expired) this.remove(mmsi);
    return expired.length;
  }

  /** Removes every point. */
  clear(): void {
    this.points.clear();
    this.cells.clear();
    this.latest = undefined;
  }

  /** Event time of queries without an explicit reference. */
  private referenceTime(): Date {
    return this.latest === undefined ? this.clock() : new Date(this.latest);
  }

  private leave(cell: number, mmsi: number): void {
    const members = this.cells.get(cell);
    if (members === undefined) return;
    members.delete(mmsi);
    if (members.size === 0) this.cells.delete(cell);
  }

  private row(lat: number): number {
    return Math.min(
      this.rows - 1,
      Math.max(0, Math.floor((lat + 90) / this.cellDegrees)),
    );
  }

  private column(lon: number): number {
    const wrapped = ((((lon + 180) % 360) + 360) % 360) / this.cellDegrees;
    return Math.min(this.columns - 1, Math.floor(wrapped));
  }

  private cellOf(lat: number, lon: number): number {
    return this.row(lat) * this.columns + this.column(lon);
  }

  /** MMSIs of the cells covering the circle (columns wrap at the antimeridian). */
  private *candidates(origin: GeoPoint, radiusM: number): Generator<number> {
    const [minLon, minLat, maxLon, maxLat] = searchBox(origin, radiusM);
    const firstRow = this.row(minLat);
    const lastRow = this.row(maxLat);
    // Unwrapped column numbers: the box may extend past ±180° of longitude.
    let firstColumn = Math.floor((minLon + 180) / this.cellDegrees);
    let lastColumn = Math.floor((maxLon + 180) / this.cellDegrees);
    if (lastColumn - firstColumn + 1 >= this.columns) {
      firstColumn = 0;
      lastColumn = this.columns - 1;
    }
    for (let row = firstRow; row <= lastRow; row += 1) {
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const wrapped = ((column % this.columns) + this.columns) % this.columns;
        const members = this.cells.get(row * this.columns + wrapped);
        if (members !== undefined) yield* members;
      }
    }
  }
}
