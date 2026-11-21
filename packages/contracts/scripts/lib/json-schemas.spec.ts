import { Ajv2020 } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  EVENT_EXAMPLES,
  exampleEnvelope,
} from '../../src/events/__fixtures__/examples.js';
import { EVENT_TYPE_LIST } from '../../src/events/index.js';
import { buildAsyncApiDocument } from './asyncapi.js';
import { asJsonObject } from './json.js';
import {
  catalogJsonSchemas,
  envelopeJsonSchema,
  jsonSchemaFiles,
  payloadJsonSchema,
  SCHEMA_BASE_URI,
} from './json-schemas.js';

// ajv-formats is CommonJS: `module.exports = plugin` with `plugin.default = plugin`.
const addFormats = ajvFormats.default;

const createAjv = (): Ajv2020 => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv;
};

describe('generated JSON Schemas', () => {
  it('compiles in strict mode and accepts every example payload', () => {
    const ajv = createAjv();
    for (const type of EVENT_TYPE_LIST) {
      const validate = ajv.compile(payloadJsonSchema(type));
      expect(
        validate(EVENT_EXAMPLES[type]),
        `${type}: ${ajv.errorsText(validate.errors)}`,
      ).toBe(true);
    }
  });

  it('rejects the same invalid payloads as the zod schemas', () => {
    const ajv = createAjv();
    const raw = ajv.compile(payloadJsonSchema('ais.raw.received.v1'));
    const example = EVENT_EXAMPLES['ais.raw.received.v1'];
    for (const patch of [
      { mmsi: 52500522 },
      { lat: 91 },
      { hdg: 400 },
      { navstatus: 16 },
      { source: 'satellite' },
      { positionTime: '2026-11-20T15:30:00+07:00' },
    ]) {
      expect(raw({ ...example, ...patch }), JSON.stringify(patch)).toBe(false);
    }
    expect(raw({ ...example, hdg: 511, futureMember: 1 })).toBe(true);
  });

  it('describes the envelope and names every file after its event type', () => {
    const ajv = createAjv();
    const validate = ajv.compile(envelopeJsonSchema());
    expect(validate(exampleEnvelope('alert.raised.v1'))).toBe(true);
    expect(validate({ ...exampleEnvelope('alert.raised.v1'), id: 'x' })).toBe(
      false,
    );
    expect([...jsonSchemaFiles().keys()].sort()).toEqual(
      [
        'event-envelope.json',
        'methodology.methods.json',
        'methodology.references.json',
        ...EVENT_TYPE_LIST.map((type) => `${type}.json`),
      ].sort(),
    );
    expect(payloadJsonSchema('geo.zone.upserted.v1').$id).toBe(
      `${SCHEMA_BASE_URI}geo.zone.upserted.v1`,
    );
    expect(SCHEMA_BASE_URI).toBe('urn:ais-its:schema:events:');
  });

  it('keeps alert types open and the payloads free of removed fields', () => {
    const ajv = createAjv();
    const alert = ajv.compile(payloadJsonSchema('alert.raised.v1'));
    const example = EVENT_EXAMPLES['alert.raised.v1'];
    expect(alert({ ...example, type: 'anchor_dragging' })).toBe(true);
    expect(alert({ ...example, type: 'Anchor Dragging' })).toBe(false);
    expect(alert({ ...example, methodId: undefined })).toBe(false);
    const position = payloadJsonSchema('ais.position.recorded.v1');
    expect(
      Object.keys(asJsonObject(position.properties, 'position')),
    ).not.toContain('ewsStatus');
    const zone = ajv.compile(payloadJsonSchema('geo.zone.upserted.v1'));
    const zoneExample = EVENT_EXAMPLES['geo.zone.upserted.v1'];
    expect(zone(zoneExample)).toBe(true);
    expect(
      zone({
        ...zoneExample,
        geometry: { type: 'LineString', coordinates: [[112.7, -6.8]] },
      }),
    ).toBe(false);
  });
});

