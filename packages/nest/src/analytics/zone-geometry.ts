import type {
  BBox,
  GeoJsonGeometry,
  GeoJsonPosition,
  GeoPoint,
} from '@darmawanweb/ais-its-contracts/domain';
import Flatbush from 'flatbush';

import {
  arcBBox,
  type DistanceModel,
  distanceToArc,
  geodesicDistanceM,
  haversineMeters,
  interpolateGreatCircle,
  searchBox,
} from './geodesy.js';

/** Distance from a point to a geometry. */
export interface GeometryDistance {
  /** Metres; `0` inside a polygon. */
  readonly distanceM: number;
  /** Nearest point of the geometry (the point itself when inside). */
  readonly nearest: GeoPoint;
  /** `true` when the point lies inside a polygon of the geometry. */
  readonly inside: boolean;
}

/** Geometries with fewer elements are scanned instead of indexed. */
const INDEX_THRESHOLD = 32;

/** First radius of the expanding nearest-element search, metres. */
const INITIAL_SEARCH_RADIUS_M = 2_000;

/**
 * Longest polygon edge kept as is, metres. Longer edges are split along
 * their great circle, so the lon/lat chords used for containment stay
 * within a few metres of the geodesic edge (PostGIS `geography`).
 */
export const MAX_POLYGON_EDGE_M = 10_000;

/**
 * A zone geometry prepared for fast queries: polygon rings, line segments and
 * points, with a Flatbush index over the elements of large geometries.
 *
 * One model throughout, PostGIS `geography` semantics (the geo service
 * stores zones as geography): edges are great-circle arcs between
 * vertices. Polygon edges longer than {@link MAX_POLYGON_EDGE_M} are split
 * along their great circle when compiling, so containment (even–odd rule
 * on the densified ring) agrees with `ST_Covers(geography)` and with the
 * distances (great-circle arcs, requested {@link DistanceModel}) to within
 * metres. Geometries must not cross the antimeridian (contracts `BBox`
 * convention).
 */
export class CompiledGeometry {
  /** Bounding box of the vertices. */
  readonly bbox: BBox;
  /** `true` when the geometry has a polygon (an interior). */
  readonly hasArea: boolean;
  /** Segment ends `[lonA, latA, lonB, latB]` (polygon rings and lines). */
  private readonly segments: number[] = [];
  /** Polygon number of each segment (`-1` for line segments). */
  private readonly segmentPolygon: number[] = [];
  /** Standalone points `[lon, lat]`. */
  private readonly points: number[] = [];
  private readonly polygonBoxes: BBox[] = [];
  /** Box of every element (`[minLon, minLat, maxLon, maxLat]` each), arcs included. */
  private readonly elementBoxes: number[] = [];
  private readonly index: Flatbush | undefined;

  constructor(geometry: GeoJsonGeometry) {
    this.collect(geometry);
    this.hasArea = this.polygonBoxes.length > 0;
    this.computeElementBoxes();
    this.bbox = this.unionOfElementBoxes();
    const elements = this.segmentCount + this.pointCount;
    this.index =
      elements >= INDEX_THRESHOLD ? this.buildIndex(elements) : undefined;
  }

  /** Number of segments (polygon edges and line segments). */
  get segmentCount(): number {
    return this.segmentPolygon.length;
  }

  /** Number of standalone points. */
  get pointCount(): number {
    return this.points.length / 2;
  }

  /** `true` when `point` lies inside a polygon (even–odd rule, holes excluded). */
  contains(point: GeoPoint): boolean {
    if (!this.hasArea) return false;
    const candidates = this.polygonBoxes.some(
      (box) =>
        point.lon >= box[0] &&
        point.lon <= box[2] &&
        point.lat >= box[1] &&
        point.lat <= box[3],
    );
    if (!candidates) return false;
    const parity = new Map<number, boolean>();
    const visit = (segment: number): void => {
      const polygon = this.segmentPolygon[segment] ?? -1;
      if (polygon < 0) return;
      const offset = segment * 4;
      const x1 = this.segments[offset] ?? 0;
      const y1 = this.segments[offset + 1] ?? 0;
      const x2 = this.segments[offset + 2] ?? 0;
      const y2 = this.segments[offset + 3] ?? 0;
      if (y1 > point.lat !== y2 > point.lat) {
        const crossingLon = x1 + ((point.lat - y1) * (x2 - x1)) / (y2 - y1);
        if (point.lon < crossingLon)
          parity.set(polygon, !(parity.get(polygon) ?? false));
      }
    };
    if (this.index === undefined) {
      for (let segment = 0; segment < this.segmentCount; segment += 1)
        visit(segment);
    } else {
      // Only edges that reach the eastward ray from the point can cross it.
      for (const id of this.index.search(
        point.lon,
        point.lat,
        Number.POSITIVE_INFINITY,
        point.lat,
      )) {
        if (id < this.segmentCount) visit(id);
      }
    }
    for (const inside of parity.values()) if (inside) return true;
    return false;
  }

