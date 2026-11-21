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
  envelopeJsonSchema,
  jsonSchemaFiles,
  payloadJsonSchema,
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
        ...EVENT_TYPE_LIST.map((type) => `${type}.json`),
      ].sort(),
    );
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
      'emission.cii.v1.{mmsi}',
      'alert.v1.{alertType}.{mmsi}',
      'notify.email.v1',
      'audit.v1.{service}',
      'dlq.{stream}.{consumer}',
      'seemp.telemetry.{deviceId}',
    ]);
  });
});
