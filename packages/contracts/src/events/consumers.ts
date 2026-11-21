import type { ServiceName } from './services.js';
import type { StreamName } from './streams.js';
import { SUBJECT_FILTERS } from './subjects.js';
import { EVENT_TYPES, type EventType } from './types.js';

/** Deliveries before a message is copied to `dlq.<stream>.<consumer>` and acked. */
export const DEFAULT_MAX_DELIVER = 10;

/** Plain-data durable consumer definition, ensured on boot by its service. */
export interface DurableConsumerDefinition {
  readonly durableName: string;
  readonly stream: StreamName;
  readonly filterSubjects: readonly string[];
  /** Service owning (and ensuring) the consumer. */
  readonly service: ServiceName;
  /** Event types delivered to the consumer. */
  readonly eventTypes: readonly EventType[];
  /** Explicit acks; nak with exponential backoff; dead-lettered after this many deliveries. */
  readonly maxDeliver: number;
  readonly description: string;
}

const fleetProjection = (
  durableName: string,
  service: ServiceName,
): DurableConsumerDefinition => ({
  durableName,
  stream: 'FLEET',
  filterSubjects: [SUBJECT_FILTERS.FLEET_VESSEL],
  service,
  eventTypes: [
    EVENT_TYPES.FLEET_VESSEL_UPSERTED,
    EVENT_TYPES.FLEET_VESSEL_DELETED,
  ],
  maxDeliver: DEFAULT_MAX_DELIVER,
  description: `Vessel projection (mmsi → vesselId, orgId) of ${service}.`,
});

const zoneProjection = (
  durableName: string,
  service: ServiceName,
): DurableConsumerDefinition => ({
  durableName,
  stream: 'GEO',
  filterSubjects: [SUBJECT_FILTERS.GEO_ZONE],
  service,
  eventTypes: [EVENT_TYPES.GEO_ZONE_UPSERTED, EVENT_TYPES.GEO_ZONE_DELETED],
  maxDeliver: DEFAULT_MAX_DELIVER,
  description: `Zone projection with a spatial index (ZoneIndex) of ${service}.`,
});

const positionFeed = (
  durableName: string,
  service: ServiceName,
  description: string,
): DurableConsumerDefinition => ({
  durableName,
  stream: 'AIS_POSITION',
  filterSubjects: [SUBJECT_FILTERS.AIS_POSITION],
  service,
  eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
  maxDeliver: DEFAULT_MAX_DELIVER,
  description,
});

/** Every durable consumer of spec 7.3, keyed by durable name. */
export const CONSUMERS = {
  'ais-processor': {
    durableName: 'ais-processor',
    stream: 'AIS_RAW',
    filterSubjects: [SUBJECT_FILTERS.AIS_RAW],
    service: 'ais-processor',
    eventTypes: [EVENT_TYPES.AIS_RAW_RECEIVED],
    maxDeliver: DEFAULT_MAX_DELIVER,
    description: 'Enriches and records raw AIS reports.',
  },
  'emission-positions': positionFeed(
    'emission-positions',
    'emission',
    'Builds voyage segments (fuel, CO2, CII) from positions.',
  ),
  'safety-positions': positionFeed(
    'safety-positions',
    'safety',
    'Feeds the navigational safety detectors (ews, collision).',
  ),
  'surveillance-positions': positionFeed(
    'surveillance-positions',
    'surveillance',
    'Feeds the surveillance detectors (transhipment, anomaly, dark, geofence, fishing).',
  ),
  'emission-fuel': {
    durableName: 'emission-fuel',
    stream: 'FUEL',
    filterSubjects: [SUBJECT_FILTERS.FUEL_READING],
    service: 'emission',
    eventTypes: [EVENT_TYPES.FUEL_READING_RECORDED],
    maxDeliver: DEFAULT_MAX_DELIVER,
    description: 'Telemetry fuel readings for segment fuel estimation.',
  },
  'emission-fleet': fleetProjection('emission-fleet', 'emission'),
  'safety-fleet': fleetProjection('safety-fleet', 'safety'),
  'surveillance-fleet': fleetProjection('surveillance-fleet', 'surveillance'),
  'notification-fleet': fleetProjection('notification-fleet', 'notification'),
  'telemetry-fleet': fleetProjection('telemetry-fleet', 'telemetry'),
  'ais-processor-fleet': fleetProjection(
    'ais-processor-fleet',
    'ais-processor',
  ),
  'safety-zones': zoneProjection('safety-zones', 'safety'),
  'surveillance-zones': zoneProjection('surveillance-zones', 'surveillance'),
  'notification-alerts': {
    durableName: 'notification-alerts',
    stream: 'ALERTS',
    filterSubjects: [SUBJECT_FILTERS.ALERT],
    service: 'notification',
    eventTypes: [EVENT_TYPES.ALERT_RAISED],
    maxDeliver: DEFAULT_MAX_DELIVER,
    description:
      'Stores alerts in the inbox, applies alert rules and pushes them to clients.',
  },
  'notification-email': {
    durableName: 'notification-email',
    stream: 'NOTIFY',
    filterSubjects: [SUBJECT_FILTERS.NOTIFY_EMAIL],
    service: 'notification',
    eventTypes: [EVENT_TYPES.NOTIFY_EMAIL_REQUESTED],
    maxDeliver: DEFAULT_MAX_DELIVER,
    description: 'Renders and sends transactional e-mails.',
  },
  'auth-audit': {
    durableName: 'auth-audit',
    stream: 'AUDIT',
    filterSubjects: [SUBJECT_FILTERS.AUDIT],
    service: 'auth',
    eventTypes: [EVENT_TYPES.AUDIT_RECORDED],
    maxDeliver: DEFAULT_MAX_DELIVER,
    description: 'Writes the central audit log.',
  },
} as const satisfies Readonly<Record<string, DurableConsumerDefinition>>;

