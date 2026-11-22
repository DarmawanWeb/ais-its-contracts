import { register } from 'node:module';

import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  propagation,
  trace,
} from '@opentelemetry/api';
import type { Instrumentation } from '@opentelemetry/instrumentation';
import type * as SdkTrace from '@opentelemetry/sdk-trace';

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
   * Instrumentations to enable, by the suffix of their package
   * (`@opentelemetry/instrumentation-<name>`, see
   * {@link SUPPORTED_INSTRUMENTATIONS}). `OTEL_NODE_ENABLED_INSTRUMENTATIONS`
   * (comma list) wins when set; unknown names are ignored with a warning.
   * Default: all of them. Fastify is always instrumented with `@fastify/otel`.
   */
  readonly instrumentations?: readonly InstrumentationName[] | undefined;
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

/**
 * Instrumentations the kit ships (its only OpenTelemetry instrumentation
 * dependencies, which keeps service images small): incoming and outgoing
 * HTTP, `fetch` (undici), PostgreSQL (`pg`) and Valkey (`ioredis`).
 */
export const SUPPORTED_INSTRUMENTATIONS = [
  'http',
  'undici',
  'pg',
  'ioredis',
] as const;

/** Name of an instrumentation in {@link SUPPORTED_INSTRUMENTATIONS}. */
export type InstrumentationName = (typeof SUPPORTED_INSTRUMENTATIONS)[number];

/** Instrumentations enabled by default: all {@link SUPPORTED_INSTRUMENTATIONS}. */
export const DEFAULT_INSTRUMENTATIONS: readonly InstrumentationName[] = [
  ...SUPPORTED_INSTRUMENTATIONS,
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

const isInstrumentationName = (name: string): name is InstrumentationName =>
  (SUPPORTED_INSTRUMENTATIONS as readonly string[]).includes(name);

/**
 * The instrumentations to enable: `OTEL_NODE_ENABLED_INSTRUMENTATIONS`
 * (comma list of names) when set, else `configured`.
 */
export function enabledInstrumentations(
  configured: readonly InstrumentationName[] = DEFAULT_INSTRUMENTATIONS,
  env: Readonly<Record<string, string | undefined>> = process.env,
): InstrumentationName[] {
  const variable = env.OTEL_NODE_ENABLED_INSTRUMENTATIONS;
  if (variable === undefined) return [...new Set(configured)];
  const names = variable
    .split(',')
    .map((name) => name.trim().replace(/^@opentelemetry\/instrumentation-/, ''))
    .filter((name) => name !== '');
  const unknown = names.filter((name) => !isInstrumentationName(name));
  if (unknown.length > 0) {
    diag.warn(
      `OTEL_NODE_ENABLED_INSTRUMENTATIONS: ignoring unsupported instrumentation(s) ${unknown.join(', ')} ` +
        `(supported: ${SUPPORTED_INSTRUMENTATIONS.join(', ')})`,
    );
  }
  return [...new Set(names.filter(isInstrumentationName))];
}

/** Creates one instrumentation (loaded lazily: nothing is imported while tracing is off). */
async function createInstrumentation(
  name: InstrumentationName,
  ignored: ReadonlySet<string>,
): Promise<Instrumentation> {
  switch (name) {
    case 'http': {
      const { HttpInstrumentation } =
        await import('@opentelemetry/instrumentation-http');
      return new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => {
          const path = request.url?.split('?', 1)[0];
          return path !== undefined && ignored.has(path);
        },
      });
    }
    case 'undici': {
      const { UndiciInstrumentation } =
        await import('@opentelemetry/instrumentation-undici');
      return new UndiciInstrumentation();
    }
    case 'pg': {
      const { PgInstrumentation } =
        await import('@opentelemetry/instrumentation-pg');
      return new PgInstrumentation();
    }
    case 'ioredis': {
      const { IORedisInstrumentation } =
        await import('@opentelemetry/instrumentation-ioredis');
      return new IORedisInstrumentation();
    }
  }
}

/**
 * Starts OpenTelemetry tracing for http, Fastify, pg, ioredis and fetch,
 * with W3C trace context and baggage propagation: a tracer provider with a
 * batch span processor and the OTLP/HTTP exporter (`<endpoint>/v1/traces`),
 * the AsyncLocalStorage context manager and the selected instrumentations,
 * without the full NodeSDK (no gRPC/proto exporters, metrics or logs SDK in
 * the image). A no-op when no endpoint is configured or
 * `OTEL_SDK_DISABLED=true`. Idempotent: later calls return the first
 * handle. The standard `OTEL_TRACES_SAMPLER(_ARG)`, `OTEL_PROPAGATORS`
 * (`tracecontext`, `baggage`, `none`), `OTEL_BSP_*`, span limit and
 * `OTEL_RESOURCE_ATTRIBUTES` / `OTEL_SERVICE_NAME` variables are honoured;
 * `serviceName` and `serviceVersion` win over the latter.
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

/** Environment variables read by the tracing bootstrap. */
type Env = Readonly<Record<string, string | undefined>>;

