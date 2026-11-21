import * as z from 'zod';

import {
  EVENT_CATALOG,
  EVENT_SCHEMAS,
  EVENT_TYPE_LIST,
  EventEnvelopeSchema,
  type EventType,
} from '../../src/events/index.js';
import { MethodSchema, ReferenceSchema } from '../../src/references/index.js';
import type { JsonObject } from './json.js';

/** Prefix of the `$id` (a URN, like the problem types) of the event JSON Schemas. */
export const SCHEMA_BASE_URI = 'urn:ais-its:schema:events:';

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
    $id: `${SCHEMA_BASE_URI}${type}`,
    title: definition.payloadName,
    description: `Payload ("data") of ${type}. ${typeof description === 'string' ? description : definition.description}`,
    ...json,
  };
}

/** Draft 2020-12 JSON Schema of the event envelope (any `data`). */
export function envelopeJsonSchema(): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${SCHEMA_BASE_URI}event-envelope`,
    title: 'EventEnvelope',
    ...toJsonSchema(EventEnvelopeSchema, 'draft-2020-12'),
    description:
      'Envelope of every NATS message (spec 7.1); "data" is validated with the schema of "type".',
  };
}

/** Prefix of the `$id` of the methodology catalog JSON Schemas. */
export const CATALOG_SCHEMA_BASE_URI = 'urn:ais-its:schema:methodology:';

/** Catalog file (in `docs/references`) described by each catalog schema file. */
const CATALOG_SCHEMAS = {
  'methodology.references.json': {
    collection: 'references',
    item: ReferenceSchema,
    title: 'Methodology references',
  },
  'methodology.methods.json': {
    collection: 'methods',
    item: MethodSchema,
    title: 'Methodology methods',
  },
} as const;

/**
 * Draft 2020-12 JSON Schemas of the methodology catalog files
 * `docs/references/{references,methods}.json` — an array, or an object with
 * the array under the collection name next to `$schema` — for editors and
 * checks of the catalog; `references:sync` additionally rejects duplicate ids
 * and dangling `referenceIds`.
 */
export function catalogJsonSchemas(): Map<string, JsonObject> {
  return new Map(
    Object.entries(CATALOG_SCHEMAS).map(
      ([file, { collection, item, title }]) => {
        const entries = { type: 'array', items: { $ref: '#/$defs/entry' } };
        return [
          file,
          {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $id: `${CATALOG_SCHEMA_BASE_URI}${collection}`,
            title,
            description: `docs/references/${collection}.json of the methodology catalog (spec 17), shipped as ${collection === 'references' ? 'REFERENCES' : 'METHODS'} by @darmawanweb/ais-its-contracts/references.`,
            anyOf: [
              entries,
              {
                type: 'object',
                properties: {
                  $schema: { type: 'string' },
                  [collection]: entries,
                },
                required: [collection],
                additionalProperties: false,
              },
            ],
            $defs: { entry: toJsonSchema(item, 'draft-2020-12') },
          },
        ];
      },
    ),
  );
}

/** Every JSON Schema file keyed by file name. */
export function jsonSchemaFiles(): Map<string, JsonObject> {
  const files = new Map<string, JsonObject>([
    ['event-envelope.json', envelopeJsonSchema()],
  ]);
  for (const type of EVENT_TYPE_LIST) {
    files.set(payloadSchemaFile(type), payloadJsonSchema(type));
  }
  for (const [file, schema] of catalogJsonSchemas()) files.set(file, schema);
  return files;
}
