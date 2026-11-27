import type { StreamName } from '@darmawanweb/ais-its-contracts/events';

/** Injection token of the {@link NatsModuleOptions}. */
export const NATS_OPTIONS = 'AISITS_NATS_OPTIONS';

/**
 * Default {@link NatsModuleOptions.minMaxPayloadBytes}: 4 MiB, the
 * `max_payload: 4MB` of the platform's NATS configuration
 * (`infra/nats/nats.conf`).
 */
export const DEFAULT_MIN_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Default {@link NatsModuleOptions.connectionDrainTimeoutMs}: 5 s, the
 * longest the connection drain at shutdown waits for the server.
 */
export const DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS = 5000;

/** Options of `NatsModule.forRoot()`. */
export interface NatsModuleOptions {
  /**
   * Contracts streams this service PRODUCES to: ensured (created, or updated
   * to match the contracts definition; never deleted) on boot. Streams of
   * the service's durable consumers and the `DLQ` stream are ensured by the
   * consumers themselves.
   */
  readonly streams?: readonly StreamName[] | undefined;
  /** How long startup waits for NATS, ms. Default 30 s. */
  readonly connectTimeoutMs?: number | undefined;
  /** Timeout of JetStream API calls and publish acks, ms. Default 10 s. */
  readonly requestTimeoutMs?: number | undefined;
  /**
   * How long a graceful shutdown waits for in-flight handlers before
   * aborting them, ms. Default 25 s.
   */
  readonly drainTimeoutMs?: number | undefined;
  /**
   * Longest wait for the connection drain at shutdown (pending publishes
   * flushed, subscriptions drained), ms; then the connection is closed with
   * a warning, so a server that accepts the connection but never answers
   * (a paused container, a partition) cannot hold the shutdown until the
   * `SHUTDOWN_TIMEOUT_MS` forced exit. The wait is also bounded by what is
   * left of that budget (less 1 s for the hooks that follow). Default
   * {@link DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS} (5 s).
   */
  readonly connectionDrainTimeoutMs?: number | undefined;
  /**
   * Smallest server `max_payload` the service expects, bytes: a startup
   * warning is logged when the server allows less (events larger than the
   * server limit are refused with `EventTooLargeError`). Default
   * {@link DEFAULT_MIN_MAX_PAYLOAD_BYTES} (4 MiB).
   */
  readonly minMaxPayloadBytes?: number | undefined;
}