/** A trace sampler chosen by `OTEL_TRACES_SAMPLER` (+ `OTEL_TRACES_SAMPLER_ARG`). */
export interface SamplerChoice {
  readonly name:
    | 'always_on'
    | 'always_off'
    | 'traceidratio'
    | 'parentbased_always_on'
    | 'parentbased_always_off'
    | 'parentbased_traceidratio';
  /** Sampling ratio of the `traceidratio` samplers (0–1, default 1). */
  readonly ratio: number;
}

const SAMPLER_NAMES: readonly SamplerChoice['name'][] = [
  'always_on',
  'always_off',
  'traceidratio',
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
];

const isSamplerName = (name: string): name is SamplerChoice['name'] =>
  (SAMPLER_NAMES as readonly string[]).includes(name);

function numberFromEnv(env: Env, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (Number.isFinite(value)) return value;
  diag.warn(`${name}: ignoring the non-numeric value "${raw}"`);
  return undefined;
}

function nonNegativeFromEnv(env: Env, name: string): number | undefined {
  const value = numberFromEnv(env, name);
  if (value === undefined || value >= 0) return value;
  diag.warn(`${name}: ignoring the negative value ${value}`);
  return undefined;
}

/**
 * The sampler of `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` (the
 * OpenTelemetry SDK environment variables NodeSDK read).
 *
 * @returns `undefined` for the SDK default (parent based, always on), also
 *   for an unknown name (with a warning).
 */
export function samplerFromEnv(
  env: Env = process.env,
): SamplerChoice | undefined {
  const name = env.OTEL_TRACES_SAMPLER?.trim();
  if (name === undefined || name === '') return undefined;
  if (!isSamplerName(name)) {
    diag.error(
      `Unknown OTEL_TRACES_SAMPLER "${name}", using the default sampler`,
    );
    return undefined;
  }
  const ratio = numberFromEnv(env, 'OTEL_TRACES_SAMPLER_ARG');
  if (ratio !== undefined && (ratio < 0 || ratio > 1))
    diag.error(`OTEL_TRACES_SAMPLER_ARG=${ratio} is outside [0, 1], using 1`);
  return {
    name,
    ratio: ratio === undefined || ratio < 0 || ratio > 1 ? 1 : ratio,
  };
}

/**
 * The propagators of `OTEL_PROPAGATORS`: `tracecontext` and `baggage`
 * (W3C; the default is both), or none for `none`. Other names (`b3`, …) are
 * not shipped by the kit and are ignored with a warning.
 */
export function propagatorsFromEnv(
  env: Env = process.env,
): ('tracecontext' | 'baggage')[] {
  const names = (env.OTEL_PROPAGATORS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) return ['tracecontext', 'baggage'];
  if (names.includes('none')) return [];
  const selected: ('tracecontext' | 'baggage')[] = [];
  for (const name of new Set(names)) {
    if (name === 'tracecontext' || name === 'baggage') selected.push(name);
    else
      diag.warn(
        `OTEL_PROPAGATORS: propagator "${name}" is not supported (tracecontext, baggage)`,
      );
  }
  return selected;
}

/** `OTEL_BSP_*` settings of the batch span processor (unset values keep the SDK defaults). */
export function batchSpanProcessorSettingsFromEnv(env: Env = process.env): {
  readonly maxQueueSize?: number | undefined;
  readonly scheduledDelayMillis?: number | undefined;
  readonly exportTimeoutMillis?: number | undefined;
  readonly maxExportBatchSize?: number | undefined;
} {
  return {
    maxQueueSize: nonNegativeFromEnv(env, 'OTEL_BSP_MAX_QUEUE_SIZE'),
    scheduledDelayMillis: nonNegativeFromEnv(env, 'OTEL_BSP_SCHEDULE_DELAY'),
    exportTimeoutMillis: nonNegativeFromEnv(env, 'OTEL_BSP_EXPORT_TIMEOUT'),
    maxExportBatchSize: nonNegativeFromEnv(
      env,
      'OTEL_BSP_MAX_EXPORT_BATCH_SIZE',
    ),
  };
}

