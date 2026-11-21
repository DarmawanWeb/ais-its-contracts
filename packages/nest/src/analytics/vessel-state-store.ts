import type { Redis } from 'ioredis';
import { LRUCache } from 'lru-cache';

import type { VesselPosition } from './vessel-position.js';

/** The latest kinematic state of a vessel (its last position, without `previous`). */
export interface VesselState extends Omit<VesselPosition, 'previous'> {
  /** When the store accepted the position (processing time). */
  readonly receivedAt: Date;
}

/** Outcome of {@link VesselStateStore.upsert}. */
export type VesselStateUpsert =
  | { readonly outcome: 'created'; readonly state: VesselState }
  | {
      readonly outcome: 'updated';
      readonly state: VesselState;
      readonly previous: VesselState;
    }
  /** Not newer than the stored state (duplicate or out of order): ignored. */
  | { readonly outcome: 'stale'; readonly state: VesselState };

/**
 * Persistence of the store's states (warm restarts). Writes are
 * fire-and-forget from the store's point of view; failures are reported to
 * `onError`.
 */
export interface VesselStateMirror {
  save(state: VesselState): Promise<void>;
  remove(mmsi: number): Promise<void>;
  /** Every mirrored state (used once at startup). */
  loadAll(): Promise<VesselState[]>;
}

/** Options of {@link VesselStateStore}. */
export interface VesselStateStoreOptions {
  /** Vessels kept in memory (least recently updated evicted first). Default 200 000. */
  readonly maxVessels?: number | undefined;
  /** A state older than this is stale, ms. Default 10 min. */
  readonly staleAfterMs?: number | undefined;
  /** Optional mirror (e.g. {@link RedisVesselStateMirror}). */
  readonly mirror?: VesselStateMirror | undefined;
  /** Clock (tests). Default `() => new Date()`. */
  readonly clock?: (() => Date) | undefined;
  /** Mirror write failures. Default: ignored. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

/** Options of the staleness helpers. */
export interface FreshnessOptions {
  /** Reference time. Default: the store clock. */
  readonly now?: Date | undefined;
  /** Overrides the store's `staleAfterMs`. */
  readonly maxAgeMs?: number | undefined;
}

/** Called when a state leaves the store (eviction or deletion). */
export type VesselStateRemovedListener = (state: VesselState) => void;

/**
 * Latest kinematic state per MMSI (spec §18): an in-memory LRU with an
 * optional mirror (Valkey) for warm restarts, plus staleness helpers. Only
 * newer positions replace a state, so redeliveries and out-of-order messages
 * are detected (`'stale'`).
 */
export class VesselStateStore {
  /** States older than this are stale, ms. */
  readonly staleAfterMs: number;
  private readonly states: LRUCache<number, VesselState>;
  private readonly mirror: VesselStateMirror | undefined;
  private readonly clock: () => Date;
  private readonly onError: (error: unknown) => void;
  private readonly listeners = new Set<VesselStateRemovedListener>();
  private readonly pendingWrites = new Set<Promise<void>>();
  /** Vessels whose state was loaded by {@link warmUp} and not yet confirmed by a position. */
  private readonly seeded = new Set<number>();

  constructor(options: VesselStateStoreOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? 10 * 60_000;
    this.mirror = options.mirror;
    this.clock = options.clock ?? (() => new Date());
    this.onError = options.onError ?? (() => undefined);
    this.states = new LRUCache<number, VesselState>({
      max: options.maxVessels ?? 200_000,
      dispose: (state, _mmsi, reason) => {
        if (reason === 'evict' || reason === 'delete') {
          for (const listener of this.listeners) listener(state);
        }
      },
    });
  }

  /** Number of vessels in memory. */
  get size(): number {
    return this.states.size;
  }

  /** Registers a listener of evictions and deletions; returns its unsubscribe function. */
  onRemoved(listener: VesselStateRemovedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Stores `position` when it is newer than the vessel's state. A state
   * seeded by {@link warmUp} is no watermark: the first position after a
   * restart replaces it even when older, so the redelivered backlog of the
   * service's own consumer still reaches the detectors.
   */
  upsert(position: VesselPosition | VesselState): VesselStateUpsert {
    const existing = this.states.peek(position.mmsi);
    if (
      existing !== undefined &&
      !this.seeded.has(position.mmsi) &&
      position.time.getTime() <= existing.time.getTime()
    ) {
      return { outcome: 'stale', state: existing };
    }
    this.seeded.delete(position.mmsi);
    const state = toState(
      position,
      'receivedAt' in position ? position.receivedAt : this.clock(),
    );
    this.states.set(state.mmsi, state);
    this.write(() => this.mirror?.save(state));
    return existing === undefined
      ? { outcome: 'created', state }
      : { outcome: 'updated', state, previous: existing };
  }

  /** The state of a vessel. */
  get(mmsi: number): VesselState | undefined {
    return this.states.peek(mmsi);
  }

  /** `true` when the vessel has a state. */
  has(mmsi: number): boolean {
    return this.states.has(mmsi);
  }

  /** Removes a vessel (listeners are notified); `true` when it was known. */
  delete(mmsi: number): boolean {
    const known = this.states.delete(mmsi);
    this.seeded.delete(mmsi);
    if (known) this.write(() => this.mirror?.remove(mmsi));
    return known;
  }

  /** Every state, most recently updated first. */
  values(): VesselState[] {
    return [...this.states.values()];
  }

  /** Age of a state, ms. */
  ageMs(state: Pick<VesselState, 'time'>, now: Date = this.clock()): number {
    return now.getTime() - state.time.getTime();
  }

  /** `true` when the state (or the vessel's state) is older than the stale limit, or unknown. */
  isStale(
    target: number | Pick<VesselState, 'time'>,
    options: FreshnessOptions = {},
  ): boolean {
    const state =
      typeof target === 'number' ? this.states.peek(target) : target;
    if (state === undefined) return true;
    return (
      this.ageMs(state, options.now ?? this.clock()) >
      (options.maxAgeMs ?? this.staleAfterMs)
    );
  }

  /** States that are not stale. */
  fresh(options: FreshnessOptions = {}): VesselState[] {
    return this.values().filter((state) => !this.isStale(state, options));
  }

  /** Vessels last seen longer ago than `maxAgeMs` (e.g. dark-vessel candidates). */
  staleSince(options: FreshnessOptions = {}): VesselState[] {
    return this.values().filter((state) => this.isStale(state, options));
  }

  /** Loads the mirrored states into memory (startup); returns how many were loaded. */
  async warmUp(): Promise<number> {
    if (this.mirror === undefined) return 0;
    const states = await this.mirror.loadAll();
    let loaded = 0;
    for (const state of states.sort(
      (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
    )) {
      const existing = this.states.peek(state.mmsi);
      if (
        existing !== undefined &&
        existing.time.getTime() >= state.time.getTime()
      )
        continue;
      this.states.set(state.mmsi, state);
      this.seeded.add(state.mmsi);
      loaded += 1;
    }
    return loaded;
  }

  /** Waits for the pending mirror writes (shutdown). */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pendingWrites]);
  }