  /** Distance from `point` to the geometry (`0` inside a polygon). */
  distance(point: GeoPoint, model: DistanceModel): GeometryDistance {
    if (this.contains(point))
      return { distanceM: 0, nearest: point, inside: true };
    const nearest =
      this.index === undefined
        ? this.scanAll(point, model)
        : this.searchNearest(point, model);
    return { ...nearest, inside: false };
  }

  /**
   * `true` when `point` is inside a polygon or within `meters` of the
   * geometry (`ST_DWithin` semantics).
   */
  within(point: GeoPoint, meters: number, model: DistanceModel): boolean {
    if (this.contains(point)) return true;
    if (meters <= 0) return false;
    const box = searchBox(point, meters);
    if (
      box[0] > this.bbox[2] ||
      box[2] < this.bbox[0] ||
      box[1] > this.bbox[3] ||
      box[3] < this.bbox[1]
    ) {
      return false;
    }
    const ids =
      this.index === undefined
        ? undefined
        : this.index.search(box[0], box[1], box[2], box[3]);
    const best = this.minimum(point, model, ids);
    return best.distanceM <= meters;
  }

  private searchNearest(
    point: GeoPoint,
    model: DistanceModel,
  ): Omit<GeometryDistance, 'inside'> {
    const index = this.index;
    if (index === undefined) return this.scanAll(point, model);
    for (let radius = INITIAL_SEARCH_RADIUS_M; ; radius *= 4) {
      const box = searchBox(point, radius);
      const covers =
        box[0] <= this.bbox[0] &&
        box[1] <= this.bbox[1] &&
        box[2] >= this.bbox[2] &&
        box[3] >= this.bbox[3];
      const ids = index.search(box[0], box[1], box[2], box[3]);
      if (ids.length > 0) {
        const first = this.minimum(point, model, ids);
        // Anything closer than the best candidate intersects its search box.
        const exactBox = searchBox(point, first.distanceM);
        return this.minimum(
          point,
          model,
          index.search(exactBox[0], exactBox[1], exactBox[2], exactBox[3]),
        );
      }
      if (covers || radius > 40_000_000) return this.scanAll(point, model);
    }
  }

  private scanAll(
    point: GeoPoint,
    model: DistanceModel,
  ): Omit<GeometryDistance, 'inside'> {
    return this.minimum(point, model, undefined);
  }

  /** Closest element among `ids` (every element when `undefined`). */
  private minimum(
    point: GeoPoint,
    model: DistanceModel,
    ids: readonly number[] | undefined,
  ): Omit<GeometryDistance, 'inside'> {
    let best: Omit<GeometryDistance, 'inside'> = {
      distanceM: Number.POSITIVE_INFINITY,
      nearest: point,
    };
    const consider = (id: number): void => {
      const candidate = this.elementDistance(point, id, model);
      if (candidate.distanceM < best.distanceM) best = candidate;
    };
    if (ids === undefined) {
      const total = this.segmentCount + this.pointCount;
      for (let id = 0; id < total; id += 1) consider(id);
    } else {
      for (const id of ids) consider(id);
    }
    return best;
  }

  private elementDistance(
    point: GeoPoint,
    id: number,
    model: DistanceModel,
  ): Omit<GeometryDistance, 'inside'> {
    if (id < this.segmentCount) {
      const offset = id * 4;
      return distanceToArc(
        point,
        {
          lon: this.segments[offset] ?? 0,
          lat: this.segments[offset + 1] ?? 0,
        },
        {
          lon: this.segments[offset + 2] ?? 0,
          lat: this.segments[offset + 3] ?? 0,
        },
        model,
      );
    }
    const offset = (id - this.segmentCount) * 2;
    const vertex = {
      lon: this.points[offset] ?? 0,
      lat: this.points[offset + 1] ?? 0,
    };
    return {
      distanceM: geodesicDistanceM(point, vertex, model),
      nearest: vertex,
    };
  }

  private collect(geometry: GeoJsonGeometry): void {
    switch (geometry.type) {
      case 'Point':
        this.addPoint(geometry.coordinates);
        break;
      case 'MultiPoint':
        for (const point of geometry.coordinates) this.addPoint(point);
        break;
      case 'LineString':
        this.addLine(geometry.coordinates, -1);
        break;
      case 'MultiLineString':
        for (const line of geometry.coordinates) this.addLine(line, -1);
        break;
      case 'Polygon':
        this.addPolygon(geometry.coordinates);
        break;
      case 'MultiPolygon':
        for (const polygon of geometry.coordinates) this.addPolygon(polygon);
        break;
      case 'GeometryCollection':
        for (const member of geometry.geometries) this.collect(member);
        break;
    }
  }

