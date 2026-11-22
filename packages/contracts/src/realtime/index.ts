/**
 * Realtime protocol of the notification service (spec 9): socket.io path and
 * event names, message schemas, typed event maps, rooms and tile math, and
 * the payloads of the core NATS subscriptions (alert push fan-out between
 * notification instances).
 *
 * @packageDocumentation
 */
export * from './constants.js';
export * from './fanout.js';
export * from './rooms.js';
export * from './schemas.js';
export * from './tiles.js';