describe('generated methodology catalog JSON Schemas', () => {
  const reference = {
    id: 'imo-mepc-353-78',
    type: 'regulation',
    title:
      '2022 Guidelines on the reference lines for use with operational carbon intensity indicators (CII reference lines guidelines, G2)',
    issuerOrAuthors: 'IMO MEPC',
    year: 2022,
    identifier: 'Resolution MEPC.353(78)',
    url: 'https://www.imo.org/',
    verification: 'verified',
  };
  const method = {
    id: 'cii.required',
    domain: 'emission',
    name: { id: 'CII yang disyaratkan', en: 'Required CII' },
    summary: {
      id: 'Garis referensi dikurangi faktor Z.',
      en: 'Reference line reduced by Z.',
    },
    formulaLatex: '\\mathrm{CII}_{req} = (1 - Z/100) \\cdot a \\cdot C^{-c}',
    referenceIds: ['imo-mepc-353-78'],
    status: 'implemented',
  };

  it('validates the catalog files with optional members omitted', () => {
    const ajv = createAjv();
    const schemas = catalogJsonSchemas();
    const references = ajv.compile(
      asJsonObject(schemas.get('methodology.references.json'), 'references'),
    );
    const methods = ajv.compile(
      asJsonObject(schemas.get('methodology.methods.json'), 'methods'),
    );
    expect(references([reference]), ajv.errorsText(references.errors)).toBe(
      true,
    );
    expect(methods([method]), ajv.errorsText(methods.errors)).toBe(true);
    expect(references([{ ...reference, url: 'ftp://example.com' }])).toBe(
      false,
    );
    expect(references([{ ...reference, accessed: '20-11-2026' }])).toBe(false);
    expect(methods([{ ...method, name: { en: 'Required CII' } }])).toBe(false);
    expect(methods([{ ...method, id: 'CII Required' }])).toBe(false);
    expect(
      methods({ $schema: './methodology.methods.json', methods: [method] }),
    ).toBe(true);
    expect(methods({ methods: [method], extra: true })).toBe(false);
    expect(methods({ references: [] })).toBe(false);
  });
});

describe('generated AsyncAPI document', () => {
  const document = buildAsyncApiDocument({ version: '0.0.0-test' });
  const channels = asJsonObject(document.channels, 'channels');
  const components = asJsonObject(document.components, 'components');
  const messages = asJsonObject(components.messages, 'messages');

  const resolve = (pointer: string): unknown =>
    pointer
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>(
        (node, key) => asJsonObject(node, pointer)[key],
        document,
      );

  it('is an AsyncAPI 3.0 document with one message per event type', () => {
    expect(document.asyncapi).toBe('3.0.0');
    const names = Object.values(messages).map(
      (message) => asJsonObject(message, 'message').name,
    );
    for (const type of EVENT_TYPE_LIST) expect(names).toContain(type);
  });

  it('resolves every $ref of channels and operations', () => {
    const refs: string[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (typeof node === 'object' && node !== null) {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') refs.push(value);
          else collect(value);
        }
      }
    };
    collect(document);
    expect(refs.length).toBeGreaterThan(50);
    for (const pointer of refs) expect(resolve(pointer), pointer).toBeDefined();
  });

  it('declares the channel addresses of spec 7.3', () => {
    const addresses = Object.values(channels).map(
      (channel) => asJsonObject(channel, 'channel').address,
    );
    expect(addresses).toEqual([
      'ais.raw.v1.{source}',
      'ais.position.v1.{partition}.{mmsi}',
      'fuel.reading.v1.{mmsi}',
      'fleet.vessel.v1.{vesselId}',
      'geo.zone.v1.{zoneId}',
      'safety.state.v1.{mmsi}',
      'emission.cii.v1.{mmsi}',
      'alert.v1.{alertType}.{mmsi}',
      'notify.email.v1',
      'audit.v1.{service}',
      'dlq.{stream}.{consumer}',
      'aisits.telemetry.{deviceId}',
    ]);
  });

  it('documents the open alert type set with examples instead of an enum', () => {
    const alert = asJsonObject(channels.alert, 'alert channel');
    const parameters = asJsonObject(alert.parameters, 'alert parameters');
    const alertType = asJsonObject(parameters.alertType, 'alertType');
    expect(alertType.enum).toBeUndefined();
    expect(alertType.examples).toEqual([
      'ews',
      'collision',
      'transhipment',
      'anomaly',
      'dark',
      'geofence',
      'fishing',
    ]);
    expect(JSON.stringify(document)).not.toMatch(
      /seemp-contracts|seemp\.|x-seemp|\bdetection\b/i,
    );
  });
});
