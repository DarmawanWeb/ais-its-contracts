import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AlertRaisedV1,
  type AlertResolvedV1,
  AlertResolvedV1Schema,
} from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import {
  AlertEmitter,
  type AlertPersistence,
  type AlertResolution,
  type AlertSignal,
  AlertSignalError,
  type AlertUpdate,
  type OpenAlert,
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
    expect(await emitter.retryPending()).toMatchObject({
      published: 0,
      failed: 1,
    });
    failing = false;
    // The next signal of the key publishes the pending alert first, then is unchanged.
    expect(await emitter.raise('safety', ews('warning'))).toBe('unchanged');
    expect(published.map((alert) => alert.id)).toEqual(persisted);
    expect(emitter.pendingCount).toBe(0);
    expect(await emitter.retryPending()).toEqual({
      published: 0,
      failed: 0,
      resolutionsPublished: 0,
      resolutionsFailed: 0,
      resolutionsWaiting: 0,
    });
  });
});

const KEY = `ews:525005223:${ZONE}`;
const T0 = new Date('2026-01-01T00:00:00.000Z');
const MINUTE = 60_000;

/** An emitter publishing raises and resolutions into one ordered log. */
function setupEvents(
  options: {
    readonly persistence?: AlertPersistence;
    readonly repeatedIntervalMs?: number;
  } = {},
) {
  let now = T0;
  let failResolutions = false;
  const raised: AlertRaisedV1[] = [];
  const resolved: AlertResolvedV1[] = [];
  const log: string[] = [];
  const emitter = new AlertEmitter({
    clock: () => now,
    cooldownMs: 10 * MINUTE,
    repeatedIntervalMs: options.repeatedIntervalMs,
    persistence: options.persistence,
    publish: (alert) => {
      raised.push(alert);
      log.push(`raise:${alert.id}`);
      return Promise.resolve();
    },
    publishResolution: (event) => {
      if (failResolutions) return Promise.reject(new Error('NATS down'));
      resolved.push(AlertResolvedV1Schema.parse(event));
      log.push(`resolve:${event.alertId}`);
      return Promise.resolve();
    },
  });
  return {
    emitter,
    raised,
    resolved,
    log,
    advance: (ms: number): void => {
      now = new Date(now.getTime() + ms);
    },
    failResolutions: (fail: boolean): void => {
      failResolutions = fail;
    },
  };
}

/** A persistence hook that records which hooks ran. */
function recordingHooks() {
  const calls: string[] = [];
  const resolutions: AlertResolution[] = [];
  const persistence: AlertPersistence = {
    onRaised: (alert, outcome) => {
      calls.push(`raised:${outcome}:${alert.severity}`);
      return Promise.resolve();
    },
    onUpdated: (update) => {
      calls.push(`updated:${update.reason}`);
      return Promise.resolve();
    },
    onRepeated: () => {
      calls.push('repeated');
      return Promise.resolve();
    },
    onResolved: (resolution) => {
      calls.push('resolved');
      resolutions.push(resolution);
      return Promise.resolve();
    },
  };
  return { calls, resolutions, persistence };
}

const restoredAlert = (overrides: Partial<OpenAlert> = {}): OpenAlert => ({
  alertId: '018f2b5e-0000-7000-8000-0000000000ff',
  dedupKey: KEY,
  type: 'ews',
  mmsi: 525005223,
  relatedMmsi: null,
  zoneId: ZONE,
  severity: 'warning',
  publishedSeverity: 'warning',
  openedAt: new Date('2025-12-31T22:00:00.000Z'),
  publishedAt: new Date('2025-12-31T22:00:00.000Z'),
  lastSeenAt: new Date('2025-12-31T23:00:00.000Z'),
  ...overrides,
});

