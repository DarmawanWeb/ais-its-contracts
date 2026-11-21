/**
 * The detector and harness examples of README.md, kept compiling and passing.
 */
import { Injectable } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  type Detector,
  type DetectorContext,
  RegisterDetector,
} from './detector.js';
import { DetectorTestHarness } from './detector-test-harness.js';
import type { VesselPosition } from './vessel-position.js';

const geofenceConfig = z.object({
  KINDS: z
    .string()
    .default('restricted,mpa,custom')
    .transform((value) => value.split(',').map((kind) => kind.trim())),
});
type GeofenceConfig = z.output<typeof geofenceConfig>;

@RegisterDetector()
@Injectable()
class GeofenceDetector implements Detector<GeofenceConfig> {
  readonly id = 'geofence';
  readonly domain = 'surveillance';
  readonly methodIds = ['geo.geofence_enter'];
  readonly alertTypes = ['geofence'] as const;
  readonly configSchema = geofenceConfig;

  async onPosition(
    context: DetectorContext<GeofenceConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const inside = context.zones
      .zonesAt(position, { useBuffer: false })
      .filter(
        (zone) => zone.alertOnEnter && context.config.KINDS.includes(zone.kind),
      );
    for (const zone of inside) {
      await context.alerts.raise({
        type: 'geofence',
        dedupKey: `geofence:${position.mmsi}:${zone.id}`,
        severity: 'warning',
        mmsi: position.mmsi,
        title: `Entered ${zone.name}`,
        message: `Vessel ${position.mmsi} entered ${zone.name} (${zone.kind})`,
        position,
        occurredAt: position.time,
        zoneId: zone.id,
        data: {
          zoneKind: zone.kind,
          orgId: context.fleet.orgOf(position.mmsi) ?? null,
        },
      });
    }
    // `open()` only lists this detector's occurrences.
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (!inside.some((zone) => zone.id === open.zoneId)) {
        await context.alerts.resolve(open.dedupKey, {
          at: position.time,
          reason: 'left the zone',
        });
      }
    }
  }
}

describe('README: GeofenceDetector', () => {
  it('alerts on entry and resolves on exit', async () => {
    const harness = DetectorTestHarness.create({
      detectors: [new GeofenceDetector()],
      env: { GEOFENCE_KINDS: 'restricted' },
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
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
    });
    await harness.position({ mmsi: 525005223, lat: 1.05, lon: 104.05 });
    expect(harness.alerts).toEqual([
      expect.objectContaining({
        type: 'geofence',
        zoneId: zone.id,
        severity: 'warning',
      }),
    ]);

    harness.advance(60_000);
    await harness.position({ mmsi: 525005223, lat: 1.2, lon: 104.2 });
    expect(harness.resolutions).toHaveLength(1);
    expect(harness.logs.filter((line) => line.startsWith('error'))).toEqual([]);
  });
});