/** `OTEL_SPAN_*` / `OTEL_ATTRIBUTE_*` span limits (unset values keep the SDK defaults). */
export function spanLimitsFromEnv(env: Env = process.env): {
  readonly attributeCountLimit?: number | undefined;
  readonly attributeValueLengthLimit?: number | undefined;
  readonly eventCountLimit?: number | undefined;
  readonly linkCountLimit?: number | undefined;
  readonly attributePerEventCountLimit?: number | undefined;
  readonly attributePerLinkCountLimit?: number | undefined;
} {
  const first = (...names: string[]): number | undefined => {
    for (const name of names) {
      const value = nonNegativeFromEnv(env, name);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  return {
    attributeCountLimit: first(
      'OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT',
      'OTEL_ATTRIBUTE_COUNT_LIMIT',
    ),
    attributeValueLengthLimit: first(
      'OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT',
      'OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT',
    ),
    eventCountLimit: first('OTEL_SPAN_EVENT_COUNT_LIMIT'),
    linkCountLimit: first('OTEL_SPAN_LINK_COUNT_LIMIT'),
    attributePerEventCountLimit: first(
      'OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT',
      'OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT',
    ),
    attributePerLinkCountLimit: first(
      'OTEL_LINK_ATTRIBUTE_COUNT_LIMIT',
      'OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT',
    ),
  };
}

/** `T` without `undefined` values (the SDK options are exact optional properties). */
type Defined<T> = { -readonly [Key in keyof T]?: Exclude<T[Key], undefined> };

/** Drops the `undefined` entries of a settings object. */
function defined<T extends object>(settings: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}

async function start(options: TelemetryOptions): Promise<TelemetryHandle> {
  const endpoint = options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint === '') return DISABLED;

  if (process.env.OTEL_LOG_LEVEL !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }
  if (process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true')
    return DISABLED;

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
    sdkTrace,
    { AsyncLocalStorageContextManager },
    { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator },
    { registerInstrumentations },
    { OTLPTraceExporter },
    resources,
    { FastifyOtelInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/context-async-hooks'),
    import('@opentelemetry/core'),
    import('@opentelemetry/instrumentation'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@fastify/otel'),
  ]);

  const ignored = new Set(options.ignorePaths ?? DEFAULT_IGNORED_PATHS);
  const instrumentations = await Promise.all(
    enabledInstrumentations(options.instrumentations).map((name) =>
      createInstrumentation(name, ignored),
    ),
  );

  // The order of NodeSDK.start(): instrumentations, context manager,
  // propagator, then the tracer provider (spans before it go nowhere).
  registerInstrumentations({
    instrumentations: [
      ...instrumentations,
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: ({ url }) => ignored.has(url),
      }),
    ],
  });
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  const propagators = propagatorsFromEnv().map((name) =>
    name === 'tracecontext'
      ? new W3CTraceContextPropagator()
      : new W3CBaggagePropagator(),
  );
  if (propagators.length > 0)
    propagation.setGlobalPropagator(new CompositePropagator({ propagators }));

  // NodeSDK's default detectors (service instance id, process, host, os,
  // OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME); the service wins.
  const resource = resources
    .defaultResource()
    .merge(
      resources.detectResources({
        detectors: [
          resources.serviceInstanceIdDetector,
          resources.processDetector,
          resources.hostDetector,
          resources.osDetector,
          resources.serviceNameEnvDetector,
          resources.resourceAttributesEnvDetector,
        ],
      }),
    )
    .merge(
      resources.resourceFromAttributes({
        'service.name': options.serviceName,
        'service.version': options.serviceVersion,
      }),
    );

  const sampler = samplerFromEnv();
  const provider = new sdkTrace.TracerProvider({
    resource,
    spanLimits: defined(spanLimitsFromEnv()),
    spanProcessors: [
      new sdkTrace.BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: `${endpoint.replace(/\/+$/, '')}/v1/traces`,
        }),
        ...defined(batchSpanProcessorSettingsFromEnv()),
      }),
    ],
    ...(sampler === undefined
      ? {}
      : { sampler: createSampler(sdkTrace, sampler) }),
  });
  // Metrics are served by prom-client (/metrics) and logs by pino: only
  // traces are exported (OTLP/HTTP).
  trace.setGlobalTracerProvider(provider);
  await waitForLoader?.();

  let stopped: Promise<void> | undefined;
  return {
    enabled: true,
    shutdown: () => {
      stopped ??= provider.shutdown().catch((error: unknown) => {
        diag.error('OpenTelemetry tracer provider shutdown failed', error);
      });
      return stopped;
    },
  };
}

/** The SDK sampler of a {@link SamplerChoice}. */
function createSampler(
  sdkTrace: typeof SdkTrace,
  choice: SamplerChoice,
): SdkTrace.Sampler {
  const {
    AlwaysOffSampler,
    AlwaysOnSampler,
    ParentBasedSampler,
    TraceIdRatioBasedSampler,
  } = sdkTrace;
  switch (choice.name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(choice.ratio);
    case 'parentbased_always_on':
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    case 'parentbased_always_off':
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case 'parentbased_traceidratio':
      return new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(choice.ratio),
      });
  }
}
