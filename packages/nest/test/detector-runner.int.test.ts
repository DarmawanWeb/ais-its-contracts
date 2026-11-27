import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AlertRaisedV1,
  AlertResolvedV1Schema,
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
  AlertEmitter,
  type AlertPersistence,
  type AlertResolution,
  type AlertUpdate,
  type Detector,
  type DetectorContext,
  type DetectorZoneChange,
  DetectorRegistry,
  DetectorRunnerModule,
  makeTestVesselSnapshot,
  makeTestZone,
  type OpenAlert,
  RegisterDetector,
  toPositionPayload,
  type VesselPosition,
  ZoneIndex,
} from '../src/analytics/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import { EventPublisher, NatsClient, NatsModule } from '../src/nats/index.js';
import { RedisModule } from '../src/redis/index.js';
import {
  buildTestApp,
  createTestConfig,
  waitFor,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';
import { startTcpLink } from './support/tcp-link.js';

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

const position = (
  lat: number,
  lon: number,
  time: Date,
  mmsi: number = MMSI,
): VesselPosition => ({
  mmsi,
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
  let raisedSeq = 0;
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
          // Resolutions are announced at once (no reopen window).
          alertCooldownMs: 0,
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
    raisedSeq = stored.seq;
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

    // alert.resolved.v1 follows the raise on its subject in ALERTS.
    const client = app.get(NatsClient);
    const stored = await waitFor(
      async () => {
        const last = await client.manager.streams
          .getMessage('ALERTS', {
            last_by_subj: subjects.alert('geofence', MMSI),
          })
          .catch(() => undefined);
        return (last?.seq ?? 0) > raisedSeq ? last : undefined;
      },
      { timeoutMs: 15_000 },
    );
    const parsed = parseEnvelope(stored.data);
    if (!parsed.success || parsed.envelope.type !== EVENT_TYPES.ALERT_RESOLVED)
      throw new Error('expected a resolution');
    expect(AlertResolvedV1Schema.parse(parsed.envelope.data)).toMatchObject({
      id: persistence.resolved[0]?.eventId,
      alertId: persistence.raised[0]?.id,
      type: 'geofence',
      domain: 'surveillance',
      severity: 'critical',
      mmsi: MMSI,
      zoneId: naval.id,
      dedupKey: `geofence:${MMSI}:${naval.id}`,
      reason: 'left',
      methodId: 'geo.geofence_enter',
    });
    expect(parsed.envelope.id).toBe(parsed.envelope.data.id);
    const info = await client.manager.streams.info('ALERTS', {
      subjects_filter: subjects.alert('geofence', MMSI),
    });
    expect(info.state.subjects).toEqual({
      [subjects.alert('geofence', MMSI)]: 2,
    });
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
    expect(metrics).toContain(
      'aisits_detector_alert_resolutions_total{detector="restricted_area"} 1',
    );
  });
});

/** The `events` table of the failover test, shared by both instances. */
class SharedAlertStore implements AlertPersistence {
  readonly open = new Map<string, OpenAlert>();
  readonly raised: AlertRaisedV1[] = [];
  readonly resolved: AlertResolution[] = [];

  onRaised(alert: AlertRaisedV1): Promise<void> {
    this.raised.push(alert);
    const now = new Date();
    this.open.set(alert.dedupKey, {
      alertId: alert.id,
      dedupKey: alert.dedupKey,
      type: alert.type,
      mmsi: alert.mmsi,
      relatedMmsi: alert.relatedMmsi,
      zoneId: alert.zoneId,
      severity: alert.severity,
      publishedSeverity: alert.severity,
      openedAt: now,
      publishedAt: now,
      lastSeenAt: now,
      firstOccurredAt: new Date(alert.occurredAt),
      lastOccurredAt: new Date(alert.occurredAt),
      domain: alert.domain,
      methodId: alert.methodId,
      detector: 'failover_probe',
    });
    return Promise.resolve();
  }

  onUpdated(update: AlertUpdate): Promise<void> {
    this.open.set(update.alert.dedupKey, update.alert);
    return Promise.resolve();
  }

  onResolved(resolution: AlertResolution): Promise<void> {
    this.resolved.push(resolution);
    if (
      this.open.get(resolution.alert.dedupKey)?.alertId ===
      resolution.alert.alertId
    )
      this.open.delete(resolution.alert.dedupKey);
    return Promise.resolve();
  }

  loadOpen(): Promise<readonly OpenAlert[]> {
    return Promise.resolve([...this.open.values()]);
  }
}

/** Alerts while a vessel is inside a restricted zone; records its calls and ticks. */
@RegisterDetector()
@Injectable()
class FailoverProbe implements Detector {
  readonly id = 'failover_probe';
  readonly domain = 'surveillance' as const;
  readonly methodIds = ['geo.geofence_enter'];
  readonly tickIntervalMs = 100;
  readonly calls: string[] = [];
  /** Time of each vessel's state when the instance was activated. */
  readonly statesAtActivation = new Map<number, number | undefined>();
  ticks = 0;

