import {
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  type TextMapGetter,
  type TextMapSetter,
  trace,
  type Tracer,
} from '@opentelemetry/api';

/** Name of the platform's tracer (instrumentation scope). */
export const PLATFORM_TRACER_NAME = '@darmawanweb/seemp-platform';

/** The W3C `traceparent` header / envelope member. */
export const TRACEPARENT_HEADER = 'traceparent';

/** The W3C `tracestate` header. */
export const TRACESTATE_HEADER = 'tracestate';

/** A minimal header carrier: NATS `MsgHdrs`, `Headers`, or a plain map. */
export interface HeaderCarrier {
  get(name: string): string | null | undefined;
  set(name: string, value: string): void;
}

const carrierGetter: TextMapGetter<HeaderCarrier> = {
  get: (carrier, key) => {
    const value = carrier.get(key);
    return value === null || value === undefined || value === '' ? undefined : value;
  },
  keys: () => [TRACEPARENT_HEADER, TRACESTATE_HEADER],
};

const carrierSetter: TextMapSetter<HeaderCarrier> = {
  set: (carrier, key, value) => {
    carrier.set(key, value);
  },
};

const recordGetter: TextMapGetter<Readonly<Record<string, string | undefined>>> = {
  get: (carrier, key) => carrier[key],
  keys: (carrier) => Object.keys(carrier),
};

/** The platform tracer (a no-op until `startTelemetry()` registered an SDK). */
export function platformTracer(): Tracer {
  return trace.getTracer(PLATFORM_TRACER_NAME);
}

/**
 * Writes the W3C trace context of `ctx` (default: the active context) into
 * `carrier`. A no-op when tracing is disabled.
 */
export function injectTraceContext(carrier: HeaderCarrier, ctx: Context = context.active()): void {
  propagation.inject(ctx, carrier, carrierSetter);
}

/** Reads the W3C trace context of `carrier` into a new context (parent: `base`). */
export function extractTraceContext(
  carrier: HeaderCarrier,
  base: Context = context.active(),
): Context {
  return propagation.extract(base, carrier, carrierGetter);
}

/** Context whose remote parent is the given `traceparent` (envelope member). */
export function contextFromTraceparent(
  traceparent: string | undefined,
  base: Context = context.active(),
): Context {
  if (traceparent === undefined) return base;
  return propagation.extract(base, { [TRACEPARENT_HEADER]: traceparent }, recordGetter);
}

/**
 * The `traceparent` of the active span, or `undefined` when tracing is
 * disabled or no span is active.
 */
export function currentTraceparent(ctx: Context = context.active()): string | undefined {
  const headers: Record<string, string> = {};
  propagation.inject(ctx, headers, {
    set: (carrier, key, value) => {
      carrier[key] = value;
    },
  });
  return headers[TRACEPARENT_HEADER];
}

/** Trace id of the active (sampled or not) span, or `undefined`. */
export function currentTraceId(ctx: Context = context.active()): string | undefined {
  const spanContext = trace.getSpanContext(ctx);
  if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) return undefined;
  return spanContext.traceId;
}

/** Options of {@link withSpan}. */
export interface WithSpanOptions {
  readonly kind?: SpanKind | undefined;
  readonly attributes?: Readonly<Record<string, string | number | boolean>> | undefined;
  /** Parent context (default: the active one). */
  readonly parent?: Context | undefined;
}

/**
 * Runs `fn` inside a new span of the platform tracer; records exceptions and
 * ends the span. With tracing disabled the span is a no-op.
 */
export async function withSpan<T>(
  name: string,
  options: WithSpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = options.parent ?? context.active();
  return platformTracer().startActiveSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      ...(options.attributes === undefined ? {} : { attributes: { ...options.attributes } }),
    },
    parent,
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

export { SpanKind };
