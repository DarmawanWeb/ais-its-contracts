import * as z from 'zod';

import { issuesToFieldErrors } from '../api/problem.js';
import { ENVELOPE_SHAPE, type EventEnvelope } from './envelope.js';
import { type EventFailure, eventFailure } from './failure.js';
import {
  AisPositionRecordedV1Schema,
  AisRawReceivedV1Schema,
  AlertRaisedV1Schema,
  AlertResolvedV1Schema,
  AuditRecordedV1Schema,
  CiiUpdatedV1Schema,
  EmailRequestedV1Schema,
  FuelReadingRecordedV1Schema,
  SafetyVesselStateV1Schema,
  VesselDeletedV1Schema,
  VesselSnapshotV1Schema,
  ZoneDeletedV1Schema,
  ZoneSnapshotV1Schema,
} from './payloads/index.js';
import { EVENT_TYPES, type EventType, isEventType } from './types.js';

/** Payload schema of every event type. */
export const EVENT_SCHEMAS = {
  [EVENT_TYPES.AIS_RAW_RECEIVED]: AisRawReceivedV1Schema,
  [EVENT_TYPES.AIS_POSITION_RECORDED]: AisPositionRecordedV1Schema,
  [EVENT_TYPES.FUEL_READING_RECORDED]: FuelReadingRecordedV1Schema,
  [EVENT_TYPES.FLEET_VESSEL_UPSERTED]: VesselSnapshotV1Schema,
  [EVENT_TYPES.FLEET_VESSEL_DELETED]: VesselDeletedV1Schema,
  [EVENT_TYPES.GEO_ZONE_UPSERTED]: ZoneSnapshotV1Schema,
  [EVENT_TYPES.GEO_ZONE_DELETED]: ZoneDeletedV1Schema,
  [EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED]: SafetyVesselStateV1Schema,
  [EVENT_TYPES.EMISSION_CII_UPDATED]: CiiUpdatedV1Schema,
  [EVENT_TYPES.ALERT_RAISED]: AlertRaisedV1Schema,
  [EVENT_TYPES.ALERT_RESOLVED]: AlertResolvedV1Schema,
  [EVENT_TYPES.NOTIFY_EMAIL_REQUESTED]: EmailRequestedV1Schema,
  [EVENT_TYPES.AUDIT_RECORDED]: AuditRecordedV1Schema,
} as const satisfies Readonly<Record<EventType, z.ZodType>>;

/** Payload type of every event type. */
export type EventPayloadMap = {
  readonly [Type in EventType]: z.output<(typeof EVENT_SCHEMAS)[Type]>;
};

/** Payload type of the event type `Type`. */
export type EventPayload<Type extends EventType> = EventPayloadMap[Type];

/** Envelope of the event type `Type` with its typed payload. */
export type TypedEventEnvelope<Type extends EventType> = EventEnvelope<
  EventPayload<Type>,
  Type
>;

/** Any known event, discriminated by `type` (narrow with `switch (e.type)`). */
export type AnyEventEnvelope = {
  [Type in EventType]: TypedEventEnvelope<Type>;
}[EventType];

/** The `{ type, data }` pair of any known event, discriminated by `type`. */
export type AnyEventData = {
  [Type in EventType]: {
    readonly type: Type;
    readonly data: EventPayload<Type>;
  };
}[EventType];

/**
 * Zod schema of the complete envelope of `type` (`type` is a literal, `data`
 * the payload schema). Used to validate produced events and to generate the
 * AsyncAPI document.
 */
export function typedEnvelopeSchema<Type extends EventType>(type: Type) {
  return z.object({
    ...ENVELOPE_SHAPE,
    type: z.literal(type),
    data: EVENT_SCHEMAS[type],
  });
}

/** Result of {@link validateEvent}. */
export type EventValidationResult<TData> =
  { readonly success: true; readonly data: TData } | EventFailure;

/**
 * Validates the payload of an event type with its contracts schema.
 *
 * @returns the parsed payload (unknown keys stripped) or an {@link EventFailure}
 * (`unknown_type` / `invalid_payload`).
 *
 * @example
 * const result = validateEvent('ais.raw.received.v1', data);
 * if (!result.success) logger.warn(result.message);
 */
export function validateEvent<Type extends EventType>(
  type: Type,
  data: unknown,
): EventValidationResult<EventPayload<Type>>;
export function validateEvent(
  type: string,
  data: unknown,
): EventValidationResult<unknown>;
export function validateEvent(
  type: string,
  data: unknown,
): EventValidationResult<unknown> {
  if (!isEventType(type)) {
    return eventFailure('unknown_type', `Unknown event type "${type}"`, type);
  }
  const schema: z.ZodType = EVENT_SCHEMAS[type];
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return eventFailure(
    'invalid_payload',
    `Invalid payload of ${type}`,
    type,
    issuesToFieldErrors(result.error.issues),
  );
}
