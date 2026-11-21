import { describe, expect, expectTypeOf, it } from 'vitest';

import { EVENT_EXAMPLES } from '../events/__fixtures__/examples.js';
import { REALTIME_CLIENT_EVENTS, REALTIME_SERVER_EVENTS } from './constants.js';
import {
  PositionsBatchSchema,
  type RealtimeAck,
  realtimeAckSchema,
  type RealtimeAlert,
  RealtimeAlertSchema,
  type RealtimeClientToServerEvents,
  RealtimeErrorSchema,
  RealtimeHandshakeAuthSchema,
  RealtimePositionSchema,
  type RealtimeSafetyState,
  RealtimeSafetyStateSchema,
  type RealtimeServerToClientEvents,
  SafetyStatesBatchSchema,
  toRealtimePosition,
  toRealtimeSafetyState,
  VesselSubscribeRequestSchema,
  ViewportSetRequestSchema,
  ViewportSetResultSchema,
} from './schemas.js';

const POSITION_EVENT = EVENT_EXAMPLES['ais.position.recorded.v1'];
const ALERT_EVENT = EVENT_EXAMPLES['alert.raised.v1'];
const SAFETY_EVENT = EVENT_EXAMPLES['safety.vessel_state.updated.v1'];

const ALERT: RealtimeAlert = {
  id: ALERT_EVENT.id,
  type: ALERT_EVENT.type,
  domain: ALERT_EVENT.domain,
  severity: ALERT_EVENT.severity,
  status: 'open',
  mmsi: ALERT_EVENT.mmsi,
  relatedMmsi: null,
  title: ALERT_EVENT.title,
  message: ALERT_EVENT.message,
  lat: ALERT_EVENT.lat,
  lon: ALERT_EVENT.lon,
  zoneId: ALERT_EVENT.zoneId,
  methodId: ALERT_EVENT.methodId,
  occurredAt: ALERT_EVENT.occurredAt,
  lastOccurredAt: '2026-11-20T08:41:00.000Z',
  occurrences: 3,
  data: ALERT_EVENT.data,
};

