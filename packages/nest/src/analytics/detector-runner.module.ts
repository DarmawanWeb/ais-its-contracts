import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  type DynamicModule,
  type InjectionToken,
  Logger,
  Module,
  type ModuleMetadata,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { Redis } from 'ioredis';

import {
  type ProviderDefinition,
  provideAs,
} from '../common/provider-definition.js';
import { errorMessage, retryUntilDeadline } from '../common/retry.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { EventPublisher } from '../nats/event-publisher.js';
import { REDIS_CLIENT } from '../redis/redis.tokens.js';
import { AlertEmitter, type AlertPersistence } from './alert-emitter.js';
import { DetectorEngine } from './detector-engine.js';
import { DetectorMetrics } from './detector-metrics.js';
import {
  DetectorRegistry,
  type DetectorServices,
} from './detector-registry.js';
import { DetectorRunner } from './detector-runner.js';
import {
  ALERT_PERSISTENCE,
  DETECTOR_CLOCK,
  DETECTOR_ENV,
  DETECTOR_RUNNER_OPTIONS,
  type DetectorRunnerOptions,
} from './detector-runner.options.js';
import { FleetDirectory } from './fleet-directory.js';
import { PairSearch } from './pair-search.js';
import {
  RedisVesselStateMirror,
  type VesselState,
  VesselStateStore,
} from './vessel-state-store.js';
import { ZoneIndex } from './zone-index.js';

/** Attempts of an alert publication before the error reaches the detector. */
const PUBLISH_ATTEMPTS_DEADLINE_MS = 5_000;

/** Retry schedule of alert and resolution publications (same event id: deduplicated). */
const PUBLISH_RETRY = {
  deadlineMs: PUBLISH_ATTEMPTS_DEADLINE_MS,
  initialDelayMs: 200,
  maxDelayMs: 2_000,
} as const;

type Clock = () => Date;

/**
 * The Detector SDK runtime of a service (spec §18): registers the
 * `@RegisterDetector()` providers of the application, keeps the shared state
 * ({@link VesselStateStore}, {@link PairSearch}, {@link ZoneIndex},
 * {@link FleetDirectory}, {@link AlertEmitter}) and feeds it from NATS — the
 * durable position consumer plus `GEO` / `FLEET` snapshots — through the
 * {@link DetectorRunner}. Requires `NatsModule` (and `RedisModule` when
 * `vesselState.mirror` is on). Global: every provider is exported, so any
 * controller can inject e.g. `DetectorRegistry` for `GET …/detectors`.
 *
 * The persistence hook is provided under the `ALERT_PERSISTENCE` token; a
 * `{ useClass: X }` hook is also provided as `X` (one instance), so tests
 * can `app.get(X)`. Resolutions are published as `alert.resolved.v1`
 * unless `publishResolutions: false`.
 *
 * @example
 * DetectorRunnerModule.forRoot({
 *   positions: 'safety-positions',
 *   persistence: { useClass: SafetyEventsRepository },
 * })
 * // or with options from the typed configuration:
 * DetectorRunnerModule.forRootAsync({
 *   inject: [APP_CONFIG],
 *   useFactory: (config: Config) => ({ positions: 'safety-positions', concurrency: config.SAFETY_CONCURRENCY }),
 *   persistence: { useClass: SafetyEventsRepository },
 * })
 */
/** Options of {@link DetectorRunnerModule.forRootAsync}. */
export interface DetectorRunnerModuleAsyncOptions {
  /** Builds the options, e.g. from `APP_CONFIG` (the validated configuration). */
  readonly useFactory: (
    ...args: never[]
  ) => DetectorRunnerOptions | Promise<DetectorRunnerOptions>;
  /** Providers handed to `useFactory`. */
  readonly inject?:
    readonly (InjectionToken | OptionalFactoryDependency)[] | undefined;
  /** Modules of the injected providers and of the persistence provider. */
  readonly imports?: ModuleMetadata['imports'];
  /** The service's event repository hook (static: it is a provider). */
  readonly persistence?: ProviderDefinition<AlertPersistence> | undefined;
}