  private addPoint(value: GeoJsonPosition): void {
    this.points.push(value[0], value[1]);
  }

  private addLine(line: readonly GeoJsonPosition[], polygon: number): void {
    if (line.length === 1 && line[0] !== undefined) this.addPoint(line[0]);
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      if (start === undefined || end === undefined) continue;
      this.segments.push(start[0], start[1], end[0], end[1]);
      this.segmentPolygon.push(polygon);
    }
  }

  private addPolygon(rings: readonly (readonly GeoJsonPosition[])[]): void {
    const outer = rings[0];
    if (outer === undefined || outer.length === 0) return;
    const polygon = this.polygonBoxes.length;
    const densified = rings.map((ring) => densifyRing(ring));
    let minLon = Number.POSITIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (const vertex of densified[0] ?? []) {
      minLon = Math.min(minLon, vertex[0]);
      minLat = Math.min(minLat, vertex[1]);
      maxLon = Math.max(maxLon, vertex[0]);
      maxLat = Math.max(maxLat, vertex[1]);
    }
    this.polygonBoxes.push([minLon, minLat, maxLon, maxLat]);
    for (const ring of densified) this.addLine(ring, polygon);
  }

  private computeElementBoxes(): void {
    for (let segment = 0; segment < this.segmentCount; segment += 1) {
      const offset = segment * 4;
      this.elementBoxes.push(
        ...arcBBox(
          {
            lon: this.segments[offset] ?? 0,
            lat: this.segments[offset + 1] ?? 0,
          },
          {
            lon: this.segments[offset + 2] ?? 0,
            lat: this.segments[offset + 3] ?? 0,
          },
        ),
      );
    }
    for (let offset = 0; offset < this.points.length; offset += 2) {
      const lon = this.points[offset] ?? 0;
      const lat = this.points[offset + 1] ?? 0;
      this.elementBoxes.push(lon, lat, lon, lat);
    }
  }

  private unionOfElementBoxes(): BBox {
    if (this.elementBoxes.length === 0) return [0, 0, 0, 0];
    let minLon = Number.POSITIVE_INFINITY;
    let minLat = Number.POSITIVE_INFINITY;
    let maxLon = Number.NEGATIVE_INFINITY;
    let maxLat = Number.NEGATIVE_INFINITY;
    for (let offset = 0; offset < this.elementBoxes.length; offset += 4) {
      minLon = Math.min(minLon, this.elementBoxes[offset] ?? 0);
      minLat = Math.min(minLat, this.elementBoxes[offset + 1] ?? 0);
      maxLon = Math.max(maxLon, this.elementBoxes[offset + 2] ?? 0);
      maxLat = Math.max(maxLat, this.elementBoxes[offset + 3] ?? 0);
    }
    return [minLon, minLat, maxLon, maxLat];
  }

  private buildIndex(elements: number): Flatbush {
    const index = new Flatbush(elements);
    for (let offset = 0; offset < this.elementBoxes.length; offset += 4) {
      index.add(
        this.elementBoxes[offset] ?? 0,
        this.elementBoxes[offset + 1] ?? 0,
        this.elementBoxes[offset + 2] ?? 0,
        this.elementBoxes[offset + 3] ?? 0,
      );
    }
    index.finish();
    return index;
  }
}

/**
 * Closes a ring and splits every edge longer than
 * {@link MAX_POLYGON_EDGE_M} along its great circle (meridians stay as is).
 */
function densifyRing(ring: readonly GeoJsonPosition[]): GeoJsonPosition[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  // Rings are closed in GeoJSON; close them defensively.
  const closed =
    first !== undefined &&
    last !== undefined &&
    (first[0] !== last[0] || first[1] !== last[1])
      ? [...ring, first]
      : [...ring];
  const result: GeoJsonPosition[] = [];
  for (let index = 0; index < closed.length; index += 1) {
    const end = closed[index];
    if (end === undefined) continue;
    const start = closed[index - 1];
    if (start !== undefined && start[0] !== end[0]) {
      const from = { lon: start[0], lat: start[1] };
      const to = { lon: end[0], lat: end[1] };
      const pieces = Math.ceil(haversineMeters(from, to) / MAX_POLYGON_EDGE_M);
      for (let piece = 1; piece < pieces; piece += 1) {
        const point = interpolateGreatCircle(from, to, piece / pieces);
        result.push([point.lon, point.lat]);
      }
    }
    result.push(end);
  }
  return result;
}

/** Compiles a GeoJSON geometry for repeated point queries. */
export function compileGeometry(geometry: GeoJsonGeometry): CompiledGeometry {
  return new CompiledGeometry(geometry);
}
