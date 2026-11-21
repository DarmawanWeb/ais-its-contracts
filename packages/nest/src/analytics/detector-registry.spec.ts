import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { ConfigValidationError } from '../config/define-config.js';
import type {
  Detector,
  DetectorContext,
  DetectorZoneChange,
} from './detector.js';
import { parseDetectorConfig, parseDetectorList } from './detector-config.js';
import { DetectorRegistrationError } from './detector-registry.js';
import {
  DetectorTestHarness,
  type TestZoneInput,
} from './detector-test-harness.js';
import type { VesselPosition } from './vessel-position.js';

const geofenceConfig = z.object({
  RADIUS_M: z.coerce.number().positive().default(500),
});
type GeofenceConfig = z.output<typeof geofenceConfig>;

/** Toy detector: alerts when a vessel comes within RADIUS_M of a restricted zone. */
class GeofenceDetector implements Detector<GeofenceConfig> {
  readonly id = 'geofence';
  readonly domain = 'surveillance' as const;
  readonly methodIds = ['geo.geofence_enter'];
  readonly configSchema = geofenceConfig;
  readonly zoneChanges: DetectorZoneChange[] = [];

  async onPosition(
    context: DetectorContext<GeofenceConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const near = context.zones.near(position, context.config.RADIUS_M, {
      kinds: ['restricted'],
    });
    for (const { zone, distanceM } of near) {
      await context.alerts.raise({
        type: 'geofence',
        dedupKey: `geofence:${position.mmsi}:${zone.id}`,
        severity: 'warning',
        mmsi: position.mmsi,
        title: `Near ${zone.name}`,
        message: `${Math.round(distanceM)} m from ${zone.name}`,
        position,
        zoneId: zone.id,
        data: { distanceM },
      });
    }
    for (const alert of context.alerts.open({ mmsi: position.mmsi })) {
      if (
        alert.zoneId !== null &&
        !near.some((entry) => entry.zone.id === alert.zoneId)
      ) {
        await context.alerts.resolve(alert.dedupKey, { reason: 'left' });
      }
    }
  }

  onZoneChanged(
    _context: DetectorContext<GeofenceConfig>,
    change: DetectorZoneChange,
  ): void {
    this.zoneChanges.push(change);
  }
}

/** Toy detector that always fails. */
class BrokenDetector implements Detector {
  readonly id = 'broken';
  readonly domain = 'safety' as const;
  readonly methodIds = ['safety.broken'];
  calls = 0;

  onPosition(): void {
    this.calls += 1;
    throw new Error('boom');
  }
}

/** Toy detector that never settles. */
class HangingDetector implements Detector {
  readonly id = 'hanging';
  readonly domain = 'safety' as const;
  readonly methodIds = ['safety.hanging'];
  readonly tickIntervalMs = 1_000;
  ticks = 0;

  onPosition(): Promise<void> {
    return new Promise(() => undefined);
  }

  onTick(): void {
    this.ticks += 1;
  }
}

const restricted: TestZoneInput = {
  kind: 'restricted',
  name: 'Naval area',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [104, 1],
        [104.1, 1],
        [104.1, 1.1],
        [104, 1.1],
        [104, 1],
      ],
    ],
  },
};

