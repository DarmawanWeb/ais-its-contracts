import { type AisSource, isValidMmsi } from '../domain/ais.js';
import { ALERT_TYPE_PATTERN, type AlertType } from '../domain/alerts.js';
import type { AnyEventEnvelope } from './registry.js';
import type { StreamName } from './streams.js';
import { EVENT_TYPES } from './types.js';

/** Number of `ais.position.v1.<partition>.>` partitions (`mmsi % 16`). */
export const AIS_POSITION_PARTITIONS = 16;

/** Subject of the transactional e-mail work queue. */
export const NOTIFY_EMAIL_SUBJECT = 'notify.email.v1';

/** Subject filters (with wildcards) of every subject family. */
export const SUBJECT_FILTERS = {
  AIS_RAW: 'ais.raw.v1.>',
  AIS_POSITION: 'ais.position.v1.>',
  FUEL_READING: 'fuel.reading.v1.>',
  FLEET_VESSEL: 'fleet.vessel.v1.>',
  GEO_ZONE: 'geo.zone.v1.>',
  SAFETY_STATE: 'safety.state.v1.>',
  CII_UPDATED: 'emission.cii.v1.>',
  ALERT: 'alert.v1.>',
  NOTIFY_EMAIL: NOTIFY_EMAIL_SUBJECT,
  AUDIT: 'audit.v1.>',
  DLQ: 'dlq.>',
  TELEMETRY_MQTT: 'aisits.telemetry.*',
  /** Core NATS (no stream): alert pushes fanned out to every notification instance. */
  NOTIFICATION_REALTIME: 'aisits.notification.realtime.v1',
} as const;

/** Prefix of the MQTT topics of fuel meters: `aisits/telemetry/<deviceId>`. */
export const TELEMETRY_MQTT_TOPIC_PREFIX = 'aisits/telemetry/';

const INVALID_TOKEN_CHARACTERS = /[\s.*>]/;

/** Validates one subject token (no dots, wildcards or whitespace). */
function token(value: string, name: string): string {
  if (value === '' || INVALID_TOKEN_CHARACTERS.test(value)) {
    throw new RangeError(`Invalid ${name} "${value}" for a NATS subject token`);
  }
  return value;
}

/** Validates an alert type used as a subject token. */
function alertTypeToken(type: AlertType): string {
  if (!ALERT_TYPE_PATTERN.test(type)) {
    throw new RangeError(
      `Invalid alert type "${type}": expected a lowercase token [a-z][a-z0-9_]*`,
    );
  }
  return type;
}

/** Validates an MMSI used as a subject token. */
function mmsiToken(mmsi: number): string {
  if (!isValidMmsi(mmsi)) {
    throw new RangeError(
      `Invalid MMSI ${mmsi}: expected an integer with 9 digits`,
    );
  }
  return String(mmsi);
}

/**
 * Partition of a vessel's position subject (`mmsi % 16`).
 *
 * @throws {RangeError} when `mmsi` is not a 9-digit integer.
 */
export function aisPositionPartition(mmsi: number): number {
  mmsiToken(mmsi);
  return mmsi % AIS_POSITION_PARTITIONS;
}

/**
 * Builders of every concrete subject and subject filter (spec 7.3). Never
 * build subjects by hand. Every builder throws a `RangeError` for invalid
 * tokens (non 9-digit MMSI, dots, wildcards, whitespace).
 */
