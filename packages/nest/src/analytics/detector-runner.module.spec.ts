import 'reflect-metadata';

import {
  EVENT_TYPES,
  type EventType,
} from '@darmawanweb/ais-its-contracts/events';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { APP_CONFIG, ConfigModule } from '../config/config.module.js';
import { baseConfigSchema } from '../config/define-config.js';
import type { BaseConfig } from '../config/env-schema.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { EventPublisher } from '../nats/event-publisher.js';
import { NatsModule } from '../nats/nats.module.js';
import { createTestConfig } from '../testing/test-app.js';
import {
  AlertEmitter,
  type AlertPersistence,
  type OpenAlert,
} from './alert-emitter.js';
import type { Detector } from './detector.js';
import { DetectorRegistry } from './detector-registry.js';
import { DetectorRunnerModule } from './detector-runner.module.js';
import { ALERT_PERSISTENCE, DETECTOR_ENV } from './detector-runner.options.js';

const detector = (id: string): Detector => ({
  id,
  domain: 'safety',
  methodIds: ['ews.pipeline_distance_status'],
  onPosition: () => undefined,
});

/** An `EventPublisher` stand-in recording what would be published. */
function fakePublisher() {
  const published: {
    type: EventType;
    id: string | undefined;
    dataId: unknown;
  }[] = [];
  const publisher = {
    publishEvent: (
      type: EventType,
      data: { readonly id?: unknown },
      options: { readonly id?: string } = {},
    ) => {
      published.push({ type, id: options.id, dataId: data.id });
      return Promise.resolve({});
    },
  };
  return { published, publisher };
}

/** Compiles (without initializing: no connection) an application with the runner module. */
async function compile(
  runner: ReturnType<typeof DetectorRunnerModule.forRoot>,
  env?: Readonly<Record<string, string>>,
  publisher?: unknown,
) {
  const config = createTestConfig(baseConfigSchema, {
    SERVICE_NAME: 'safety',
    NATS_URL: 'nats://127.0.0.1:1',
  });
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot(config),
      MetricsModule,
      NatsModule.forRoot(),
      runner,
    ],
  });
  if (env !== undefined)
    builder = builder.overrideProvider(DETECTOR_ENV).useValue(env);
  if (publisher !== undefined)
    builder = builder.overrideProvider(EventPublisher).useValue(publisher);
  return builder.compile();
}

/** A persistence class the application gets through `{ useClass }`. */
@Injectable()
class EventsRepository implements AlertPersistence {
  loads = 0;

  loadOpen(): Promise<readonly OpenAlert[]> {
    this.loads += 1;
    return Promise.resolve([]);
  }
}

const signal = {
  type: 'ews',
  dedupKey: 'ews:525005223',
  severity: 'warning',
  mmsi: 525005223,
  title: 'Pipeline proximity',
  message: 'Vessel near the pipeline',
  methodId: 'safety.ews',
} as const;

describe('DetectorRunnerModule options', () => {
  it('builds the options with forRootAsync from the typed configuration', async () => {
    const moduleRef = await compile(
      DetectorRunnerModule.forRootAsync({
        inject: [APP_CONFIG],
        useFactory: (config: BaseConfig) => ({
          positions: 'safety-positions',
          env: { DETECTORS: config.SERVICE_NAME === 'safety' ? 'ews' : 'none' },
        }),
      }),
    );
    const registry = moduleRef.get(DetectorRegistry);
    registry.register([detector('ews'), detector('collision')]);
    expect(registry.enabled.map((entry) => entry.descriptor.id)).toEqual([
      'ews',
    ]);
  });

  it('reads DETECTORS and <ID>_* from the DETECTOR_ENV provider, which tests can override', async () => {
    const moduleRef = await compile(
      DetectorRunnerModule.forRoot({ positions: 'safety-positions', env: {} }),
      { DETECTORS: 'collision' },
    );
    expect(moduleRef.get(DETECTOR_ENV)).toEqual({ DETECTORS: 'collision' });
    const registry = moduleRef.get(DetectorRegistry);
    registry.register([detector('ews'), detector('collision')]);
    expect(registry.enabled.map((entry) => entry.descriptor.id)).toEqual([
      'collision',
    ]);
  });
});

describe('DetectorRunnerModule persistence and resolutions', () => {
  it('provides a useClass persistence under its class and ALERT_PERSISTENCE as one instance', async () => {
    const moduleRef = await compile(
      DetectorRunnerModule.forRoot({
        positions: 'safety-positions',
        env: {},
        persistence: { useClass: EventsRepository },
      }),
    );
    const repository = moduleRef.get(EventsRepository);
    expect(moduleRef.get(ALERT_PERSISTENCE)).toBe(repository);
    await moduleRef.get(AlertEmitter).restoreFromPersistence();
    expect(repository.loads).toBe(1);
  });

  it('keeps other persistence providers under ALERT_PERSISTENCE only', async () => {
    const hook: AlertPersistence = { loadOpen: () => Promise.resolve([]) };
    const moduleRef = await compile(
      DetectorRunnerModule.forRoot({
        positions: 'safety-positions',
        env: {},
        persistence: { useValue: hook },
      }),
    );
    expect(moduleRef.get(ALERT_PERSISTENCE)).toBe(hook);
  });

  it('publishes resolutions as alert.resolved.v1 with the event id, unless publishResolutions is false', async () => {
    const enabled = fakePublisher();
    const moduleRef = await compile(
      DetectorRunnerModule.forRoot({
        positions: 'safety-positions',
        env: {},
        alertCooldownMs: 0,
      }),
      undefined,
      enabled.publisher,
    );
    const emitter = moduleRef.get(AlertEmitter);
    await emitter.raise('safety', signal);
    const alertId = emitter.get(signal.dedupKey)?.alertId;
    await emitter.resolve(signal.dedupKey, { reason: 'left' });
    expect(enabled.published.map((entry) => entry.type)).toEqual([
      EVENT_TYPES.ALERT_RAISED,
      EVENT_TYPES.ALERT_RESOLVED,
    ]);
    // Envelope id = payload id: retries are deduplicated by JetStream.
    expect(enabled.published[0]?.id).toBe(alertId);
    expect(enabled.published[1]?.id).toBe(enabled.published[1]?.dataId);
    expect(enabled.published[1]?.id).not.toBe(alertId);

    const disabled = fakePublisher();
    const quiet = await compile(
      DetectorRunnerModule.forRoot({
        positions: 'safety-positions',
        env: {},
        alertCooldownMs: 0,
        publishResolutions: false,
      }),
      undefined,
      disabled.publisher,
    );
    const quietEmitter = quiet.get(AlertEmitter);
    await quietEmitter.raise('safety', signal);
    await quietEmitter.resolve(signal.dedupKey);
    expect(disabled.published.map((entry) => entry.type)).toEqual([
      EVENT_TYPES.ALERT_RAISED,
    ]);
  });
});
