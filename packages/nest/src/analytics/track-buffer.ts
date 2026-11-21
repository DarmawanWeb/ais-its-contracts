import { LRUCache } from 'lru-cache';

/** Anything with a time: positions, states or detector-specific samples. */
export interface TrackPoint {
  readonly time: Date;
}

/** Options of {@link TrackBuffer}. */
export interface TrackBufferOptions {
  /** Points kept per vessel (oldest dropped first). Default 256. */
  readonly maxPoints?: number | undefined;
  /** Span kept per vessel, relative to its newest point, ms. Default 2 h. */
  readonly maxAgeMs?: number | undefined;
  /** Vessels kept (least recently updated dropped first). Default 100 000. */
  readonly maxVessels?: number | undefined;
}

/** A fixed-capacity circular buffer of one vessel's points, oldest first. */
class Ring<Point extends TrackPoint> {
  private readonly slots: (Point | undefined)[];
  private start = 0;
  private count = 0;

  constructor(capacity: number) {
    this.slots = new Array<Point | undefined>(capacity);
  }

  get length(): number {
    return this.count;
  }

  /** Newest point. */
  get newest(): Point | undefined {
    return this.count === 0
      ? undefined
      : this.slots[(this.start + this.count - 1) % this.slots.length];
  }

  /** Oldest point. */
  get oldest(): Point | undefined {
    return this.count === 0 ? undefined : this.slots[this.start];
  }

  push(point: Point): void {
    if (this.count < this.slots.length) {
      this.slots[(this.start + this.count) % this.slots.length] = point;
      this.count += 1;
      return;
    }
    this.slots[this.start] = point;
    this.start = (this.start + 1) % this.slots.length;
  }

  dropOldest(): void {
    if (this.count === 0) return;
    this.slots[this.start] = undefined;
    this.start = (this.start + 1) % this.slots.length;
    this.count -= 1;
  }

  toArray(): Point[] {
    const points: Point[] = [];
    for (let index = 0; index < this.count; index += 1) {
      const point = this.slots[(this.start + index) % this.slots.length];
      if (point !== undefined) points.push(point);
    }
    return points;
  }
}

/**
 * Per-vessel ring buffers for pattern detectors (spec §18): at most
 * `maxPoints` points spanning at most `maxAgeMs` per vessel, for at most
 * `maxVessels` vessels. Points must arrive in time order per vessel; older or
 * equal times are rejected, so redeliveries cannot duplicate points.
 *
 * @example
 * private readonly tracks = new TrackBuffer<VesselPosition>({ maxPoints: 64, maxAgeMs: 45 * 60_000 });
 * this.tracks.push(position.mmsi, position);
 * const lastHalfHour = this.tracks.points(position.mmsi, { since: new Date(position.time.getTime() - 30 * 60_000) });
 */
export class TrackBuffer<Point extends TrackPoint = TrackPoint> {
  /** Points kept per vessel. */
  readonly maxPoints: number;
  /** Span kept per vessel, ms. */
  readonly maxAgeMs: number;
  private readonly tracks: LRUCache<number, Ring<Point>>;

  constructor(options: TrackBufferOptions = {}) {
    this.maxPoints = positive(options.maxPoints ?? 256, 'maxPoints');
    this.maxAgeMs = positive(options.maxAgeMs ?? 2 * 60 * 60_000, 'maxAgeMs');
    this.tracks = new LRUCache<number, Ring<Point>>({
      max: positive(options.maxVessels ?? 100_000, 'maxVessels'),
    });
  }

  /** Vessels with a track. */
  get vesselCount(): number {
    return this.tracks.size;
  }

  /**
   * Appends a point to the vessel's track and drops points beyond the limits.
   *
   * @returns `false` when the point is not newer than the track's newest point (ignored).
   */
  push(mmsi: number, point: Point): boolean {
    let ring = this.tracks.get(mmsi);
    const newest = ring?.newest;
    if (newest !== undefined && point.time.getTime() <= newest.time.getTime())
      return false;
    if (ring === undefined) {
      ring = new Ring<Point>(this.maxPoints);
      this.tracks.set(mmsi, ring);
    }
    ring.push(point);
    const horizon = point.time.getTime() - this.maxAgeMs;
    for (
      let oldest = ring.oldest;
      oldest !== undefined && oldest.time.getTime() < horizon;
      oldest = ring.oldest
    ) {
      ring.dropOldest();
    }
    return true;
  }

  /** The vessel's points, oldest first, optionally only those at or after `since`. */
  points(
    mmsi: number,
    options: { readonly since?: Date | undefined } = {},
  ): Point[] {
    const points = this.tracks.peek(mmsi)?.toArray() ?? [];
    const since = options.since;
    return since === undefined
      ? points
      : points.filter((point) => point.time.getTime() >= since.getTime());
  }

  /** The `count` newest points, oldest first. */
  tail(mmsi: number, count: number): Point[] {
    const points = this.points(mmsi);
    return count <= 0 ? [] : points.slice(-count);
  }

  /** The newest point. */
  last(mmsi: number): Point | undefined {
    return this.tracks.peek(mmsi)?.newest;
  }

  /** Number of points of the vessel. */
  length(mmsi: number): number {
    return this.tracks.peek(mmsi)?.length ?? 0;
  }

  /** `true` when the vessel has points. */
  has(mmsi: number): boolean {
    return this.length(mmsi) > 0;
  }

  /** Forgets a vessel. */
  delete(mmsi: number): boolean {
    return this.tracks.delete(mmsi);
  }

  /** Forgets every vessel. */
  clear(): void {
    this.tracks.clear();
  }

  /** Forgets vessels whose newest point is older than `now - maxAgeMs`; returns how many. */
  prune(now: Date): number {
    const horizon = now.getTime() - this.maxAgeMs;
    const expired: number[] = [];
    for (const [mmsi, ring] of this.tracks.entries()) {
      const newest = ring.newest;
      if (newest === undefined || newest.time.getTime() < horizon)
        expired.push(mmsi);
    }
    for (const mmsi of expired) this.tracks.delete(mmsi);
    return expired.length;
  }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive number`);
  return Math.floor(value) === value ? value : Math.floor(value);
}
