import type { ModuleMetadata } from '@nestjs/common';

import type { ProviderDefinition } from '../common/provider-definition.js';
import type { DurableConsumerRef } from '../nats/consumer-definitions.js';
import type { ExclusiveConsumerOptions } from '../nats/event-handler.decorator.js';
import type { AlertPersistence } from './alert-emitter.js';
import type { DistanceModel } from './geodesy.js';
import type { PairSearchOptions } from './pair-search.js';
import type {
  RedisVesselStateMirrorOptions,
  VesselStateStoreOptions,
} from './vessel-state-store.js';

/** Injection token of the {@link DetectorRunnerOptions}. */
export const DETECTOR_RUNNER_OPTIONS = 'AISITS_DETECTOR_RUNNER_OPTIONS';

/**
 * Injection token of the service's {@link AlertPersistence} hook
 * (`DetectorRunnerOptions.persistence`), e.g.
 * `app.get<AlertPersistence>(ALERT_PERSISTENCE)` in tests.
 */
export const ALERT_PERSISTENCE = 'AISITS_ALERT_PERSISTENCE';

/** Injection token of the SDK clock (`() => Date`). */
export const DETECTOR_CLOCK = 'AISITS_DETECTOR_CLOCK';

/**
 * Injection token of the variables `DETECTORS` and `<ID>_*` are read from
 * (default `DetectorRunnerOptions.env ?? process.env`, read when the module
 * is built, i.e. after `loadConfig()` loaded `.env`). Override it in tests:
 * `buildTestApp(AppModule, { config, overrides: [{ provide: DETECTOR_ENV, useValue: { DETECTORS: 'ews' } }] })`.
 */
export const DETECTOR_ENV = 'AISITS_DETECTOR_ENV';

/** Options of `DetectorRunnerModule.forRoot()`. */
export interface DetectorRunnerOptions {
  /**
   * Durable consumer of the position feed: `'safety-positions'`,
   * `'surveillance-positions'` (contracts `CONSUMERS`) or an explicit
   * definition on `AIS_POSITION`.
   */
  readonly positions: DurableConsumerRef;
  /** Positions handled in parallel (one vessel's positions stay in order). Default 8. */
  readonly concurrency?: number | undefined;
  /**
   * Single active instance (default `true`): detector state lives in
   * memory, so with several replicas only one consumes positions (NATS
   * priority group `pinned_client`); the others stand by and take over
   * when it stops gracefully (it releases the pin) or stops pulling for
   * `pinnedTtlMs` (default 30 s). Before its first position, the new active
   * instance publishes its pending resolutions, reloads the open alerts
   * from `AlertPersistence.loadOpen` (replace semantics), re-seeds vessel
   * states from the mirror and calls `Detector.onActivated`; ticks run only
   * on the active instance (`DetectorContext.isActive`). Replicas give
   * failover, not throughput: scale out by splitting detectors over
   * deployments with `DETECTORS` (each subset consumes through its own
   * durable, `<positions>-<ids>`). `false` lets every replica share the
   * feed (every replica is active) — only for detectors without per-vessel
   * or pair state.
   */
  readonly exclusive?: boolean | ExclusiveConsumerOptions | undefined;
  /** Load the `GEO` projection into the `ZoneIndex`. Default `true`. */
  readonly zones?: boolean | undefined;
  /** Load the `FLEET` projection into the `FleetDirectory`. Default `true`. */
  readonly fleet?: boolean | undefined;
  /** Distance model of the `ZoneIndex` and `PairSearch`. Default `'wgs84'`. */
  readonly distanceModel?: DistanceModel | undefined;
  /** Vessel state store limits; `mirror: true` mirrors states to Valkey (`RedisModule` required). */
  readonly vesselState?:
    | (Omit<VesselStateStoreOptions, 'mirror' | 'clock' | 'onError'> & {
        readonly mirror?: boolean | RedisVesselStateMirrorOptions | undefined;
      })
    | undefined;
  /** Neighbour search grid. */
  readonly pairSearch?:
    Omit<PairSearchOptions, 'clock' | 'distanceModel'> | undefined;
  /**
   * Alert emitter cooldown between publications of a key, ms. Default 10
   * min. A resolution is announced once the key's cooldown since its last
   * published raise is over (see `AlertEmitterOptions.publishResolution`).
   */
  readonly alertCooldownMs?: number | undefined;
  /**
   * Minimum event-time interval between two `AlertPersistence.onRepeated`
   * calls of a key, ms. Default 60 s.
   */
  readonly alertRepeatedIntervalMs?: number | undefined;
  /**
   * Publish resolutions as `alert.resolved.v1` on the raise's subject
   * (`EventPublisher`, retried for up to 5 s like raises, then by the
   * runner's housekeeping). Default `true`; `false` only persists them.
   */
  readonly publishResolutions?: boolean | undefined;
  /**
   * The service's event repository hook (`useClass`, `useExisting`,
   * `useFactory` or `useValue`), provided as `ALERT_PERSISTENCE`; a
   * `useClass` hook is also provided under its class (same instance), so
   * `app.get(MyEventsRepository)` works in tests. When the application
   * already provides the class, pass `{ useExisting: MyEventsRepository }`
   * to share that instance.
   */
  readonly persistence?: ProviderDefinition<AlertPersistence> | undefined;
  /** Source of `DETECTORS` and `<ID>_*`. Default `process.env` (after `loadConfig` read `.env`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Enabled detector ids; overrides `DETECTORS`. */
  readonly enabled?: readonly string[] | undefined;
  /** Upper bound of one detector call, ms. Default 10 s. */
  readonly callTimeoutMs?: number | undefined;
  /** How long startup waits for the projections' snapshots, ms. Default 60 s. */
  readonly catchUpTimeoutMs?: number | undefined;
  /** Modules the persistence provider depends on. */
  readonly imports?: ModuleMetadata['imports'];
}
