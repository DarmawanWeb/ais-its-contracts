import * as z from 'zod';

import { IsoDateTimeSchema } from '../api/datetime.js';
import { ERROR_CODE_PATTERN } from '../api/error-codes.js';
import { MmsiSchema } from '../domain/ais.js';
import { AlertStatusSchema } from '../domain/alerts.js';
import { BBoxSchema } from '../domain/geo.js';
import type { AisPositionRecordedV1 } from '../events/payloads/ais.js';
import { AisPositionRecordedV1Schema } from '../events/payloads/ais.js';
import { AlertRaisedV1Schema } from '../events/payloads/alert.js';
import type { CiiUpdatedV1 } from '../events/payloads/emission.js';
import { MAX_TILE_ZOOM } from './tiles.js';

/** `viewport:set` request: the visible map box and zoom. */
export const ViewportSetRequestSchema = z
  .object({
    bbox: BBoxSchema,
    zoom: z.number().min(0).max(MAX_TILE_ZOOM).describe('Map zoom level'),
  })
  .describe('viewport:set request');

/** `viewport:set` request. */
export type ViewportSetRequest = z.infer<typeof ViewportSetRequestSchema>;

/** `viewport:set` acknowledgement data: how the viewport was subscribed. */
export const ViewportSetResultSchema = z
  .object({
    mode: z.enum(['tiles', 'all']),
    tileCount: z.int().nonnegative().describe('Tile rooms joined (0 for all)'),
  })
  .describe('viewport:set result');

/** `viewport:set` acknowledgement data. */
export type ViewportSetResult = z.infer<typeof ViewportSetResultSchema>;

/** `vessel:subscribe` / `vessel:unsubscribe` request. */
export const VesselSubscribeRequestSchema = z
  .object({ mmsi: MmsiSchema })
  .describe('vessel:subscribe / vessel:unsubscribe request');

/** `vessel:subscribe` / `vessel:unsubscribe` request. */
export type VesselSubscribeRequest = z.infer<
  typeof VesselSubscribeRequestSchema
>;

/** A vessel position as pushed to clients (subset of `AisPositionRecordedV1`). */
export const RealtimePositionSchema = AisPositionRecordedV1Schema.pick({
  mmsi: true,
  time: true,
  lat: true,
  lon: true,
  sog: true,
  cog: true,
  hdg: true,
  navstatus: true,
  predictedNavstatus: true,
  ewsStatus: true,
  source: true,
}).describe('Realtime vessel position');

/** A vessel position as pushed to clients. */
export type RealtimePosition = z.infer<typeof RealtimePositionSchema>;

/** Projects a recorded position event onto the realtime shape. */
export function toRealtimePosition(
  position: AisPositionRecordedV1,
): RealtimePosition {
  return {
    mmsi: position.mmsi,
    time: position.time,
    lat: position.lat,
    lon: position.lon,
    sog: position.sog,
    cog: position.cog,
    hdg: position.hdg,
    navstatus: position.navstatus,
    predictedNavstatus: position.predictedNavstatus,
    ewsStatus: position.ewsStatus,
    source: position.source,
  };
}

/** `positions` batch: latest position per vessel in the batch window. */
export const PositionsBatchSchema = z
  .object({
    at: IsoDateTimeSchema.describe('When the batch was emitted'),
    items: z.array(RealtimePositionSchema),
  })
  .describe('positions batch');

/** `positions` batch. */
export type PositionsBatch = z.infer<typeof PositionsBatchSchema>;

/** An alert as delivered to clients (`alert:raised` / `alert:updated`). */
export const RealtimeAlertSchema = AlertRaisedV1Schema.pick({
  id: true,
  type: true,
  severity: true,
  mmsi: true,
  relatedMmsi: true,
  title: true,
  message: true,
  lat: true,
  lon: true,
  zoneId: true,
  occurredAt: true,
  data: true,
})
  .extend({
    status: AlertStatusSchema,
    lastOccurredAt: IsoDateTimeSchema.describe('Latest merged occurrence'),
    occurrences: z
      .int()
      .min(1)
      .describe('Occurrences merged into this alert (same dedupKey)'),
  })
  .describe('Alert (inbox view)');

/** An alert as delivered to clients. */
export type RealtimeAlert = z.infer<typeof RealtimeAlertSchema>;

/** Error delivered in acknowledgements and `connect_error` data. */
export const RealtimeErrorSchema = z
  .object({
    code: z
      .string()
      .regex(ERROR_CODE_PATTERN)
      .describe('Stable error code, e.g. UNAUTHORIZED, VALIDATION_FAILED'),
    message: z.string().optional(),
  })
  .describe('Realtime error');

/** Error delivered in acknowledgements and `connect_error` data. */
export type RealtimeError = z.infer<typeof RealtimeErrorSchema>;

/** Acknowledgement of a client → server event. */
export type RealtimeAck<TData> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly error: RealtimeError };

/** Zod schema factory of a {@link RealtimeAck} carrying `data`. */
export function realtimeAckSchema<TData extends z.ZodType>(data: TData) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: RealtimeErrorSchema }),
  ]);
}

/** Handshake `auth` payload: `io(url, { path: '/ws', auth: { token } })`. */
export const RealtimeHandshakeAuthSchema = z.object({
  token: z.string().min(1).describe('Access token (JWT)'),
});

/** Handshake `auth` payload. */
export type RealtimeHandshakeAuth = z.infer<typeof RealtimeHandshakeAuthSchema>;

/**
 * Typed client → server event map for socket.io generics
 * (`Server<RealtimeClientToServerEvents, RealtimeServerToClientEvents>`).
 */
export interface RealtimeClientToServerEvents {
  'viewport:set': (
    request: ViewportSetRequest,
    ack: (response: RealtimeAck<ViewportSetResult>) => void,
  ) => void;
  'vessel:subscribe': (
    request: VesselSubscribeRequest,
    ack: (response: RealtimeAck<VesselSubscribeRequest>) => void,
  ) => void;
  'vessel:unsubscribe': (
    request: VesselSubscribeRequest,
    ack: (response: RealtimeAck<VesselSubscribeRequest>) => void,
  ) => void;
}

/**
 * Typed server → client event map for socket.io generics
 * (`Socket<RealtimeServerToClientEvents, RealtimeClientToServerEvents>`).
 */
export interface RealtimeServerToClientEvents {
  positions: (batch: PositionsBatch) => void;
  'vessel:position': (position: RealtimePosition) => void;
  'alert:raised': (alert: RealtimeAlert) => void;
  'alert:updated': (alert: RealtimeAlert) => void;
  'cii:updated': (update: CiiUpdatedV1) => void;
}
