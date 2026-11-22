import type {
  VesselDeletedV1,
  VesselSnapshotV1,
  ZoneDeletedV1,
  ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';
import { Logger } from '@nestjs/common';

import { errorMessage } from '../common/retry.js';
import type { AlertPublicationResult, OpenAlert } from './alert-emitter.js';
import type { DetectorVesselChange, DetectorZoneChange } from './detector.js';
import { DetectorMetrics, type PositionOutcome } from './detector-metrics.js';
import type {
  DetectorRegistry,
  DetectorServices,
} from './detector-registry.js';
import type { VesselPosition } from './vessel-position.js';

/** Options of {@link DetectorEngine.activate}. */
export interface DetectorActivationOptions {
  /**
   * Source of the open occurrences, normally `AlertPersistence.loadOpen`:
   * they replace the emitter's occurrences of the enabled detectors
   * (`AlertEmitter.replaceOpen`). Without it the emitter keeps its state
   * (after a failover it may then re-raise what another instance raised).
   */
  readonly loadOpen?: (() => Promise<readonly OpenAlert[]>) | undefined;
}

/** What {@link DetectorEngine.activate} did. */
export interface DetectorActivation {
  /** `false` when no `loadOpen` was given: the open occurrences were kept. */
  readonly reloaded: boolean;
  /** Open occurrences installed from `loadOpen`. */
  readonly restored: number;
  /** Open occurrences dropped because `loadOpen` no longer returned them (ended elsewhere). */
  readonly forgotten: number;
  /** Pending publications sent before the reload. */
  readonly flushed: AlertPublicationResult;
  /** Vessel states re-seeded from the state mirror (0 without one). */
  readonly vesselsReseeded: number;
}

/**
 * Applies events to the shared SDK state and dispatches them to the
 * detectors, in the order the SDK guarantees: a position first updates the
 * {@link DetectorServices.vessels | vessel state} and the pair search (stale
 * positions stop here), then reaches `onPosition`; projection changes first
 * update the zone index / fleet directory, then reach the change hooks.
 * Shared by the NATS `DetectorRunner` and the `DetectorTestHarness`, it
 * also runs the {@link activate} / {@link deactivate} sequences of a
 * failover.
 */
export class DetectorEngine {
  private readonly logger = new Logger('DetectorEngine');

  constructor(
    readonly registry: DetectorRegistry,
    readonly services: DetectorServices,
    private readonly metrics: DetectorMetrics = new DetectorMetrics(),
  ) {
    // States evicted from the LRU leave the neighbour index too.
    services.vessels.onRemoved((state) => {
      services.pairs.remove(state.mmsi);
    });
  }

  /** Processes a position; `'stale'` when it is not newer than the vessel's state. */
  async ingestPosition(position: VesselPosition): Promise<PositionOutcome> {
    const result = this.services.vessels.upsert(position);
    if (result.outcome === 'stale') {
      this.metrics.positions.inc({ outcome: 'stale' });
      return 'stale';
    }
    this.services.pairs.upsert(result.state);
    await this.registry.dispatchPosition(position);
    this.metrics.positions.inc({ outcome: 'processed' });
    return 'processed';
  }

  /** Applies a zone snapshot; `undefined` when it is older than the indexed one. */
  async upsertZone(
    zone: ZoneSnapshotV1,
    initial = false,
  ): Promise<DetectorZoneChange | undefined> {
    const change = this.services.zones.upsert(zone);
    if (change === undefined) return undefined;
    const detectorChange: DetectorZoneChange = { ...change, initial };
    await this.registry.dispatchZoneChange(detectorChange);
    return detectorChange;
  }

  /** Removes a zone; `undefined` when it was unknown. */
  async deleteZone(
    deleted: ZoneDeletedV1 | string,
    initial = false,
  ): Promise<DetectorZoneChange | undefined> {
    const change = this.services.zones.remove(deleted);
    if (change === undefined) return undefined;
    const detectorChange: DetectorZoneChange = { ...change, initial };
    await this.registry.dispatchZoneChange(detectorChange);
    return detectorChange;
  }

  /** Applies a vessel snapshot; `undefined` when it is older than the stored one. */
  async upsertVessel(
    vessel: VesselSnapshotV1,
    initial = false,
  ): Promise<DetectorVesselChange | undefined> {
    const change = this.services.fleet.upsert(vessel);
    if (change === undefined) return undefined;
    const detectorChange: DetectorVesselChange = { ...change, initial };
    await this.registry.dispatchVesselChange(detectorChange);
    return detectorChange;
  }

  /** Removes a vessel snapshot. */
  async deleteVessel(
    deleted: VesselDeletedV1,
    initial = false,
  ): Promise<DetectorVesselChange> {
    const detectorChange: DetectorVesselChange = {
      ...this.services.fleet.remove(deleted),
      initial,
    };
    await this.registry.dispatchVesselChange(detectorChange);
    return detectorChange;
  }

  /** `true` while this instance is the active one (`DetectorRegistry.active`). */
  get active(): boolean {
    return this.registry.active;
  }

  /**
   * Makes this instance the active one, e.g. when its exclusive position
   * consumer was pinned after a failover; positions must wait until it
   * resolves. In order: ticks pause (`active` is `false` meanwhile), the
   * running detector calls settle, pending alert publications go out
   * (`AlertEmitter.flush`), the open occurrences of the enabled detectors
   * are replaced with `options.loadOpen()`, vessel states are re-seeded
   * from the state mirror (best effort) and the neighbour index with them,
   * and the detectors' `onActivated` run (isolated); then `active` turns
   * `true`.
   *
   * @throws when `loadOpen` fails; the instance stays inactive (retry by
   *   calling it again).
   */
  async activate(
    options: DetectorActivationOptions = {},
  ): Promise<DetectorActivation> {
    const { alerts, vessels, pairs } = this.services;
    this.registry.setActive(false);
    try {
      await this.registry.settled();
      const flushed = await alerts.flush();
      let replaced = { restored: 0, forgotten: 0 };
      if (options.loadOpen !== undefined) {
        const open = await options.loadOpen();
        replaced = await alerts.replaceOpen(open, {
          filter: (alert) => this.registry.owns(alert),
        });
      }
      let vesselsReseeded = 0;
      try {
        vesselsReseeded = await vessels.warmUp();
        if (vesselsReseeded > 0)
          for (const state of vessels.values()) pairs.upsert(state);
      } catch (error) {
        this.logger.warn(
          `Re-seeding vessel states from the mirror failed (continuing with the local states): ${errorMessage(error)}`,
        );
      }
      await this.registry.dispatchActivated();
      this.registry.setActive(true);
      this.metrics.activations.inc({ outcome: 'completed' });
      return {
        reloaded: options.loadOpen !== undefined,
        ...replaced,
        flushed,
        vesselsReseeded,
      };
    } catch (error) {
      this.metrics.activations.inc({ outcome: 'failed' });
      throw error;
    }
  }

  /**
   * Ends the active period of this instance (another instance took over,
   * or it stops): ticks pause, the running detector calls settle, pending
   * alert publications go out — resolutions still within their cooldown
   * included — and the detectors' `onDeactivated` run (isolated). Never
   * rejects.
   */
  async deactivate(): Promise<AlertPublicationResult> {
    this.registry.setActive(false);
    await this.registry.settled();
    const flushed = await this.services.alerts.flush();
    await this.registry.dispatchDeactivated();
    return flushed;
  }

  /**
   * Runs `onTick` of the given detectors (default: every enabled detector
   * with `onTick`) and forgets expired alert cooldowns; does nothing while
   * this instance is not {@link active}.
   */
  async tick(now: Date, detectorIds?: readonly string[]): Promise<void> {
    if (!this.registry.active) return;
    const ids =
      detectorIds ??
      this.registry.enabled
        .filter((entry) => entry.detector.onTick !== undefined)
        .map((entry) => entry.descriptor.id);
    await Promise.all(ids.map((id) => this.registry.dispatchTick(id, now)));
    this.services.alerts.prune(now);
  }
}
