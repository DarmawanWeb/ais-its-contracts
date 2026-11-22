import { describe, expect, it } from 'vitest';

import {
  batchSpanProcessorSettingsFromEnv,
  DEFAULT_INSTRUMENTATIONS,
  enabledInstrumentations,
  propagatorsFromEnv,
  samplerFromEnv,
  shutdownTelemetry,
  spanLimitsFromEnv,
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

describe('OpenTelemetry SDK environment variables (kept without NodeSDK, CORE-13)', () => {
  it('reads OTEL_TRACES_SAMPLER and its ratio', () => {
    expect(samplerFromEnv({})).toBeUndefined();
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'always_off' })).toEqual({
      name: 'always_off',
      ratio: 1,
    });
    expect(
      samplerFromEnv({
        OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '0.25',
      }),
    ).toEqual({ name: 'parentbased_traceidratio', ratio: 0.25 });
    expect(
      samplerFromEnv({
        OTEL_TRACES_SAMPLER: 'traceidratio',
        OTEL_TRACES_SAMPLER_ARG: '7',
      }),
    ).toEqual({ name: 'traceidratio', ratio: 1 });
    expect(samplerFromEnv({ OTEL_TRACES_SAMPLER: 'jaeger_remote' })).toBe(
      undefined,
    );
  });

  it('reads OTEL_PROPAGATORS (W3C trace context and baggage by default)', () => {
    expect(propagatorsFromEnv({})).toEqual(['tracecontext', 'baggage']);
    expect(propagatorsFromEnv({ OTEL_PROPAGATORS: 'tracecontext' })).toEqual([
      'tracecontext',
    ]);
    expect(propagatorsFromEnv({ OTEL_PROPAGATORS: 'b3,baggage' })).toEqual([
      'baggage',
    ]);
    expect(propagatorsFromEnv({ OTEL_PROPAGATORS: 'none' })).toEqual([]);
  });

  it('reads the batch processor settings and span limits', () => {
    expect(
      batchSpanProcessorSettingsFromEnv({
        OTEL_BSP_SCHEDULE_DELAY: '200',
        OTEL_BSP_MAX_QUEUE_SIZE: '-1',
        OTEL_BSP_EXPORT_TIMEOUT: 'soon',
      }),
    ).toEqual({
      maxQueueSize: undefined,
      scheduledDelayMillis: 200,
      exportTimeoutMillis: undefined,
      maxExportBatchSize: undefined,
    });
    expect(
      spanLimitsFromEnv({
        OTEL_ATTRIBUTE_COUNT_LIMIT: '64',
        OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: '1024',
        OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '9',
      }),
    ).toMatchObject({
      attributeCountLimit: 64,
      attributeValueLengthLimit: 1024,
      eventCountLimit: undefined,
    });
  });
});
