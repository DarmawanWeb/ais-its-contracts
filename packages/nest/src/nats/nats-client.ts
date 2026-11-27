import { setTimeout as sleep } from 'node:timers/promises';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import {
  jetstream,
  type JetStreamClient,
  type JetStreamManager,
  jetstreamManager,
} from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';

import { errorMessage, retryUntilDeadline } from '../common/retry.js';
import { remainingShutdownMs } from '../common/shutdown-deadline.js';
import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import {
  DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS,
  DEFAULT_MIN_MAX_PAYLOAD_BYTES,
  NATS_OPTIONS,
  type NatsModuleOptions,
} from './nats.options.js';

/** Part of the shutdown budget left to the hooks after the NATS drain, ms. */
const SHUTDOWN_RESERVE_MS = 1000;

/** Longest wait for `close()` after a failed or timed-out drain, ms. */
const CLOSE_TIMEOUT_MS = 1000;

/**
 * How long the connection drain at shutdown may take, ms: the configured
 * bound (default {@link DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS}) or, when a
 * shutdown deadline runs, what is left of it less 1 s, whichever is
 * smaller (never negative).
 */
export function connectionDrainBoundMs(
  configuredMs: number | undefined,
  remainingMs: number | undefined,
): number {
  const configured = configuredMs ?? DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS;
  if (remainingMs === undefined) return Math.max(0, configured);
  return Math.max(0, Math.min(configured, remainingMs - SHUTDOWN_RESERVE_MS));
}

/** Thrown when the connection is used before `onModuleInit` connected it. */
export class NatsNotConnectedError extends Error {
  override readonly name = 'NatsNotConnectedError';

  constructor() {
    super(
      'NATS is not connected yet: use the connection from lifecycle hooks (onModuleInit or later)',
    );
  }
}

/** A connected NATS client with its JetStream contexts. */
export interface NatsHandles {
  readonly connection: NatsConnection;
  readonly jetstream: JetStreamClient;
  readonly manager: JetStreamManager;
}

/**
 * The service's NATS connection (spec §7). Connects in `onModuleInit` (never
 * in a constructor) with bounded startup retries, then reconnects forever
 * with jittered backoff; drains in `onApplicationShutdown`, after the
 * consumers stopped and the HTTP server closed.
 */
