import type { StreamName } from '@darmawanweb/ais-its-contracts/events';

/** Injection token of the {@link NatsModuleOptions}. */
export const NATS_OPTIONS = 'AISITS_NATS_OPTIONS';

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
}
