import * as z from 'zod';

import {
  CONSUMER_LIST,
  CORE_SUBSCRIPTIONS,
  ENVELOPE_SHAPE,
  EVENT_DEFINITIONS,
  EVENT_SCHEMAS,
  type EventDefinition,
  EventEnvelopeSchema,
  type EventType,
  makeEnvelope,
  NATS_HEADERS,
  ORDERED_CONSUMERS,
  type StreamName,
  STREAMS,
} from '../../src/events/index.js';
import { EVENT_EXAMPLES } from '../../src/events/__fixtures__/examples.js';
import { asJsonObject, asStringArray, type JsonObject } from './json.js';
import { toJsonSchema } from './json-schemas.js';

/** Channel id of every stream (one channel per subject family). */
const CHANNEL_IDS: Readonly<Record<StreamName, string>> = {
  AIS_RAW: 'aisRaw',
  AIS_POSITION: 'aisPosition',
  FUEL: 'fuelReading',
  FLEET: 'fleetVessel',
  EMISSION: 'ciiUpdated',
  ALERTS: 'alert',
  NOTIFY: 'notifyEmail',
  AUDIT: 'audit',
  DLQ: 'deadLetter',
};

const TELEMETRY_CHANNEL = 'telemetryMqtt';
const DEAD_LETTER_MESSAGE = 'DeadLetter';
const DEVICE_TELEMETRY_MESSAGE = 'DeviceTelemetry';

/** Fixed metadata so the generated examples are deterministic. */
const EXAMPLE_ID = '01a1f8c2-54dc-7f00-8a00-000000000001';
const EXAMPLE_TIME = new Date('2026-11-20T08:30:01.000Z');
const EXAMPLE_TRACEPARENT =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Human readable duration of a stream limit (`0` = unlimited). */
export function formatDuration(ms: number): string {
  if (ms === 0) return '∞';
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} d`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS} h`;
  return `${ms / 60_000} min`;
}

const ref = (path: string): JsonObject => ({ $ref: path });

function channelOf(
  stream: StreamName,
  definitions: readonly EventDefinition[],
) {
  const config = STREAMS[stream];
  const first = definitions[0];
  if (first === undefined) throw new Error(`No event on stream ${stream}`);
  const perSubject =
    config.maxMsgsPerSubject > 0
      ? `, keeps ${config.maxMsgsPerSubject} message(s) per subject`
      : '';
  return {
    address: first.subject,
    title: stream,
    description: `${config.description} JetStream stream ${stream}: ${config.retention} retention, max age ${formatDuration(config.maxAgeMs)}${perSubject}.`,
    parameters: Object.fromEntries(
      Object.entries(first.parameters).map(([name, parameter]) => [
        name,
        {
          description: parameter.description,
          ...(parameter.enum === undefined
            ? {}
            : { enum: [...parameter.enum] }),
        },
      ]),
    ),
    messages: Object.fromEntries(
      definitions.map((definition) => [
        definition.payloadName,
        ref(`#/components/messages/${definition.payloadName}`),
      ]),
    ),
    'x-seemp-stream': { ...config, subjects: [...config.subjects] },
  };
}

/** Envelope payload schema of a message whose `data` references `payloadName`. */
function envelopePayload(type: EventType, payloadName: string): JsonObject {
  const meta = toJsonSchema(z.object(ENVELOPE_SHAPE), 'draft-7');
  const properties = asJsonObject(meta.properties, 'envelope properties');
  const typeProperty = asJsonObject(properties.type, 'envelope type');
  return {
    ...meta,
    title: `${payloadName} envelope`,
    properties: {
      ...properties,
      type: {
        type: 'string',
        const: type,
        description: typeProperty.description,
      },
      data: ref(`#/components/schemas/${payloadName}`),
    },
    required: [...asStringArray(meta.required, 'envelope required'), 'data'],
  };
}

