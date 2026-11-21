import type {
  BBox,
  GeoPoint,
  ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import type {
  ZoneDeletedV1,
  ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import Flatbush from 'flatbush';

import {
  DEFAULT_DISTANCE_MODEL,
  type DistanceModel,
  searchBox,
} from './geodesy.js';
import { CompiledGeometry, type GeometryDistance } from './zone-geometry.js';

/** Filters of zone queries. */
export interface ZoneQuery {
  /** Only zones of these kinds. Default: every kind. */
  readonly kinds?: readonly ZoneKind[] | undefined;
  /** Include zones with `active: false`. Default `false`. */
  readonly includeInactive?: boolean | undefined;
  /**
   * Tenant filter: global zones (`orgId: null`) plus the zones of this
   * organization. Default: every zone.
   */
  readonly orgId?: string | null | undefined;
  /** Additional predicate. */
  readonly filter?: ((zone: ZoneSnapshotV1) => boolean) | undefined;
}

/** A zone with its distance to a point. */
export interface ZoneDistance extends GeometryDistance {
  readonly zone: ZoneSnapshotV1;
  /** `true` when the point is inside the zone or within its `bufferM`. */
  readonly withinBuffer: boolean;
}

/** What a projection change did to the index. */
export interface ZoneChange {
  readonly kind: 'upserted' | 'deleted';
  /** The zone after an upsert, the removed zone after a delete. */
  readonly zone: ZoneSnapshotV1;
  /** The zone before the change (upserts of known zones). */
  readonly previous: ZoneSnapshotV1 | undefined;
}

/** Options of {@link ZoneIndex}. */
export interface ZoneIndexOptions {
  /** Distance model of every query. Default `'wgs84'` (PostGIS `geography`). */
  readonly distanceModel?: DistanceModel | undefined;
}

interface Entry {
  readonly zone: ZoneSnapshotV1;
  readonly geometry: CompiledGeometry;
}

/** Flatbush over the zone boxes, with the largest buffer of the indexed zones. */
interface BoxIndex {
  readonly index: Flatbush;
  readonly ids: readonly string[];
  readonly maxBufferM: number;
}

/**
 * In-memory projection of the `GEO` stream (spec §18) with a spatial index:
 * point-in-zone, distance-to-zone (geodesic metres, great-circle edges, with
 * the zone's `bufferM`) and "zones of kind X near a point".
 *
 * Every geometry is compiled once per snapshot (Flatbush index over its edges
 * for large geometries); a second Flatbush over the zone boxes is rebuilt
 * lazily after changes. Out-of-order snapshots (older `updatedAt`) are
 * ignored. The `DetectorRunnerModule` feeds it from `geo.zone.*` events; tests
 * feed it directly.
 *
 * @example
 * const pipelines = zones.near(position, 2_000, { kinds: ['pipeline'] });
 * const ews = zones.nearest(position, { kinds: ['pipeline'] }); // { zone, distanceM, nearest, … }
 */
export class ZoneIndex {
  /** Distance model of the queries. */
  readonly distanceModel: DistanceModel;
  private readonly entries = new Map<string, Entry>();
  private boxIndex: BoxIndex | undefined;

  constructor(options: ZoneIndexOptions = {}) {
    this.distanceModel = options.distanceModel ?? DEFAULT_DISTANCE_MODEL;
  }

  /** Number of zones (active or not). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Adds or replaces a zone. Returns the change, or `undefined` when the
   * snapshot is older than the stored one (and was ignored).
   */
  upsert(zone: ZoneSnapshotV1): ZoneChange | undefined {
    const existing = this.entries.get(zone.id);
    if (
      existing !== undefined &&
      Date.parse(existing.zone.updatedAt) > Date.parse(zone.updatedAt)
    ) {
      return undefined;
    }
    this.entries.set(zone.id, {
      zone,
      geometry: new CompiledGeometry(zone.geometry),
    });
    this.invalidate();
    return { kind: 'upserted', zone, previous: existing?.zone };
  }

  /** Removes a zone (`geo.zone.deleted.v1`); `undefined` when it was unknown. */
  remove(deleted: Pick<ZoneDeletedV1, 'id'> | string): ZoneChange | undefined {
    const id = typeof deleted === 'string' ? deleted : deleted.id;
    const existing = this.entries.get(id);
    if (existing === undefined) return undefined;
    this.entries.delete(id);
    this.invalidate();
    return { kind: 'deleted', zone: existing.zone, previous: existing.zone };
  }

  /** Removes every zone. */
  clear(): void {
    this.entries.clear();
    this.invalidate();
  }

  /** The zone with this id. */
  get(id: string): ZoneSnapshotV1 | undefined {
    return this.entries.get(id)?.zone;
  }

  /** `true` when the zone is known. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Zones matching `query` (active ones by default), in insertion order. */
  all(query: ZoneQuery = {}): ZoneSnapshotV1[] {
    const zones: ZoneSnapshotV1[] = [];
    for (const { zone } of this.entries.values())
      if (matches(zone, query)) zones.push(zone);
    return zones;
  }

  /** Bounding box of a zone's geometry (arcs included). */
  bboxOf(id: string): BBox | undefined {
    return this.entries.get(id)?.geometry.bbox;
  }

  /**
   * `true` when `point` is inside the zone's polygon, or — with
   * `useBuffer` (default `true`) — within its `bufferM` of the geometry
   * (lines and points only have a buffer).
   */
  contains(
    zoneId: string,
    point: GeoPoint,
    options: { readonly useBuffer?: boolean } = {},
  ): boolean {
    const entry = this.entries.get(zoneId);
    if (entry === undefined) return false;
    const buffer = (options.useBuffer ?? true) ? entry.zone.bufferM : 0;
    return entry.geometry.within(point, buffer, this.distanceModel);
  }

  /** Distance from `point` to a zone (`0` inside its polygon); `undefined` for unknown zones. */
  distance(zoneId: string, point: GeoPoint): ZoneDistance | undefined {
    const entry = this.entries.get(zoneId);
    if (entry === undefined) return undefined;
    return this.measure(entry, point);
  }

  /**
   * Zones that contain `point` — inside their polygon or within their
   * `bufferM` (`useBuffer`, default `true`) — e.g. "inside a transhipment
   * area", "entered a restricted zone".
   */
  zonesAt(
    point: GeoPoint,
    query: ZoneQuery & { readonly useBuffer?: boolean } = {},
  ): ZoneSnapshotV1[] {
    const useBuffer = query.useBuffer ?? true;
    const zones: ZoneSnapshotV1[] = [];
    const radius = useBuffer ? (this.ensureBoxIndex()?.maxBufferM ?? 0) : 0;
    for (const entry of this.candidates(point, radius, query)) {
      const buffer = useBuffer ? entry.zone.bufferM : 0;
      if (entry.geometry.within(point, buffer, this.distanceModel))
        zones.push(entry.zone);
    }
    return zones;
  }

  /** Zones whose geometry is within `radiusM` of `point`, nearest first. */
  near(
    point: GeoPoint,
    radiusM: number,
    query: ZoneQuery = {},
  ): ZoneDistance[] {
    const results: ZoneDistance[] = [];
    for (const entry of this.candidates(point, radiusM, query)) {
      const measured = this.measure(entry, point);
      if (measured.distanceM <= radiusM) results.push(measured);
    }
    return results.sort((a, b) => a.distanceM - b.distanceM);
  }

  /**
   * The zone nearest to `point` (optionally within `maxDistanceM`), e.g. the
   * nearest pipeline for EWS.
   */
  nearest(
    point: GeoPoint,
    query: ZoneQuery & { readonly maxDistanceM?: number } = {},
  ): ZoneDistance | undefined {
    const limit = query.maxDistanceM;
    const entries =
      limit === undefined
        ? [...this.entries.values()].filter((entry) =>
            matches(entry.zone, query),
          )
        : this.candidates(point, limit, query);
    let best: ZoneDistance | undefined;
    for (const entry of entries) {
      const measured = this.measure(entry, point);
      if (limit !== undefined && measured.distanceM > limit) continue;
      if (best === undefined || measured.distanceM < best.distanceM)
        best = measured;
    }
    return best;
  }

  private measure(entry: Entry, point: GeoPoint): ZoneDistance {
    const measured = entry.geometry.distance(point, this.distanceModel);
    return {
      ...measured,
      zone: entry.zone,
      withinBuffer: measured.distanceM <= entry.zone.bufferM,
    };
  }

  /** Matching zones whose box is within `radiusM` of `point`. */
  private candidates(
    point: GeoPoint,
    radiusM: number,
    query: ZoneQuery,
  ): Entry[] {
    const index = this.ensureBoxIndex();
    if (index === undefined) return [];
    const box = searchBox(point, radiusM);
    const entries: Entry[] = [];
    for (const position of index.index.search(box[0], box[1], box[2], box[3])) {
      const id = index.ids[position];
      const entry = id === undefined ? undefined : this.entries.get(id);
      if (entry !== undefined && matches(entry.zone, query))
        entries.push(entry);
    }
    return entries;
  }

  private invalidate(): void {
    this.boxIndex = undefined;
  }

  private ensureBoxIndex(): BoxIndex | undefined {
    if (this.boxIndex !== undefined) return this.boxIndex;
    if (this.entries.size === 0) return undefined;
    const index = new Flatbush(this.entries.size);
    const ids: string[] = [];
    let maxBuffer = 0;
    for (const [id, entry] of this.entries) {
      const [minLon, minLat, maxLon, maxLat] = entry.geometry.bbox;
      index.add(minLon, minLat, maxLon, maxLat);
      ids.push(id);
      maxBuffer = Math.max(maxBuffer, entry.zone.bufferM);
    }
    index.finish();
    this.boxIndex = { index, ids, maxBufferM: maxBuffer };
    return this.boxIndex;
  }
}

function matches(zone: ZoneSnapshotV1, query: ZoneQuery): boolean {
  if (query.includeInactive !== true && !zone.active) return false;
  if (query.kinds !== undefined && !query.kinds.includes(zone.kind))
    return false;
  if (
    query.orgId !== undefined &&
    zone.orgId !== null &&
    zone.orgId !== query.orgId
  )
    return false;
  return query.filter === undefined || query.filter(zone);
}
