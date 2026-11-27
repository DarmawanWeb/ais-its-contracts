/**
 * Failover of the Detector SDK (hot standby): `DetectorEngine.activate` /
 * `deactivate` through the test harness, `DetectorContext.isActive`, tick
 * gating and the detector-scoped `forget`.
 */
import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import type { AlertPersistence, OpenAlert } from './alert-emitter.js';
import type { Detector, DetectorContext } from './detector.js';
import { DetectorTestHarness } from './detector-test-harness.js';
import type { VesselPosition } from './vessel-position.js';

const A = 525_005_221;
const B = 525_005_222;
const C = 525_005_223;

/** Raises `ews:<mmsi>` while a vessel moves faster than 5 kn, resolves it below. */
class SpeedDetector implements Detector {
  readonly id = 'speed';
  readonly domain = 'safety';
  readonly methodIds = ['safety.ews'];
  readonly tickIntervalMs = 1_000;
  readonly calls: string[] = [];
  ticks = 0;
  failActivation = false;

  async onPosition(
    context: DetectorContext,
    position: VesselPosition,
  ): Promise<void> {
    const dedupKey = `ews:${position.mmsi}`;
    if (position.sog > 5) {
      const outcome = await context.alerts.raise({
        type: 'ews',
        dedupKey,
        severity: 'warning',
        mmsi: position.mmsi,
        title: 'Fast',
        message: `Vessel ${position.mmsi} is fast`,
        occurredAt: position.time,
      });
      this.calls.push(`${position.mmsi}:${outcome}`);
    } else if (await context.alerts.resolve(dedupKey, { at: position.time })) {
      this.calls.push(`${position.mmsi}:resolved`);
    }
  }

  onTick(): void {
    this.ticks += 1;
  }

  onActivated(context: DetectorContext): void {
    this.calls.push(`activated:active=${String(context.isActive())}`);
    if (this.failActivation) throw new Error('tracker reset failed');
  }

  onDeactivated(context: DetectorContext): void {
    this.calls.push(`deactivated:active=${String(context.isActive())}`);
  }
}

/** Open occurrences as another instance left them in the store. */
class StoredAlerts implements AlertPersistence {
  open: OpenAlert[] = [];
  failing = false;

  loadOpen(): Promise<readonly OpenAlert[]> {
    if (this.failing) return Promise.reject(new Error('db down'));
    return Promise.resolve(this.open);
  }
}

const stored = (mmsi: number, alert: Partial<OpenAlert> = {}): OpenAlert => ({
  alertId: '018f2b5e-0000-7000-8000-0000000000c1',
  dedupKey: `ews:${mmsi}`,
  type: 'ews',
  mmsi,
  relatedMmsi: null,
  zoneId: null,
  severity: 'warning',
  publishedSeverity: 'warning',
  openedAt: new Date('2026-01-01T00:00:00.000Z'),
  publishedAt: new Date('2026-01-01T00:00:00.000Z'),
  lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
  detector: 'speed',
  ...alert,
});

function setup() {
  const detector = new SpeedDetector();
  const store = new StoredAlerts();
  const harness = DetectorTestHarness.create({
    detectors: [detector],
    persistence: store,
  });
  return { detector, store, harness };
}

const ids = (alerts: readonly AlertRaisedV1[]): number[] =>
  alerts.map((alert) => alert.mmsi);