function message(definition: EventDefinition): JsonObject {
  const example = makeEnvelope({
    type: definition.type,
    source: definition.producers[0] ?? 'unknown',
    data: EVENT_EXAMPLES[definition.type],
    id: EXAMPLE_ID,
    time: EXAMPLE_TIME,
    traceparent: EXAMPLE_TRACEPARENT,
  });
  return {
    name: definition.type,
    title: definition.payloadName,
    summary: definition.description,
    contentType: 'application/json',
    headers: ref('#/components/schemas/NatsHeaders'),
    payload: envelopePayload(definition.type, definition.payloadName),
    examples: [
      {
        name: 'example',
        headers: {
          [NATS_HEADERS.MSG_ID]: example.id,
          [NATS_HEADERS.TRACEPARENT]: EXAMPLE_TRACEPARENT,
        },
        payload: example,
      },
    ],
  };
}

const messageRef = (channel: string, name: string): JsonObject =>
  ref(`#/channels/${channel}/messages/${name}`);

function operations(): JsonObject {
  const entries: [string, JsonObject][] = [];
  for (const definition of EVENT_DEFINITIONS) {
    const channel = CHANNEL_IDS[definition.stream];
    entries.push([
      `send-${definition.type}`,
      {
        action: 'send',
        channel: ref(`#/channels/${channel}`),
        summary: `Published by ${definition.producers.join(', ')}.`,
        messages: [messageRef(channel, definition.payloadName)],
        'x-seemp-producers': [...definition.producers],
      },
    ]);
  }
  const payloadNameOf = (type: EventType): string =>
    EVENT_DEFINITIONS.find((definition) => definition.type === type)
      ?.payloadName ?? type;
  for (const consumer of CONSUMER_LIST) {
    const channel = CHANNEL_IDS[consumer.stream];
    entries.push([
      `receive-${consumer.durableName}`,
      {
        action: 'receive',
        channel: ref(`#/channels/${channel}`),
        summary: `${consumer.service}: ${consumer.description}`,
        messages: consumer.eventTypes.map((type) =>
          messageRef(channel, payloadNameOf(type)),
        ),
        'x-seemp-consumer': {
          kind: 'durable',
          durableName: consumer.durableName,
          service: consumer.service,
          stream: consumer.stream,
          filterSubjects: [...consumer.filterSubjects],
          maxDeliver: consumer.maxDeliver,
          deadLetterSubject: `dlq.${consumer.stream}.${consumer.durableName}`,
        },
      },
    ]);
  }
  for (const consumer of ORDERED_CONSUMERS) {
    const channel = CHANNEL_IDS[consumer.stream];
    entries.push([
      `receive-${consumer.name}`,
      {
        action: 'receive',
        channel: ref(`#/channels/${channel}`),
        summary: `${consumer.service}: ${consumer.description}`,
        messages: consumer.eventTypes.map((type) =>
          messageRef(channel, payloadNameOf(type)),
        ),
        'x-seemp-consumer': {
          kind: 'ordered',
          service: consumer.service,
          stream: consumer.stream,
          filterSubjects: [...consumer.filterSubjects],
        },
      },
    ]);
  }
  entries.push([
    'send-dead-letter',
    {
      action: 'send',
      channel: ref(`#/channels/${CHANNEL_IDS.DLQ}`),
      summary:
        'Every durable consumer copies a message here after max_deliver deliveries, then acks it.',
      messages: [messageRef(CHANNEL_IDS.DLQ, DEAD_LETTER_MESSAGE)],
    },
  ]);
  for (const subscription of CORE_SUBSCRIPTIONS) {
    entries.push([
      `receive-${subscription.name}`,
      {
        action: 'receive',
        channel: ref(`#/channels/${TELEMETRY_CHANNEL}`),
        summary: `${subscription.service}: ${subscription.description}`,
        messages: [messageRef(TELEMETRY_CHANNEL, DEVICE_TELEMETRY_MESSAGE)],
        'x-seemp-consumer': {
          kind: 'core',
          service: subscription.service,
          subject: subscription.subject,
        },
      },
    ]);
  }
  return Object.fromEntries(entries);
}

/** Options of {@link buildAsyncApiDocument}. */
export interface AsyncApiOptions {
  /** Version of the contracts package (document `info.version`). */
  readonly version: string;
}

