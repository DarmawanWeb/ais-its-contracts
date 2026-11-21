import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INSTRUMENTATIONS,
  enabledInstrumentations,
  shutdownTelemetry,
  startTelemetry,
  SUPPORTED_INSTRUMENTATIONS,
} from './start-telemetry.js';

describe('startTelemetry', () => {
  it('is a no-op without an OTLP endpoint (and stays one: started once per process)', async () => {
    const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      const handle = await startTelemetry({
        serviceName: 'fleet',
        serviceVersion: '0.1.0',
      });
      expect(handle.enabled).toBe(false);
      await expect(handle.shutdown()).resolves.toBeUndefined();
      const again = await startTelemetry({
        serviceName: 'fleet',
        serviceVersion: '0.1.0',
        endpoint: 'http://127.0.0.1:4318',
      });
      expect(again).toBe(handle);
      await expect(shutdownTelemetry()).resolves.toBeUndefined();
    } finally {
      if (previous !== undefined)
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous;
    }
  });
});

describe('enabledInstrumentations', () => {
  it('enables every supported instrumentation by default', () => {
    expect(DEFAULT_INSTRUMENTATIONS).toEqual([...SUPPORTED_INSTRUMENTATIONS]);
    expect(enabledInstrumentations(undefined, {})).toEqual([
      'http',
      'undici',
      'pg',
      'ioredis',
    ]);
  });

  it('keeps the configured selection without duplicates', () => {
    expect(enabledInstrumentations(['pg', 'http', 'pg'], {})).toEqual([
      'pg',
      'http',
    ]);
  });

  it('lets OTEL_NODE_ENABLED_INSTRUMENTATIONS win and ignores unsupported names', () => {
    expect(
      enabledInstrumentations(['http'], {
        OTEL_NODE_ENABLED_INSTRUMENTATIONS:
          'pg, @opentelemetry/instrumentation-ioredis,express,,',
      }),
    ).toEqual(['pg', 'ioredis']);
    expect(
      enabledInstrumentations(['http'], {
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: '',
      }),
    ).toEqual([]);
  });
});
