import type { OpenVocabulary } from '../domain/vocabulary.js';
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
  /**
   * Service owning (and ensuring) the consumer. Open vocabulary: a new
   * service (e.g. a detector service generated from the template) declares
   * its consumers before contracts lists it in `SERVICE_NAMES`.
   */
  readonly service: OpenVocabulary<ServiceName>;
  /** Event types delivered to the consumer. */
  readonly eventTypes: readonly EventType[];
  /** Explicit acks; nak with exponential backoff; dead-lettered after this many deliveries. */
  readonly maxDeliver: number;
  readonly description: string;
}

/**
 * Declares a durable consumer and keeps its literal types: `eventTypes` stays
 * a tuple of event type literals (and `durableName`, `stream` and `service`
 * their literal values), so the kit's `ConsumerEnvelope<typeof definition>`
 * is the union of exactly those events and a `switch (event.type)` can be
 * exhaustive. Use it for consumers that {@link CONSUMERS} does not list yet,
 * e.g. in a service generated from the template; annotating a definition
 * with `: DurableConsumerDefinition` instead widens `eventTypes` to every
 * event type. The definition is returned unchanged.
 *
 * @example
 * export const SPEED_LIMIT_ALERTS = defineDurableConsumer({
 *   durableName: 'speed-limit-alerts',
 *   stream: 'ALERTS',
 *   filterSubjects: [SUBJECT_FILTERS.ALERT],
 *   service: 'speed-limit',
 *   eventTypes: [EVENT_TYPES.ALERT_RAISED, EVENT_TYPES.ALERT_RESOLVED],
 *   maxDeliver: DEFAULT_MAX_DELIVER,
 *   description: 'Keeps the speed limit dashboard in sync with the alerts.',
 * });
 */
export function defineDurableConsumer<
  const Definition extends DurableConsumerDefinition,
>(definition: Definition): Definition {
  return definition;
}

/**
 * Durable consumer of the AIS position feed (stream `AIS_POSITION`, every
 * partition) delivering exactly `ais.position.recorded.v1`, with literal
 * types (see {@link defineDurableConsumer}).
 *
 * @param durableName - durable name, e.g. `"speed-limit-positions"`
 * @param service - service owning (and ensuring) the consumer
 * @param description - what the service does with the positions
 *
 * @example
 * export const POSITIONS_CONSUMER = positionFeedConsumer(
 *   'speed-limit-positions',
 *   'speed-limit',
 *   'Feeds the speed limit detector.',
 * );
 */
export function positionFeedConsumer<
  const Name extends string,
  const Service extends string,
>(durableName: Name, service: Service, description: string) {
  return {
    durableName,
    stream: 'AIS_POSITION',
    filterSubjects: [SUBJECT_FILTERS.AIS_POSITION],
    service,
    eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
    maxDeliver: DEFAULT_MAX_DELIVER,
    description,
  } as const satisfies DurableConsumerDefinition;
}

/**
 * Durable consumer of the vessel projection (stream `FLEET`) delivering
 * exactly `fleet.vessel.upserted.v1` and `fleet.vessel.deleted.v1`, with
 * literal types (see {@link defineDurableConsumer}). The service keeps
 * mmsi → vesselId, orgId from it.
 *
 * @param durableName - durable name, e.g. `"speed-limit-fleet"`
 * @param service - service owning (and ensuring) the consumer
 */
export function fleetProjectionConsumer<
  const Name extends string,
  const Service extends string,
>(durableName: Name, service: Service) {
  return {
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
  } as const satisfies DurableConsumerDefinition;
}

/**
 * Durable consumer of the zone projection (stream `GEO`) delivering exactly
 * `geo.zone.upserted.v1` and `geo.zone.deleted.v1`, with literal types (see
 * {@link defineDurableConsumer}). The service keeps a spatial index
 * (`ZoneIndex`) from it.
 *
 * @param durableName - durable name, e.g. `"speed-limit-zones"`
 * @param service - service owning (and ensuring) the consumer
 */
export function zoneProjectionConsumer<
  const Name extends string,
  const Service extends string,
