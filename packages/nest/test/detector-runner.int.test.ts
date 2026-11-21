import {
  type AlertRaisedV1,
  type DurableConsumerDefinition,
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { Injectable, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  type AlertPersistence,
  type AlertResolution,
  type Detector,
  type DetectorContext,
  type DetectorZoneChange,
  DetectorRegistry,
  DetectorRunnerModule,
  makeTestVesselSnapshot,
  makeTestZone,
  RegisterDetector,
  toPositionPayload,
  type VesselPosition,
  ZoneIndex,
} from '../src/analytics/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import { EventPublisher, NatsClient, NatsModule } from '../src/nats/index.js';
import {
  buildTestApp,
  createTestConfig,
  waitFor,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

const MMSI = 400_000_000 + Math.floor(Math.random() * 500_000_000);
const ORG = '018f2b5e-0000-7000-8000-0000000000aa';

const toyConfig = z.object({
  SEVERITY: z.enum(['info', 'warning', 'critical']).default('warning'),
});
type ToyConfig = z.output<typeof toyConfig>;

/** Toy detector: alerts while a vessel is inside a restricted zone. */
@RegisterDetector()
@Injectable()
class RestrictedAreaDetector implements Detector<ToyConfig> {
  readonly id = 'restricted_area';
  readonly domain = 'surveillance' as const;
  readonly methodIds = ['geo.geofence_enter'];
  readonly configSchema = toyConfig;
  readonly zoneChanges: DetectorZoneChange[] = [];

  async onPosition(
    context: DetectorContext<ToyConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const inside = context.zones.zonesAt(position, { kinds: ['restricted'] });
    for (const zone of inside) {
      await context.alerts.raise({
        type: 'geofence',
        dedupKey: `geofence:${position.mmsi}:${zone.id}`,
        severity: context.config.SEVERITY,
        mmsi: position.mmsi,
        title: `Entered ${zone.name}`,
        message: `Vessel ${position.mmsi} is inside ${zone.name}`,
        position,
        occurredAt: position.time,
        zoneId: zone.id,
        data: {
          orgId: context.fleet.orgOf(position.mmsi) ?? null,
          sog: position.sog,
        },
      });
    }
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (!inside.some((zone) => zone.id === open.zoneId))
        await context.alerts.resolve(open.dedupKey, { reason: 'left' });
    }
  }

  onZoneChanged(
    _context: DetectorContext<ToyConfig>,
    change: DetectorZoneChange,
  ): void {
    this.zoneChanges.push(change);
  }
}

class RecordingPersistence implements AlertPersistence {
  readonly raised: AlertRaisedV1[] = [];
  readonly resolved: AlertResolution[] = [];

  onRaised(alert: AlertRaisedV1): Promise<void> {
    this.raised.push(alert);
    return Promise.resolve();
  }

  onResolved(resolution: AlertResolution): Promise<void> {
    this.resolved.push(resolution);
    return Promise.resolve();
  }
}

const positions: DurableConsumerDefinition = {
  durableName: uniqueName('detector_positions'),
  stream: 'AIS_POSITION',
  filterSubjects: [subjects.aisPosition(MMSI)],
  service: 'surveillance',
  eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
  maxDeliver: 10,
  description: 'detector runner integration test',
};

const square = (lon: number, lat: number, size: number) => ({
  type: 'Polygon' as const,
  coordinates: [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ] as [number, number][],
  ],
});

const position = (lat: number, lon: number, time: Date): VesselPosition => ({
  mmsi: MMSI,
  time,
  source: 'primary',
  lat,
  lon,
  sog: 3.5,
  cog: 80,
  hdg: 81,
  navstatus: 0,
  predictedNavstatus: 0,
  coastDistanceM: null,
  previous: null,
});

