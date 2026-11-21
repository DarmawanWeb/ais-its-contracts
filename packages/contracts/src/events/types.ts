/**
 * Event types (spec 7.3). A type is `<domain>.<entity>.<verb>.v<N>`; a version
 * is never changed incompatibly — breaking changes get a new `.vN+1` type.
 */
export const EVENT_TYPES = {
  AIS_RAW_RECEIVED: 'ais.raw.received.v1',
  AIS_POSITION_RECORDED: 'ais.position.recorded.v1',
  FUEL_READING_RECORDED: 'fuel.reading.recorded.v1',
  FLEET_VESSEL_UPSERTED: 'fleet.vessel.upserted.v1',
  FLEET_VESSEL_DELETED: 'fleet.vessel.deleted.v1',
  EMISSION_CII_UPDATED: 'emission.cii.updated.v1',
  ALERT_RAISED: 'alert.raised.v1',
  NOTIFY_EMAIL_REQUESTED: 'notify.email.requested.v1',
  AUDIT_RECORDED: 'audit.recorded.v1',
} as const;

/** A known event type. */
export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/** Every known event type. */
export const EVENT_TYPE_LIST: readonly EventType[] = Object.values(EVENT_TYPES);

/** Format of every event type: dot separated lowercase tokens ending in `.v<N>`. */
export const EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\.v[1-9]\d*$/;

/** Returns `true` when `value` is a known event type. */
export function isEventType(value: unknown): value is EventType {
  return EVENT_TYPE_LIST.some((type) => type === value);
}

/**
 * Major version of an event type (`"ais.raw.received.v1"` → `1`).
 *
 * @returns the version, or `null` when `type` does not match {@link EVENT_TYPE_PATTERN}.
 */
export function eventTypeVersion(type: string): number | null {
  if (!EVENT_TYPE_PATTERN.test(type)) return null;
  return Number(type.slice(type.lastIndexOf('.v') + 2));
}
