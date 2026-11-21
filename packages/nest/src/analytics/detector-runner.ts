import {
  type AnyEventEnvelope,
  EVENT_TYPES,
  type EventType,
  SUBJECT_FILTERS,
  type StreamName,
} from '@darmawanweb/ais-its-contracts/events';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import { createHash } from 'node:crypto';

import { errorMessage } from '../common/retry.js';
import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { NatsConsumerRuntime } from '../nats/consumer-runtime.js';
import { DurableConsumerRunner } from '../nats/durable-consumer-runner.js';
import {
  type DurableHandlerSettings,
  durableHandlerSettings,
  withDurableName,
} from '../nats/event-handler.decorator.js';
import {
  OrderedConsumers,
  type OrderedSubscription,
} from '../nats/ordered-consumers.service.js';
import { StreamManager } from '../nats/stream-manager.js';
import { isDetector, RegisterDetector } from './detector.js';
import { DetectorEngine } from './detector-engine.js';
import {
  DetectorRegistrationError,
  DetectorRegistry,
} from './detector-registry.js';
import {
  DETECTOR_RUNNER_OPTIONS,
  type DetectorRunnerOptions,
} from './detector-runner.options.js';
import { toVesselPosition } from './vessel-position.js';
import { VesselStateStore } from './vessel-state-store.js';

/** Default positions handled in parallel. */
const DEFAULT_CONCURRENCY = 8;

/** Interval of the runner's housekeeping (pending alerts, cooldowns, stale neighbours), ms. */
const MAINTENANCE_INTERVAL_MS = 30_000;

/** Longest durable name derived for a detector subset before hashing the ids. */
const MAX_DURABLE_NAME_LENGTH = 64;

/**
 * Wires the Detector SDK to NATS (spec §18). At module init it discovers the
 * `@RegisterDetector()` providers and registers them (configuration errors
 * stop the boot). At application bootstrap — after migrations — it restores
 * open alerts and mirrored vessel states, loads the `GEO` and `FLEET`
 * snapshots with ordered `last_per_subject` consumers (every instance holds
 * every zone and vessel) and waits until they are complete, then starts the
 * durable position consumer (ack / nak / DLQ semantics of the kit; single
 * active instance by default, see `DetectorRunnerOptions.exclusive`) and
 * the detector ticks. A `DETECTORS` subset consumes through its own durable
 * (`<positions>-<sorted ids>`), so differently configured deployments never
 * split the feed. On shutdown it stops ticks and consumers and flushes the
 * vessel state mirror.
 */