  async onPosition(
    context: DetectorContext,
    position: VesselPosition,
  ): Promise<void> {
    const inside = context.zones.zonesAt(position, { kinds: ['restricted'] });
    for (const zone of inside) {
      const outcome = await context.alerts.raise({
        type: 'geofence',
        dedupKey: `geofence:${position.mmsi}:${zone.id}`,
        severity: 'warning',
        mmsi: position.mmsi,
        title: `Entered ${zone.name}`,
        message: `Vessel ${position.mmsi} is inside ${zone.name}`,
        position,
        occurredAt: position.time,
        zoneId: zone.id,
      });
      this.calls.push(`position:${position.mmsi}:${outcome}`);
    }
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (inside.some((zone) => zone.id === open.zoneId)) continue;
      if (
        await context.alerts.resolve(open.dedupKey, {
          at: position.time,
          reason: 'left',
        })
      )
        this.calls.push(`position:${position.mmsi}:resolved`);
    }
  }

  onTick(): void {
    this.ticks += 1;
  }

  onActivated(context: DetectorContext): void {
    this.calls.push(`activated:open=${context.alerts.open().length}`);
    for (const state of context.vessels.values())
      this.statesAtActivation.set(state.mmsi, state.time.getTime());
  }

  onDeactivated(): void {
    this.calls.push('deactivated');
  }
}

