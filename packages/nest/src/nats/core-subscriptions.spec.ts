import type { Msg } from '@nats-io/transport-node';
import { describe, expect, it } from 'vitest';

import {
  checkCorePayload,
  contractsCorePayloadSchema,
  coreSubscriptionQueue,
  coreSubscriptionSettings,
} from './core-subscriptions.js';

const alert = {
  id: '01a1f8c2-54d8-71c4-95cf-ab5eb8908e01',
  type: 'ews',
  domain: 'safety',
  severity: 'critical',
  status: 'open',
  mmsi: 525_005_223,
  relatedMmsi: null,
  title: 'At anchor within 500 m of the pipeline',
  message: 'KM Sinar Batam is predicted at anchor 312 m from the pipeline.',
  lat: -6.8629,
  lon: 112.7166,
  zoneId: null,
  methodId: 'ews.status',
  occurredAt: '2026-11-20T08:31:00.000Z',
  lastOccurredAt: '2026-11-20T08:41:00.000Z',
  occurrences: 3,
  data: { ewsStatus: 0 },
};

const push = { event: 'alert:updated', rooms: ['authority'], alert };

/** A core message whose `json()` parses `text`. */
const message = (text: string): Pick<Msg, 'json'> =>
  ({ json: () => JSON.parse(text) as unknown }) as Pick<Msg, 'json'>;

describe('core subscription delivery (NATS-11)', () => {
  it('follows the definition: fan-out without queue group, queue with SERVICE_NAME', () => {
    const fanout = coreSubscriptionSettings({
      subscription: 'notification-realtime-fanout',
    });
    expect(coreSubscriptionQueue(fanout, 'notification')).toBeUndefined();
    const queue = coreSubscriptionSettings({ subscription: 'telemetry-mqtt' });
    expect(coreSubscriptionQueue(queue, 'telemetry')).toBe('telemetry');
  });

  it('lets an explicit queue option win', () => {
    expect(
      coreSubscriptionQueue(
        coreSubscriptionSettings({
          subscription: 'notification-realtime-fanout',
          queue: 'pushers',
        }),
        'notification',
      ),
    ).toBe('pushers');
    expect(
      coreSubscriptionQueue(
        coreSubscriptionSettings({
          subscription: 'telemetry-mqtt',
          queue: false,
        }),
        'telemetry',
      ),
    ).toBeUndefined();
  });

  it('treats a local definition without delivery as a queue subscription', () => {
    const settings = coreSubscriptionSettings({
      subscription: {
        name: 'local-commands',
        subject: 'aisits.local.commands',
        service: 'fleet',
        description: 'test',
      },
    });
    expect(coreSubscriptionQueue(settings, 'fleet')).toBe('fleet');
    expect(settings.payloadSchema).toBeUndefined();
  });
});

describe('core subscription payload schemas (NATS-11)', () => {
  it('applies the contracts schema of the fan-out subscription, not the unknown one of telemetry', () => {
    expect(
      contractsCorePayloadSchema('notification-realtime-fanout'),
    ).toBeDefined();
    expect(contractsCorePayloadSchema('telemetry-mqtt')).toBeUndefined();
    expect(contractsCorePayloadSchema('toString')).toBeUndefined();
    expect(
      coreSubscriptionSettings({ subscription: 'notification-realtime-fanout' })
        .payloadSchema,
    ).toBeDefined();
  });

  it('validates messages: valid, not JSON, violating the schema', () => {
    const schema = contractsCorePayloadSchema('notification-realtime-fanout');
    if (schema === undefined) throw new Error('no schema');
    const valid = checkCorePayload(message(JSON.stringify(push)), schema);
    expect(valid).toEqual({ valid: true, payload: push });
    expect(checkCorePayload(message('{not json'), schema)).toEqual({
      valid: false,
      reason: 'invalid JSON',
    });
    expect(
      checkCorePayload(message(JSON.stringify({ ...push, rooms: [] })), schema),
    ).toEqual({
      valid: false,
      reason: 'payload violates the contracts schema',
    });
  });
});