@Injectable()
export class NatsClient implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Nats');
  private handles: NatsHandles | undefined;
  private connecting: Promise<NatsHandles> | undefined;
  private connected = false;

  constructor(
    @InjectConfig() private readonly config: BaseConfig,
    @Inject(NATS_OPTIONS) private readonly options: NatsModuleOptions,
  ) {}

  /** Connects (lifecycle hook). */
  async onModuleInit(): Promise<void> {
    await this.ready();
  }

  /**
   * Resolves once connected; starts connecting on first call. Every
   * component that needs NATS during startup awaits it, so module init
   * order does not matter.
   */
  ready(): Promise<NatsHandles> {
    this.connecting ??= this.open();
    return this.connecting;
  }

  /** The connection. @throws {NatsNotConnectedError} before `ready()` resolved. */
  get connection(): NatsConnection {
    return this.current().connection;
  }

  /** The JetStream client. @throws {NatsNotConnectedError} before `ready()` resolved. */
  get jetstream(): JetStreamClient {
    return this.current().jetstream;
  }

  /** The JetStream manager. @throws {NatsNotConnectedError} before `ready()` resolved. */
  get manager(): JetStreamManager {
    return this.current().manager;
  }

  /**
   * The largest message the connected server accepts (`max_payload` of its
   * INFO, headers included), bytes; `undefined` before `ready()` resolved.
   * `EventPublisher` refuses larger events with `EventTooLargeError`.
   */
  maxPayloadBytes(): number | undefined {
    return this.handles?.connection.info?.max_payload;
  }

  /** `true` while connected to a server (not while reconnecting or closed). */
  isConnected(): boolean {
    return (
      this.connected &&
      this.handles !== undefined &&
      !this.handles.connection.isClosed()
    );
  }

  /**
   * Drains the connection (pending publishes are flushed), for at most
   * {@link connectionDrainBoundMs}; a drain that fails or does not finish
   * in time closes the connection instead (warning). Idempotent.
   */
  async onApplicationShutdown(): Promise<void> {
    const handles = this.handles;
    if (handles === undefined || handles.connection.isClosed()) return;
    this.connected = false;
    const boundMs = connectionDrainBoundMs(
      this.options.connectionDrainTimeoutMs,
      remainingShutdownMs(),
    );
    const outcome = await Promise.race([
      handles.connection.drain().then(
        () => 'drained' as const,
        (error: unknown) => error,
      ),
      sleep(boundMs, 'timeout' as const, { ref: false }),
    ]);
    if (outcome === 'drained') return;
    this.logger.warn(
      outcome === 'timeout'
        ? `NATS drain did not finish within ${boundMs} ms (server not answering): closing the connection, unflushed publishes are lost`
        : `NATS drain failed: ${errorMessage(outcome)}`,
    );
    await Promise.race([
      handles.connection.close().catch(() => undefined),
      sleep(CLOSE_TIMEOUT_MS, undefined, { ref: false }),
    ]);
  }

  private current(): NatsHandles {
    if (this.handles === undefined) throw new NatsNotConnectedError();
    return this.handles;
  }

  private async open(): Promise<NatsHandles> {
    const servers = [...this.config.NATS_URL];
    const tls = servers.some((server) => server.startsWith('tls://'));
    const connection = await retryUntilDeadline(
      () =>
        connect({
          servers,
          name: `${this.config.SERVICE_NAME}@${process.pid}`,
          maxReconnectAttempts: -1,
          reconnectTimeWait: 2000,
          reconnectJitter: 1000,
          waitOnFirstConnect: false,
          timeout: 5000,
          ...(tls ? { tls: {} } : {}),
        }),
      {
        deadlineMs: this.options.connectTimeoutMs ?? 30_000,
        onRetry: (error, attempt, delayMs) => {
          this.logger.warn(
            `NATS not reachable (attempt ${attempt}: ${errorMessage(error)}), retrying in ${delayMs} ms`,
          );
        },
      },
    );
    this.connected = true;
    this.logger.log(`Connected to NATS ${connection.getServer()}`);
    this.checkMaxPayload(connection);
    void this.watch(connection);

    const timeout = this.options.requestTimeoutMs ?? 10_000;
    this.handles = {
      connection,
      jetstream: jetstream(connection, { timeout }),
      manager: await jetstreamManager(connection, { timeout }),
    };
    return this.handles;
  }

  /** Warns when the server's `max_payload` is below `minMaxPayloadBytes`. */
  private checkMaxPayload(connection: NatsConnection): void {
    const maxPayload = connection.info?.max_payload;
    const minimum =
      this.options.minMaxPayloadBytes ?? DEFAULT_MIN_MAX_PAYLOAD_BYTES;
    if (maxPayload === undefined || maxPayload >= minimum) return;
    this.logger.warn(
      `NATS server ${connection.getServer()} accepts messages of at most ${maxPayload} bytes (max_payload), ` +
        `less than the ${minimum} bytes this service expects: larger events are refused with EventTooLargeError ` +
        '(set max_payload: 4MB on the server, as infra/nats/nats.conf does)',
    );
  }

  /** Logs connection state changes until the connection closes. */
  private async watch(connection: NatsConnection): Promise<void> {
    for await (const status of connection.status()) {
      // Other statuses (pings, reconnecting attempts, updates) are not logged.
      if (status.type === 'disconnect') {
        this.connected = false;
        this.logger.warn(`Disconnected from NATS ${status.server}`);
      } else if (status.type === 'reconnect') {
        this.connected = true;
        this.logger.log(`Reconnected to NATS ${status.server}`);
      } else if (status.type === 'error') {
        this.logger.error(`NATS error: ${status.error.message}`);
      } else if (status.type === 'slowConsumer') {
        this.logger.warn(
          `NATS slow consumer on ${status.sub.getSubject()} (${status.pending} pending)`,
        );
      }
    }
    this.connected = false;
  }
}
