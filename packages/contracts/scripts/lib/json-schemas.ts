import * as z from 'zod';

import {
  EVENT_CATALOG,
  EVENT_SCHEMAS,
  EVENT_TYPE_LIST,
  EventEnvelopeSchema,
  type EventType,
} from '../../src/events/index.js';
import type { JsonObject } from './json.js';

/** Base URI of the published JSON Schemas. */
export const SCHEMA_BASE_URI = 'https://seemp.dev/schemas/events/';

/** JSON Schema dialects the generator emits. */
export type SchemaTarget = 'draft-2020-12' | 'draft-7';

/**
 * Converts a zod schema to JSON Schema describing what consumers accept
 * (`io: 'input'`: unknown members are allowed for forward compatibility).
 */
export function toJsonSchema(
  schema: z.ZodType,
  target: SchemaTarget,
): JsonObject {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, {
    target,
    io: 'input',
    unrepresentable: 'throw',
  });
  return json;
}

/** File name of the JSON Schema of an event payload. */
export const payloadSchemaFile = (type: EventType): string => `${type}.json`;

/** Draft 2020-12 JSON Schema of an event payload with `$id` and title. */
export function payloadJsonSchema(type: EventType): JsonObject {
  const definition = EVENT_CATALOG[type];
  const {
    title: _title,
    description,
    ...json
  } = toJsonSchema(EVENT_SCHEMAS[type], 'draft-2020-12');
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SCHEMA_BASE_URI}${payloadSchemaFile(type)}`,
    title: definition.payloadName,
    description: `Payload ("data") of ${type}. ${typeof description === 'string' ? description : definition.description}`,
    ...json,
  };
}

/** Draft 2020-12 JSON Schema of the event envelope (any `data`). */
export function envelopeJsonSchema(): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SCHEMA_BASE_URI}event-envelope.json`,
    title: 'EventEnvelope',
    ...toJsonSchema(EventEnvelopeSchema, 'draft-2020-12'),
    description:
      'Envelope of every NATS message (spec 7.1); "data" is validated with the schema of "type".',
  };
}

/** Every JSON Schema file keyed by file name. */
export function jsonSchemaFiles(): Map<string, JsonObject> {
  const files = new Map<string, JsonObject>([
    ['event-envelope.json', envelopeJsonSchema()],
  ]);
  for (const type of EVENT_TYPE_LIST) {
    files.set(payloadSchemaFile(type), payloadJsonSchema(type));
  }
  return files;
}