describe('client → server messages', () => {
  it('validates viewport:set requests', () => {
    const request = { bbox: [103.5, -1, 107.5, 1.5], zoom: 8.5 };
    expect(ViewportSetRequestSchema.parse(request)).toEqual(request);
    for (const invalid of [
      { bbox: [107.5, -1, 103.5, 1.5], zoom: 8 },
      { bbox: [103.5, -1, 107.5], zoom: 8 },
      { bbox: [-181, -1, 107.5, 1.5], zoom: 8 },
      { bbox: [103.5, -1, 107.5, 1.5], zoom: -1 },
      { bbox: [103.5, -1, 107.5, 1.5] },
    ]) {
      expect(ViewportSetRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('validates vessel subscriptions and the handshake', () => {
    expect(VesselSubscribeRequestSchema.parse({ mmsi: 525005223 })).toEqual({
      mmsi: 525005223,
    });
    expect(
      VesselSubscribeRequestSchema.safeParse({ mmsi: '525005223' }).success,
    ).toBe(false);
    expect(RealtimeHandshakeAuthSchema.safeParse({ token: '' }).success).toBe(
      false,
    );
  });

  it('declares the event names of spec 9', () => {
    expect(Object.values(REALTIME_CLIENT_EVENTS)).toEqual([
      'viewport:set',
      'vessel:subscribe',
      'vessel:unsubscribe',
    ]);
    expect(Object.values(REALTIME_SERVER_EVENTS)).toEqual([
      'positions',
      'safety:states',
      'vessel:position',
      'vessel:safety',
      'alert:raised',
      'alert:updated',
      'cii:updated',
    ]);
  });
});

describe('server → client messages', () => {
  it('projects recorded positions onto RealtimePosition', () => {
    const position = toRealtimePosition(POSITION_EVENT);
    expect(Object.keys(position).sort()).toEqual(
      [
        'mmsi',
        'time',
        'lat',
        'lon',
        'sog',
        'cog',
        'hdg',
        'navstatus',
        'predictedNavstatus',
        'source',
      ].sort(),
    );
    expect(RealtimePositionSchema.parse(POSITION_EVENT)).toEqual(position);
    expect(
      PositionsBatchSchema.parse({
        at: '2026-11-20T08:30:01.000Z',
        items: [position],
      }),
    ).toEqual({ at: '2026-11-20T08:30:01.000Z', items: [position] });
  });

  it('projects safety states onto RealtimeSafetyState at the latest position', () => {
    const state = toRealtimeSafetyState(SAFETY_EVENT, {
      lat: -6.8629,
      lon: 112.7166,
    });
    const expected: RealtimeSafetyState = {
      mmsi: 525005223,
      time: SAFETY_EVENT.time,
      lat: -6.8629,
      lon: 112.7166,
      ewsStatus: 0,
      collisionRisk: 'low',
      closestEncounter: SAFETY_EVENT.closestEncounter,
    };
    expect(state).toEqual(expected);
    expect(Object.keys(state)).toEqual([
      'mmsi',
      'time',
      'lat',
      'lon',
      'ewsStatus',
      'collisionRisk',
      'closestEncounter',
    ]);
    expect(RealtimeSafetyStateSchema.parse({ ...state, extra: 1 })).toEqual(
      state,
    );
    expect(
      RealtimeSafetyStateSchema.safeParse({ ...state, lat: 95 }).success,
    ).toBe(false);
    expect(
      SafetyStatesBatchSchema.parse({
        at: '2026-11-20T08:31:01.000Z',
        items: [state],
      }).items,
    ).toEqual([state]);
    expect(
      SafetyStatesBatchSchema.safeParse({ at: 'now', items: [] }).success,
    ).toBe(false);
  });

  it('validates alerts as delivered to clients', () => {
    expect(RealtimeAlertSchema.parse(ALERT)).toEqual(ALERT);
    expect(
      RealtimeAlertSchema.safeParse({ ...ALERT, status: 'closed' }).success,
    ).toBe(false);
    expect(
      RealtimeAlertSchema.safeParse({ ...ALERT, occurrences: 0 }).success,
    ).toBe(false);
    expect(
      RealtimeAlertSchema.parse({ ...ALERT, dedupKey: 'ews:1' }),
    ).not.toHaveProperty('dedupKey');
    expect(
      RealtimeAlertSchema.parse({
        ...ALERT,
        type: 'anchor_dragging',
        domain: 'safety',
      }).type,
    ).toBe('anchor_dragging');
    expect(
      RealtimeAlertSchema.safeParse({ ...ALERT, domain: undefined }).success,
    ).toBe(false);
  });

  it('validates errors and acknowledgements', () => {
    expect(RealtimeErrorSchema.parse({ code: 'UNAUTHORIZED' })).toEqual({
      code: 'UNAUTHORIZED',
    });
    expect(
      RealtimeErrorSchema.safeParse({ code: 'unauthorized' }).success,
    ).toBe(false);
    const ack = realtimeAckSchema(ViewportSetResultSchema);
    expect(
      ack.parse({ ok: true, data: { mode: 'tiles', tileCount: 4 } }),
    ).toEqual({
      ok: true,
      data: { mode: 'tiles', tileCount: 4 },
    });
    expect(
      ack.parse({
        ok: false,
        error: { code: 'VALIDATION_FAILED', message: 'bbox' },
      }),
    ).toEqual({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'bbox' },
    });
    expect(ack.safeParse({ ok: true }).success).toBe(false);
  });
});

describe('typed socket.io event maps', () => {
  it('fits the socket.io EventsMap constraint and names every event', () => {
    /** Equivalent of socket.io's `EventsMap` constraint (`{ [event: string]: any }`). */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors socket.io's own declaration
    type EventsMap = Record<string, any>;
    expectTypeOf<RealtimeServerToClientEvents>().toExtend<EventsMap>();
    expectTypeOf<RealtimeClientToServerEvents>().toExtend<EventsMap>();
    expectTypeOf<keyof RealtimeServerToClientEvents>().toEqualTypeOf<
      (typeof REALTIME_SERVER_EVENTS)[keyof typeof REALTIME_SERVER_EVENTS]
    >();
    expectTypeOf<keyof RealtimeClientToServerEvents>().toEqualTypeOf<
      (typeof REALTIME_CLIENT_EVENTS)[keyof typeof REALTIME_CLIENT_EVENTS]
    >();
    expectTypeOf<
      Parameters<Parameters<RealtimeClientToServerEvents['viewport:set']>[1]>[0]
    >().toEqualTypeOf<
      RealtimeAck<{ mode: 'tiles' | 'all'; tileCount: number }>
    >();
  });
});