describe('AlertEmitter resolution events (alert.resolved.v1)', () => {
  it('publishes at once when the key was last published at least the cooldown ago', async () => {
    const { persistence, resolutions } = recordingHooks();
    const { emitter, raised, resolved, advance } = setupEvents({
      persistence,
    });
    await emitter.raise('safety', {
      ...ews('warning'),
      occurredAt: new Date('2025-12-31T23:59:00.000Z'),
    });
    advance(10 * MINUTE);
    const at = new Date('2026-01-01T00:09:30.000Z');
    expect(
      await emitter.resolve(KEY, {
        at,
        reason: 'left the zone',
        data: { distanceM: 2400 },
      }),
    ).toBe(true);
    expect(resolved).toEqual([
      {
        id: resolutions[0]?.eventId,
        alertId: raised[0]?.id,
        type: 'ews',
        domain: 'safety',
        severity: 'warning',
        mmsi: 525005223,
        relatedMmsi: null,
        zoneId: ZONE,
        dedupKey: KEY,
        // Event time of the first signal, not the emitter clock.
        openedAt: '2025-12-31T23:59:00.000Z',
        resolvedAt: at.toISOString(),
        reason: 'left the zone',
        methodId: 'safety.ews',
        data: { distanceM: 2400 },
      },
    ]);
    expect(emitter.pendingResolutionCount).toBe(0);
  });

  it('waits for the end of the cooldown window, then retryPending publishes it', async () => {
    const { emitter, resolved, advance } = setupEvents();
    await emitter.raise('safety', ews('warning'));
    advance(MINUTE);
    await emitter.resolve(KEY, { reason: 'left the zone' });
    expect(resolved).toEqual([]);
    expect(emitter.pendingResolutionCount).toBe(1);
    advance(5 * MINUTE);
    expect(await emitter.retryPending()).toMatchObject({
      resolutionsPublished: 0,
      resolutionsWaiting: 1,
    });
    advance(4 * MINUTE);
    expect(await emitter.retryPending()).toMatchObject({
      resolutionsPublished: 1,
      resolutionsWaiting: 0,
    });
    expect(resolved.map((event) => event.reason)).toEqual(['left the zone']);
    expect(await emitter.retryPending()).toMatchObject({
      resolutionsPublished: 0,
    });
  });

  it('is cancelled when the key is raised again within the cooldown (suppressed reopen)', async () => {
    const { persistence, resolutions } = recordingHooks();
    const { emitter, raised, resolved, advance } = setupEvents({
      persistence,
    });
    await emitter.raise('safety', ews('warning'));
    advance(MINUTE);
    await emitter.resolve(KEY);
    advance(MINUTE);
    expect(await emitter.raise('safety', ews('warning'))).toBe('suppressed');
    expect(emitter.pendingResolutionCount).toBe(0);
    advance(20 * MINUTE);
    await emitter.retryPending();
    expect(resolved).toEqual([]);
    // Ending the reopened occurrence (cooldown over now) is announced once.
    await emitter.resolve(KEY);
    expect(resolved.map((event) => [event.id, event.alertId])).toEqual([
      [resolutions[1]?.eventId, raised[0]?.id],
    ]);
    expect(resolutions[0]?.eventId).not.toBe(resolutions[1]?.eventId);
  });

  it('is cancelled when the key escalates within the cooldown', async () => {
    const { emitter, raised, resolved, advance } = setupEvents();
    await emitter.raise('safety', ews('warning'));
    advance(MINUTE);
    await emitter.resolve(KEY);
    expect(await emitter.raise('safety', ews('critical'))).toBe('raised');
    advance(20 * MINUTE);
    expect(await emitter.flush()).toMatchObject({ resolutionsPublished: 0 });
    expect(resolved).toEqual([]);
    expect(raised.map((alert) => alert.severity)).toEqual([
      'warning',
      'critical',
    ]);
  });

  it('goes out before the next raise of the key once the window ended', async () => {
    const { emitter, raised, log, advance } = setupEvents();
    await emitter.raise('safety', ews('warning'));
    advance(MINUTE);
    await emitter.resolve(KEY);
    advance(10 * MINUTE);
    // The housekeeping has not run yet: the new raise publishes it first.
    expect(await emitter.raise('safety', ews('warning'))).toBe('raised');
    expect(log).toEqual([
      `raise:${raised[0]?.id}`,
      `resolve:${raised[0]?.id}`,
      `raise:${raised[1]?.id}`,
    ]);
  });

  it('keeps a failed publication pending and retries it with the same event id', async () => {
    const { persistence, resolutions } = recordingHooks();
    const { emitter, resolved, advance, failResolutions } = setupEvents({
      persistence,
    });
    await emitter.raise('safety', ews('warning'));
    advance(10 * MINUTE);
    failResolutions(true);
    // Resolved and persisted; the publication error propagates.
    await expect(emitter.resolve(KEY)).rejects.toThrow('NATS down');
    expect(emitter.isOpen(KEY)).toBe(false);
    expect(resolutions).toHaveLength(1);
    expect(await emitter.retryPending()).toMatchObject({
      resolutionsFailed: 1,
    });
    failResolutions(false);
    expect(await emitter.retryPending()).toMatchObject({
      resolutionsPublished: 1,
    });
    expect(resolved.map((event) => event.id)).toEqual([
      resolutions[0]?.eventId,
    ]);
  });

  it('flush() publishes resolutions still within their cooldown', async () => {
    const { emitter, resolved, advance } = setupEvents();
    await emitter.raise('safety', ews('warning'));
    advance(MINUTE);
    await emitter.resolve(KEY);
    expect(await emitter.flush()).toEqual({
      published: 0,
      failed: 0,
      resolutionsPublished: 1,
      resolutionsFailed: 0,
      resolutionsWaiting: 0,
    });
    expect(resolved).toHaveLength(1);
    expect(emitter.pendingResolutionCount).toBe(0);
  });

  it('only persists with publish: false or without publishResolution', async () => {
    const { persistence, resolutions } = recordingHooks();
    const { emitter, resolved, advance } = setupEvents({ persistence });
    await emitter.raise('safety', ews('warning'));
    advance(10 * MINUTE);
    await emitter.resolve(KEY, { publish: false });
    expect(resolved).toEqual([]);
    expect(resolutions[0]?.eventId).toBeUndefined();

    const plain = setup(persistence);
    await plain.emitter.raise('safety', ews('warning'));
    plain.advance(10 * MINUTE);
    await plain.emitter.resolve(KEY);
    expect(resolutions[1]?.eventId).toBeUndefined();
    expect(plain.emitter.pendingResolutionCount).toBe(0);
  });

  it('completes restored occurrences with the registry domain and the fallback method id', async () => {
    const { emitter, resolved } = setupEvents();
    emitter.restore([restoredAlert()]);
    await emitter.resolve(KEY, { methodId: 'safety.ews', domain: 'safety' });
    expect(resolved).toEqual([
      expect.objectContaining({
        alertId: '018f2b5e-0000-7000-8000-0000000000ff',
        domain: 'safety',
        methodId: 'safety.ews',
        openedAt: '2025-12-31T22:00:00.000Z',
      }),
    ]);
    // A future type restored without domain or method id is only persisted.
    emitter.restore([
      restoredAlert({ type: 'grounding', dedupKey: 'grounding:1' }),
    ]);
    expect(await emitter.resolve('grounding:1')).toBe(true);
    expect(resolved).toHaveLength(1);
  });
});

