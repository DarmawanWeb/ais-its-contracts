import { describe, expect, expectTypeOf, it } from 'vitest';

import { CORE_SUBSCRIPTIONS } from '../events/consumers.js';
import { REALTIME_ALERT_FANOUT_EXAMPLE } from './__fixtures__/fanout.js';
import {
  CORE_SUBSCRIPTION_PAYLOADS,
  type CoreSubscriptionPayload,
  type CoreSubscriptionPayloadName,
  REALTIME_FANOUT_MAX_ROOMS,
  type RealtimeAlertFanout,
  RealtimeAlertFanoutSchema,
} from './fanout.js';

describe('RealtimeAlertFanoutSchema', () => {
  it('accepts an alert push and strips unknown members', () => {
    expect(
      RealtimeAlertFanoutSchema.parse({
        ...REALTIME_ALERT_FANOUT_EXAMPLE,
        addedLater: true,
      }),
    ).toEqual(REALTIME_ALERT_FANOUT_EXAMPLE);
    expect(
      RealtimeAlertFanoutSchema.safeParse({
        ...REALTIME_ALERT_FANOUT_EXAMPLE,
        event: 'alert:raised',
        rooms: Array.from(
          { length: REALTIME_FANOUT_MAX_ROOMS },
          (_, i) => `org:${i}`,
        ),
      }).success,
    ).toBe(true);
  });

  it('rejects malformed pushes', () => {
    const invalid: Record<string, unknown>[] = [
      { rooms: [] },
      {
        rooms: Array.from(
          { length: REALTIME_FANOUT_MAX_ROOMS + 1 },
          (_, i) => `org:${i}`,
        ),
      },
      { rooms: [''] },
      { rooms: ['x'.repeat(129)] },
      { event: 'positions' },
      { event: 'alert:resolved' },
      { alert: { ...REALTIME_ALERT_FANOUT_EXAMPLE.alert, occurrences: 0 } },
      { alert: { ...REALTIME_ALERT_FANOUT_EXAMPLE.alert, status: 'closed' } },
      { alert: undefined },
    ];
    for (const patch of invalid) {
      const candidate = { ...REALTIME_ALERT_FANOUT_EXAMPLE, ...patch };
      expect(
        RealtimeAlertFanoutSchema.safeParse(candidate).success,
        JSON.stringify(patch).slice(0, 80),
      ).toBe(false);
    }
    expect(REALTIME_FANOUT_MAX_ROOMS).toBe(16);
  });
});

describe('CORE_SUBSCRIPTION_PAYLOADS', () => {
  it('declares a payload schema for every contracts core subscription', () => {
    expect(Object.keys(CORE_SUBSCRIPTION_PAYLOADS).sort()).toEqual(
      CORE_SUBSCRIPTIONS.map((subscription) => subscription.name).sort(),
    );
    expect(CORE_SUBSCRIPTION_PAYLOADS['notification-realtime-fanout']).toBe(
      RealtimeAlertFanoutSchema,
    );
    // Raw device JSON is validated by the telemetry service itself.
    for (const raw of [{ fuel: 1 }, [1, 2], 'text', 42, null]) {
      expect(
        CORE_SUBSCRIPTION_PAYLOADS['telemetry-mqtt'].safeParse(raw).success,
      ).toBe(true);
    }
  });

  it('types the payload of each core subscription', () => {
    expectTypeOf<CoreSubscriptionPayloadName>().toEqualTypeOf<
      'telemetry-mqtt' | 'notification-realtime-fanout'
    >();
    expectTypeOf<
      CoreSubscriptionPayload<'notification-realtime-fanout'>
    >().toEqualTypeOf<RealtimeAlertFanout>();
    expectTypeOf<
      CoreSubscriptionPayload<'telemetry-mqtt'>
    >().toEqualTypeOf<unknown>();
  });
});
