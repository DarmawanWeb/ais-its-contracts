import type {
  AlertDomain,
  AlertType,
} from '@darmawanweb/ais-its-contracts/domain';
import { DiscoveryService } from '@nestjs/core';
import type * as z from 'zod';

import type {
  AlertOutcome,
  AlertResolveOptions,
  AlertSignal,
  OpenAlert,
} from './alert-emitter.js';
import type { FleetDirectory, VesselChange } from './fleet-directory.js';
import type { PairSearch } from './pair-search.js';
import type { VesselPosition } from './vessel-position.js';
import type { VesselState, VesselStateStore } from './vessel-state-store.js';
import type { ZoneChange, ZoneIndex } from './zone-index.js';

/** Format of detector ids: a lowercase token, e.g. `ews`, `collision`, `dark_vessel`. */
export const DETECTOR_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/** A zone change as delivered to detectors. */
export interface DetectorZoneChange extends ZoneChange {
  /** `true` while the projection loads its initial snapshot at startup. */
  readonly initial: boolean;
}

/** A vessel change as delivered to detectors. */
export interface DetectorVesselChange extends VesselChange {
  /** `true` while the projection loads its initial snapshot at startup. */
  readonly initial: boolean;
}

/** A signal raised through {@link DetectorAlerts}: the method id defaults to the detector's first one. */
export type DetectorAlertSignal = Omit<AlertSignal, 'methodId'> & {
  readonly methodId?: string | undefined;
};

/** The alert emitter bound to one detector (its domain, default method id and metrics). */
export interface DetectorAlerts {
  /** Reports a condition; see `AlertEmitter.raise` for the outcomes. */
  raise(signal: DetectorAlertSignal): Promise<AlertOutcome>;
  /** Ends the open occurrence of `dedupKey`; `false` when none was open. */
  resolve(
    dedupKey: string,
    options?: Omit<AlertResolveOptions, 'accept'>,
  ): Promise<boolean>;
  /** The open occurrence of a key. */
  get(dedupKey: string): OpenAlert | undefined;
  /** `true` when the key is open. */
  isOpen(dedupKey: string): boolean;
  /**
   * Open occurrences raised by THIS detector (plus restored ones without an
   * owner of its domain), optionally of one vessel. `get`, `isOpen` and
   * `resolve` see the same set: a detector never touches another
   * detector's alerts.
   */
  open(filter?: { readonly mmsi?: number }): OpenAlert[];
}

/** Per-call facts handed to a detector hook. */
export interface DetectorCall {
  /**
   * Aborted when the call exceeds the registry's `callTimeoutMs`: stop
   * working (the result is ignored). Until the call settles, the detector's
   * next calls for the same vessel are skipped.
   */
  readonly signal: AbortSignal;
}

/** Logger handed to a detector (Nest `Logger` with context `Detector:<id>`). */
export interface DetectorLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** Identity of a registered detector. */
export interface DetectorDescriptor {
  readonly id: string;
  readonly domain: AlertDomain;
  readonly methodIds: readonly string[];
}

/**
 * What every detector call receives: its validated configuration and the
 * shared SDK state (spec §18). The runner updates `vessels` and `pairs` with
 * a position BEFORE calling `onPosition`, so they already contain it.
 */
export interface DetectorContext<Config = unknown> {
  readonly detector: DetectorDescriptor;
  /** The detector's `<ID>_*` configuration, validated with its `configSchema`. */
  readonly config: Config;
  /** Latest state per vessel (all vessels of the position feed). */
  readonly vessels: VesselStateStore;
  /** Latest state per vessel indexed for neighbour queries. */
  readonly pairs: PairSearch<VesselState>;
  /** `GEO` projection. */
  readonly zones: ZoneIndex;
  /** `FLEET` projection (mmsi → vessel, org). */
  readonly fleet: FleetDirectory;
  readonly alerts: DetectorAlerts;
  readonly logger: DetectorLogger;
  /** The SDK clock (fixed in tests). */
  now(): Date;
}

