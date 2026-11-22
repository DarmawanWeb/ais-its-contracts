import {
  type AnyEventEnvelope,
  encodeEnvelope,
  type EventPayload,
  type EventType,
  makeEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import { PubHeaders, type StreamExpectations } from '@nats-io/jetstream';
import type { MsgHdrs } from '@nats-io/transport-node';

/**
 * Default allowance of {@link eventMessageSize} for what publication adds
 * to the encoded envelope, bytes: the NATS headers (`Nats-Msg-Id`,
 * `content-type`, `Ais-Its-Event-Type`, `traceparent`, about 250 bytes) and
 * the envelope fields only known then (`source`, `traceparent`).
 */
export const DEFAULT_HEADER_ALLOWANCE_BYTES = 1024;

/** Options of {@link eventMessageSize}. */
export interface EventMessageSizeOptions {
  /** Bytes added for headers and publication-time fields. Default {@link DEFAULT_HEADER_ALLOWANCE_BYTES}. */
  readonly headerAllowanceBytes?: number | undefined;
  /** Envelope `source`. Default `'outbox'`. */
  readonly source?: string | undefined;
  /** Envelope `id`. Default a new UUID v7 (all ids have the same length). */
  readonly id?: string | undefined;
  /** Envelope `time`. Default now (all ISO times have the same length). */
  readonly time?: Date | undefined;
  /** Envelope `subject` (entity key). Default derived from the payload. */
  readonly entityKey?: string | undefined;
  /** Envelope `traceparent`. Default none. */
  readonly traceparent?: string | undefined;
}

/**
 * Size of the NATS message of an event, bytes: the encoded contracts
 * envelope (`encodeEnvelope(makeEnvelope(…))`) plus a header allowance.
 * Compare it with `NatsClient.maxPayloadBytes()` to refuse an event that
 * can never be published before it is written anywhere (`EventPublisher`
 * and `enqueueEvent({ maxBytes })` do it themselves).
 *
 * @throws {InvalidEventError} when `data` violates the contract.
 * @example
 * const max = this.nats.maxPayloadBytes();
 * if (max !== undefined && eventMessageSize(EVENT_TYPES.GEO_ZONE_UPSERTED, snapshot) > max)
 *   throw new UnprocessableEntityError('Zone snapshot too large', { code: 'ZONE_SNAPSHOT_TOO_LARGE' });
 */
export function eventMessageSize<Type extends EventType>(
  type: Type,
  data: EventPayload<Type>,
  options: EventMessageSizeOptions = {},
): number {
  const envelope = makeEnvelope({
    type,
    source: options.source ?? 'outbox',
    data,
    id: options.id,
    time: options.time,
    subject: options.entityKey,
    traceparent: options.traceparent,
  });
  return envelopeMessageSize(
    // A typed envelope is one member of the union `AnyEventEnvelope`.
    envelope as AnyEventEnvelope,
    options.headerAllowanceBytes ?? DEFAULT_HEADER_ALLOWANCE_BYTES,
  );
}

/** Encoded size of `envelope` plus `allowanceBytes`. */
export function envelopeMessageSize(
  envelope: AnyEventEnvelope,
  allowanceBytes: number = DEFAULT_HEADER_ALLOWANCE_BYTES,
): number {
  return encodeEnvelope(envelope).length + Math.max(0, allowanceBytes);
}

/** Bytes of one header line `name: value` plus its CRLF. */
function headerLineBytes(name: string, value: string): number {
  return Buffer.byteLength(name) + 2 + Buffer.byteLength(value) + 2;
}

/**
 * Bytes of a NATS header block as the client encodes it (`NATS/1.0`, one
 * line per value, blank line), including `extra` entries that are not yet
 * set on `headers`. `0` for no header at all.
 */
export function headerBlockBytes(
  headers: MsgHdrs | undefined,
  extra: readonly (readonly [string, string])[] = [],
): number {
  let lines = 0;
  let bytes = 0;
  for (const [name, values] of headers ?? []) {
    for (const value of values) {
      lines += 1;
      bytes += headerLineBytes(name, value);
    }
  }
  for (const [name, value] of extra) {
    lines += 1;
    bytes += headerLineBytes(name, value);
  }
  // "NATS/1.0" CRLF … CRLF CRLF
  return lines === 0 ? 0 : 'NATS/1.0'.length + 2 + bytes + 2;
}

/**
 * The headers a JetStream publish adds to the message (`Nats-Msg-Id` and
 * the optimistic concurrency expectations), as `@nats-io/jetstream` sets
 * them.
 */
export function jetStreamPublishHeaders(
  msgId: string | undefined,
  expect: Partial<StreamExpectations> | undefined,
): [string, string][] {
  const entries: [string, string][] = [];
  if (msgId !== undefined && msgId !== '')
    entries.push([PubHeaders.MsgIdHdr, msgId]);
  if (expect === undefined) return entries;
  if (expect.lastMsgID !== undefined && expect.lastMsgID !== '')
    entries.push([PubHeaders.ExpectedLastMsgIdHdr, expect.lastMsgID]);
  if (expect.streamName !== undefined && expect.streamName !== '')
    entries.push([PubHeaders.ExpectedStreamHdr, expect.streamName]);
  if (typeof expect.lastSequence === 'number')
    entries.push([PubHeaders.ExpectedLastSeqHdr, String(expect.lastSequence)]);
  if (typeof expect.lastSubjectSequence === 'number')
    entries.push([
      PubHeaders.ExpectedLastSubjectSequenceHdr,
      String(expect.lastSubjectSequence),
    ]);
  if (
    expect.lastSubjectSequenceSubject !== undefined &&
    expect.lastSubjectSequenceSubject !== ''
  )
    entries.push([
      PubHeaders.ExpectedLastSubjectSequenceSubjectHdr,
      expect.lastSubjectSequenceSubject,
    ]);
  return entries;
}

/** `true` for the client's `max_payload size exceeded` error and {@link EventTooLargeError}. */
export function isMaxPayloadError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('max_payload');
}