/**
 * Providers of the persistence hook: `ALERT_PERSISTENCE`, plus the class
 * itself for `{ useClass: X }` (aliased, so both tokens give one instance).
 */
function persistenceProviders(
  definition: ProviderDefinition<AlertPersistence>,
): Provider[] {
  if (!('useClass' in definition))
    return [provideAs(ALERT_PERSISTENCE, definition)];
  const { useClass, ...rest } = definition;
  return [
    { ...rest, provide: useClass, useClass },
    { provide: ALERT_PERSISTENCE, useExisting: useClass },
  ];
}

@Module({})
export class DetectorRunnerModule {
  /** Registers the SDK providers and the runner. */
  static forRoot(options: DetectorRunnerOptions): DynamicModule {
    return DetectorRunnerModule.build(
      { provide: DETECTOR_RUNNER_OPTIONS, useValue: options },
      options.persistence,
      options.imports,
    );
  }

  /**
   * Like {@link forRoot}, with the options built by a factory (e.g. from
   * the typed configuration, `inject: [APP_CONFIG]`).
   */
  static forRootAsync(
    options: DetectorRunnerModuleAsyncOptions,
  ): DynamicModule {
    return DetectorRunnerModule.build(
      {
        provide: DETECTOR_RUNNER_OPTIONS,
        useFactory: options.useFactory,
        inject: [...(options.inject ?? [])],
      },
      options.persistence,
      options.imports,
    );
  }