describe('detector configuration', () => {
  it('parses DETECTORS lists', () => {
    expect(parseDetectorList(undefined)).toBeUndefined();
    expect(parseDetectorList(' , ')).toBeUndefined();
    expect(parseDetectorList('EWS, collision,ews')).toEqual([
      'ews',
      'collision',
    ]);
  });

  it('validates the <ID>_* namespace and names full variables in issues', () => {
    expect(
      parseDetectorConfig('geofence', geofenceConfig, {
        GEOFENCE_RADIUS_M: '750',
        OTHER: 'x',
      }),
    ).toEqual({
      success: true,
      config: { RADIUS_M: 750 },
    });
    expect(parseDetectorConfig('geofence', geofenceConfig, {})).toEqual({
      success: true,
      config: { RADIUS_M: 500 },
    });
    const invalid = parseDetectorConfig('geofence', geofenceConfig, {
      GEOFENCE_RADIUS_M: '-1',
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success)
      expect(invalid.issues[0]?.variable).toBe('GEOFENCE_RADIUS_M');
  });
});

describe('DetectorRegistry', () => {
  it('enables the DETECTORS subset and describes every detector', () => {
    const harness = DetectorTestHarness.create({
      detectors: [new GeofenceDetector(), new BrokenDetector()],
      env: { DETECTORS: 'geofence', GEOFENCE_RADIUS_M: '800' },
    });
    expect(
      harness.registry.enabled.map((entry) => entry.descriptor.id),
    ).toEqual(['geofence']);
    expect(harness.describe()).toEqual([
      {
        id: 'geofence',
        domain: 'surveillance',
        methodIds: ['geo.geofence_enter'],
        alertTypes: null,
        enabled: true,
        config: { RADIUS_M: 800 },
        tickIntervalMs: null,
      },
      {
        id: 'broken',
        domain: 'safety',
        methodIds: ['safety.broken'],
        alertTypes: null,
        enabled: false,
        config: null,
        tickIntervalMs: null,
      },
    ]);
  });

  it('refuses unknown DETECTORS entries, duplicates, bad ids and invalid configuration', () => {
    expect(() =>
      DetectorTestHarness.create({
        detectors: [new GeofenceDetector()],
        env: { DETECTORS: 'ews' },
      }),
    ).toThrow(DetectorRegistrationError);
    expect(() =>
      DetectorTestHarness.create({
        detectors: [new BrokenDetector(), new BrokenDetector()],
      }),
    ).toThrow(/registered twice/);
    const badId: Detector = {
      id: 'Bad-Id',
      domain: 'safety',
      methodIds: ['safety.bad'],
      onPosition: () => undefined,
    };
    expect(() => DetectorTestHarness.create({ detectors: [badId] })).toThrow(
      /must match/,
    );
    const noMethods: Detector = {
      id: 'nomethod',
      domain: 'safety',
      methodIds: [],
      onPosition: () => undefined,
    };
    expect(() =>
      DetectorTestHarness.create({ detectors: [noMethods] }),
    ).toThrow(/method id/);
    expect(() =>
      DetectorTestHarness.create({
        detectors: [new GeofenceDetector()],
        env: { GEOFENCE_RADIUS_M: 'far' },
      }),
    ).toThrow(ConfigValidationError);
  });
});

describe('DetectorTestHarness', () => {
  it('feeds zones and positions and records alerts and resolutions', async () => {
    const geofence = new GeofenceDetector();
    const harness = DetectorTestHarness.create({ detectors: [geofence] });
    const zone = await harness.zone(restricted);
    expect(geofence.zoneChanges).toEqual([
      expect.objectContaining({ kind: 'upserted', initial: false }),
    ]);

    expect(
      await harness.position({ mmsi: 525005223, lat: 1.05, lon: 103.997 }),
    ).toBe('processed');
    expect(harness.alerts).toEqual([
      expect.objectContaining({
        type: 'geofence',
        domain: 'surveillance',
        mmsi: 525005223,
        zoneId: zone.id,
        methodId: 'geo.geofence_enter',
      }),
    ]);
    harness.advance(60_000);
    await harness.position({ mmsi: 525005223, lat: 1.05, lon: 103.99 }); // still near: no repeat
    expect(harness.alerts).toHaveLength(1);
    harness.advance(60_000);
    await harness.position({ mmsi: 525005223, lat: 1.05, lon: 103.9 }); // 11 km away: resolved
    expect(harness.resolutions.map((resolution) => resolution.reason)).toEqual([
      'left',
    ]);
    expect(harness.services.vessels.get(525005223)?.lon).toBe(103.9);
    expect(harness.services.pairs.get(525005223)?.lon).toBe(103.9);
  });

  it('drops stale positions before detectors and links previous positions', async () => {
    const seen: VesselPosition[] = [];
    const recorder: Detector = {
      id: 'recorder',
      domain: 'safety',
      methodIds: ['safety.recorder'],
      onPosition: (_context, position) => {
        seen.push(position);
      },
    };
    const harness = DetectorTestHarness.create({ detectors: [recorder] });
    const t0 = harness.now;
    await harness.track([
      { mmsi: 111111111, lat: 1, lon: 104, time: t0 },
      {
        mmsi: 111111111,
        lat: 1.001,
        lon: 104,
        time: new Date(t0.getTime() + 10_000),
      },
    ]);
    expect(
      await harness.position({ mmsi: 111111111, lat: 1, lon: 104, time: t0 }),
    ).toBe('stale');
    expect(seen).toHaveLength(2);
    expect(seen[1]?.previous).toMatchObject({ lat: 1, lon: 104, time: t0 });
    expect(harness.now).toEqual(new Date(t0.getTime() + 10_000));
  });

  it('isolates failing and hanging detectors and counts them', async () => {
    const geofence = new GeofenceDetector();
    const broken = new BrokenDetector();
    const hanging = new HangingDetector();
    const harness = DetectorTestHarness.create({
      detectors: [broken, hanging, geofence],
      callTimeoutMs: 50,
    });
    await harness.zone(restricted);
    await harness.position({ mmsi: 525005223, lat: 1.05, lon: 103.997 });
    expect(broken.calls).toBe(1);
    expect(harness.alerts).toHaveLength(1); // geofence still ran
    expect(harness.logs.filter((line) => line.startsWith('error'))).toEqual([
      'error broken: onPosition failed: boom',
      'error hanging: onPosition failed: onPosition did not settle within 50 ms',
    ]);
    await harness.tick();
    expect(hanging.ticks).toBe(1);
    const metrics = await harness.metrics.render();
    expect(metrics).toContain(
      'aisits_detector_errors_total{detector="broken",hook="onPosition"} 1',
    );
    expect(metrics).toContain(
      'aisits_detector_errors_total{detector="hanging",hook="onPosition"} 1',
    );
    expect(metrics).toContain(
      'aisits_detector_evaluations_total{detector="geofence"} 1',
    );
    expect(metrics).toContain(
      'aisits_detector_evaluations_total{detector="hanging"} 2',
    );
    expect(metrics).toContain(
      'aisits_detector_alerts_total{detector="geofence",severity="warning"} 1',
    );
    expect(metrics).toContain(
      'aisits_detector_positions_total{outcome="processed"} 1',
    );
    expect(metrics).toMatch(
      /aisits_detector_duration_seconds_count\{detector="geofence"\} 1/,
    );
  });

  it('applies vessel snapshots and deletions to the fleet directory', async () => {
    const harness = DetectorTestHarness.create({
      detectors: [new GeofenceDetector()],
    });
    const vessel = await harness.vessel({
      mmsi: 525005223,
      orgId: '018f2b5e-0000-7000-8000-000000000001',
    });
    expect(harness.services.fleet.orgOf(525005223)).toBe(
      '018f2b5e-0000-7000-8000-000000000001',
    );
    await harness.removeVessel(vessel);
    expect(harness.services.fleet.orgOf(525005223)).toBeUndefined();
  });
});
