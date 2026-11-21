import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as z from 'zod';

import { UuidV7Schema } from '../domain/id.js';
import { EVENT_EXAMPLES, exampleEnvelope } from './__fixtures__/examples.js';
import {
  encodeEnvelope,
  eventEntityKey,
  makeEnvelope,
  parseEnvelope,
} from './codec.js';
import { EventEnvelope, type EventEnvelopeSchema } from './envelope.js';
import { InvalidEventError } from './failure.js';
import { AisRawReceivedV1Schema } from './payloads/ais.js';
import type { AisPositionRecordedV1 } from './payloads/ais.js';
import type { AnyEventEnvelope, TypedEventEnvelope } from './registry.js';
import { typedEnvelopeSchema } from './registry.js';
import {
  EVENT_TYPE_LIST,
  EVENT_TYPES,
  eventTypeVersion,
  isEventType,
} from './types.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const encoder = new TextEncoder();

describe('makeEnvelope', () => {
  it('creates a v7 id, an ISO time and the entity key subject', () => {
    const before = Date.now();
    const envelope = makeEnvelope({
      type: EVENT_TYPES.AIS_POSITION_RECORDED,
      source: 'ais-processor',
      data: EVENT_EXAMPLES['ais.position.recorded.v1'],
      traceparent: TRACEPARENT,
    });
    expect(UuidV7Schema.safeParse(envelope.id).success).toBe(true);
    expect(Date.parse(envelope.time)).toBeGreaterThanOrEqual(before);
    expect(envelope.time.endsWith('Z')).toBe(true);
    expect(envelope).toMatchObject({
      type: 'ais.position.recorded.v1',
      source: 'ais-processor',
      subject: '525005223',
      traceparent: TRACEPARENT,
      data: EVENT_EXAMPLES['ais.position.recorded.v1'],
    });
    expectTypeOf(envelope.data).toEqualTypeOf<AisPositionRecordedV1>();
  });

  it('generates time-ordered unique ids', () => {
    const ids = Array.from(
      { length: 50 },
      () =>
        makeEnvelope({
          type: 'notify.email.requested.v1',
          source: 'auth',
          data: EVENT_EXAMPLES['notify.email.requested.v1'],
        }).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('honours explicit id, time and subject and omits absent optionals', () => {
    const envelope = makeEnvelope({
      type: 'audit.recorded.v1',
      source: 'fleet',
      data: { ...EVENT_EXAMPLES['audit.recorded.v1'], targetId: null },
      id: '01a1f8c2-54db-7a10-8b21-0c9d8e7f6a5b',
      time: new Date('2026-11-20T08:00:00.000Z'),
    });
    expect(envelope.id).toBe('01a1f8c2-54db-7a10-8b21-0c9d8e7f6a5b');
    expect(envelope.time).toBe('2026-11-20T08:00:00.000Z');
    expect(envelope).not.toHaveProperty('subject');
    expect(envelope).not.toHaveProperty('traceparent');

    const keyed = makeEnvelope({
      type: 'fleet.vessel.upserted.v1',
      source: 'fleet',
      data: EVENT_EXAMPLES['fleet.vessel.upserted.v1'],
      subject: 'custom-key',
    });
    expect(keyed.subject).toBe('custom-key');
  });

  it('rejects payloads and metadata that violate the contract', () => {
    const invalidPayload = () =>
      makeEnvelope({
        type: 'ais.raw.received.v1',
        source: 'ais-ingestor',
        data: { ...EVENT_EXAMPLES['ais.raw.received.v1'], lat: 91 },
      });
    expect(invalidPayload).toThrow(InvalidEventError);
    try {
      invalidPayload();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEventError);
      const { issues, failure } = error as InvalidEventError;
      expect(issues.map((issue) => issue.field)).toEqual(['data.lat']);
      expect(failure.type).toBe('ais.raw.received.v1');
      expect(failure.reason).toBe('invalid_payload');
      expect((error as Error).message).toMatch(
        /^Invalid ais\.raw\.received\.v1 event: data\.lat: /,
      );
    }

    for (const metadata of [
      { source: '' },
      { traceparent: 'not-a-traceparent' },
      { id: '01a1f8c2-54db-4a10-8b21-0c9d8e7f6a5b' },
    ]) {
      expect(() =>
        makeEnvelope({
          type: 'alert.raised.v1',
          source: 'detection',
          data: EVENT_EXAMPLES['alert.raised.v1'],
          ...metadata,
        }),
      ).toThrow(InvalidEventError);
    }
    expect(() =>
      makeEnvelope({
        type: 'alert.raised.v1',
        source: 'detection',
        data: EVENT_EXAMPLES['alert.raised.v1'],
        time: new Date('invalid'),
      }),
    ).toThrow(RangeError);
  });
});

describe('envelope round trip', () => {
  it.each(EVENT_TYPE_LIST)('%s survives encode → parse unchanged', (type) => {
    const envelope = exampleEnvelope(type);
    const bytes = encodeEnvelope(envelope);
    expect(bytes).toBeInstanceOf(Uint8Array);

    const fromBytes = parseEnvelope(bytes);
    expect(fromBytes).toEqual({ success: true, envelope });
    expect(parseEnvelope(new TextDecoder().decode(bytes))).toEqual(fromBytes);
    expect(parseEnvelope(JSON.parse(new TextDecoder().decode(bytes)))).toEqual(
      fromBytes,
    );
  });

  it('narrows the parsed envelope by type', () => {
    const result = parseEnvelope(
      encodeEnvelope(exampleEnvelope('alert.raised.v1')),
    );
    expect(result.success).toBe(true);
    if (result.success && result.envelope.type === EVENT_TYPES.ALERT_RAISED) {
      expectTypeOf(result.envelope.data.dedupKey).toEqualTypeOf<string>();
      expect(result.envelope.data.dedupKey).toBe('ews:525005223');
    }
  });

  it('strips unknown envelope and payload members', () => {
    const envelope = exampleEnvelope('fuel.reading.recorded.v1');
    const result = parseEnvelope({
      ...envelope,
      specversion: '1.0',
      data: { ...envelope.data, calibration: 0.98 },
    });
    expect(result).toEqual({ success: true, envelope });
  });
});

describe('parseEnvelope failures', () => {
  it('accepts every binary representation of the message', () => {
    const envelope = exampleEnvelope('audit.recorded.v1');
    const bytes = encodeEnvelope(envelope);
    const expected = { success: true, envelope };
    expect(parseEnvelope(bytes.buffer.slice(0))).toEqual(expected);
    expect(parseEnvelope(new DataView(bytes.buffer))).toEqual(expected);
    expect(parseEnvelope(Buffer.from(bytes))).toEqual(expected);
  });

  it('reports bytes that are not UTF-8 JSON', () => {
    for (const raw of [
      Uint8Array.from([0xff, 0xfe, 0x00]),
      encoder.encode('{"id": '),
      'not json',
    ]) {
      expect(parseEnvelope(raw)).toMatchObject({
        success: false,
        reason: 'invalid_json',
        type: null,
        issues: [],
      });
    }
  });

  it('reports invalid envelopes with the offending members', () => {
    const envelope = exampleEnvelope('ais.raw.received.v1');
    const { data: _data, ...withoutData } = envelope;
    const cases: [unknown, string[]][] = [
      [{ ...envelope, id: 'abc' }, ['id']],
      [{ ...envelope, type: 'AisRawReceived' }, ['type']],
      [{ ...envelope, time: '20/11/2026' }, ['time']],
      [withoutData, ['data']],
      [42, ['']],
    ];
    for (const [raw, fields] of cases) {
      const result = parseEnvelope(raw);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_envelope');
        expect(result.issues.map((issue) => issue.field)).toEqual(fields);
      }
    }
    expect(parseEnvelope({ ...envelope, id: 'abc' })).toMatchObject({
      type: 'ais.raw.received.v1',
    });
  });

  it('reports unknown event types without validating data', () => {
    const envelope = exampleEnvelope('ais.raw.received.v1');
    expect(
      parseEnvelope({
        ...envelope,
        type: 'ais.raw.received.v2',
        data: { any: 1 },
      }),
    ).toMatchObject({
      success: false,
      reason: 'unknown_type',
      type: 'ais.raw.received.v2',
      message: 'Unknown event type "ais.raw.received.v2"',
    });
  });

  it('reports invalid payloads with data-prefixed paths', () => {
    const envelope = exampleEnvelope('ais.raw.received.v1');
    const result = parseEnvelope({
      ...envelope,
      data: { ...envelope.data, mmsi: 123, navstatus: 99 },
    });
    expect(result).toMatchObject({
      success: false,
      reason: 'invalid_payload',
      type: 'ais.raw.received.v1',
    });
    if (!result.success) {
      expect(result.issues.map((issue) => issue.field)).toEqual([
        'data.mmsi',
        'data.navstatus',
      ]);
      expect(result.message).toMatch(
        /^Invalid payload of ais\.raw\.received\.v1: data\.mmsi: .+; data\.navstatus: /,
      );
    }
  });
});

describe('envelope schemas and types', () => {
  it('builds a typed envelope schema with the factory', () => {
    const Envelope = EventEnvelope(AisRawReceivedV1Schema);
    const envelope = exampleEnvelope('ais.raw.received.v1');
    expect(Envelope.parse(envelope)).toEqual(envelope);
    expect(Envelope.safeParse({ ...envelope, data: {} }).success).toBe(false);
    expectTypeOf<z.output<typeof Envelope>['data']>().toEqualTypeOf<
      z.output<typeof AisRawReceivedV1Schema>
    >();
  });

  it('pins the literal type in typed envelope schemas', () => {
    const schema = typedEnvelopeSchema('alert.raised.v1');
    const envelope = exampleEnvelope('alert.raised.v1');
    expect(schema.safeParse(envelope).success).toBe(true);
    expect(
      schema.safeParse({ ...envelope, type: 'audit.recorded.v1' }).success,
    ).toBe(false);
  });

  it('keeps the interface and the zod output compatible', () => {
    expectTypeOf<
      z.output<typeof EventEnvelopeSchema>
    >().toExtend<EventEnvelope>();
    expectTypeOf<
      TypedEventEnvelope<'audit.recorded.v1'>
    >().toExtend<AnyEventEnvelope>();
  });

  it('validates event type names and versions', () => {
    expect(EVENT_TYPE_LIST.every(isEventType)).toBe(true);
    expect(isEventType('ais.raw.received.v2')).toBe(false);
    expect(eventTypeVersion('ais.raw.received.v1')).toBe(1);
    expect(eventTypeVersion('fleet.vessel.upserted.v12')).toBe(12);
    expect(eventTypeVersion('fleet.vessel.upserted')).toBeNull();
    expect(eventTypeVersion('Fleet.Vessel.v1')).toBeNull();
  });

  it('derives entity keys per event family', () => {
    expect(
      EVENT_TYPE_LIST.map((type) => [
        type,
        eventEntityKey(exampleEnvelope(type)),
      ]),
    ).toEqual([
      ['ais.raw.received.v1', '525005223'],
      ['ais.position.recorded.v1', '525005223'],
      ['fuel.reading.recorded.v1', '525005223'],
      ['fleet.vessel.upserted.v1', '01a1f8c2-54d9-7223-9107-543e8d90de1c'],
      ['fleet.vessel.deleted.v1', '01a1f8c2-54d9-7223-9107-543e8d90de1c'],
      ['emission.cii.updated.v1', '525005223'],
      ['alert.raised.v1', '525005223'],
      ['notify.email.requested.v1', 'operator@example.com'],
      ['audit.recorded.v1', '01a1f8c2-54d9-7223-9107-543e8d90de1c'],
    ]);
  });
});