  /** Removes every state (listeners are notified). */
  clear(): void {
    this.seeded.clear();
    this.states.clear();
  }

  private write(operation: () => Promise<void> | undefined): void {
    const pending = operation();
    if (pending === undefined) return;
    const tracked = pending.catch((error: unknown) => {
      this.onError(error);
    });
    this.pendingWrites.add(tracked);
    void tracked.finally(() => this.pendingWrites.delete(tracked));
  }
}

function toState(
  position: VesselPosition | VesselState,
  receivedAt: Date,
): VesselState {
  return {
    mmsi: position.mmsi,
    time: position.time,
    source: position.source,
    lat: position.lat,
    lon: position.lon,
    sog: position.sog,
    cog: position.cog,
    hdg: position.hdg,
    navstatus: position.navstatus,
    predictedNavstatus: position.predictedNavstatus,
    coastDistanceM: position.coastDistanceM,
    receivedAt,
  };
}

/** Options of {@link RedisVesselStateMirror}. */
export interface RedisVesselStateMirrorOptions {
  /**
   * Key prefix; use a service namespace, `aisits:<SERVICE_NAME>:vessel-state:`
   * (what `DetectorRunnerModule` sets). Default
   * {@link DEFAULT_VESSEL_STATE_KEY_PREFIX}, shared by every service.
   */
  readonly keyPrefix?: string | undefined;
  /** Expiry of mirrored states, ms. Default 24 h. */
  readonly ttlMs?: number | undefined;
}

/**
 * Default key prefix of {@link RedisVesselStateMirror}: shared by every
 * service on the Valkey server. `DetectorRunnerModule` uses
 * `aisits:<SERVICE_NAME>:vessel-state:` instead; pass a service namespace
 * when constructing the mirror yourself.
 */
export const DEFAULT_VESSEL_STATE_KEY_PREFIX = 'aisits:vessel-state:';

interface SerializedState extends Omit<VesselState, 'time' | 'receivedAt'> {
  readonly time: string;
  readonly receivedAt: string;
}

/**
 * {@link VesselStateMirror} in Valkey/Redis: one JSON string per vessel
 * (`<prefix><mmsi>`, expiring after `ttlMs`), loaded with `SCAN` + `MGET`.
 * Honours the client's own `keyPrefix`.
 */
export class RedisVesselStateMirror implements VesselStateMirror {
  private readonly keyPrefix: string;
  private readonly ttlMs: number;

  constructor(
    private readonly redis: Redis,
    options: RedisVesselStateMirrorOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_VESSEL_STATE_KEY_PREFIX;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
  }

  /** @inheritdoc */
  async save(state: VesselState): Promise<void> {
    const serialized: SerializedState = {
      ...state,
      time: state.time.toISOString(),
      receivedAt: state.receivedAt.toISOString(),
    };
    await this.redis.set(
      `${this.keyPrefix}${state.mmsi}`,
      JSON.stringify(serialized),
      'PX',
      this.ttlMs,
    );
  }

  /** @inheritdoc */
  async remove(mmsi: number): Promise<void> {
    await this.redis.del(`${this.keyPrefix}${mmsi}`);
  }

  /** @inheritdoc */
  async loadAll(): Promise<VesselState[]> {
    const clientPrefix = this.redis.options.keyPrefix ?? '';
    const pattern = `${clientPrefix}${this.keyPrefix}*`;
    const states: VesselState[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        1000,
      );
      cursor = next;
      if (keys.length === 0) continue;
      // SCAN returns full keys; commands add the client prefix again.
      const values = await this.redis.mget(
        ...keys.map((key) => key.slice(clientPrefix.length)),
      );
      for (const value of values) {
        const state = value === null ? undefined : parseState(value);
        if (state !== undefined) states.push(state);
      }
    } while (cursor !== '0');
    return states;
  }
}

function parseState(value: string): VesselState | undefined {
  try {
    const parsed = JSON.parse(value) as SerializedState;
    const time = new Date(parsed.time);
    const receivedAt = new Date(parsed.receivedAt);
    if (
      !Number.isFinite(time.getTime()) ||
      !Number.isFinite(receivedAt.getTime())
    )
      return undefined;
    return { ...parsed, time, receivedAt };
  } catch {
    return undefined;
  }
}