describe('AlertEmitter.replaceOpen / forget / withKey', () => {
  it('replaces the open set within the filter without persistence hooks', async () => {
    const { persistence, calls } = recordingHooks();
    const { emitter, advance } = setupEvents({ persistence });
    const signal = (key: string, detector = 'ews'): AlertSignal => ({
      ...ews('warning'),
      dedupKey: key,
      detector,
    });
    await emitter.raise('safety', signal('kept'));
    await emitter.raise('safety', signal('dropped'));
    await emitter.raise('safety', signal('cooling'));
    await emitter.raise('safety', signal('other', 'collision'));
    await emitter.resolve('cooling');
    advance(MINUTE);
    calls.length = 0;
    const replacement = restoredAlert({
      dedupKey: 'kept',
      alertId: '018f2b5e-0000-7000-8000-0000000000a1',
      severity: 'critical',
      publishedSeverity: 'critical',
      detector: 'ews',
    });
    const added = restoredAlert({ dedupKey: 'added', detector: 'ews' });
    const foreign = restoredAlert({ dedupKey: 'foreign', detector: 'other' });
    const result = await emitter.replaceOpen([replacement, added, foreign], {
      filter: (alert) => alert.detector === 'ews',
    });
    expect(result).toEqual({ restored: 2, forgotten: 1 });
    expect(calls).toEqual([]);
    expect(emitter.get('kept')).toMatchObject({
      alertId: replacement.alertId,
      severity: 'critical',
      // Event times default to the stored ones.
      firstOccurredAt: replacement.openedAt,
      lastOccurredAt: replacement.lastSeenAt,
    });
    expect(emitter.isOpen('added')).toBe(true);
    expect(emitter.isOpen('dropped')).toBe(false);
    expect(emitter.isOpen('foreign')).toBe(false);
    // Outside the filter: untouched.
    expect(emitter.isOpen('other')).toBe(true);
    // The cooldown entry was cleared: a new occurrence, not a reopen.
    expect(await emitter.raise('safety', signal('cooling'))).toBe('raised');
  });

  it('replaces a key after its raise that is still persisting, and later raises see the new state', async () => {
    let release: () => void = () => undefined;
    const persisting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { emitter } = setupEvents({
      persistence: { onRaised: () => persisting },
    });
    const raising = emitter.raise('safety', ews('warning'));
    const replacing = emitter.replaceOpen([restoredAlert()]);
    release();
    expect(await raising).toBe('raised');
    expect(await replacing).toEqual({ restored: 1, forgotten: 0 });
    expect(emitter.get(KEY)?.alertId).toBe(restoredAlert().alertId);
    expect(await emitter.raise('safety', ews('warning'))).toBe('unchanged');
    expect(await emitter.replaceOpen([])).toEqual({
      restored: 0,
      forgotten: 1,
    });
    expect(emitter.isOpen(KEY)).toBe(false);
  });

  it('forget drops open and cooldown state without hooks: the next signal raises', async () => {
    const { persistence, calls } = recordingHooks();
    const { emitter, raised, resolved } = setupEvents({ persistence });
    await emitter.raise('safety', ews('warning'));
    await emitter.resolve(KEY);
    calls.length = 0;
    expect(await emitter.forget(KEY)).toBe(true);
    expect(await emitter.forget(KEY)).toBe(false);
    expect(await emitter.raise('safety', ews('warning'))).toBe('raised');
    expect(raised).toHaveLength(2);
    // The pending resolution of the first occurrence went out before the raise.
    expect(resolved.map((event) => event.alertId)).toEqual([raised[0]?.id]);
    expect(await emitter.forget(KEY, { accept: () => false })).toBe(false);
    expect(await emitter.forget(KEY)).toBe(true);
    expect(emitter.isOpen(KEY)).toBe(false);
    expect(calls).toEqual(['raised:raised:warning']);
  });

  it('withKey runs in turn with raise and resolve, and is re-entrant for its key', async () => {
    const order: string[] = [];
    const { emitter } = setupEvents({
      persistence: {
        onRaised: async () => {
          order.push('raise:persist');
          await sleep(20);
        },
      },
    });
    const raising = emitter.raise('safety', ews('warning'));
    const external = emitter.withKey(KEY, async () => {
      order.push(`with:open=${String(emitter.isOpen(KEY))}`);
      await sleep(20);
      // Re-entrant: runs now instead of waiting for this callback.
      const resolved = await emitter.resolve(KEY);
      order.push(`with:resolved=${String(resolved)}`);
      return 'done';
    });
    const after = emitter.raise('safety', ews('critical')).then((outcome) => {
      order.push(`raise:${outcome}`);
    });
    expect(await external).toBe('done');
    await Promise.all([raising, after]);
    expect(order).toEqual([
      'raise:persist',
      'with:open=true',
      'with:resolved=true',
      'raise:persist',
      'raise:raised',
    ]);
    // Other keys are not held.
    await expect(
      emitter.withKey('other', () =>
        emitter.withKey(KEY, () => Promise.resolve(1)),
      ),
    ).resolves.toBe(1);
  });
});

