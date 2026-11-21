import { register } from 'node:module';

import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

/** Options of {@link startTelemetry}. */
export interface TelemetryOptions {
  /** `service.name` resource attribute (use `SERVICE_NAME`). */
  readonly serviceName: string;
  /** `service.version` resource attribute. */
  readonly serviceVersion: string;
  /**
   * OTLP/HTTP base endpoint, e.g. `http://localhost:4318`. Defaults to
   * `OTEL_EXPORTER_OTLP_ENDPOINT`; tracing is a no-op when neither is set.
   */
  readonly endpoint?: string | undefined;
  /**
   * Registers the ESM loader hook (import-in-the-middle) so that modules
   * imported with `import` (pg, ioredis) are instrumented too. Default `true`.
   */
  readonly esmLoaderHook?: boolean | undefined;
  /**
   * Instrumentations of `@opentelemetry/auto-instrumentations-node` to enable
   * (package suffixes). `OTEL_NODE_ENABLED_INSTRUMENTATIONS` wins when set.
   * Default `['http', 'pg', 'ioredis', 'undici']`; Fastify is always
   * instrumented with `@fastify/otel`.
   */
  readonly instrumentations?: readonly string[] | undefined;
  /** Paths whose requests are not traced. Default `/health/*` and `/metrics`. */
  readonly ignorePaths?: readonly string[] | undefined;
}

/** A started (or disabled) telemetry pipeline. */
export interface TelemetryHandle {
  /** `false` when no OTLP endpoint is configured (every call is a no-op). */
  readonly enabled: boolean;
  /** Flushes pending spans and stops the SDK. Idempotent. */
  shutdown(): Promise<void>;
}

/** Instrumentations enabled by default (spec §10: HTTP, Fastify, pg, ioredis). */
export const DEFAULT_INSTRUMENTATIONS: readonly string[] = [
  'http',
  'pg',
  'ioredis',
  'undici',
];

/** Requests that are not traced by default. */
export const DEFAULT_IGNORED_PATHS: readonly string[] = [
  '/health/live',
  '/health/ready',
  '/metrics',
];

const DISABLED: TelemetryHandle = {
  enabled: false,
  shutdown: () => Promise.resolve(),
};

let active: Promise<TelemetryHandle> | undefined;

/**
 * Runs `create` with `OTEL_NODE_ENABLED_INSTRUMENTATIONS` set to `names`
 * unless the operator already set it, so the standard variable keeps
 * overriding the platform's default selection.
 */
function withEnabledInstrumentations<T>(
  names: readonly string[],
  create: () => T,
): T {
  const variable = 'OTEL_NODE_ENABLED_INSTRUMENTATIONS';
  if (process.env[variable] !== undefined) return create();
  process.env[variable] = names.join(',');
  try {
    return create();
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- restoring the environment
    delete process.env[variable];
  }
}

/**
 * Starts OpenTelemetry tracing (NodeSDK, OTLP/HTTP exporter) for http,
 * Fastify, pg, ioredis and fetch, with W3C trace context propagation. A
 * no-op when no endpoint is configured. Idempotent: later calls return the
 * first handle.
 *
 * Instrumentation patches modules when they are loaded, so this MUST run
 * before the application modules are imported: call it at the top of
 * `main.ts` and load the application with a dynamic `import()` (or start
 * the process with `node --import ./dist/instrumentation.js`).
 *
 * @example
 * // src/main.ts
 * import { startTelemetry } from '@darmawanweb/ais-its-nest/telemetry';
 * await startTelemetry({ serviceName: 'fleet', serviceVersion: '0.1.0' });
 * await import('./bootstrap.js');
 */
export function startTelemetry(
  options: TelemetryOptions,
): Promise<TelemetryHandle> {
  active ??= start(options);
  return active;
}

/**
 * Flushes and stops the telemetry started by {@link startTelemetry}; called
 * by the platform when the application shuts down. Safe without telemetry.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (active === undefined) return;
  const handle = await active;
  await handle.shutdown();
}

async function start(options: TelemetryOptions): Promise<TelemetryHandle> {
  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint === '') return DISABLED;

  if (process.env.OTEL_LOG_LEVEL !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  let waitForLoader: (() => Promise<void>) | undefined;
  if (options.esmLoaderHook ?? true) {
    const syncHooks = await import('import-in-the-middle/register-hooks.mjs');
    if (syncHooks.supportsSyncHooks()) {
      // In-thread hooks (module.registerHooks): Hook() registrations are seen directly.
      syncHooks.register();
    } else {
      // Older Node.js: loader thread; each Hook() is sent over this channel.
      const { createAddHookMessageChannel } =
        await import('import-in-the-middle');
      const { registerOptions, waitForAllMessagesAcknowledged } =
        createAddHookMessageChannel();
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- fallback for Node.js without module.registerHooks
      register(
        'import-in-the-middle/hook.mjs',
        import.meta.url,
        registerOptions,
      );
      waitForLoader = waitForAllMessagesAcknowledged;
    }
  }

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { getNodeAutoInstrumentations },
    { resourceFromAttributes },
    { FastifyOtelInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/resources'),
    import('@fastify/otel'),
  ]);

  const ignored = new Set(options.ignorePaths ?? DEFAULT_IGNORED_PATHS);
  const instrumentations = withEnabledInstrumentations(
    options.instrumentations ?? DEFAULT_INSTRUMENTATIONS,
    () =>
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) => {
            const path = request.url?.split('?', 1)[0];
            return path !== undefined && ignored.has(path);
          },
        },
      }),
  );

  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    resource: resourceFromAttributes({
      'service.name': options.serviceName,
      'service.version': options.serviceVersion,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/+$/, '')}/v1/traces`,
    }),
    instrumentations: [
      ...instrumentations,
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: ({ url }) => ignored.has(url),
      }),
    ],
    // Metrics are served by prom-client (/metrics) and logs by pino.
    logRecordProcessors: [],
  });
  sdk.start();
  await waitForLoader?.();

  let stopped: Promise<void> | undefined;
  return {
    enabled: true,
    shutdown: () => {
      stopped ??= sdk.shutdown().catch((error: unknown) => {
        diag.error('OpenTelemetry SDK shutdown failed', error);
      });
      return stopped;
    },
  };
}
