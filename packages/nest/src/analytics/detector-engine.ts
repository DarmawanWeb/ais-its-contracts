import type {
  VesselDeletedV1,
  VesselSnapshotV1,
  ZoneDeletedV1,
  ZoneSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';

import type { DetectorVesselChange, DetectorZoneChange } from './detector.js';
import { DetectorMetrics, type PositionOutcome } from './detector-metrics.js';
import type {
  DetectorRegistry,
  DetectorServices,
} from './detector-registry.js';
import type { VesselPosition } from './vessel-position.js';

/**
 * Applies events to the shared SDK state and dispatches them to the
 * detectors, in the order the SDK guarantees: a position first updates the
 * {@link DetectorServices.vessels | vessel state} and the pair search (stale
 * positions stop here), then reaches `onPosition`; projection changes first
 * update the zone index / fleet directory, then reach the change hooks.
 * Shared by the NATS `DetectorRunner` and the `DetectorTestHarness`.
 */
export class DetectorEngine {
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

  /** Runs `onTick` of the given detectors (default: every enabled detector with `onTick`). */
  async tick(now: Date, detectorIds?: readonly string[]): Promise<void> {
    const ids =
      detectorIds ??
      this.registry.enabled
        .filter((entry) => entry.detector.onTick !== undefined)
        .map((entry) => entry.descriptor.id);
    await Promise.all(ids.map((id) => this.registry.dispatchTick(id, now)));
    this.services.alerts.prune(now);
  }
}
