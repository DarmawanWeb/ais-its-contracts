import type {
  VesselDeletedV1,
  VesselSnapshotV1,
} from '@darmawanweb/ais-its-contracts/events';

/** What a `FLEET` projection change did to the directory. */
export interface VesselChange {
  readonly kind: 'upserted' | 'deleted';
  /** The vessel after an upsert, the removed vessel after a delete (when it was known). */
  readonly vessel: VesselSnapshotV1 | undefined;
  /** The vessel before the change. */
  readonly previous: VesselSnapshotV1 | undefined;
  /** MMSI concerned (for deletes of unknown vessels: the event's MMSI). */
  readonly mmsi: number;
  readonly vesselId: string;
}

/**
 * In-memory projection of the `FLEET` stream: vessel snapshots by id and by
 * MMSI (spec §8.5: services learn `mmsi → orgId` from it). Out-of-order
 * snapshots (older `updatedAt`) are ignored; an MMSI change moves the vessel.
 *
 * @example
 * const orgId = fleet.orgOf(position.mmsi); // undefined = not a registered vessel
 */
export class FleetDirectory {
  private readonly byIdMap = new Map<string, VesselSnapshotV1>();
  private readonly byMmsiMap = new Map<number, VesselSnapshotV1>();

  /** Number of vessels. */
  get size(): number {
    return this.byIdMap.size;
  }

  /** Adds or replaces a vessel; `undefined` when the snapshot is older than the stored one. */
  upsert(vessel: VesselSnapshotV1): VesselChange | undefined {
    const previous = this.byIdMap.get(vessel.id);
    if (
      previous !== undefined &&
      Date.parse(previous.updatedAt) > Date.parse(vessel.updatedAt)
    )
      return undefined;
    if (
      previous !== undefined &&
      previous.mmsi !== vessel.mmsi &&
      this.byMmsiMap.get(previous.mmsi)?.id === vessel.id
    ) {
      this.byMmsiMap.delete(previous.mmsi);
    }
    this.byIdMap.set(vessel.id, vessel);
    this.byMmsiMap.set(vessel.mmsi, vessel);
    return {
      kind: 'upserted',
      vessel,
      previous,
      mmsi: vessel.mmsi,
      vesselId: vessel.id,
    };
  }

  /** Removes a vessel (`fleet.vessel.deleted.v1`). */
  remove(deleted: Pick<VesselDeletedV1, 'id' | 'mmsi'>): VesselChange {
    const previous = this.byIdMap.get(deleted.id);
    this.byIdMap.delete(deleted.id);
    const mmsi = previous?.mmsi ?? deleted.mmsi;
    if (this.byMmsiMap.get(mmsi)?.id === deleted.id)
      this.byMmsiMap.delete(mmsi);
    return {
      kind: 'deleted',
      vessel: previous,
      previous,
      mmsi,
      vesselId: deleted.id,
    };
  }

  /** The vessel registered with this MMSI. */
  byMmsi(mmsi: number): VesselSnapshotV1 | undefined {
    return this.byMmsiMap.get(mmsi);
  }

  /** The vessel with this id. */
  byId(id: string): VesselSnapshotV1 | undefined {
    return this.byIdMap.get(id);
  }

  /**
   * Owner organization of the vessel with this MMSI: its `orgId` (possibly
   * `null`), or `undefined` when no registered vessel has the MMSI.
   */
  orgOf(mmsi: number): string | null | undefined {
    const vessel = this.byMmsiMap.get(mmsi);
    return vessel === undefined ? undefined : vessel.orgId;
  }

  /** Every vessel. */
  all(): VesselSnapshotV1[] {
    return [...this.byIdMap.values()];
  }

  /** Removes every vessel. */
  clear(): void {
    this.byIdMap.clear();
    this.byMmsiMap.clear();
  }
}
