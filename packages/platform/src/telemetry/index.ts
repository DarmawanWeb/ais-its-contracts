export {
  DEFAULT_IGNORED_PATHS,
  DEFAULT_INSTRUMENTATIONS,
  shutdownTelemetry,
  startTelemetry,
  type TelemetryHandle,
  type TelemetryOptions,
} from './start-telemetry.js';
export {
  contextFromTraceparent,
  currentTraceId,
  currentTraceparent,
  extractTraceContext,
  type HeaderCarrier,
  injectTraceContext,
  PLATFORM_TRACER_NAME,
  platformTracer,
  SpanKind,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  withSpan,
  type WithSpanOptions,
} from './trace-context.js';