>(durableName: Name, service: Service) {
  return {
    durableName,
    stream: 'GEO',
    filterSubjects: [SUBJECT_FILTERS.GEO_ZONE],
    service,
    eventTypes: [EVENT_TYPES.GEO_ZONE_UPSERTED, EVENT_TYPES.GEO_ZONE_DELETED],
    maxDeliver: DEFAULT_MAX_DELIVER,
    description: `Zone projection with a spatial index (ZoneIndex) of ${service}.`,
  } as const satisfies DurableConsumerDefinition;
}

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
  'emission-positions': positionFeedConsumer(
    'emission-positions',
    'emission',
    'Builds voyage segments (fuel, CO2, CII) from positions.',
  ),
  'safety-positions': positionFeedConsumer(
    'safety-positions',
    'safety',
    'Feeds the navigational safety detectors (ews, collision).',
  ),
  'surveillance-positions': positionFeedConsumer(
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
  'emission-fleet': fleetProjectionConsumer('emission-fleet', 'emission'),
  'safety-fleet': fleetProjectionConsumer('safety-fleet', 'safety'),
  'surveillance-fleet': fleetProjectionConsumer(
    'surveillance-fleet',
    'surveillance',
  ),
  'notification-fleet': fleetProjectionConsumer(
    'notification-fleet',
    'notification',
  ),
  'telemetry-fleet': fleetProjectionConsumer('telemetry-fleet', 'telemetry'),
  'ais-processor-fleet': fleetProjectionConsumer(
    'ais-processor-fleet',
    'ais-processor',
  ),
  'safety-zones': zoneProjectionConsumer('safety-zones', 'safety'),
  'surveillance-zones': zoneProjectionConsumer(
    'surveillance-zones',
    'surveillance',
  ),
  'notification-alerts': {
    durableName: 'notification-alerts',
    stream: 'ALERTS',
    filterSubjects: [SUBJECT_FILTERS.ALERT],
    service: 'notification',
    // One durable for both types keeps the raise → resolve order of an
    // occurrence (same subject); a separate resolution consumer would race.
    eventTypes: [EVENT_TYPES.ALERT_RAISED, EVENT_TYPES.ALERT_RESOLVED],
    maxDeliver: DEFAULT_MAX_DELIVER,
    description:
      'Stores alerts in the inbox, applies alert rules and pushes them to clients; resolves them on alert.resolved.v1.',
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
  readonly service: OpenVocabulary<ServiceName>;
  readonly eventTypes: readonly EventType[];
  readonly description: string;
}

/** Ordered consumers of spec 7.3, keyed by name. */
export const ORDERED_CONSUMERS = {
  'notification-positions': {
    name: 'notification-positions',
    stream: 'AIS_POSITION',
    filterSubjects: [SUBJECT_FILTERS.AIS_POSITION],
    service: 'notification',
    eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
    description:
      'Realtime position fan-out to WebSocket tile and vessel rooms.',
  },
  'notification-safety': {
    name: 'notification-safety',
    stream: 'SAFETY',
    filterSubjects: [SUBJECT_FILTERS.SAFETY_STATE],
    service: 'notification',
    eventTypes: [EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED],
    description:
      'Realtime safety:states / vessel:safety fan-out to tile and vessel rooms.',
  },
  'notification-cii': {
    name: 'notification-cii',
    stream: 'EMISSION',
    filterSubjects: [SUBJECT_FILTERS.CII_UPDATED],
    service: 'notification',
    eventTypes: [EVENT_TYPES.EMISSION_CII_UPDATED],
    description: 'Realtime cii:updated fan-out to organization rooms.',
  },
} as const satisfies Readonly<Record<string, OrderedConsumerDefinition>>;

/** An ordered consumer name. */
export type OrderedConsumerName = keyof typeof ORDERED_CONSUMERS;

/** Every ordered consumer definition. */
export const ORDERED_CONSUMER_LIST: readonly OrderedConsumerDefinition[] =
  Object.values(ORDERED_CONSUMERS);

/**
 * How the replicas of a service share the messages of a core subscription:
 *
 * - `queue` — one replica receives each message (queue group, load sharing);
 * - `fanout` — every replica receives every message (no queue group), e.g.
 *   to reach the socket clients connected to each instance.
 */
export const CORE_SUBSCRIPTION_DELIVERIES = ['queue', 'fanout'] as const;

/** Delivery mode of a core subscription (see {@link CORE_SUBSCRIPTION_DELIVERIES}). */
export type CoreSubscriptionDelivery =
  (typeof CORE_SUBSCRIPTION_DELIVERIES)[number];

/** Delivery mode of a core subscription that declares none. */
export const DEFAULT_CORE_SUBSCRIPTION_DELIVERY: CoreSubscriptionDelivery =
  'queue';

/** A core NATS (non JetStream) subscription. */
export interface CoreSubscriptionDefinition {
  readonly name: string;
  readonly subject: string;
  readonly service: OpenVocabulary<ServiceName>;
  /**
   * How the replicas of `service` share the messages; default
   * {@link DEFAULT_CORE_SUBSCRIPTION_DELIVERY} (`queue`). The payload schema
   * of a contracts subscription is `CORE_SUBSCRIPTION_PAYLOADS[name]` of
   * `./realtime`.
   */
  readonly delivery?: CoreSubscriptionDelivery | undefined;
  readonly description: string;
}

/**
 * Core NATS subscriptions of spec 7.3. Core NATS has no persistence and no
 * redelivery: a message published while no subscriber listens is lost.
 */
export const CORE_SUBSCRIPTIONS: readonly CoreSubscriptionDefinition[] = [
  {
    name: 'telemetry-mqtt',
    subject: SUBJECT_FILTERS.TELEMETRY_MQTT,
    service: 'telemetry',
    delivery: 'queue',
    description:
      'Raw device JSON from MQTT topic aisits/telemetry/<deviceId> (NATS MQTT gateway).',
  },
  {
    name: 'notification-realtime-fanout',
    subject: SUBJECT_FILTERS.NOTIFICATION_REALTIME,
    service: 'notification',
    delivery: 'fanout',
    description:
      'alert:raised / alert:updated pushes fanned out to every notification instance (Socket.IO rooms).',
  },
];

/**
 * Delivery mode of a core subscription: its `delivery`, or
 * {@link DEFAULT_CORE_SUBSCRIPTION_DELIVERY} when it declares none.
 */
export function coreSubscriptionDelivery(
  definition: Pick<CoreSubscriptionDefinition, 'delivery'>,
): CoreSubscriptionDelivery {
  return definition.delivery ?? DEFAULT_CORE_SUBSCRIPTION_DELIVERY;
}

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
  return [...CONSUMER_LIST, ...ORDERED_CONSUMER_LIST].filter((consumer) =>
    consumer.eventTypes.includes(type),
  );
}