/**
 * An analytics feature reacting to vessel movement (spec §18). Implement it
 * in a NestJS provider decorated with {@link RegisterDetector}; the
 * `DetectorRegistry` discovers it at boot, enables it unless `DETECTORS`
 * excludes it, validates its `<ID>_*` environment with `configSchema`, and
 * isolates its failures (a throwing detector never blocks the others; a
 * hanging call is abandoned after `callTimeoutMs`, its `signal` aborted).
 * A position is acknowledged once every enabled detector handled it, so the
 * slowest detector sets the position throughput of its deployment: give
 * slow detectors their own deployment with `DETECTORS` (each detector
 * subset consumes through its own durable consumer).
 *
 * Calls for one vessel never overlap and arrive in time order (positions
 * that are not newer than the vessel's state are dropped before detectors
 * see them). Handlers must be idempotent with respect to restarts.
 *
 * @typeParam Config - output of `configSchema`.
 */
export interface Detector<Config = Record<string, never>> {
  /** Unique id ({@link DETECTOR_ID_PATTERN}), also the `<ID>_` env prefix and the metrics label. */
  readonly id: string;
  /** `'safety'` or `'surveillance'`: the domain of the alerts it raises. */
  readonly domain: AlertDomain;
  /** Methodology catalog ids of the rules it implements (spec §17). */
  readonly methodIds: readonly string[];
  /**
   * Alert types it raises (contracts `ALERT_TYPES` or open-vocabulary
   * types). When declared, registration checks them against the registry's
   * domains and raising any other type fails.
   */
  readonly alertTypes?: readonly AlertType[] | undefined;
  /**
   * Schema of the detector's configuration, parsed from the `<ID>_*`
   * variables with the prefix removed: `EWS_DANGER_M=500` → `{ DANGER_M: '500' }`
   * (use `z.coerce` / the kit's `envInteger`, `envBoolean`).
   */
  readonly configSchema?: z.ZodType<Config> | undefined;
  /** Interval of {@link onTick}, ms. Default: no ticks. */
  readonly tickIntervalMs?: number | undefined;
  /** A new position of a vessel (`ais.position.recorded.v1`). */
  onPosition(
    context: DetectorContext<Config>,
    position: VesselPosition,
    call: DetectorCall,
  ): void | Promise<void>;
  /**
   * Periodic evaluation (e.g. AIS gaps), every `tickIntervalMs`; ticks never
   * overlap each other but run alongside position calls (alert operations
   * on one `dedupKey` are serialized by the emitter).
   */
  onTick?(
    context: DetectorContext<Config>,
    now: Date,
    call: DetectorCall,
  ): void | Promise<void>;
  /** A zone was created, changed or deleted (after the index was updated). */
  onZoneChanged?(
    context: DetectorContext<Config>,
    change: DetectorZoneChange,
    call: DetectorCall,
  ): void | Promise<void>;
  /** A vessel snapshot was created, changed or deleted (after the directory was updated). */
  onVesselChanged?(
    context: DetectorContext<Config>,
    change: DetectorVesselChange,
    call: DetectorCall,
  ): void | Promise<void>;
}

/** Any detector, whatever its configuration type. */
export type AnyDetector = Detector<unknown>;

/**
 * Class decorator registering a provider as a detector; the provider must be
 * listed in a module's `providers` and implement {@link Detector}.
 *
 * @example
 * @RegisterDetector()
 * @Injectable()
 * export class EwsDetector implements Detector<EwsConfig> { … }
 */
export const RegisterDetector = DiscoveryService.createDecorator<undefined>();

/** `true` when a value implements the {@link Detector} members the registry needs. */
export function isDetector(value: unknown): value is AnyDetector {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'domain' in value &&
    typeof value.domain === 'string' &&
    'methodIds' in value &&
    Array.isArray(value.methodIds) &&
    'onPosition' in value &&
    typeof value.onPosition === 'function'
  );
}