describe('DetectorRunnerModule (end to end over NATS)', () => {
  const config = () =>
    createTestConfig(baseConfigSchema, {
      SERVICE_NAME: 'surveillance',
      NATS_URL: testInfra().natsUrl,
    });
  let producer: NestFastifyApplication;
  let app: NestFastifyApplication;
  const persistence = new RecordingPersistence();
  const naval = makeTestZone({
    kind: 'restricted',
    name: 'Naval base',
    geometry: square(104.3, 1.3, 0.05),
  });

  beforeAll(async () => {
    @Module({
      imports: [
        NatsModule.forRoot({ streams: ['AIS_POSITION', 'GEO', 'FLEET'] }),
      ],
    })
    class ProducerModule {}
    producer = await buildTestApp(ProducerModule, { config: config() });
    const publisher = producer.get(EventPublisher);
    // Published before the service starts: loaded from the compacted streams.
    await publisher.publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, naval);
    await publisher.publishEvent(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      makeTestVesselSnapshot({ mmsi: MMSI, orgId: ORG }),
    );

    @Module({
      imports: [
        NatsModule.forRoot({ streams: ['ALERTS'] }),
        DetectorRunnerModule.forRoot({
          positions,
          concurrency: 2,
          persistence: { useValue: persistence },
          env: {
            DETECTORS: 'restricted_area',
            RESTRICTED_AREA_SEVERITY: 'critical',
          },
        }),
      ],
      providers: [RestrictedAreaDetector],
    })
    class SurveillanceModule {}
    app = await buildTestApp(SurveillanceModule, { config: config() });
  });

  afterAll(async () => {
    await app.close();
    await producer.close();
  });

  it('registers the detectors and loads the GEO and FLEET snapshots before consuming', () => {
    expect(app.get(DetectorRegistry).describe()).toEqual([
      expect.objectContaining({
        id: 'restricted_area',
        enabled: true,
        config: { SEVERITY: 'critical' },
      }),
    ]);
    expect(app.get(ZoneIndex).get(naval.id)?.name).toBe('Naval base');
    const detector = app.get(RestrictedAreaDetector);
    expect(detector.zoneChanges).toContainEqual(
      expect.objectContaining({ kind: 'upserted', initial: true }),
    );
  });

  it('raises an alert from a published position, persisted then published to ALERTS', async () => {
    const publisher = producer.get(EventPublisher);
    const entered = new Date();
    await publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionPayload(position(1.32, 104.32, entered)),
    );

    const client = app.get(NatsClient);
    const stored = await waitFor(
      () =>
        client.manager.streams
          .getMessage('ALERTS', {
            last_by_subj: subjects.alert('geofence', MMSI),
          })
          .catch(() => undefined),
      { timeoutMs: 15_000 },
    );
    const parsed = parseEnvelope(stored.data);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.envelope.type !== EVENT_TYPES.ALERT_RAISED)
      throw new Error('expected an alert');
    expect(parsed.envelope.source).toBe('surveillance');
    expect(parsed.envelope.data).toMatchObject({
      type: 'geofence',
      domain: 'surveillance',
      severity: 'critical',
      mmsi: MMSI,
      zoneId: naval.id,
      methodId: 'geo.geofence_enter',
      dedupKey: `geofence:${MMSI}:${naval.id}`,
      occurredAt: entered.toISOString(),
      data: { orgId: ORG, sog: 3.5 },
    });
    expect(parsed.envelope.id).toBe(parsed.envelope.data.id);
    expect(persistence.raised.map((alert) => alert.id)).toEqual([
      parsed.envelope.data.id,
    ]);
  });

  it('does not repeat an unchanged occurrence and resolves it when the vessel leaves', async () => {
    const publisher = producer.get(EventPublisher);
    const now = Date.now();
    await publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionPayload(position(1.33, 104.33, new Date(now + 1_000))),
    );
    await publisher.publishEvent(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      toPositionPayload(position(1.0, 104.0, new Date(now + 2_000))),
    );
    await waitFor(() => persistence.resolved.length === 1, {
      timeoutMs: 15_000,
    });
    expect(persistence.resolved[0]?.reason).toBe('left');
    expect(persistence.raised).toHaveLength(1);
  });

  it('applies live zone changes to the index and the detectors', async () => {
    const harbour = makeTestZone({
      kind: 'restricted',
      name: 'Harbour',
      geometry: square(104.5, 1.5, 0.02),
    });
    await producer
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, harbour);
    await waitFor(() => app.get(ZoneIndex).has(harbour.id));
    const detector = app.get(RestrictedAreaDetector);
    const live = detector.zoneChanges.find(
      (change) => change.zone.id === harbour.id,
    );
    expect(live).toMatchObject({ kind: 'upserted', initial: false });
    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toContain(
      'aisits_detector_evaluations_total{detector="restricted_area"} 3',
    );
    expect(metrics).toContain(
      'aisits_detector_alerts_total{detector="restricted_area",severity="critical"} 1',
    );
  });
});