/** AsyncAPI 3.0 document of every channel, message and operation. */
export function buildAsyncApiDocument(options: AsyncApiOptions): JsonObject {
  const byStream = new Map<StreamName, EventDefinition[]>();
  for (const definition of EVENT_DEFINITIONS) {
    byStream.set(definition.stream, [
      ...(byStream.get(definition.stream) ?? []),
      definition,
    ]);
  }

  const channels: JsonObject = {};
  for (const [stream, definitions] of byStream) {
    channels[CHANNEL_IDS[stream]] = channelOf(stream, definitions);
  }
  channels[CHANNEL_IDS.DLQ] = {
    address: 'dlq.{stream}.{consumer}',
    title: 'DLQ',
    description: `${STREAMS.DLQ.description} JetStream stream DLQ: ${STREAMS.DLQ.retention} retention, max age ${formatDuration(STREAMS.DLQ.maxAgeMs)}.`,
    parameters: {
      stream: {
        description: 'Stream of the failed message.',
        enum: Object.keys(STREAMS),
      },
      consumer: { description: 'Durable consumer that gave up.' },
    },
    messages: {
      [DEAD_LETTER_MESSAGE]: ref(
        `#/components/messages/${DEAD_LETTER_MESSAGE}`,
      ),
    },
    'x-seemp-stream': { ...STREAMS.DLQ, subjects: [...STREAMS.DLQ.subjects] },
  };
  channels[TELEMETRY_CHANNEL] = {
    address: 'seemp.telemetry.{deviceId}',
    title: 'Device telemetry (core NATS)',
    description:
      'Core NATS subject of MQTT topic seemp/telemetry/<deviceId> (NATS MQTT gateway); not persisted in JetStream.',
    parameters: { deviceId: { description: 'Registered device id.' } },
    messages: {
      [DEVICE_TELEMETRY_MESSAGE]: ref(
        `#/components/messages/${DEVICE_TELEMETRY_MESSAGE}`,
      ),
    },
  };

  const schemas: JsonObject = {
    EventEnvelope: {
      title: 'EventEnvelope',
      ...toJsonSchema(EventEnvelopeSchema, 'draft-7'),
    },
    NatsHeaders: {
      type: 'object',
      properties: {
        [NATS_HEADERS.MSG_ID]: {
          type: 'string',
          description:
            'Deduplication id (2 min window): the envelope id; the ingestor uses <mmsi>:<positionTime>:<source>.',
        },
        [NATS_HEADERS.TRACEPARENT]: {
          type: 'string',
          description: 'W3C trace context, mirrors the envelope traceparent.',
        },
      },
      required: [NATS_HEADERS.MSG_ID],
    },
  };
  const messages: JsonObject = {};
  for (const definition of EVENT_DEFINITIONS) {
    schemas[definition.payloadName] = toJsonSchema(
      EVENT_SCHEMAS[definition.type],
      'draft-7',
    );
    messages[definition.payloadName] = message(definition);
  }
  messages[DEAD_LETTER_MESSAGE] = {
    name: 'dead-letter',
    title: 'Dead letter',
    summary: 'Unmodified copy of a message that exceeded max_deliver.',
    contentType: 'application/json',
    payload: ref('#/components/schemas/EventEnvelope'),
  };
  messages[DEVICE_TELEMETRY_MESSAGE] = {
    name: 'device-telemetry',
    title: 'Device telemetry',
    summary: 'Raw JSON published by a registered fuel meter.',
    contentType: 'application/json',
    payload: {
      type: 'object',
      description:
        'Device specific JSON; validated and normalized by the telemetry service.',
    },
  };

  return {
    asyncapi: '3.0.0',
    info: {
      title: 'SEEMP Platform Events',
      version: options.version,
      description:
        'NATS JetStream contracts of the SEEMP platform v2 (spec section 7), generated from @darmawanweb/seemp-contracts. Every message is a JSON event envelope; "data" follows the payload schema of its "type".',
      license: { name: 'UNLICENSED' },
    },
    defaultContentType: 'application/json',
    servers: {
      local: {
        host: 'localhost:4222',
        protocol: 'nats',
        description: 'NATS with JetStream of the local development stack.',
      },
    },
    channels,
    operations: operations(),
    components: { schemas, messages },
  };
}