/** A durable consumer name. */
export type DurableConsumerName = keyof typeof CONSUMERS;

/** Every durable consumer definition. */
export const CONSUMER_LIST: readonly DurableConsumerDefinition[] =
  Object.values(CONSUMERS);

/**
 * An ordered (ephemeral, per instance) consumer: no durable state, replays
 * from "new" on start. Used where every instance needs every message.
 */
export interface OrderedConsumerDefinition {
  /** Descriptive name (not a durable name). */
  readonly name: string;
  readonly stream: StreamName;
  readonly filterSubjects: readonly string[];
  readonly service: ServiceName;
  readonly eventTypes: readonly EventType[];
  readonly description: string;
}

/** Ordered consumers of spec 7.3. */
export const ORDERED_CONSUMERS: readonly OrderedConsumerDefinition[] = [
  {
    name: 'notification-positions',
    stream: 'AIS_POSITION',
    filterSubjects: [SUBJECT_FILTERS.AIS_POSITION],
    service: 'notification',
    eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
    description:
      'Realtime position fan-out to WebSocket tile and vessel rooms.',
  },
  {
    name: 'notification-safety',
    stream: 'SAFETY',
    filterSubjects: [SUBJECT_FILTERS.SAFETY_STATE],
    service: 'notification',
    eventTypes: [EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED],
    description:
      'Realtime safety:states / vessel:safety fan-out to tile and vessel rooms.',
  },
  {
    name: 'notification-cii',
    stream: 'EMISSION',
    filterSubjects: [SUBJECT_FILTERS.CII_UPDATED],
    service: 'notification',
    eventTypes: [EVENT_TYPES.EMISSION_CII_UPDATED],
    description: 'Realtime cii:updated fan-out to organization rooms.',
  },
];

/** A core NATS (non JetStream) subscription. */
export interface CoreSubscriptionDefinition {
  readonly name: string;
  readonly subject: string;
  readonly service: ServiceName;
  readonly description: string;
}

/** Core NATS subscriptions of spec 7.3. */
export const CORE_SUBSCRIPTIONS: readonly CoreSubscriptionDefinition[] = [
  {
    name: 'telemetry-mqtt',
    subject: SUBJECT_FILTERS.TELEMETRY_MQTT,
    service: 'telemetry',
    description:
      'Raw device JSON from MQTT topic aisits/telemetry/<deviceId> (NATS MQTT gateway).',
  },
];

/** Durable consumers owned by a service. */
export function consumersOfService(
  service: ServiceName,
): DurableConsumerDefinition[] {
  return CONSUMER_LIST.filter((consumer) => consumer.service === service);
}

/** Durable and ordered consumers that receive an event type. */
export function consumersOfEvent(
  type: EventType,
): (DurableConsumerDefinition | OrderedConsumerDefinition)[] {
  return [...CONSUMER_LIST, ...ORDERED_CONSUMERS].filter((consumer) =>
    consumer.eventTypes.includes(type),
  );
}