@Injectable()
export class DetectorRunner
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('DetectorRunner');
  private readonly projections: OrderedSubscription[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private positions: DurableConsumerRunner | undefined;
  private stopping = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly registry: DetectorRegistry,
    private readonly engine: DetectorEngine,
    private readonly vessels: VesselStateStore,
    private readonly runtime: NatsConsumerRuntime,
    private readonly orderedConsumers: OrderedConsumers,
    private readonly streams: StreamManager,
    @InjectConfig() private readonly config: BaseConfig,
    @Inject(DETECTOR_RUNNER_OPTIONS)
    private readonly options: DetectorRunnerOptions,
  ) {}

  /** Discovers and registers the detectors (no connection needed). */
  onModuleInit(): void {
    const detectors = this.discovery
      .getProviders({ metadataKey: RegisterDetector.KEY })
      .map((wrapper) => {
        const instance: unknown = wrapper.instance;
        if (!isDetector(instance)) {
          throw new DetectorRegistrationError(
            `${wrapper.name} is decorated with @RegisterDetector() but does not implement Detector (id, domain, methodIds, onPosition)`,
          );
        }
        return instance;
      });
    this.registry.register(detectors);
    const enabled = this.registry.enabled.map((entry) => entry.descriptor.id);
    this.logger.log(
      `Detectors enabled: ${enabled.length === 0 ? '(none)' : enabled.join(', ')}`,
    );
  }

  /** Restores state, loads the projections, then starts consuming positions and ticking. */
  async onApplicationBootstrap(): Promise<void> {
    const restored = await this.engine.services.alerts.restoreFromPersistence();
    const warmed = await this.vessels.warmUp();
    // Seeds of the neighbour index; the backlog replaces them as it arrives.
    for (const state of this.vessels.values())
      this.engine.services.pairs.upsert(state);
    if (restored > 0 || warmed > 0)
      this.logger.log(
        `Restored ${restored} open alert(s) and ${warmed} vessel state(s)`,
      );
    await this.streams.ensure(['ALERTS']);

    if (this.options.zones ?? true) {
      await this.startProjection('GEO', SUBJECT_FILTERS.GEO_ZONE, [
        EVENT_TYPES.GEO_ZONE_UPSERTED,
        EVENT_TYPES.GEO_ZONE_DELETED,
      ]);
    }
    if (this.options.fleet ?? true) {
      await this.startProjection('FLEET', SUBJECT_FILTERS.FLEET_VESSEL, [
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        EVENT_TYPES.FLEET_VESSEL_DELETED,
      ]);
    }

    const settings = this.positionsSettings();
    if (settings.definition.stream !== 'AIS_POSITION') {
      throw new DetectorRegistrationError(
        `The positions consumer ${settings.definition.durableName} reads ${settings.definition.stream}, not AIS_POSITION`,
      );
    }
    this.positions = new DurableConsumerRunner(
      this.runtime,
      settings,
      (event) => this.onPosition(event),
      'DetectorRunner.onPosition',
    );
    await this.positions.start();
    this.startTicks();
    this.startMaintenance();
  }

  /** Stops ticks, the position consumer and the projections; flushes the state mirror. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    await this.positions?.stop(25_000);
    await Promise.all(
      this.projections.splice(0).map((projection) => projection.stop(5_000)),
    );
    await this.vessels.flush();
  }

  /** Settings of the position consumer: kit prefix, detector subset and exclusivity applied. */
  private positionsSettings(): DurableHandlerSettings {
    const settings = durableHandlerSettings({
      consumer: this.options.positions,
      concurrency: this.options.concurrency ?? DEFAULT_CONCURRENCY,
      exclusive: this.options.exclusive ?? true,
    });
    let name = settings.definition.durableName;
    if (this.registry.isSubset) {
      const ids = this.registry.enabled.map((entry) => entry.descriptor.id).sort();
      const suffix = ids.length === 0 ? 'none' : ids.join('-').replaceAll('_', '-');
      name =
        `${name}-${suffix}`.length <= MAX_DURABLE_NAME_LENGTH
          ? `${name}-${suffix}`
          : `${name}-${createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 12)}`;
    }
    return withDurableName(settings, `${this.runtime.durablePrefix}${name}`);
  }

  private async onPosition(event: AnyEventEnvelope): Promise<void> {
    if (event.type !== EVENT_TYPES.AIS_POSITION_RECORDED) return;
    await this.engine.ingestPosition(toVesselPosition(event.data));
  }

  private async startProjection(
    stream: StreamName,
    filter: string,
    eventTypes: readonly EventType[],
  ): Promise<void> {
    let initial = true;
    const subscription = await this.orderedConsumers.start({
      name: `${this.config.SERVICE_NAME}-${stream.toLowerCase()}-projection`,
      stream,
      filterSubjects: [filter],
      eventTypes,
      deliver: 'last_per_subject',
      handler: async (event) => {
        await this.applyProjectionEvent(event, initial);
      },
    });
    this.projections.push(subscription);
    await subscription.caughtUp(this.options.catchUpTimeoutMs ?? 60_000);
    initial = false;
    const size =
      stream === 'GEO'
        ? this.engine.services.zones.size
        : this.engine.services.fleet.size;
    this.logger.log(
      `${stream} projection loaded (${size} ${stream === 'GEO' ? 'zones' : 'vessels'})`,
    );
  }

  private async applyProjectionEvent(
    event: AnyEventEnvelope,
    initial: boolean,
  ): Promise<void> {
    if (event.type === EVENT_TYPES.GEO_ZONE_UPSERTED)
      await this.engine.upsertZone(event.data, initial);
    else if (event.type === EVENT_TYPES.GEO_ZONE_DELETED)
      await this.engine.deleteZone(event.data, initial);
    else if (event.type === EVENT_TYPES.FLEET_VESSEL_UPSERTED)
      await this.engine.upsertVessel(event.data, initial);
    else if (event.type === EVENT_TYPES.FLEET_VESSEL_DELETED)
      await this.engine.deleteVessel(event.data, initial);
  }

  /**
   * Every 30 s: retry unpublished alerts, forget expired alert cooldowns and
   * drop neighbour-index entries older than the pair search window.
   */
  private startMaintenance(): void {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.stopping) return;
      running = true;
      const { alerts, pairs, clock } = this.engine.services;
      alerts
        .retryPending()
        .then(({ published, failed }) => {
          if (published > 0)
            this.logger.log(`Published ${published} pending alert(s)`);
          if (failed > 0)
            this.logger.warn(`${failed} alert(s) still unpublished`);
          alerts.prune(clock());
          // Event time: a consumer catching up on a backlog keeps its neighbours.
          pairs.prune();
        })
        .catch((error: unknown) => {
          this.logger.error(`Maintenance failed: ${errorMessage(error)}`);
        })
        .finally(() => {
          running = false;
        });
    }, MAINTENANCE_INTERVAL_MS);
    timer.unref();
    this.timers.push(timer);
  }

  private startTicks(): void {
    for (const entry of this.registry.enabled) {
      const interval = entry.detector.tickIntervalMs;
      if (entry.detector.onTick === undefined || interval === undefined)
        continue;
      let running = false;
      const timer = setInterval(() => {
        if (running || this.stopping) return;
        running = true;
        this.engine
          .tick(this.engine.services.clock(), [entry.descriptor.id])
          .catch((error: unknown) => {
            this.logger.error(
              `Tick of ${entry.descriptor.id} failed: ${errorMessage(error)}`,
            );
          })
          .finally(() => {
            running = false;
          });
      }, interval);
      timer.unref();
      this.timers.push(timer);
    }
  }
}
