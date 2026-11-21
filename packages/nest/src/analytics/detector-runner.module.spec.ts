import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { APP_CONFIG, ConfigModule } from '../config/config.module.js';
import { baseConfigSchema } from '../config/define-config.js';
import type { BaseConfig } from '../config/env-schema.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { NatsModule } from '../nats/nats.module.js';
import { createTestConfig } from '../testing/test-app.js';
import type { Detector } from './detector.js';
import { DetectorRegistry } from './detector-registry.js';
import { DetectorRunnerModule } from './detector-runner.module.js';
import { DETECTOR_ENV } from './detector-runner.options.js';

const detector = (id: string): Detector => ({
  id,
  domain: 'safety',
  methodIds: ['ews.pipeline_distance_status'],
  onPosition: () => undefined,
});

/** Compiles (without initializing: no connection) an application with the runner module. */
async function compile(
  runner: ReturnType<typeof DetectorRunnerModule.forRoot>,
  env?: Readonly<Record<string, string>>,
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
  return builder.compile();
}

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
