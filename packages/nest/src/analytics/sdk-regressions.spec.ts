import { setTimeout as sleep } from 'node:timers/promises';

import type { AlertType } from '@darmawanweb/ais-its-contracts/domain';
import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import { Controller, Get } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { createFastifyAdapter } from '../http/fastify-adapter.js';

import {
  AlertEmitter,
  type AlertPersistence,
  type AlertSignal,
} from './alert-emitter.js';
import type { Detector, DetectorCall, DetectorContext } from './detector.js';
import {
  ApiDetectorsResponse,
  DetectorDescriptionDto,
} from './detector-description.dto.js';
import { DetectorRegistrationError } from './detector-registry.js';
import { DetectorTestHarness } from './detector-test-harness.js';
import { PairSearch } from './pair-search.js';
import type { VesselPosition } from './vessel-position.js';
import {
  type VesselState,
  type VesselStateMirror,
  VesselStateStore,
} from './vessel-state-store.js';
import { CompiledGeometry } from './zone-geometry.js';

const A = 525_005_221;
const B = 525_005_222;

function emitterWithSlowPersistence(latencyMs: number) {
  const published: AlertRaisedV1[] = [];
  const persistence: AlertPersistence = {
    onRaised: () => sleep(latencyMs),
    onResolved: () => sleep(latencyMs),
  };
  const emitter = new AlertEmitter({
    persistence,
    publish: (alert) => {
      published.push(alert);
      return Promise.resolve();
    },
  });
  return { emitter, published };
}

const collision = (mmsi: number, relatedMmsi: number): AlertSignal => ({
  type: 'collision',
  dedupKey: `collision:${Math.min(mmsi, relatedMmsi)}:${Math.max(mmsi, relatedMmsi)}`,
  severity: 'critical',
  mmsi,
  relatedMmsi,
  title: 'Collision risk',
  message: 'CPA below 0.25 nm',
  methodId: 'collision.cpa_tcpa',
});

describe('AlertEmitter serializes operations per dedupKey', () => {
  it('opens one occurrence for concurrent raises of a pair (one per vessel)', async () => {
    const { emitter, published } = emitterWithSlowPersistence(20);
    const outcomes = await Promise.all([
      emitter.raise('safety', collision(A, B)),
      emitter.raise('safety', collision(B, A)),
    ]);
    expect(outcomes.sort()).toEqual(['raised', 'unchanged']);
    expect(published).toHaveLength(1);
  });

  it('applies a resolve issued while the raise is still persisting', async () => {
    const { emitter } = emitterWithSlowPersistence(20);
    const raising = emitter.raise('safety', collision(A, B));
    const resolved = await emitter.resolve(collision(A, B).dedupKey);
    expect(await raising).toBe('raised');
    expect(resolved).toBe(true);
    expect(emitter.isOpen(collision(A, B).dedupKey)).toBe(false);
  });
});

/** Raises `ews:<mmsi>:z1` for every position. */
class AlphaDetector implements Detector {
  readonly id: string = 'alpha';
  readonly domain = 'safety' as const;
  readonly methodIds = ['ews.pipeline_distance_status'];
  readonly alertTypes: readonly AlertType[] = ['ews'];

  async onPosition(context: DetectorContext, position: VesselPosition) {
    await context.alerts.raise({
      type: 'ews',
      dedupKey: `ews:${position.mmsi}:z1`,
      severity: 'warning',
      mmsi: position.mmsi,
      title: 'Near pipeline',
      message: 'within 1 750 m',
    });
  }
}

/** Resolves every open alert it can see: must not see alpha's. */
class BetaDetector implements Detector {
  readonly id = 'beta';
  readonly domain = 'safety' as const;
  readonly methodIds = ['collision.cpa_tcpa'];
  seen: string[] = [];
  resolved = 0;

  async onPosition(context: DetectorContext, position: VesselPosition) {
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      this.seen.push(open.dedupKey);
      if (await context.alerts.resolve(open.dedupKey)) this.resolved += 1;
    }
    if (context.alerts.isOpen(`ews:${position.mmsi}:z1`))
      this.seen.push('isOpen leaked');
  }
}