describe('DetectorTestHarness failover (activate / deactivate)', () => {
  it('pauses ticks on deactivation, publishes pending resolutions, and reloads the open alerts on activation', async () => {
    const { detector, store, harness } = setup();
    expect(harness.active).toBe(true);
    await harness.position({ mmsi: A, lat: 1, lon: 104, sog: 10 });
    await harness.position({ mmsi: B, lat: 1, lon: 104.1, sog: 10 });
    await harness.position({ mmsi: B, lat: 1, lon: 104.1, sog: 0 });
    // Resolved within the cooldown: announced later, unless re-raised.
    expect(harness.resolvedEvents).toEqual([]);
    await harness.tick();
    expect(detector.ticks).toBe(1);

    // Another instance takes over: pending resolutions go out first.
    const flushed = await harness.deactivate();
    expect(flushed.resolutionsPublished).toBe(1);
    expect(harness.resolvedEvents.map((event) => event.mmsi)).toEqual([B]);
    expect(harness.active).toBe(false);
    await harness.tick(harness.advance(5_000));
    expect(detector.ticks).toBe(1);

    // Meanwhile the other instance resolved A and raised C.
    store.open = [stored(C)];
    const activation = await harness.activate();
    expect(activation).toMatchObject({
      reloaded: true,
      restored: 1,
      forgotten: 1,
    });
    expect(harness.active).toBe(true);
    expect(detector.calls).toEqual([
      `${A}:raised`,
      `${B}:raised`,
      `${B}:resolved`,
      'deactivated:active=false',
      // isActive() turns true once onActivated settled.
      'activated:active=false',
    ]);
    await harness.tick(harness.advance(1_000));
    expect(detector.ticks).toBe(2);

    // C is known: same severity is unchanged (no second alert). A was
    // forgotten: its next signal is a new occurrence.
    harness.clearRecords();
    await harness.position({ mmsi: C, lat: 1, lon: 104.2, sog: 10 });
    await harness.position({ mmsi: A, lat: 1, lon: 104, sog: 10 });
    expect(detector.calls.slice(-2)).toEqual([`${C}:unchanged`, `${A}:raised`]);
    expect(ids(harness.alerts)).toEqual([A]);
    // B's cooldown entry was cleared too: a re-raise publishes.
    await harness.position({ mmsi: B, lat: 1, lon: 104.1, sog: 10 });
    expect(ids(harness.alerts)).toEqual([A, B]);
    expect(await harness.metricsText()).toContain(
      'aisits_detector_activations_total{outcome="completed"} 1',
    );
  });

  it('stays inactive when loadOpen fails, and isolates a failing onActivated', async () => {
    const { detector, store, harness } = setup();
    await harness.deactivate();
    store.failing = true;
    await expect(harness.activate()).rejects.toThrow('db down');
    expect(harness.active).toBe(false);
    await harness.tick();
    expect(detector.ticks).toBe(0);

    store.failing = false;
    detector.failActivation = true;
    await harness.activate();
    expect(harness.active).toBe(true);
    expect(harness.logs).toContainEqual(
      'error speed: onActivated failed: tracker reset failed',
    );
    const metrics = await harness.metricsText();
    expect(metrics).toContain(
      'aisits_detector_activations_total{outcome="failed"} 1',
    );
    expect(metrics).toContain(
      'aisits_detector_errors_total{detector="speed",hook="onActivated"} 1',
    );
  });

  it('keeps the open alerts when the persistence hook has no loadOpen', async () => {
    const detector = new SpeedDetector();
    const harness = DetectorTestHarness.create({ detectors: [detector] });
    await harness.position({ mmsi: A, lat: 1, lon: 104, sog: 10 });
    await harness.deactivate();
    expect(await harness.activate()).toMatchObject({
      reloaded: false,
      restored: 0,
      forgotten: 0,
    });
    expect(harness.services.alerts.isOpen(`ews:${A}`)).toBe(true);
  });

  it('counts resolutions per detector and scopes forget to the detector', async () => {
    const other: Detector = {
      id: 'other',
      domain: 'safety',
      methodIds: ['safety.ews'],
      onPosition: () => undefined,
    };
    const { harness, detector } = setup();
    const recreated = DetectorTestHarness.create({
      detectors: [detector, other],
    });
    await recreated.position({ mmsi: A, lat: 1, lon: 104, sog: 10 });
    const speed = recreated.registry.get('speed')?.context;
    const foreign = recreated.registry.get('other')?.context;
    expect(await foreign?.alerts.forget(`ews:${A}`)).toBe(false);
    expect(recreated.services.alerts.isOpen(`ews:${A}`)).toBe(true);
    expect(await speed?.alerts.forget(`ews:${A}`)).toBe(true);
    expect(recreated.services.alerts.isOpen(`ews:${A}`)).toBe(false);
    expect(recreated.updates).toEqual([]);
    expect(recreated.resolutions).toEqual([]);

    await harness.position({ mmsi: A, lat: 1, lon: 104, sog: 10 });
    await harness.position({ mmsi: A, lat: 1, lon: 104, sog: 0 });
    expect(await harness.metricsText()).toContain(
      'aisits_detector_alert_resolutions_total{detector="speed"} 1',
    );
  });
});

describe('activation announces resolutions a crashed instance left unannounced (K6)', () => {
  it('queues them after the reload and publishes them once their cooldown ended', async () => {
    const detector = new SpeedDetector();
    const marked: string[] = [];
    let failing = false;
    const lost = {
      alert: stored(A, { domain: 'safety', methodId: 'safety.ews' }),
      resolvedAt: new Date('2026-01-01T00:01:00.000Z'),
      reason: 'slowed down',
      eventId: '018f2b5e-0000-7000-8000-0000000000e1',
    };
    const persistence: AlertPersistence = {
      loadOpen: () => Promise.resolve([]),
      loadUnannounced: () =>
        failing
          ? Promise.reject(new Error('db down'))
          : Promise.resolve([lost]),
      onResolutionPublished: (resolution) => {
        marked.push(resolution.eventId);
        return Promise.resolve();
      },
    };
    const harness = DetectorTestHarness.create({
      detectors: [detector],
      persistence,
      now: new Date('2026-01-01T00:02:00.000Z'),
    });
    await harness.deactivate();
    const activation = await harness.activate();
    expect(activation.unannounced).toBe(1);
    // Cooldown (10 min) since the raise published at 00:00 not over yet.
    await harness.maintain();
    expect(harness.resolvedEvents).toEqual([]);
    harness.advance(9 * 60_000);
    await harness.maintain();
    expect(harness.resolvedEvents).toMatchObject([
      { id: lost.eventId, mmsi: A, reason: 'slowed down' },
    ]);
    expect(marked).toEqual([lost.eventId]);

    // A failing loadUnannounced does not fail the activation.
    failing = true;
    await harness.deactivate();
    const again = await harness.activate();
    expect(again.unannounced).toBe(0);
    expect(harness.active).toBe(true);
  });
});
