import type { AisPositionRecordedV1 } from '@darmawanweb/ais-its-contracts/events';

/** The position a detector receives: `ais.position.recorded.v1` with `Date` times. */
export interface VesselPosition {
  readonly mmsi: number;
  /** Position time. */
  readonly time: Date;
  readonly source: AisPositionRecordedV1['source'];
  readonly lat: number;
  readonly lon: number;
  /** Speed over ground, knots. */
  readonly sog: number;
  /** Course over ground, degrees. */
  readonly cog: number;
  /** Heading, degrees (`511` = not available). */
  readonly hdg: number;
  /** Reported AIS navigational status (0–15). */
  readonly navstatus: AisPositionRecordedV1['navstatus'];
  /** `1` = predicted at anchor (legacy `calculatePredictedNavStatus`). */
  readonly predictedNavstatus: AisPositionRecordedV1['predictedNavstatus'];
  /** Distance to the coastline, metres (`null` when unknown). */
  readonly coastDistanceM: number | null;
  /** The vessel's previously recorded position, if any. */
  readonly previous: PreviousVesselPosition | null;
}

/** The previously recorded position carried by a {@link VesselPosition}. */
export interface PreviousVesselPosition {
  readonly time: Date;
  readonly lat: number;
  readonly lon: number;
  readonly sog: number;
  readonly cog: number;
  readonly hdg: number;
  readonly navstatus: AisPositionRecordedV1['navstatus'];
  readonly predictedNavstatus: AisPositionRecordedV1['predictedNavstatus'];
}

/** Converts an `ais.position.recorded.v1` payload (ISO strings) to a {@link VesselPosition}. */
export function toVesselPosition(
  payload: AisPositionRecordedV1,
): VesselPosition {
  const { previous } = payload;
  return {
    mmsi: payload.mmsi,
    time: new Date(payload.time),
    source: payload.source,
    lat: payload.lat,
    lon: payload.lon,
    sog: payload.sog,
    cog: payload.cog,
    hdg: payload.hdg,
    navstatus: payload.navstatus,
    predictedNavstatus: payload.predictedNavstatus,
    coastDistanceM: payload.coastDistanceM,
    previous:
      previous === null
        ? null
        : {
            time: new Date(previous.time),
            lat: previous.lat,
            lon: previous.lon,
            sog: previous.sog,
            cog: previous.cog,
            hdg: previous.hdg,
            navstatus: previous.navstatus,
            predictedNavstatus: previous.predictedNavstatus,
          },
  };
}

/** Converts a {@link VesselPosition} back to its event payload (tests, replays). */
export function toPositionPayload(
  position: VesselPosition,
): AisPositionRecordedV1 {
  const { previous } = position;
  return {
    mmsi: position.mmsi,
    time: position.time.toISOString(),
    source: position.source,
    lat: position.lat,
    lon: position.lon,
    sog: position.sog,
    cog: position.cog,
    hdg: position.hdg,
    navstatus: position.navstatus,
    predictedNavstatus: position.predictedNavstatus,
    coastDistanceM: position.coastDistanceM,
    previous:
      previous === null
        ? null
        : {
            time: previous.time.toISOString(),
            lat: previous.lat,
            lon: previous.lon,
            sog: previous.sog,
            cog: previous.cog,
            hdg: previous.hdg,
            navstatus: previous.navstatus,
            predictedNavstatus: previous.predictedNavstatus,
          },
  };
}