describe('DetectorContext.alerts is scoped to its detector', () => {
  it('never shows or resolves another detector’s occurrences', async () => {
    const beta = new BetaDetector();
    const harness = DetectorTestHarness.create({
      detectors: [new AlphaDetector(), beta],
    });
    await harness.position({ mmsi: A, lat: 1.1, lon: 104 });
    await harness.position({ mmsi: A, lat: 1.11, lon: 104 });
    expect(harness.alertsOf('ews')).toHaveLength(1);
    expect(beta.seen).toEqual([]);
    expect(beta.resolved).toBe(0);
    expect(harness.resolutions).toHaveLength(0);
  });

  it('checks declared alert types at registration and when raising', async () => {
    class WrongDomain extends AlphaDetector {
      override readonly id = 'wrong';
      override readonly alertTypes: readonly AlertType[] = ['transhipment'];
    }
    expect(() =>
      DetectorTestHarness.create({ detectors: [new WrongDomain()] }),
    ).toThrow(DetectorRegistrationError);

    class Undeclared extends AlphaDetector {
      override readonly id = 'undeclared';
      override readonly alertTypes: readonly AlertType[] = ['collision'];
    }
    const harness = DetectorTestHarness.create({
      detectors: [new Undeclared()],
    });
    await harness.position({ mmsi: A, lat: 1.1, lon: 104 });
    expect(harness.alerts).toHaveLength(0);
    expect(await harness.metricsText()).toMatch(
      /aisits_detector_errors_total\{detector="undeclared",hook="onPosition"\} 1/,
    );
  });
});

describe('detector call isolation', () => {
  it('never overlaps calls for one vessel after a timeout, and aborts the late call', async () => {
    let running = 0;
    let maxRunning = 0;
    const aborted: boolean[] = [];
    const slow: Detector = {
      id: 'slow',
      domain: 'safety',
      methodIds: ['ews.pipeline_distance_status'],
      async onPosition(_context, _position, call: DetectorCall) {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(300);
        aborted.push(call.signal.aborted);
        running -= 1;
      },
    };
    const harness = DetectorTestHarness.create({
      detectors: [slow],
      callTimeoutMs: 50,
    });
    await harness.position({ mmsi: A, lat: 1, lon: 104 });
    await harness.position({ mmsi: A, lat: 1.01, lon: 104 });
    await sleep(400);
    expect(maxRunning).toBe(1);
    expect(aborted).toEqual([true]);
    expect(await harness.metricsText()).toMatch(
      /aisits_detector_skipped_total\{detector="slow",hook="onPosition"\} 1/,
    );
  });
});

describe('PairSearch uses event time', () => {
  it('finds neighbours of a backlog far behind the wall clock', () => {
    const wallClock = new Date('2026-01-01T10:30:00Z');
    const pairs = new PairSearch<VesselState>({ clock: () => wallClock });
    const at = new Date('2026-01-01T10:25:00Z');
    const state = (mmsi: number, lon: number): VesselState => ({
      mmsi,
      time: at,
      receivedAt: wallClock,
      lat: 1,
      lon,
      sog: 5,
      cog: 90,
      hdg: 90,
      navstatus: 0,
      predictedNavstatus: 0,
      source: 'primary',
      coastDistanceM: null,
    });
    pairs.upsert(state(A, 104));
    pairs.upsert(state(B, 104.001));
    expect(pairs.neighbours(state(A, 104), { radiusM: 2_000 })).toHaveLength(1);
    expect(pairs.pairs({ radiusM: 2_000 })).toHaveLength(1);
    expect(pairs.prune()).toBe(0);
    expect(pairs.eventTime?.toISOString()).toBe(at.toISOString());
  });
});

