import {
  encodeEnvelope,
  EVENT_TYPES,
  type FuelReadingRecordedV1,
  makeEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import { PubHeaders } from '@nats-io/jetstream';
import { headers as natsHeaders, type MsgHdrs } from '@nats-io/transport-node';
import { describe, expect, it } from 'vitest';

import { EventTooLargeError } from './errors.js';
import {
  DEFAULT_HEADER_ALLOWANCE_BYTES,
  envelopeMessageSize,
  eventMessageSize,
  headerBlockBytes,
  isMaxPayloadError,
  jetStreamPublishHeaders,
} from './message-size.js';

const reading: FuelReadingRecordedV1 = {
  mmsi: 525_005_223,
  time: '2026-01-01T00:05:00.000Z',
  periodStart: null,
  fuelMeTon: 1.5,
  fuelAeTon: 0.25,
  deviceId: null,
  source: 'api',
};

/** Bytes of the header block as the NATS client encodes it. */
function encodedHeaderBytes(headers: MsgHdrs): number {
  return (headers as unknown as { encode(): Uint8Array }).encode().length;
}

describe('eventMessageSize', () => {
  it('is the encoded envelope plus the header allowance', () => {
    const id = '0192f2a0-0000-7000-8000-000000000001';
    const time = new Date('2026-01-01T00:05:00Z');
    const envelope = makeEnvelope({
      type: EVENT_TYPES.FUEL_READING_RECORDED,
      source: 'outbox',
      data: reading,
      id,
      time,
    });
    const encoded = encodeEnvelope(envelope).length;
    expect(
      eventMessageSize(EVENT_TYPES.FUEL_READING_RECORDED, reading, {
        id,
        time,
      }),
    ).toBe(encoded + DEFAULT_HEADER_ALLOWANCE_BYTES);
    expect(
      eventMessageSize(EVENT_TYPES.FUEL_READING_RECORDED, reading, {
        id,
        time,
        headerAllowanceBytes: 0,
      }),
    ).toBe(encoded);
    expect(envelopeMessageSize(envelope, 10)).toBe(encoded + 10);
    expect(encoded).toBe(Buffer.byteLength(JSON.stringify(envelope)));
  });

  it('does not depend on the generated id and time (fixed lengths)', () => {
    const a = eventMessageSize(EVENT_TYPES.FUEL_READING_RECORDED, reading);
    const b = eventMessageSize(EVENT_TYPES.FUEL_READING_RECORDED, reading, {
      time: new Date('2030-12-31T23:59:59.999Z'),
    });
    expect(a).toBe(b);
  });
});

describe('header sizes', () => {
  it('matches the NATS client encoding of the publish headers', () => {
    const headers = natsHeaders();
    headers.set('content-type', 'application/json');
    headers.set('Ais-Its-Event-Type', EVENT_TYPES.FUEL_READING_RECORDED);
    headers.set(
      'traceparent',
      '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    );
    const extra = jetStreamPublishHeaders('0192f2a0-msg-id', {
      lastSubjectSequence: 42,
      streamName: 'FLEET',
    });
    const all = natsHeaders();
    for (const [name, values] of headers)
      for (const value of values) all.append(name, value);
    for (const [name, value] of extra) all.append(name, value);
    expect(headerBlockBytes(headers, extra)).toBe(encodedHeaderBytes(all));
    expect(headerBlockBytes(undefined)).toBe(0);
    expect(headerBlockBytes(undefined, [['a', 'b']])).toBeGreaterThan(0);
  });

  it('lists the JetStream publish headers it adds', () => {
    expect(jetStreamPublishHeaders(undefined, undefined)).toEqual([]);
    expect(
      jetStreamPublishHeaders('id-1', {
        lastMsgID: 'id-0',
        lastSequence: 0,
        lastSubjectSequenceSubject: 'fleet.vessel.v1.1',
      }),
    ).toEqual([
      [PubHeaders.MsgIdHdr, 'id-1'],
      [PubHeaders.ExpectedLastMsgIdHdr, 'id-0'],
      [PubHeaders.ExpectedLastSeqHdr, '0'],
      [PubHeaders.ExpectedLastSubjectSequenceSubjectHdr, 'fleet.vessel.v1.1'],
    ]);
  });

  it('recognizes the client and kit max_payload errors', () => {
    expect(isMaxPayloadError(new Error('max_payload size exceeded'))).toBe(
      true,
    );
    const tooLarge = new EventTooLargeError('geo.zone.upserted.v1', 2000, 1000);
    expect(isMaxPayloadError(tooLarge)).toBe(true);
    expect(tooLarge).toMatchObject({
      name: 'EventTooLargeError',
      type: 'geo.zone.upserted.v1',
      sizeBytes: 2000,
      maxBytes: 1000,
    });
    expect(isMaxPayloadError(new Error('timeout'))).toBe(false);
    expect(isMaxPayloadError('max_payload')).toBe(false);
  });
});
