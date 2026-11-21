/** socket.io path of the realtime gateway (same origin, notification service). */
export const REALTIME_PATH = '/ws';

/** Zoom level of the slippy-map tiles used as position rooms. */
export const REALTIME_TILE_ZOOM = 6;

/** Above this many tiles a viewport joins `tile:all` instead. */
export const REALTIME_MAX_TILES = 64;

/** Batch interval of `positions` for tile rooms, in milliseconds. */
export const REALTIME_TILE_BATCH_INTERVAL_MS = 1000;

/** Batch interval of `positions` for the `tile:all` room, in milliseconds. */
export const REALTIME_ALL_TILES_BATCH_INTERVAL_MS = 5000;

/** Client → server events (all acknowledged). */
export const REALTIME_CLIENT_EVENTS = {
  VIEWPORT_SET: 'viewport:set',
  VESSEL_SUBSCRIBE: 'vessel:subscribe',
  VESSEL_UNSUBSCRIBE: 'vessel:unsubscribe',
} as const;

/** A client → server event name. */
export type RealtimeClientEvent =
  (typeof REALTIME_CLIENT_EVENTS)[keyof typeof REALTIME_CLIENT_EVENTS];

/** Server → client events. */
export const REALTIME_SERVER_EVENTS = {
  POSITIONS: 'positions',
  VESSEL_POSITION: 'vessel:position',
  ALERT_RAISED: 'alert:raised',
  ALERT_UPDATED: 'alert:updated',
  CII_UPDATED: 'cii:updated',
} as const;

/** A server → client event name. */
export type RealtimeServerEvent =
  (typeof REALTIME_SERVER_EVENTS)[keyof typeof REALTIME_SERVER_EVENTS];