describe('VesselStateStore warm-up seeds', () => {
  it('lets the backlog after a restart reach the detectors', async () => {
    const mirrored: VesselState = {
      mmsi: A,
      time: new Date('2026-01-01T10:30:00Z'),
      receivedAt: new Date('2026-01-01T10:30:01Z'),
      lat: 1,
      lon: 104,
      sog: 5,
      cog: 0,
      hdg: 0,
      navstatus: 0,
      predictedNavstatus: 0,
      source: 'primary',
      coastDistanceM: null,
    };
    const mirror: VesselStateMirror = {
      save: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      loadAll: () => Promise.resolve([mirrored]),
    };
    const store = new VesselStateStore({ mirror });
    expect(await store.warmUp()).toBe(1);
    const backlog = { ...mirrored, time: new Date('2026-01-01T10:10:00Z') };
    expect(store.upsert(backlog).outcome).toBe('updated');
    // once confirmed by a position, the state is a watermark again
    expect(store.upsert(backlog).outcome).toBe('stale');
  });
});

describe('DetectorTestHarness tracks without times', () => {
  it('steps the time of each position so the whole track is processed', async () => {
    const seen: number[] = [];
    const harness = DetectorTestHarness.create({
      detectors: [
        {
          id: 'track',
          domain: 'surveillance',
          methodIds: ['geo.geofence_enter'],
          onPosition: (_context, position) => {
            seen.push(position.time.getTime());
          },
        },
      ],
    });
    const outcomes = await harness.track([
      { mmsi: A, lat: 1.0, lon: 104 },
      { mmsi: A, lat: 1.01, lon: 104 },
      { mmsi: A, lat: 1.02, lon: 104 },
    ]);
    expect(outcomes).toEqual(['processed', 'processed', 'processed']);
    expect(seen).toHaveLength(3);
    expect((seen[2] ?? 0) - (seen[0] ?? 0)).toBe(20_000);
  });
});

describe('CompiledGeometry follows geodesic polygon edges', () => {
  it('agrees with itself (and PostGIS geography) near a long edge', () => {
    const geometry = new CompiledGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [100, 5],
          [110, 5],
          [110, 0],
          [100, 0],
          [100, 5],
        ],
      ],
    });
    // The great circle from (100,5) to (110,5) bows to ~5.10° at 105°E.
    const inside = { lon: 105, lat: 5.01 };
    expect(geometry.contains(inside)).toBe(true);
    expect(geometry.distance(inside, 'wgs84')).toMatchObject({
      distanceM: 0,
      inside: true,
    });
    const outside = { lon: 105, lat: 5.2 };
    expect(geometry.contains(outside)).toBe(false);
    expect(geometry.distance(outside, 'wgs84').distanceM).toBeGreaterThan(
      5_000,
    );
  });
});

describe('DetectorDescriptionDto / ApiDetectorsResponse', () => {
  it('copies a description and documents the detectors endpoint', async () => {
    const harness = DetectorTestHarness.create({
      detectors: [new AlphaDetector()],
    });
    const [description] = harness.describe();
    expect(description).toBeDefined();
    if (description === undefined) return;
    expect(new DetectorDescriptionDto(description)).toEqual(description);

    @Controller('safety')
    class DetectorsController {
      @Get('detectors')
      @ApiDetectorsResponse()
      detectors(): DetectorDescriptionDto[] {
        return harness.describe().map((d) => new DetectorDescriptionDto(d));
      }
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [DetectorsController],
    }).compile();
    const app = moduleRef.createNestApplication(createFastifyAdapter());
    await app.init();
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      expect(
        document.paths['/safety/detectors']?.get?.responses['200'],
      ).toMatchObject({
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: { $ref: '#/components/schemas/DetectorDescriptionDto' },
            },
          },
        },
      });
      const schema = document.components?.schemas?.DetectorDescriptionDto as
        { readonly required?: readonly string[] } | undefined;
      for (const key of ['id', 'domain', 'methodIds', 'enabled'])
        expect(schema?.required).toContain(key);
    } finally {
      await app.close();
    }
  });
});
