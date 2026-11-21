import {
  type GeoJsonGeometry,
  newId,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  type AlertRaisedV1,
  type VesselSnapshotV1,
  VesselSnapshotV1Schema,
  type ZoneSnapshotV1,
  ZoneSnapshotV1Schema,
} from '@darmawanweb/ais-its-contracts/events';

import { MetricsService } from '../metrics/metrics.service.js';
import {
  AlertEmitter,
  type AlertPersistence,
  type AlertResolution,
  type AlertUpdate,
} from './alert-emitter.js';
import type {
  AnyDetector,
  DetectorVesselChange,
  DetectorZoneChange,
} from './detector.js';
import { DetectorEngine } from './detector-engine.js';
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

/** A synthetic position: `mmsi`, `lat` and `lon` are required, the rest has defaults. */
export type TestPositionInput = Pick<VesselPosition, 'mmsi' | 'lat' | 'lon'> &
  Partial<Omit<VesselPosition, 'mmsi' | 'lat' | 'lon'>>;

/** A synthetic zone: `geometry` is required (and `kind`, default `custom`). */
export type TestZoneInput = Pick<ZoneSnapshotV1, 'geometry'> &
  Partial<Omit<ZoneSnapshotV1, 'geometry'>>;

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
  readonly distanceModel?: DistanceModel | undefined;
  readonly pairSearch?:
    Omit<PairSearchOptions, 'clock' | 'distanceModel'> | undefined;
  readonly vesselState?:
    Omit<VesselStateStoreOptions, 'clock' | 'mirror'> | undefined;
  /** Persistence hook to exercise (calls are recorded either way). */
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
 * published alerts, updates and resolutions. The detectors see exactly what
 * the runner gives them in production (same engine, registry, configuration
 * parsing and failure isolation).
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
  /** Resolutions, in order. */
  readonly resolutions: AlertResolution[] = [];
  /** Log lines of the detectors (`<level> <detector>: <message>`), e.g. isolated failures. */
  readonly logs: string[] = [];
  /** Registry metrics (a private registry). */
  readonly metrics: MetricsService;
  readonly registry: DetectorRegistry;
  readonly engine: DetectorEngine;
  readonly services: DetectorServices;
  private clock: Date;
  private readonly stepMs: number;
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
      onResolved: async (resolution) => {
        this.resolutions.push(resolution);
        await persistence?.onResolved?.(resolution);
      },
      loadOpen: async () => (await persistence?.loadOpen?.()) ?? [],
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
        persistence: recording,
        publish: (alert) => {
          this.alerts.push(alert);
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

  /** Runs `onTick` of the detectors (default: all that tick) at `now` (default: the clock). */
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

  /** Forgets the recorded alerts, updates and resolutions (state is kept). */
  clearRecords(): void {
    this.alerts.length = 0;
    this.updates.length = 0;
    this.resolutions.length = 0;
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

/** A valid `ZoneSnapshotV1` from a geometry and overrides (validated with the contracts schema). */
export function makeTestZone(
  input: TestZoneInput,
  updatedAt: Date = DEFAULT_START,
): ZoneSnapshotV1 {
  const id = input.id ?? newId();
  const kind: ZoneKind = input.kind ?? 'custom';
  const geometry: GeoJsonGeometry = input.geometry;
  return ZoneSnapshotV1Schema.parse({
    id,
    orgId: input.orgId ?? null,
    code: input.code ?? `${kind}-${id.slice(-8)}`,
    name: input.name ?? `Test ${kind} zone`,
    kind,
    geometry,
    bufferM: input.bufferM ?? 0,
    active: input.active ?? true,
    alertOnEnter: input.alertOnEnter ?? false,
    properties: input.properties ?? {},
    updatedAt: input.updatedAt ?? updatedAt.toISOString(),
  });
}

/**
 * A valid `VesselSnapshotV1` (a 52 000 DWT bulk carrier) with overrides,
 * validated with the contracts schema; nested objects are replaced, not merged.
 */
export function makeTestVesselSnapshot(
  overrides: Partial<VesselSnapshotV1> & Pick<VesselSnapshotV1, 'mmsi'>,
): VesselSnapshotV1 {
  return VesselSnapshotV1Schema.parse({
    id: newId(),
    orgId: null,
    imo: null,
    name: `Test vessel ${overrides.mmsi}`,
    flag: 'ID',
    builtYear: 2010,
    status: 'active',
    annualVoyagePercentage: 70,
    dimensions: {
      capacity: 52_000,
      dwt: 52_000,
      gt: 31_200,
      cb: 0.82,
      lwl: 186.5,
      b: 32.26,
      t: 12.1,
      cwp: 0.89,
      loa: 189.99,
      lpp: 182,
      cp: 0.83,
      cm: 0.99,
      cbnsp: 0.81,
      bulbousBow: true,
      cstern: 0,
      c1: 2.12,
      c2: 1,
      c3: 1,
      c5: 1,
      vs: 14.2,
    },
    type: {
      id: newId(),
      code: 'bulk_carrier',
      name: 'Bulk carrier',
      capacityUnit: 'DWT',
      a: 4745,
      c: 0.622,
      capacityFixed: null,
      d: { d1: 0.86, d2: 0.94, d3: 1.06, d4: 1.18 },
    },
    fuel: {
      id: newId(),
      code: 'HFO',
      name: 'Heavy fuel oil',
      carbonContent: 0.8493,
      conversionFactor: 3.114,
      density: 0.991,
    },
    mainEngine: null,
    auxEngines: [],
    auxEngineQuantity: 0,
    firstFuelFormula: null,
    portIds: [],
    updatedAt: DEFAULT_START.toISOString(),
    ...overrides,
  });
}
