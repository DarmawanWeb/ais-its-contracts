import type {
  AlertRaisedV1,
  AlertResolvedV1,
  VesselSnapshotV1,
  ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';

import { MetricsService } from '../metrics/metrics.service.js';
import {
  makeTestVesselSnapshot,
  makeTestZone,
  type TestZoneInput,
} from '../testing/fixtures.js';
import {
  AlertEmitter,
  type AlertPersistence,
  type AlertPublicationResult,
  type AlertResolution,
  type AlertUpdate,
  type OpenAlert,
  type UnannouncedResolution,
} from './alert-emitter.js';
import type {
  AnyDetector,
  DetectorVesselChange,
  DetectorZoneChange,
} from './detector.js';
import { type DetectorActivation, DetectorEngine } from './detector-engine.js';
import { DetectorMetrics, type PositionOutcome } from './detector-metrics.js';
import {
  type DetectorDescription,
  DetectorRegistry,
  type DetectorServices,
} from './detector-registry.js';
import { FleetDirectory } from './fleet-directory.js';
import type { DistanceModel } from './geodesy.js';
import { PairSearch, type PairSearchOptions } from './pair-search.js';
import type {
  PreviousVesselPosition,
  VesselPosition,
} from './vessel-position.js';
import {
  type VesselState,
  VesselStateStore,
  type VesselStateStoreOptions,
} from './vessel-state-store.js';
import { ZoneIndex } from './zone-index.js';

// The payload builders live in ./testing (no container dependency) and stay
// exported from ./analytics for detector tests.
export { makeTestVesselSnapshot, makeTestZone, type TestZoneInput };

/** A synthetic position: `mmsi`, `lat` and `lon` are required, the rest has defaults. */
export type TestPositionInput = Pick<VesselPosition, 'mmsi' | 'lat' | 'lon'> &
  Partial<Omit<VesselPosition, 'mmsi' | 'lat' | 'lon'>>;

/** Options of {@link DetectorTestHarness.create}. */
export interface DetectorTestHarnessOptions {
  /** Detector instances under test (constructed by the test, or taken from a Nest testing module). */
  readonly detectors: readonly AnyDetector[];
  /** `DETECTORS` and `<ID>_*` variables. Default `{}` (never `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Enabled ids (overrides `DETECTORS`). */
  readonly enabled?: readonly string[] | undefined;
  /** Initial clock. Default `2026-01-01T00:00:00Z`. */
  readonly now?: Date | undefined;
  /** Alert cooldown, ms. Default 10 min. */
  readonly alertCooldownMs?: number | undefined;
  /** Event-time throttle of `AlertPersistence.onRepeated`, ms. Default 60 s. */
  readonly alertRepeatedIntervalMs?: number | undefined;
  /**
   * Record resolutions as published `alert.resolved.v1` events
   * ({@link DetectorTestHarness.resolvedEvents}), like the runner's default.
   * Default `true`.
   */
  readonly publishResolutions?: boolean | undefined;
  readonly distanceModel?: DistanceModel | undefined;
  readonly pairSearch?:
    Omit<PairSearchOptions, 'clock' | 'distanceModel'> | undefined;
  readonly vesselState?:
    Omit<VesselStateStoreOptions, 'clock' | 'mirror'> | undefined;
  /**
   * Persistence hook to exercise (calls are recorded either way); its
   * `loadOpen` also feeds {@link DetectorTestHarness.activate}.
   */
  readonly persistence?: AlertPersistence | undefined;
  /** Upper bound of a detector call, ms. Default 10 s. */
  readonly callTimeoutMs?: number | undefined;
  /**
   * Time step of positions fed without a `time`: a vessel's next position
   * comes `stepMs` after its previous one (and the clock follows), so a
   * synthetic track is never reduced to its first point. Default 10 s.
   */
  readonly stepMs?: number | undefined;
}

/** Default {@link DetectorTestHarnessOptions.stepMs}. */
export const DEFAULT_HARNESS_STEP_MS = 10_000;

const DEFAULT_START = new Date('2026-01-01T00:00:00.000Z');

/**
 * Runs detectors without NATS, Nest or a database (spec §18): feed synthetic
 * positions, tracks, zones and vessels, move the clock, and inspect the
 * published alerts, updates, resolutions and resolution events. The
 * detectors see exactly what the runner gives them in production (same
 * engine, registry, configuration parsing and failure isolation); the
 * harness starts as the active instance, and {@link activate} /
 * {@link deactivate} simulate a failover.
 *
 * Resolution events follow the emitter's cooldown: one resolved within
 * `alertCooldownMs` of its raise is published by {@link maintain} once the
 * window ended (the runner's housekeeping, every 30 s in production).
 *
 * @example
 * const harness = DetectorTestHarness.create({ detectors: [new EwsDetector()], env: { EWS_DANGER_M: '500' } });
 * await harness.zone({ kind: 'pipeline', geometry: { type: 'LineString', coordinates: [[104, 1], [104.1, 1]] } });
 * await harness.position({ mmsi: 525005223, lat: 1.002, lon: 104.05, predictedNavstatus: 1 });
 * expect(harness.alerts).toEqual([expect.objectContaining({ type: 'ews', severity: 'critical' })]);
 */
export class DetectorTestHarness {
  /** Published alerts, in order. */
  readonly alerts: AlertRaisedV1[] = [];
  /** De-escalations and suppressed re-raises, in order. */
  readonly updates: AlertUpdate[] = [];
  /** Resolutions (persistence `onResolved`), in order. */
  readonly resolutions: AlertResolution[] = [];
  /** Published resolution events (`alert.resolved.v1` payloads), in order. */
  readonly resolvedEvents: AlertResolvedV1[] = [];
  /** Log lines of the detectors (`<level> <detector>: <message>`), e.g. isolated failures. */
  readonly logs: string[] = [];
  /** Registry metrics (a private registry). */
  readonly metrics: MetricsService;
  readonly registry: DetectorRegistry;
  readonly engine: DetectorEngine;
  readonly services: DetectorServices;
  private clock: Date;
  private readonly stepMs: number;
  /** The persistence hook's `loadOpen`, for {@link activate}. */
  private readonly loadOpen: (() => Promise<readonly OpenAlert[]>) | undefined;
  /** The persistence hook's `loadUnannounced`, for {@link activate}. */
  private readonly loadUnannounced:
    (() => Promise<readonly UnannouncedResolution[]>) | undefined;
  private readonly lastPositions = new Map<number, VesselPosition>();

  private constructor(options: DetectorTestHarnessOptions) {
    this.clock = options.now ?? DEFAULT_START;
    this.stepMs = options.stepMs ?? DEFAULT_HARNESS_STEP_MS;
    const now = (): Date => this.clock;
    const persistence = options.persistence;
    const recording: AlertPersistence = {
      onRaised: async (alert, outcome) => {
        await persistence?.onRaised?.(alert, outcome);
      },
      onUpdated: async (update) => {
        this.updates.push(update);
        await persistence?.onUpdated?.(update);
      },
      onRepeated: async (alert, occurredAt) => {
        await persistence?.onRepeated?.(alert, occurredAt);
      },
      onResolved: async (resolution) => {
        this.resolutions.push(resolution);
        await persistence?.onResolved?.(resolution);
      },
      loadOpen: async () => (await persistence?.loadOpen?.()) ?? [],
      onResolutionPublished: async (resolution) => {
        await persistence?.onResolutionPublished?.(resolution);
      },
    };
    this.services = {
      vessels: new VesselStateStore({ ...options.vesselState, clock: now }),
      pairs: new PairSearch<VesselState>({
        ...options.pairSearch,
        distanceModel: options.distanceModel,
        clock: now,
      }),
      zones: new ZoneIndex({ distanceModel: options.distanceModel }),
      fleet: new FleetDirectory(),
      alerts: new AlertEmitter({
        clock: now,
        cooldownMs: options.alertCooldownMs,
        repeatedIntervalMs: options.alertRepeatedIntervalMs,
        persistence: recording,
        publish: (alert) => {
          this.alerts.push(alert);
          return Promise.resolve();
        },
        publishResolution:
          options.publishResolutions === false
            ? undefined
            : (event) => {
                this.resolvedEvents.push(event);
                return Promise.resolve();
              },
      }),
      clock: now,
    };
    this.metrics = new MetricsService();
    const detectorMetrics = new DetectorMetrics(this.metrics);
    this.registry = new DetectorRegistry({
      services: this.services,
      env: options.env ?? {},
      enabled: options.enabled,
      metrics: detectorMetrics,
      callTimeoutMs: options.callTimeoutMs,
      logger: (detectorId) => ({
        log: (message) => this.logs.push(`log ${detectorId}: ${message}`),
        warn: (message) => this.logs.push(`warn ${detectorId}: ${message}`),
        error: (message) => this.logs.push(`error ${detectorId}: ${message}`),
        debug: (message) => this.logs.push(`debug ${detectorId}: ${message}`),
      }),
    });
    this.registry.register(options.detectors);
    this.engine = new DetectorEngine(
      this.registry,
      this.services,
      detectorMetrics,
    );
    this.loadOpen = persistence?.loadOpen?.bind(persistence);
    this.loadUnannounced = persistence?.loadUnannounced?.bind(persistence);
  }

  /**
   * Creates a harness and registers the detectors.
   *
   * @throws {DetectorRegistrationError} / {ConfigValidationError} like the runner at boot.
   */
  static create(options: DetectorTestHarnessOptions): DetectorTestHarness {
    return new DetectorTestHarness(options);
  }

  /** The harness clock. */
  get now(): Date {
    return this.clock;
  }

  /** Sets the clock. */
  setTime(time: Date): void {
    this.clock = time;
  }

  /** Moves the clock forward by `ms`. */
  advance(ms: number): Date {
    this.clock = new Date(this.clock.getTime() + ms);
    return this.clock;
  }

  /**
   * Feeds one position. Defaults: `time` = the clock for a vessel's first
   * position, then `stepMs` after its previous one (the clock follows the
   * position times), `source: 'primary'`, `sog`/`cog` 0, `hdg` 511,
   * `navstatus` 0, `predictedNavstatus` 0, `coastDistanceM: null`, and
   * `previous` = the last position fed for the vessel.
   */
  async position(input: TestPositionInput): Promise<PositionOutcome> {
    const position = this.completePosition(input);
    if (position.time.getTime() > this.clock.getTime())
      this.clock = position.time;
    const outcome = await this.engine.ingestPosition(position);
    if (outcome === 'processed')
      this.lastPositions.set(position.mmsi, position);
    return outcome;
  }

  /** Feeds positions in order (e.g. a synthetic track). */
  async track(
    inputs: readonly TestPositionInput[],
  ): Promise<PositionOutcome[]> {
    const outcomes: PositionOutcome[] = [];
    for (const input of inputs) outcomes.push(await this.position(input));
    return outcomes;
  }

  /** Adds or replaces a zone (defaults: new id, `kind: 'custom'`, active, buffer 0). */
  async zone(input: TestZoneInput): Promise<ZoneSnapshotV1> {
    const zone = makeTestZone(input, this.clock);
    await this.engine.upsertZone(zone);
    return zone;
  }

  /** Deletes a zone. */
  async removeZone(id: string): Promise<DetectorZoneChange | undefined> {
    return this.engine.deleteZone(id);
  }

  /** Adds or replaces a vessel snapshot (see {@link makeTestVesselSnapshot}). */
  async vessel(
    input: Partial<VesselSnapshotV1> & Pick<VesselSnapshotV1, 'mmsi'>,
  ): Promise<VesselSnapshotV1> {
    const vessel = makeTestVesselSnapshot({
      updatedAt: this.clock.toISOString(),
      ...input,
    });
    await this.engine.upsertVessel(vessel);
    return vessel;
  }

  /** Deletes a vessel snapshot. */
  async removeVessel(
    vessel: Pick<VesselSnapshotV1, 'id' | 'mmsi' | 'orgId'>,
  ): Promise<DetectorVesselChange> {
    return this.engine.deleteVessel({
      id: vessel.id,
      mmsi: vessel.mmsi,
      orgId: vessel.orgId,
    });
  }

  /** `true` while the harness is the active instance (the default; see {@link activate}). */
  get active(): boolean {
    return this.engine.active;
  }

  /**
   * Simulates this instance becoming the active one after a failover, like
   * the runner when its exclusive position consumer is pinned
   * (`DetectorEngine.activate`): pending alert publications go out, the
   * open occurrences are replaced with the persistence hook's `loadOpen()`
   * (kept when it has none), the detectors' `onActivated` run, then
   * `isActive()` is `true` and ticks run again.
   */
  activate(): Promise<DetectorActivation> {
    return this.engine.activate({
      loadOpen: this.loadOpen,
      loadUnannounced: this.loadUnannounced,
    });
  }

  /**
   * Simulates losing the active role (`DetectorEngine.deactivate`):
   * `isActive()` turns `false`, {@link tick} does nothing, pending alert
   * publications go out (resolutions within their cooldown included) and
   * the detectors' `onDeactivated` run.
   */
  deactivate(): Promise<AlertPublicationResult> {
    return this.engine.deactivate();
  }

  /**
   * Runs the runner's periodic housekeeping now (every 30 s in production):
   * retries failed alert publications, publishes the resolutions whose
   * cooldown window ended, forgets expired cooldowns and old neighbours.
   */
  async maintain(): Promise<AlertPublicationResult> {
    const result = await this.services.alerts.retryPending();
    this.services.alerts.prune(this.clock);
    this.services.pairs.prune();
    return result;
  }

  /**
   * Runs `onTick` of the detectors (default: all that tick) at `now`
   * (default: the clock); nothing while the harness is not {@link active}.
   */
  async tick(
    now: Date = this.clock,
    detectorIds?: readonly string[],
  ): Promise<void> {
    if (now.getTime() > this.clock.getTime()) this.clock = now;
    await this.engine.tick(now, detectorIds);
  }

  /** Published alerts of one type. */
  alertsOf(type: string): AlertRaisedV1[] {
    return this.alerts.filter((alert) => alert.type === type);
  }

  /** Detector descriptions (`GET …/detectors`). */
  describe(): DetectorDescription[] {
    return this.registry.describe();
  }

  /**
   * The harness's metrics in the Prometheus text format (`aisits_detector_*`),
   * e.g. to assert that a failing hook was counted.
   */
  metricsText(): Promise<string> {
    return this.metrics.render();
  }

  /** Forgets the recorded alerts, updates, resolutions and resolution events (state is kept). */
  clearRecords(): void {
    this.alerts.length = 0;
    this.updates.length = 0;
    this.resolutions.length = 0;
    this.resolvedEvents.length = 0;
  }

  /** Default time of a vessel's next position. */
  private nextTime(last: VesselPosition | undefined): Date {
    if (last === undefined || last.time.getTime() < this.clock.getTime())
      return this.clock;
    return new Date(last.time.getTime() + this.stepMs);
  }

  private completePosition(input: TestPositionInput): VesselPosition {
    const last = this.lastPositions.get(input.mmsi);
    const previous: PreviousVesselPosition | null =
      input.previous !== undefined
        ? input.previous
        : last === undefined
          ? null
          : {
              time: last.time,
              lat: last.lat,
              lon: last.lon,
              sog: last.sog,
              cog: last.cog,
              hdg: last.hdg,
              navstatus: last.navstatus,
              predictedNavstatus: last.predictedNavstatus,
            };
    return {
      mmsi: input.mmsi,
      time: input.time ?? this.nextTime(last),
      source: input.source ?? 'primary',
      lat: input.lat,
      lon: input.lon,
      sog: input.sog ?? 0,
      cog: input.cog ?? 0,
      hdg: input.hdg ?? 511,
      navstatus: input.navstatus ?? 0,
      predictedNavstatus: input.predictedNavstatus ?? 0,
      coastDistanceM: input.coastDistanceM ?? null,
      previous,
    };
  }
}
