import { AIS_SOURCES } from '../domain/ais.js';
import { KNOWN_ALERT_TYPES } from '../domain/alerts.js';
import { SERVICE_NAMES, type ServiceName } from './services.js';
import type { StreamName } from './streams.js';
import { EVENT_TYPES, type EventType } from './types.js';

/** A `{parameter}` of a subject pattern. */
export interface SubjectParameter {
  readonly description: string;
  /** Allowed values, when the parameter is a closed enumeration. */
  readonly enum?: readonly string[];
  /** Known values of an open set (future values are allowed). */
  readonly examples?: readonly string[];
}

/** Documentation of one event type (drives the README and AsyncAPI). */
export interface EventDefinition {
  readonly type: EventType;
  /** TypeScript type (and schema) name of the payload. */
  readonly payloadName: string;
  readonly stream: StreamName;
  /** Subject pattern with `{parameters}`, e.g. `ais.raw.v1.{source}`. */
  readonly subject: string;
  readonly parameters: Readonly<Record<string, SubjectParameter>>;
  readonly producers: readonly ServiceName[];
  readonly description: string;
}

const MMSI_PARAMETER: SubjectParameter = {
  description: 'Vessel MMSI (9 digits).',
};

/** Every event type with its stream, subject pattern and producers (spec 7.3). */
export const EVENT_CATALOG = {
  [EVENT_TYPES.AIS_RAW_RECEIVED]: {
    type: EVENT_TYPES.AIS_RAW_RECEIVED,
    payloadName: 'AisRawReceivedV1',
    stream: 'AIS_RAW',
    subject: 'ais.raw.v1.{source}',
    parameters: {
      source: { description: 'AIS feed.', enum: AIS_SOURCES },
    },
    producers: ['ais-ingestor'],
    description:
      'An AIS position report accepted and normalized by the ingestor.',
  },
  [EVENT_TYPES.AIS_POSITION_RECORDED]: {
    type: EVENT_TYPES.AIS_POSITION_RECORDED,
    payloadName: 'AisPositionRecordedV1',
    stream: 'AIS_POSITION',
    subject: 'ais.position.v1.{partition}.{mmsi}',
    parameters: {
      partition: {
        description: 'mmsi % 16, for horizontally scaled consumers.',
        enum: Array.from({ length: 16 }, (_, partition) => String(partition)),
      },
      mmsi: MMSI_PARAMETER,
    },
    producers: ['ais-processor'],
    description:
      'A recorded vessel position enriched with the predicted navstatus and the coast distance (AIS data only, no safety fields).',
  },
  [EVENT_TYPES.FUEL_READING_RECORDED]: {
    type: EVENT_TYPES.FUEL_READING_RECORDED,
    payloadName: 'FuelReadingRecordedV1',
    stream: 'FUEL',
    subject: 'fuel.reading.v1.{mmsi}',
    parameters: { mmsi: MMSI_PARAMETER },
    producers: ['telemetry'],
    description: 'A main/auxiliary engine fuel consumption reading.',
  },
  [EVENT_TYPES.FLEET_VESSEL_UPSERTED]: {
    type: EVENT_TYPES.FLEET_VESSEL_UPSERTED,
    payloadName: 'VesselSnapshotV1',
    stream: 'FLEET',
    subject: 'fleet.vessel.v1.{vesselId}',
    parameters: { vesselId: { description: 'Vessel id (UUID).' } },
    producers: ['fleet'],
    description: 'The full current snapshot of a created or changed vessel.',
  },
  [EVENT_TYPES.FLEET_VESSEL_DELETED]: {
    type: EVENT_TYPES.FLEET_VESSEL_DELETED,
    payloadName: 'VesselDeletedV1',
    stream: 'FLEET',
    subject: 'fleet.vessel.v1.{vesselId}',
    parameters: { vesselId: { description: 'Vessel id (UUID).' } },
    producers: ['fleet'],
    description: 'A vessel was deleted (tombstone of the snapshot).',
  },
  [EVENT_TYPES.GEO_ZONE_UPSERTED]: {
    type: EVENT_TYPES.GEO_ZONE_UPSERTED,
    payloadName: 'ZoneSnapshotV1',
    stream: 'GEO',
    subject: 'geo.zone.v1.{zoneId}',
    parameters: { zoneId: { description: 'Zone id (UUID).' } },
    producers: ['geo'],
    description: 'The full current snapshot of a created or changed zone.',
  },
  [EVENT_TYPES.GEO_ZONE_DELETED]: {
    type: EVENT_TYPES.GEO_ZONE_DELETED,
    payloadName: 'ZoneDeletedV1',
    stream: 'GEO',
    subject: 'geo.zone.v1.{zoneId}',
    parameters: { zoneId: { description: 'Zone id (UUID).' } },
    producers: ['geo'],
    description: 'A zone was deleted (tombstone of the snapshot).',
  },
  [EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED]: {
    type: EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED,
    payloadName: 'SafetyVesselStateV1',
    stream: 'SAFETY',
    subject: 'safety.state.v1.{mmsi}',
    parameters: { mmsi: MMSI_PARAMETER },
    producers: ['safety'],
    description:
      'The navigational safety state of a vessel (EWS status, collision risk), on change and as a heartbeat.',
  },
  [EVENT_TYPES.EMISSION_CII_UPDATED]: {
    type: EVENT_TYPES.EMISSION_CII_UPDATED,
    payloadName: 'CiiUpdatedV1',
    stream: 'EMISSION',
    subject: 'emission.cii.v1.{mmsi}',
    parameters: { mmsi: MMSI_PARAMETER },
    producers: ['emission'],
    description: 'Year-to-date CII of a vessel (at most once per interval).',
  },
  [EVENT_TYPES.ALERT_RAISED]: {
    type: EVENT_TYPES.ALERT_RAISED,
    payloadName: 'AlertRaisedV1',
    stream: 'ALERTS',
    subject: 'alert.v1.{alertType}.{mmsi}',
    parameters: {
      alertType: {
        description:
          'Alert type of the registry ALERT_TYPES or a future type (consumers accept unknown types).',
        examples: KNOWN_ALERT_TYPES,
      },
      mmsi: MMSI_PARAMETER,
    },
    producers: ['safety', 'surveillance'],
    description:
      'An alert raised by a safety (ews, collision) or surveillance (transhipment, anomaly, dark, geofence, fishing) detector.',
  },
  [EVENT_TYPES.ALERT_RESOLVED]: {
    type: EVENT_TYPES.ALERT_RESOLVED,
    payloadName: 'AlertResolvedV1',
    stream: 'ALERTS',
    subject: 'alert.v1.{alertType}.{mmsi}',
    parameters: {
      alertType: {
        description:
          'Alert type of the resolved occurrence (registry ALERT_TYPES or a future type).',
        examples: KNOWN_ALERT_TYPES,
      },
      mmsi: MMSI_PARAMETER,
    },
    producers: ['safety', 'surveillance'],
    description:
      'The end of an alert occurrence, published by the detector that raised it on the same subject (after the alert cooldown; a re-raise within it cancels the resolution). Consumers resolve the unresolved inbox alert with the dedupKey unless it merged a later occurrence.',
  },
  [EVENT_TYPES.NOTIFY_EMAIL_REQUESTED]: {
    type: EVENT_TYPES.NOTIFY_EMAIL_REQUESTED,
    payloadName: 'EmailRequestedV1',
    stream: 'NOTIFY',
    subject: 'notify.email.v1',
    parameters: {},
    producers: ['auth', 'notification'],
    description: 'A transactional e-mail to render and send.',
  },
  [EVENT_TYPES.AUDIT_RECORDED]: {
    type: EVENT_TYPES.AUDIT_RECORDED,
    payloadName: 'AuditRecordedV1',
    stream: 'AUDIT',
    subject: 'audit.v1.{service}',
    parameters: {
      service: {
        description: 'SERVICE_NAME of the producer.',
        enum: SERVICE_NAMES,
      },
    },
    producers: SERVICE_NAMES,
    description: 'An audited action for the central audit log.',
  },
} as const satisfies {
  readonly [Type in EventType]: EventDefinition & { readonly type: Type };
};

/** Every event definition in declaration order. */
export const EVENT_DEFINITIONS: readonly EventDefinition[] =
  Object.values(EVENT_CATALOG);
