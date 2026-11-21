import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  type DynamicModule,
  Logger,
  Module,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import type { Redis } from 'ioredis';

import { provideAs } from '../common/provider-definition.js';
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
 * @example
 * DetectorRunnerModule.forRoot({
 *   positions: 'safety-positions',
 *   persistence: { useClass: SafetyEventsRepository },
 * })
 */
@Module({})
export class DetectorRunnerModule {
  /** Registers the SDK providers and the runner. */
  static forRoot(options: DetectorRunnerOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: DETECTOR_RUNNER_OPTIONS, useValue: options },
      { provide: DETECTOR_CLOCK, useValue: (() => new Date()) satisfies Clock },
      {
        provide: DetectorMetrics,
        useFactory: (metrics: MetricsService) => new DetectorMetrics(metrics),
        inject: [MetricsService],
      },
      {
        provide: VesselStateStore,
        useFactory: (
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
          DETECTOR_CLOCK,
          APP_CONFIG,
          { token: REDIS_CLIENT, optional: true },
        ],
      },
      {
        provide: PairSearch,
        useFactory: (clock: Clock) =>
          new PairSearch<VesselState>({
            ...options.pairSearch,
            distanceModel: options.distanceModel,
            clock,
          }),
        inject: [DETECTOR_CLOCK],
      },
      {
        provide: ZoneIndex,
        useFactory: () =>
          new ZoneIndex({ distanceModel: options.distanceModel }),
      },
      { provide: FleetDirectory, useFactory: () => new FleetDirectory() },
      {
        provide: AlertEmitter,
        useFactory: (
          publisher: EventPublisher,
          clock: Clock,
          persistence: AlertPersistence | undefined,
        ) =>
          new AlertEmitter({
            clock,
            cooldownMs: options.alertCooldownMs,
            persistence,
            publish: async (alert) => {
              // Same id for the envelope: retries are deduplicated by JetStream.
              await retryUntilDeadline(
                () =>
                  publisher.publishEvent(EVENT_TYPES.ALERT_RAISED, alert, {
                    id: alert.id,
                  }),
                {
                  deadlineMs: PUBLISH_ATTEMPTS_DEADLINE_MS,
                  initialDelayMs: 200,
                  maxDelayMs: 2_000,
                },
              );
            },
          }),
        inject: [
          EventPublisher,
          DETECTOR_CLOCK,
          { token: ALERT_PERSISTENCE, optional: true },
        ],
      },
      {
        provide: DetectorRegistry,
        useFactory: (
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
            env: options.env,
            enabled: options.enabled,
            metrics,
            callTimeoutMs: options.callTimeoutMs,
          });
        },
        inject: [
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
    if (options.persistence !== undefined)
      providers.push(provideAs(ALERT_PERSISTENCE, options.persistence));
    return {
      module: DetectorRunnerModule,
      global: true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
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
      ],
    };
  }
}
