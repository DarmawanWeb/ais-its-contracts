import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import {
  AlertEmitter,
  type AlertPersistence,
  type AlertSignal,
  AlertSignalError,
} from './alert-emitter.js';

const ZONE = '018f2b5e-0000-7000-8000-00000000000a';

function setup(persistence: AlertPersistence = {}) {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const published: AlertRaisedV1[] = [];
  const emitter = new AlertEmitter({
    clock: () => now,
    cooldownMs: 600_000,
    persistence,
    publish: (alert) => {
      published.push(alert);
      return Promise.resolve();
    },
  });
  const advance = (ms: number): void => {
    now = new Date(now.getTime() + ms);
  };
  return { emitter, published, advance };
}

const ews = (severity: AlertSignal['severity']): AlertSignal => ({
  type: 'ews',
  dedupKey: `ews:525005223:${ZONE}`,
  severity,
  mmsi: 525005223,
  title: 'Pipeline proximity',
  message: 'Vessel predicted at anchor near the pipeline',
  position: { lat: 1.1, lon: 104 },
  zoneId: ZONE,
  methodId: 'safety.ews',
  data: { distanceM: 420 },
});

describe('AlertEmitter', () => {
  it('publishes new occurrences as valid alert.raised.v1 payloads', async () => {
    const { emitter, published } = setup();
    expect(await emitter.raise('safety', ews('warning'))).toBe('raised');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'ews',
      domain: 'safety',
      severity: 'warning',
      dedupKey: `ews:525005223:${ZONE}`,
      methodId: 'safety.ews',
      lat: 1.1,
      lon: 104,
      zoneId: ZONE,
      relatedMmsi: null,
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: { distanceM: 420 },
    });
    expect(emitter.isOpen(`ews:525005223:${ZONE}`)).toBe(true);
  });

  it('does not repeat unchanged occurrences, escalates, and records de-escalations', async () => {
    const updates: string[] = [];
    const { emitter, published, advance } = setup({
      onUpdated: (update) => {
        updates.push(
          `${update.reason}:${update.previousSeverity}->${update.alert.severity}`,
        );
        return Promise.resolve();
      },
    });
    await emitter.raise('safety', ews('warning'));
    expect(await emitter.raise('safety', ews('warning'))).toBe('unchanged');
    advance(1_000);
    expect(await emitter.raise('safety', ews('critical'))).toBe('escalated');
    expect(published.map((alert) => alert.severity)).toEqual([
      'warning',
      'critical',
    ]);
    expect(published[0]?.id).not.toBe(published[1]?.id);
    expect(await emitter.raise('safety', ews('warning'))).toBe('de-escalated');
    // Back to critical within the cooldown: flapping, not published again.
    expect(await emitter.raise('safety', ews('critical'))).toBe('suppressed');
    expect(published).toHaveLength(2);
    advance(600_000);
    expect(await emitter.raise('safety', ews('warning'))).toBe('de-escalated');
    expect(await emitter.raise('safety', ews('critical'))).toBe('escalated');
    expect(updates).toEqual([
      'de-escalated:critical->warning',
      'suppressed:warning->critical',
      'de-escalated:critical->warning',
    ]);
    expect(emitter.get(`ews:525005223:${ZONE}`)?.openedAt).toEqual(
      new Date('2026-01-01T00:00:00.000Z'),
    );
  });

  it('resolves occurrences and reopens flapping ones within the cooldown', async () => {
    const resolved: string[] = [];
    const reopened: boolean[] = [];
    const { emitter, published, advance } = setup({
      onResolved: (resolution) => {
        resolved.push(`${resolution.alert.alertId}:${resolution.reason ?? ''}`);
        return Promise.resolve();
      },
      onUpdated: (update) => {
        reopened.push(update.reopened);
        return Promise.resolve();
      },
    });
    await emitter.raise('safety', ews('warning'));
    const firstId = published[0]?.id;
    expect(
      await emitter.resolve(`ews:525005223:${ZONE}`, {
        reason: 'left the zone',
      }),
    ).toBe(true);
    expect(await emitter.resolve(`ews:525005223:${ZONE}`)).toBe(false);
    expect(resolved).toEqual([`${firstId}:left the zone`]);
    advance(60_000);
    expect(await emitter.raise('safety', ews('warning'))).toBe('suppressed');
    expect(reopened).toEqual([true]);
    expect(emitter.get(`ews:525005223:${ZONE}`)?.alertId).toBe(firstId);
    await emitter.resolve(`ews:525005223:${ZONE}`);
    advance(600_000);
    expect(await emitter.raise('safety', ews('warning'))).toBe('raised');
    expect(published).toHaveLength(2);
  });

  it('escalates past the published severity even within the cooldown after a resolution', async () => {
    const { emitter, published } = setup();
    await emitter.raise('safety', ews('warning'));
    await emitter.resolve(`ews:525005223:${ZONE}`);
    expect(await emitter.raise('safety', ews('critical'))).toBe('raised');
    expect(published.map((alert) => alert.severity)).toEqual([
      'warning',
      'critical',
    ]);
  });

  it('persists before publishing and restores open occurrences', async () => {
    const order: string[] = [];
    const { emitter } = setup({
      onRaised: (alert, outcome) => {
        order.push(`persist:${outcome}:${alert.severity}`);
        return Promise.resolve();
      },
      loadOpen: () =>
        Promise.resolve([
          {
            alertId: '018f2b5e-0000-7000-8000-0000000000ff',
            dedupKey: 'collision:1:2',
            type: 'collision',
            mmsi: 111111111,
            relatedMmsi: 222222222,
            zoneId: null,
            severity: 'critical',
            publishedSeverity: 'critical',
            openedAt: new Date('2025-12-31T23:00:00.000Z'),
            publishedAt: new Date('2025-12-31T23:00:00.000Z'),
            lastSeenAt: new Date('2025-12-31T23:59:00.000Z'),
          },
        ]),
    });
    expect(await emitter.restoreFromPersistence()).toBe(1);
    expect(
      emitter.openAlerts({ mmsi: 222222222 }).map((alert) => alert.dedupKey),
    ).toEqual(['collision:1:2']);
    expect(
      await emitter.raise('safety', {
        ...ews('critical'),
        type: 'collision',
        dedupKey: 'collision:1:2',
        mmsi: 111111111,
        relatedMmsi: 222222222,
        zoneId: null,
        methodId: 'safety.collision.cpa',
      }),
    ).toBe('unchanged');
    await emitter.raise('safety', ews('warning'));
    expect(order).toEqual(['persist:raised:warning']);
  });

  it('rejects registry types raised from another domain and invalid payloads', async () => {
    const { emitter } = setup();
    await expect(
      emitter.raise('surveillance', ews('warning')),
    ).rejects.toBeInstanceOf(AlertSignalError);
    await expect(
      emitter.raise('safety', { ...ews('warning'), methodId: 'Not A Method' }),
    ).rejects.toThrow();
    // Future types of the right shape are accepted (forward compatible).
    expect(
      await emitter.raise('safety', {
        ...ews('warning'),
        type: 'grounding',
        dedupKey: 'grounding:1',
      }),
    ).toBe('raised');
  });

  it('keeps persisted alerts whose publication failed and retries them with the same id', async () => {
    let failing = true;
    const published: AlertRaisedV1[] = [];
    const persisted: string[] = [];
    const emitter = new AlertEmitter({
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
      persistence: {
        onRaised: (alert) => {
          persisted.push(alert.id);
          return Promise.resolve();
        },
      },
      publish: (alert) => {
        if (failing) return Promise.reject(new Error('NATS down'));
        published.push(alert);
        return Promise.resolve();
      },
    });
    await expect(emitter.raise('safety', ews('warning'))).rejects.toThrow(
      'NATS down',
    );
    expect(emitter.pendingCount).toBe(1);
    expect(await emitter.retryPending()).toEqual({ published: 0, failed: 1 });
    failing = false;
    // The next signal of the key publishes the pending alert first, then is unchanged.
    expect(await emitter.raise('safety', ews('warning'))).toBe('unchanged');
    expect(published.map((alert) => alert.id)).toEqual(persisted);
    expect(emitter.pendingCount).toBe(0);
    expect(await emitter.retryPending()).toEqual({ published: 0, failed: 0 });
  });
});