export const subjects = {
  /** `ais.raw.v1.<source>` */
  aisRaw(source: AisSource): string {
    return `ais.raw.v1.${token(source, 'AIS source')}`;
  },
  /** `ais.position.v1.<mmsi % 16>.<mmsi>` */
  aisPosition(mmsi: number): string {
    return `ais.position.v1.${aisPositionPartition(mmsi)}.${mmsi}`;
  },
  /** Filter of one position partition: `ais.position.v1.<partition>.>` */
  aisPositionPartitionFilter(partition: number): string {
    if (
      !Number.isInteger(partition) ||
      partition < 0 ||
      partition >= AIS_POSITION_PARTITIONS
    ) {
      throw new RangeError(
        `Invalid partition ${partition}: expected 0..${AIS_POSITION_PARTITIONS - 1}`,
      );
    }
    return `ais.position.v1.${partition}.>`;
  },
  /** `fuel.reading.v1.<mmsi>` */
  fuelReading(mmsi: number): string {
    return `fuel.reading.v1.${mmsiToken(mmsi)}`;
  },
  /** `fleet.vessel.v1.<vesselId>` */
  fleetVessel(vesselId: string): string {
    return `fleet.vessel.v1.${token(vesselId, 'vessel id')}`;
  },
  /** `geo.zone.v1.<zoneId>` */
  geoZone(zoneId: string): string {
    return `geo.zone.v1.${token(zoneId, 'zone id')}`;
  },
  /** `safety.state.v1.<mmsi>` */
  safetyState(mmsi: number): string {
    return `safety.state.v1.${mmsiToken(mmsi)}`;
  },
  /** `emission.cii.v1.<mmsi>` */
  ciiUpdated(mmsi: number): string {
    return `emission.cii.v1.${mmsiToken(mmsi)}`;
  },
  /** `alert.v1.<alertType>.<mmsi>` (registry or future alert type) */
  alert(type: AlertType, mmsi: number): string {
    return `alert.v1.${alertTypeToken(type)}.${mmsiToken(mmsi)}`;
  },
  /** Filter of one alert type: `alert.v1.<alertType>.*` */
  alertTypeFilter(type: AlertType): string {
    return `alert.v1.${alertTypeToken(type)}.*`;
  },
  /** `notify.email.v1` */
  notifyEmail(): string {
    return NOTIFY_EMAIL_SUBJECT;
  },
  /** `audit.v1.<service>` */
  audit(service: string): string {
    return `audit.v1.${token(service, 'service name')}`;
  },
  /** `dlq.<stream>.<consumer>` */
  dlq(stream: StreamName, consumer: string): string {
    return `dlq.${token(stream, 'stream name')}.${token(consumer, 'consumer name')}`;
  },
  /** Core NATS subject of MQTT topic `aisits/telemetry/<deviceId>`: `aisits.telemetry.<deviceId>` */
  telemetryMqtt(deviceId: string): string {
    return `aisits.telemetry.${token(deviceId, 'device id')}`;
  },
  /**
   * Core NATS subject of the alert push fan-out between notification
   * instances (`notification-realtime-fanout`): `aisits.notification.realtime.v1`
   */
  notificationRealtime(): string {
    return SUBJECT_FILTERS.NOTIFICATION_REALTIME;
  },
} as const;

/**
 * MQTT topic a fuel meter publishes to, `aisits/telemetry/<deviceId>`; the
 * NATS MQTT gateway maps it to {@link subjects.telemetryMqtt}.
 *
 * @throws {RangeError} when `deviceId` contains `/`, `+`, `#`, dots, wildcards or whitespace.
 */
export function telemetryMqttTopic(deviceId: string): string {
  if (/[/+#]/.test(deviceId)) {
    throw new RangeError(`Invalid device id "${deviceId}" for an MQTT topic`);
  }
  return `${TELEMETRY_MQTT_TOPIC_PREFIX}${token(deviceId, 'device id')}`;
}

/**
 * NATS subject an event is published to, derived from its type and payload
 * (`audit` events use the envelope `source`).
 */
export function subjectForEvent(envelope: AnyEventEnvelope): string {
  switch (envelope.type) {
    case EVENT_TYPES.AIS_RAW_RECEIVED:
      return subjects.aisRaw(envelope.data.source);
    case EVENT_TYPES.AIS_POSITION_RECORDED:
      return subjects.aisPosition(envelope.data.mmsi);
    case EVENT_TYPES.FUEL_READING_RECORDED:
      return subjects.fuelReading(envelope.data.mmsi);
    case EVENT_TYPES.FLEET_VESSEL_UPSERTED:
    case EVENT_TYPES.FLEET_VESSEL_DELETED:
      return subjects.fleetVessel(envelope.data.id);
    case EVENT_TYPES.GEO_ZONE_UPSERTED:
    case EVENT_TYPES.GEO_ZONE_DELETED:
      return subjects.geoZone(envelope.data.id);
    case EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED:
      return subjects.safetyState(envelope.data.mmsi);
    case EVENT_TYPES.EMISSION_CII_UPDATED:
      return subjects.ciiUpdated(envelope.data.mmsi);
    case EVENT_TYPES.ALERT_RAISED:
    case EVENT_TYPES.ALERT_RESOLVED:
      // The raise's subject: raise and resolve of one occurrence stay ordered.
      return subjects.alert(envelope.data.type, envelope.data.mmsi);
    case EVENT_TYPES.NOTIFY_EMAIL_REQUESTED:
      return subjects.notifyEmail();
    case EVENT_TYPES.AUDIT_RECORDED:
      return subjects.audit(envelope.source);
  }
}

/** Partition and MMSI encoded in a position subject. */
export interface AisPositionSubject {
  readonly partition: number;
  readonly mmsi: number;
}

const AIS_POSITION_SUBJECT = /^ais\.position\.v1\.(\d{1,2})\.(\d{9})$/;

/**
 * Parses `ais.position.v1.<partition>.<mmsi>`.
 *
 * @returns the tokens, or `null` when the subject is not a consistent position subject.
 */
export function parseAisPositionSubject(
  subject: string,
): AisPositionSubject | null {
  const match = AIS_POSITION_SUBJECT.exec(subject);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const partition = Number(match[1]);
  const mmsi = Number(match[2]);
  if (!isValidMmsi(mmsi) || mmsi % AIS_POSITION_PARTITIONS !== partition) {
    return null;
  }
  return { partition, mmsi };
}
