import { toIsoDateTime } from '../api/datetime.js';
import { issuesToFieldErrors } from '../api/problem.js';
import { newId } from '../domain/id.js';
import { EventEnvelopeSchema } from './envelope.js';
import {
  type EventFailure,
  eventFailure,
  InvalidEventError,
} from './failure.js';
import {
  type AnyEventData,
  type AnyEventEnvelope,
  EVENT_SCHEMAS,
  type EventPayload,
  type TypedEventEnvelope,
  typedEnvelopeSchema,
} from './registry.js';
import { EVENT_TYPES, type EventType, isEventType } from './types.js';

/** Input of {@link makeEnvelope}. */
export interface MakeEnvelopeInput<Type extends EventType> {
  readonly type: Type;
  /** `SERVICE_NAME` of the producer. */
  readonly source: string;
  readonly data: EventPayload<Type>;
  /** Entity key; defaults to {@link eventEntityKey} of the payload. */
  readonly subject?: string | undefined;
  /** W3C trace context of the current span. */
  readonly traceparent?: string | undefined;
  /** Overrides the generated UUID v7 (tests, replays). */
  readonly id?: string | undefined;
  /** Overrides the production time (tests, replays); defaults to now. */
  readonly time?: Date | undefined;
}

/**
 * Entity key of a payload used as the default envelope `subject`: the MMSI
 * for vessel-centric events, the vessel id for fleet events, the zone id for
 * geo events, the recipient for e-mails and the target for audit records
 * (when any).
 */
export function eventEntityKey(event: AnyEventData): string | undefined {
  switch (event.type) {
    case EVENT_TYPES.AIS_RAW_RECEIVED:
    case EVENT_TYPES.AIS_POSITION_RECORDED:
    case EVENT_TYPES.FUEL_READING_RECORDED:
    case EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED:
    case EVENT_TYPES.EMISSION_CII_UPDATED:
    case EVENT_TYPES.ALERT_RAISED:
    case EVENT_TYPES.ALERT_RESOLVED:
      return String(event.data.mmsi);
    case EVENT_TYPES.FLEET_VESSEL_UPSERTED:
    case EVENT_TYPES.FLEET_VESSEL_DELETED:
    case EVENT_TYPES.GEO_ZONE_UPSERTED:
    case EVENT_TYPES.GEO_ZONE_DELETED:
      return event.data.id;
    case EVENT_TYPES.NOTIFY_EMAIL_REQUESTED:
      return event.data.to;
    case EVENT_TYPES.AUDIT_RECORDED:
      return event.data.targetId ?? undefined;
  }
}

/**
 * Creates a validated envelope with a new UUID v7 `id` and the current `time`.
 * The payload is parsed with its schema (unknown keys are stripped).
 *
 * @throws {InvalidEventError} when the payload or the metadata violate the contract.
 * @throws {RangeError} when `time` is an invalid date.
 *
 * @example
 * const envelope = makeEnvelope({
 *   type: EVENT_TYPES.AIS_POSITION_RECORDED,
 *   source: 'ais-processor',
 *   data: position,
 *   traceparent,
 * });
 * await js.publish(subjectForEvent(envelope), encodeEnvelope(envelope), { msgID: envelope.id });
 */
export function makeEnvelope<Type extends EventType>(
  input: MakeEnvelopeInput<Type>,
): TypedEventEnvelope<Type> {
  // A generic `{ type, data }` pair is one member of the union `AnyEventData`;
  // TypeScript cannot prove it for an unresolved `Type`, hence the assertion.
  const event = { type: input.type, data: input.data } as AnyEventData;
  const subject = input.subject ?? eventEntityKey(event);
  const candidate = {
    id: input.id ?? newId(),
    type: input.type,
    source: input.source,
    time: toIsoDateTime(input.time ?? new Date()),
    ...(subject === undefined ? {} : { subject }),
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
    data: input.data,
  };

  const result = typedEnvelopeSchema(input.type).safeParse(candidate);
  if (!result.success) {
    const issues = issuesToFieldErrors(result.error.issues);
    const payloadOnly = issues.every((issue) => issue.field.startsWith('data'));
    throw new InvalidEventError(
      eventFailure(
        payloadOnly ? 'invalid_payload' : 'invalid_envelope',
        `Invalid ${input.type} event`,
        input.type,
        issues,
      ),
    );
  }
  // The schema of `Type` produces exactly `TypedEventEnvelope<Type>`; TypeScript
  // cannot resolve the generic indexed access, hence the assertion.
  return result.data as TypedEventEnvelope<Type>;
}

/** Result of {@link parseEnvelope}. */
export type EnvelopeParseResult =
  | { readonly success: true; readonly envelope: AnyEventEnvelope }
  | EventFailure;

const decodeUtf8 = (bytes: ArrayBufferView | ArrayBuffer): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

/** Parses JSON text or bytes; returns `undefined` on malformed input. */
function readJson(
  raw: ArrayBufferView | ArrayBuffer | string,
): { value: unknown } | undefined {
  const text = typeof raw === 'string' ? raw : decodeUtf8(raw);
  if (text === null) return undefined;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * Parses and validates a received message: UTF-8 JSON bytes (NATS `msg.data`,
 * any `ArrayBufferView` or `ArrayBuffer`), JSON text, or an already decoded value.
 *
 * Validation happens in stages so the failure tells what to do: `invalid_json`
 * / `invalid_envelope` / `invalid_payload` → `term()` and count;
 * `unknown_type` → a newer producer, skip or route.
 *
 * @example
 * const result = parseEnvelope(msg.data);
 * if (!result.success) { log.warn(result.message); msg.term(); return; }
 * if (result.envelope.type === EVENT_TYPES.AIS_POSITION_RECORDED) handle(result.envelope.data);
 */
export function parseEnvelope(raw: unknown): EnvelopeParseResult {
  let value: unknown = raw;
  if (
    typeof raw === 'string' ||
    ArrayBuffer.isView(raw) ||
    raw instanceof ArrayBuffer
  ) {
    const json = readJson(raw);
    if (json === undefined) {
      return eventFailure('invalid_json', 'Message is not UTF-8 JSON', null);
    }
    value = json.value;
  }

  const envelope = EventEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    const type =
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      typeof value.type === 'string'
        ? value.type
        : null;
    return eventFailure(
      'invalid_envelope',
      'Invalid event envelope',
      type,
      issuesToFieldErrors(envelope.error.issues),
    );
  }

  const { type, data } = envelope.data;
  if (!isEventType(type)) {
    return eventFailure('unknown_type', `Unknown event type "${type}"`, type);
  }

  const payload = EVENT_SCHEMAS[type].safeParse(data);
  if (!payload.success) {
    return eventFailure(
      'invalid_payload',
      `Invalid payload of ${type}`,
      type,
      issuesToFieldErrors(
        payload.error.issues.map((issue) => ({
          ...issue,
          path: ['data', ...issue.path],
        })),
      ),
    );
  }

  // `type` and `data` were validated together by the schema of `type`.
  return {
    success: true,
    envelope: {
      ...envelope.data,
      type,
      data: payload.data,
    } as AnyEventEnvelope,
  };
}

/** Serializes an envelope to UTF-8 JSON bytes for publishing. */
export function encodeEnvelope(envelope: AnyEventEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}
