import { subjectMatchesFilter } from './subject-match.js';

/** Names of every JetStream stream (spec 7.2). */
export const STREAM_NAMES = [
  'AIS_RAW',
  'AIS_POSITION',
  'FUEL',
  'FLEET',
  'EMISSION',
  'ALERTS',
  'NOTIFY',
  'AUDIT',
  'DLQ',
] as const;

/** A stream name. */
export type StreamName = (typeof STREAM_NAMES)[number];

/** JetStream retention policy (values match the NATS API). */
export type StreamRetention = 'limits' | 'workqueue' | 'interest';

/** JetStream storage type (values match the NATS API). */
export type StreamStorage = 'file' | 'memory';

/**
 * Plain-data stream definition, ensured (create or update) on boot by the
 * producers. Durations are milliseconds; convert to nanoseconds for the NATS API.
 */
export interface StreamDefinition {
  readonly name: StreamName;
  readonly subjects: readonly string[];
  readonly retention: StreamRetention;
  /** Maximum message age in milliseconds; `0` = unlimited. */
  readonly maxAgeMs: number;
  /** Messages kept per subject; `-1` = unlimited. */
  readonly maxMsgsPerSubject: number;
  /** `Nats-Msg-Id` deduplication window in milliseconds. */
  readonly duplicateWindowMs: number;
  readonly storage: StreamStorage;
  readonly description: string;
}

/** Deduplication window of every stream (2 minutes). */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const defaults = {
  retention: 'limits',
  maxMsgsPerSubject: -1,
  duplicateWindowMs: DUPLICATE_WINDOW_MS,
  storage: 'file',
} as const;

/** Every stream of the platform, exactly as spec 7.2. */
export const STREAMS = {
  AIS_RAW: {
    ...defaults,
    name: 'AIS_RAW',
    subjects: ['ais.raw.v1.>'],
    maxAgeMs: DAY_MS,
    description: 'Normalized AIS reports published by the ais-ingestor.',
  },
  AIS_POSITION: {
    ...defaults,
    name: 'AIS_POSITION',
    subjects: ['ais.position.v1.>'],
    maxAgeMs: 7 * DAY_MS,
    description:
      'Recorded positions partitioned by mmsi % 16 (ais.position.v1.<partition>.<mmsi>).',
  },
  FUEL: {
    ...defaults,
    name: 'FUEL',
    subjects: ['fuel.reading.v1.>'],
    maxAgeMs: 30 * DAY_MS,
    description: 'Fuel consumption readings published by telemetry.',
  },
  FLEET: {
    ...defaults,
    name: 'FLEET',
    subjects: ['fleet.vessel.v1.>'],
    maxAgeMs: 0,
    maxMsgsPerSubject: 1,
    description:
      'Latest vessel snapshot per vessel (projection source for every service).',
  },
  EMISSION: {
    ...defaults,
    name: 'EMISSION',
    subjects: ['emission.cii.v1.>'],
    maxAgeMs: 30 * DAY_MS,
    description: 'Year-to-date CII updates published by emission.',
  },
  ALERTS: {
    ...defaults,
    name: 'ALERTS',
    subjects: ['alert.v1.>'],
    maxAgeMs: 90 * DAY_MS,
    description: 'Alerts raised by ais-processor (ews) and detection.',
  },
  NOTIFY: {
    ...defaults,
    name: 'NOTIFY',
    subjects: ['notify.email.v1'],
    retention: 'workqueue',
    maxAgeMs: 7 * DAY_MS,
    description: 'Transactional e-mail requests (work queue).',
  },
  AUDIT: {
    ...defaults,
    name: 'AUDIT',
    subjects: ['audit.v1.>'],
    maxAgeMs: 30 * DAY_MS,
    description: 'Audit records of every service, consumed by auth.',
  },
  DLQ: {
    ...defaults,
    name: 'DLQ',
    subjects: ['dlq.>'],
    maxAgeMs: 14 * DAY_MS,
    description:
      'Dead letters: messages that exceeded max_deliver, at dlq.<stream>.<consumer>.',
  },
} as const satisfies {
  readonly [Name in StreamName]: StreamDefinition & { readonly name: Name };
};

/** Every stream definition in declaration order. */
export const STREAM_LIST: readonly StreamDefinition[] = Object.values(STREAMS);

/** NATS message headers set by producers. */
export const NATS_HEADERS = {
  /** Deduplication id: the envelope `id` (ingestor: `<mmsi>:<positionTime>:<source>`). */
  MSG_ID: 'Nats-Msg-Id',
  /** W3C trace context, mirrors the envelope `traceparent`. */
  TRACEPARENT: 'traceparent',
} as const;

/**
 * Stream that captures a concrete subject.
 *
 * @returns the stream, or `undefined` when no stream binds the subject.
 */
export function streamForSubject(
  subject: string,
): StreamDefinition | undefined {
  return STREAM_LIST.find((stream) =>
    stream.subjects.some((filter) => subjectMatchesFilter(subject, filter)),
  );
}