  private static build(
    optionsProvider: Provider,
    persistence: ProviderDefinition<AlertPersistence> | undefined,
    imports: ModuleMetadata['imports'],
  ): DynamicModule {
    const providers: Provider[] = [
      optionsProvider,
      {
        provide: DETECTOR_ENV,
        useFactory: (options: DetectorRunnerOptions) =>
          options.env ?? process.env,
        inject: [DETECTOR_RUNNER_OPTIONS],
      },
      { provide: DETECTOR_CLOCK, useValue: (() => new Date()) satisfies Clock },
      {
        provide: DetectorMetrics,
        useFactory: (metrics: MetricsService) => new DetectorMetrics(metrics),
        inject: [MetricsService],
      },
      {
        provide: VesselStateStore,
        useFactory: (
          options: DetectorRunnerOptions,
          clock: Clock,
          config: BaseConfig,
          redis: Redis | undefined,
        ) => {
          const { mirror, ...limits } = options.vesselState ?? {};
          const logger = new Logger('VesselStateStore');
          let stateMirror: RedisVesselStateMirror | undefined;
          if (mirror !== undefined && mirror !== false) {
            if (redis === undefined)
              throw new Error(
                'vesselState.mirror needs RedisModule in the application',
              );
            // One namespace per service: services never load each other's states.
            stateMirror = new RedisVesselStateMirror(redis, {
              keyPrefix: `aisits:${config.SERVICE_NAME}:vessel-state:`,
              ...(mirror === true ? {} : mirror),
            });
          }
          return new VesselStateStore({
            ...limits,
            clock,
            mirror: stateMirror,
            onError: (error) => {
              logger.warn(
                `Vessel state mirror write failed: ${errorMessage(error)}`,
              );
            },
          });
        },
        inject: [
          DETECTOR_RUNNER_OPTIONS,
          DETECTOR_CLOCK,
          APP_CONFIG,
          { token: REDIS_CLIENT, optional: true },
        ],
      },
      {
        provide: PairSearch,
        useFactory: (options: DetectorRunnerOptions, clock: Clock) =>
          new PairSearch<VesselState>({
            ...options.pairSearch,
            distanceModel: options.distanceModel,
            clock,
          }),
        inject: [DETECTOR_RUNNER_OPTIONS, DETECTOR_CLOCK],
      },
      {
        provide: ZoneIndex,
        useFactory: (options: DetectorRunnerOptions) =>
          new ZoneIndex({ distanceModel: options.distanceModel }),
        inject: [DETECTOR_RUNNER_OPTIONS],
      },
      { provide: FleetDirectory, useFactory: () => new FleetDirectory() },
      {
        provide: AlertEmitter,
        useFactory: (
          options: DetectorRunnerOptions,
          publisher: EventPublisher,
          clock: Clock,
          alertPersistence: AlertPersistence | undefined,
        ) =>
          new AlertEmitter({
            clock,
            cooldownMs: options.alertCooldownMs,
            repeatedIntervalMs: options.alertRepeatedIntervalMs,
            persistence: alertPersistence,
            publish: async (alert) => {
              // Same id for the envelope: retries are deduplicated by JetStream.
              await retryUntilDeadline(
                () =>
                  publisher.publishEvent(EVENT_TYPES.ALERT_RAISED, alert, {
                    id: alert.id,
                  }),
                PUBLISH_RETRY,
              );
            },
            // On the raise's subject alert.v1.<type>.<mmsi>, after the raise.
            publishResolution:
              options.publishResolutions === false
                ? undefined
                : async (event) => {
                    await retryUntilDeadline(
                      () =>
                        publisher.publishEvent(
                          EVENT_TYPES.ALERT_RESOLVED,
                          event,
                          { id: event.id },
                        ),
                      PUBLISH_RETRY,
                    );
                  },
          }),
        inject: [
          DETECTOR_RUNNER_OPTIONS,
          EventPublisher,
          DETECTOR_CLOCK,
          { token: ALERT_PERSISTENCE, optional: true },
        ],
      },
      {
        provide: DetectorRegistry,
        useFactory: (
          options: DetectorRunnerOptions,
          env: Readonly<Record<string, string | undefined>>,
          vessels: VesselStateStore,
          pairs: PairSearch<VesselState>,
          zones: ZoneIndex,
          fleet: FleetDirectory,
          alerts: AlertEmitter,
          clock: Clock,
          metrics: DetectorMetrics,
        ) => {
          const services: DetectorServices = {
            vessels,
            pairs,
            zones,
            fleet,
            alerts,
            clock,
          };
          return new DetectorRegistry({
            services,
            env,
            enabled: options.enabled,
            metrics,
            callTimeoutMs: options.callTimeoutMs,
          });
        },
        inject: [
          DETECTOR_RUNNER_OPTIONS,
          DETECTOR_ENV,
          VesselStateStore,
          PairSearch,
          ZoneIndex,
          FleetDirectory,
          AlertEmitter,
          DETECTOR_CLOCK,
          DetectorMetrics,
        ],
      },
      {
        provide: DetectorEngine,
        useFactory: (
          registry: DetectorRegistry,
          vessels: VesselStateStore,
          pairs: PairSearch<VesselState>,
          zones: ZoneIndex,
          fleet: FleetDirectory,
          alerts: AlertEmitter,
          clock: Clock,
          metrics: DetectorMetrics,
        ) =>
          new DetectorEngine(
            registry,
            { vessels, pairs, zones, fleet, alerts, clock },
            metrics,
          ),
        inject: [
          DetectorRegistry,
          VesselStateStore,
          PairSearch,
          ZoneIndex,
          FleetDirectory,
          AlertEmitter,
          DETECTOR_CLOCK,
          DetectorMetrics,
        ],
      },
      DetectorRunner,
    ];
    if (persistence !== undefined)
      providers.push(...persistenceProviders(persistence));
    return {
      module: DetectorRunnerModule,
      global: true,
      imports: [DiscoveryModule, ...(imports ?? [])],
      providers,
      exports: [
        DetectorRegistry,
        DetectorEngine,
        VesselStateStore,
        PairSearch,
        ZoneIndex,
        FleetDirectory,
        AlertEmitter,
        DetectorMetrics,
        DETECTOR_CLOCK,
        DETECTOR_ENV,
      ],
    };
  }
}