describe('DetectorRunnerModule failover (two instances, one exclusive durable)', () => {
  const X = MMSI + 1;
  const Y = MMSI + 2;
  const config = () =>
    createTestConfig(baseConfigSchema, {
      SERVICE_NAME: 'surveillance',
      NATS_URL: testInfra().natsUrl,
      REDIS_URL: testInfra().redisUrl,
    });
  const store = new SharedAlertStore();
  const mirrorPrefix = `${uniqueName('vessel_state')}:`;
  const zone = makeTestZone({
    kind: 'restricted',
    name: 'Failover range',
    geometry: square(105.3, 1.3, 0.05),
  });
  const keyOf = (mmsi: number) => `geofence:${mmsi}:${zone.id}`;
  const failoverPositions: DurableConsumerDefinition = {
    durableName: uniqueName('detector_failover'),
    stream: 'AIS_POSITION',
    filterSubjects: [subjects.aisPosition(X), subjects.aisPosition(Y)],
    service: 'surveillance',
    eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
    maxDeliver: 10,
    description: 'detector runner failover test',
  };
  let producer: NestFastifyApplication;
  const apps: NestFastifyApplication[] = [];

  async function startInstance(
    options: {
      /** Default: the test NATS server (direct connection). */
      readonly natsUrl?: string;
      readonly positions?: DurableConsumerDefinition;
      readonly pinnedTtlMs?: number;
    } = {},
  ): Promise<NestFastifyApplication> {
    @Module({
      imports: [
        NatsModule.forRoot({ streams: ['ALERTS'], requestTimeoutMs: 2000 }),
        RedisModule.forRoot(),
        DetectorRunnerModule.forRoot({
          positions: options.positions ?? failoverPositions,
          ...(options.pinnedTtlMs === undefined
            ? {}
            : { exclusive: { pinnedTtlMs: options.pinnedTtlMs } }),
          fleet: false,
          vesselState: { mirror: { keyPrefix: mirrorPrefix } },
          alertCooldownMs: 0,
          persistence: { useValue: store },
          env: { DETECTORS: 'failover_probe' },
        }),
      ],
      providers: [FailoverProbe],
    })
    class InstanceModule {}
    const instance = await buildTestApp(InstanceModule, {
      config:
        options.natsUrl === undefined
          ? config()
          : createTestConfig(baseConfigSchema, {
              SERVICE_NAME: 'surveillance',
              NATS_URL: options.natsUrl,
              REDIS_URL: testInfra().redisUrl,
            }),
    });
    apps.push(instance);
    return instance;
  }

  const publish = (mmsi: number, lat: number, lon: number, time: Date) =>
    producer
      .get(EventPublisher)
      .publishEvent(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        toPositionPayload(position(lat, lon, time, mmsi)),
      );

  beforeAll(async () => {
    @Module({
      imports: [NatsModule.forRoot({ streams: ['AIS_POSITION', 'GEO'] })],
    })
    class ProducerModule {}
    producer = await buildTestApp(ProducerModule, { config: config() });
    await producer
      .get(EventPublisher)
      .publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, zone);
  });

  afterAll(async () => {
    for (const instance of apps.splice(0).reverse()) await instance.close();
    await producer.close();
  });

  it('reloads the open alerts on takeover: no second raise, no missed resolution, ticks only on the active instance', async () => {
    const t0 = Date.now();
    // A becomes the active instance with Y's alert open.
    const a = await startInstance();
    const probeA = a.get(FailoverProbe);
    await publish(Y, 1.32, 105.32, new Date(t0));
    await waitFor(() => probeA.calls.includes(`position:${Y}:raised`), {
      timeoutMs: 15_000,
    });

    // B boots as a hot standby: it restores Y as open at boot.
    const b = await startInstance();
    const probeB = b.get(FailoverProbe);
    expect(b.get(AlertEmitter).isOpen(keyOf(Y))).toBe(true);

    // A resolves Y and raises X after B booted.
    await publish(Y, 1.0, 105.0, new Date(t0 + 1_000));
    await publish(X, 1.33, 105.33, new Date(t0 + 2_000));
    await waitFor(
      () =>
        probeA.calls.includes(`position:${Y}:resolved`) &&
        probeA.calls.includes(`position:${X}:raised`),
      { timeoutMs: 15_000 },
    );
    await waitFor(() => probeA.ticks > 0);
    expect(probeB.ticks).toBe(0);
    expect(probeB.calls).toEqual([]);

    // A stops: its pin is released and B takes over with the next position.
    await a.close();
    apps.splice(apps.indexOf(a), 1);
    expect(probeA.calls.at(-1)).toBe('deactivated');
    await publish(X, 1.34, 105.34, new Date(t0 + 3_000));
    await waitFor(() => probeB.calls.includes(`position:${X}:unchanged`), {
      timeoutMs: 20_000,
    });

    // Activation ran once, before B's first position, with the store's state
    // and the vessel states A mirrored to Valkey after B booted.
    expect(probeB.calls).toEqual([
      'activated:open=1',
      `position:${X}:unchanged`,
    ]);
    expect(probeB.statesAtActivation.get(X)).toBe(t0 + 2_000);
    expect(probeB.statesAtActivation.get(Y)).toBe(t0 + 1_000);
    const emitterB = b.get(AlertEmitter);
    expect(emitterB.isOpen(keyOf(X))).toBe(true);
    expect(emitterB.isOpen(keyOf(Y))).toBe(false);
    expect(store.raised.map((alert) => alert.mmsi)).toEqual([Y, X]);
    await waitFor(() => probeB.ticks > 0);

    // ALERTS: X raised once; Y raised then resolved.
    const info = await b.get(NatsClient).manager.streams.info('ALERTS', {
      subjects_filter: `alert.v1.geofence.>`,
    });
    expect(info.state.subjects).toMatchObject({
      [subjects.alert('geofence', X)]: 1,
      [subjects.alert('geofence', Y)]: 2,
    });
    const metrics = (await b.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toContain(
      'aisits_detector_activations_total{outcome="completed"} 1',
    );
  });
  it('stops ticking and deactivates the detectors of an instance cut off from NATS before another one is pinned (K1)', async () => {
    const link = await startTcpLink(testInfra().natsUrl);
    const positions: DurableConsumerDefinition = {
      ...failoverPositions,
      durableName: uniqueName('detector_cut_off'),
    };
    const Z = MMSI + 3;
    try {
      const t0 = Date.now();
      // pinnedTtlMs 3000: the bound without server contact is 1.5 s.
      const a = await startInstance({
        natsUrl: link.url,
        positions: { ...positions, filterSubjects: [subjects.aisPosition(Z)] },
        pinnedTtlMs: 3000,
      });
      const probeA = a.get(FailoverProbe);
      await publish(Z, 1.32, 105.32, new Date(t0));
      await waitFor(() => probeA.ticks > 0, { timeoutMs: 15_000 });
      const b = await startInstance({
        positions: { ...positions, filterSubjects: [subjects.aisPosition(Z)] },
        pinnedTtlMs: 3000,
      });
      const probeB = b.get(FailoverProbe);

      const cutAt = performance.now();
      link.hold();
      await waitFor(() => probeA.calls.includes('deactivated'), {
        timeoutMs: 5000,
      });
      const deactivatedAfter = performance.now() - cutAt;
      expect(deactivatedAfter).toBeLessThan(2600);
      const ticksAtDeactivation = probeA.ticks;
      // After the pinned TTL the next position pins b, which ticks.
      await sleep(Math.max(0, cutAt + 4000 - performance.now()));
      await publish(Z, 1.33, 105.33, new Date(t0 + 1000));
      await waitFor(
        () => probeB.calls.some((call) => call.startsWith('activated')),
        { timeoutMs: 15_000 },
      );
      await waitFor(() => probeB.ticks > 0);
      // a never ticked again: never two active instances at once.
      expect(probeA.ticks).toBe(ticksAtDeactivation);
      expect(a.get(DetectorRegistry).active).toBe(false);
      link.release();
      await sleep(1000);
      expect(probeA.ticks).toBe(ticksAtDeactivation);
    } finally {
      link.release();
      for (const instance of apps.splice(0).reverse()) await instance.close();
      await link.close();
    }
  }, 60_000);
});
