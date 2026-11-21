import * as z from 'zod';

import { IsoDateTimeSchema } from '../api/datetime.js';
import { UuidV7Schema } from '../domain/id.js';
import { EVENT_TYPE_PATTERN } from './types.js';

/** W3C Trace Context `traceparent` (version-traceid-parentid-flags, lowercase hex). */
export const TRACEPARENT_PATTERN =
  /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

/** Envelope members shared by every event (spec 7.1), without `data`. */
export const ENVELOPE_SHAPE = {
  id: UuidV7Schema.describe('Event id (UUID v7); also the Nats-Msg-Id header'),
  type: z
    .string()
    .regex(EVENT_TYPE_PATTERN)
    .describe('Event type, e.g. "ais.position.recorded.v1"'),
  source: z.string().min(1).describe('SERVICE_NAME of the producer'),
  time: IsoDateTimeSchema.describe('When the event was produced'),
  subject: z
    .string()
    .min(1)
    .optional()
    .describe('Entity key: mmsi, vesselId, zoneId, …'),
  traceparent: z
    .string()
    .regex(TRACEPARENT_PATTERN)
    .optional()
    .describe('W3C trace context of the producer'),
} as const;

/**
 * Zod schema factory of the event envelope with a typed `data` payload.
 *
 * @example
 * const Envelope = EventEnvelope(AisRawReceivedV1Schema);
 * const envelope = Envelope.parse(JSON.parse(text));
 */
export function EventEnvelope<TData extends z.ZodType>(data: TData) {
  return z.object({ ...ENVELOPE_SHAPE, data });
}

/** Wire shape of every event: metadata plus the type specific `data`. */
export interface EventEnvelope<TData = unknown, TType extends string = string> {
  /** UUID v7, also sent as the `Nats-Msg-Id` header (2 min dedup window). */
  readonly id: string;
  /** Event type, e.g. `ais.position.recorded.v1`. */
  readonly type: TType;
  /** `SERVICE_NAME` of the producer. */
  readonly source: string;
  /** ISO-8601 UTC time the event was produced. */
  readonly time: string;
  /** Entity key (mmsi, vesselId, zoneId, …). */
  readonly subject?: string | undefined;
  /** W3C trace context, also sent as a NATS header. */
  readonly traceparent?: string | undefined;
  /** Payload, validated with the schema of `type`. */
  readonly data: TData;
}

/**
 * Envelope schema with an unvalidated (but present) `data` member: the first
 * parsing stage before the payload schema of `type` is applied.
 */
export const EventEnvelopeSchema = EventEnvelope(
  z.unknown().refine((value) => value !== undefined, {
    message: 'Invalid input: expected data, received undefined',
  }),
).describe('Event envelope');
