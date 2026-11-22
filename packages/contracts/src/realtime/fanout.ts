import * as z from 'zod';

import { REALTIME_SERVER_EVENTS } from './constants.js';
import { RealtimeAlertSchema } from './schemas.js';

/** Maximum socket.io rooms of one fanned-out alert push. */
export const REALTIME_FANOUT_MAX_ROOMS = 16;

/** Maximum length of a room name in a fanned-out alert push. */
export const REALTIME_FANOUT_MAX_ROOM_LENGTH = 128;

/**
 * Message of the core NATS subject `aisits.notification.realtime.v1`
 * (`subjects.notificationRealtime()`, core subscription
 * `notification-realtime-fanout` with `fanout` delivery). The durable
 * `notification-alerts` consumer and the REST acknowledge/resolve change an
 * alert on one notification instance while the socket clients are spread
 * over all of them, so the changing instance publishes the push once and
 * every instance (itself included) emits `event` with `alert` to `rooms` of
 * its own clients. Validate it on both ends; a push is best effort (the inbox
 * stays the source of truth).
 */
export const RealtimeAlertFanoutSchema = z
  .object({
    event: z
      .enum([
        REALTIME_SERVER_EVENTS.ALERT_RAISED,
        REALTIME_SERVER_EVENTS.ALERT_UPDATED,
      ])
      .describe('Server → client event to emit'),
    rooms: z
      .array(z.string().min(1).max(REALTIME_FANOUT_MAX_ROOM_LENGTH))
      .min(1)
      .max(REALTIME_FANOUT_MAX_ROOMS)
      .describe('Rooms to emit to, e.g. "authority" and "org:<orgId>"'),
    alert: RealtimeAlertSchema,
  })
  .meta({
    title: 'RealtimeAlertFanout',
    description:
      'An alert:raised / alert:updated push fanned out to every notification instance over core NATS.',
  });

/** Message of the alert push fan-out between notification instances. */
export type RealtimeAlertFanout = z.infer<typeof RealtimeAlertFanoutSchema>;

/**
 * Payload schema of every core NATS subscription of contracts
 * (`CORE_SUBSCRIPTIONS` of `./events`), keyed by subscription name. Core
 * messages are plain JSON (no event envelope). `telemetry-mqtt` carries the
 * device specific raw JSON of a fuel meter, which the telemetry service
 * validates and normalizes itself (`unknown` here).
 */
export const CORE_SUBSCRIPTION_PAYLOADS = {
  'telemetry-mqtt': z
    .unknown()
    .describe(
      'Device specific JSON; validated and normalized by the telemetry service',
    ),
  'notification-realtime-fanout': RealtimeAlertFanoutSchema,
} as const satisfies Readonly<Record<string, z.ZodType>>;

/** Name of a core subscription with a payload schema in {@link CORE_SUBSCRIPTION_PAYLOADS}. */
export type CoreSubscriptionPayloadName =
  keyof typeof CORE_SUBSCRIPTION_PAYLOADS;

/** Payload type of the core subscription `Name`. */
export type CoreSubscriptionPayload<Name extends CoreSubscriptionPayloadName> =
  z.output<(typeof CORE_SUBSCRIPTION_PAYLOADS)[Name]>;