describe('AlertEmitter event times (occurredAt)', () => {
  it('keeps the signal times apart from the emitter clock', async () => {
    const updates: AlertUpdate[] = [];
    const { emitter, advance } = setupEvents({
      persistence: {
        onUpdated: (update) => {
          updates.push(update);
          return Promise.resolve();
        },
      },
    });
    const at = (iso: string) => new Date(`2026-01-01T${iso}.000Z`);
    await emitter.raise('safety', {
      ...ews('warning'),
      occurredAt: new Date('2025-12-31T23:59:00.000Z'),
    });
    expect(emitter.get(KEY)).toMatchObject({
      openedAt: T0,
      firstOccurredAt: new Date('2025-12-31T23:59:00.000Z'),
      lastOccurredAt: new Date('2025-12-31T23:59:00.000Z'),
    });
    advance(5 * MINUTE);
    expect(
      await emitter.raise('safety', {
        ...ews('warning'),
        occurredAt: at('00:01:00'),
      }),
    ).toBe('unchanged');
    expect(emitter.get(KEY)).toMatchObject({
      lastSeenAt: at('00:05:00'),
      lastOccurredAt: at('00:01:00'),
    });
    // An older signal never moves the latest event time back.
    await emitter.raise('safety', {
      ...ews('info'),
      occurredAt: at('00:00:30'),
    });
    expect(updates[0]).toMatchObject({
      reason: 'de-escalated',
      at: at('00:05:00'),
      occurredAt: at('00:00:30'),
    });
    expect(emitter.get(KEY)?.lastOccurredAt).toEqual(at('00:01:00'));
    await emitter.resolve(KEY);
    await emitter.raise('safety', {
      ...ews('warning'),
      occurredAt: at('00:02:00'),
    });
    expect(updates[1]).toMatchObject({
      reason: 'suppressed',
      reopened: true,
      occurredAt: at('00:02:00'),
    });
    expect(emitter.get(KEY)).toMatchObject({
      firstOccurredAt: new Date('2025-12-31T23:59:00.000Z'),
      lastOccurredAt: at('00:02:00'),
    });
    // Restored rows without event times fall back to openedAt / lastSeenAt.
    emitter.restore([restoredAlert({ dedupKey: 'restored' })]);
    expect(emitter.get('restored')).toMatchObject({
      firstOccurredAt: restoredAlert().openedAt,
      lastOccurredAt: restoredAlert().lastSeenAt,
    });
  });

  it('reports unchanged signals with onRepeated, throttled per key in event time', async () => {
    const repeated: string[] = [];
    let failing = false;
    const { emitter } = setupEvents({
      repeatedIntervalMs: MINUTE,
      persistence: {
        onUpdated: () => Promise.resolve(),
        onRepeated: (alert, occurredAt) => {
          if (failing) return Promise.reject(new Error('db down'));
          repeated.push(
            `${alert.dedupKey}@${occurredAt.toISOString().slice(11, 19)}`,
          );
          return Promise.resolve();
        },
      },
    });
    const signal = (
      seconds: number,
      severity: AlertSignal['severity'] = 'warning',
    ): AlertSignal => ({
      ...ews(severity),
      occurredAt: new Date(T0.getTime() + seconds * 1000),
    });
    await emitter.raise('safety', signal(0));
    await emitter.raise('safety', signal(30));
    await emitter.raise('safety', signal(61));
    await emitter.raise('safety', signal(90));
    failing = true;
    await expect(emitter.raise('safety', signal(125))).rejects.toThrow(
      'db down',
    );
    failing = false;
    await emitter.raise('safety', signal(126));
    // A de-escalation reported the key at 130 s: the throttle restarts.
    await emitter.raise('safety', signal(130, 'info'));
    await emitter.raise('safety', signal(150, 'info'));
    await emitter.raise('safety', signal(191, 'info'));
    expect(repeated).toEqual([
      `${KEY}@00:01:01`,
      `${KEY}@00:02:06`,
      `${KEY}@00:03:11`,
    ]);
  });
});
