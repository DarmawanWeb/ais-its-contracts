import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { jetstream, type JetStreamClient, type JetStreamManager, jetstreamManager } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';

import { errorMessage, retryUntilDeadline } from '../common/retry.js';
import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { NATS_OPTIONS, type NatsModuleOptions } from './nats.options.js';

/** Thrown when the connection is used before `onModuleInit` connected it. */
export class NatsNotConnectedError extends Error {
  override readonly name = 'NatsNotConnectedError';

  constructor() {
    super('NATS is not connected yet: use the connection from lifecycle hooks (onModuleInit or later)');
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

  /** `true` while connected to a server (not while reconnecting or closed). */
  isConnected(): boolean {
    return this.connected && this.handles !== undefined && !this.handles.connection.isClosed();
  }

  /** Drains the connection (pending publishes are flushed). Idempotent. */
  async onApplicationShutdown(): Promise<void> {
    const handles = this.handles;
    if (handles === undefined || handles.connection.isClosed()) return;
    this.connected = false;
    try {
      await handles.connection.drain();
    } catch (error) {
      this.logger.warn(`NATS drain failed: ${errorMessage(error)}`);
      await handles.connection.close().catch(() => undefined);
    }
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
          this.logger.warn(`NATS not reachable (attempt ${attempt}: ${errorMessage(error)}), retrying in ${delayMs} ms`);
        },
      },
    );
    this.connected = true;
    this.logger.log(`Connected to NATS ${connection.getServer()}`);
    void this.watch(connection);

    const timeout = this.options.requestTimeoutMs ?? 10_000;
    this.handles = {
      connection,
      jetstream: jetstream(connection, { timeout }),
      manager: await jetstreamManager(connection, { timeout }),
    };
    return this.handles;
  }

  /** Logs connection state changes until the connection closes. */
  private async watch(connection: NatsConnection): Promise<void> {
    for await (const status of connection.status()) {
      switch (status.type) {
        case 'disconnect':
          this.connected = false;
          this.logger.warn(`Disconnected from NATS ${status.server}`);
          break;
        case 'reconnect':
          this.connected = true;
          this.logger.log(`Reconnected to NATS ${status.server}`);
          break;
        case 'error':
          this.logger.error(`NATS error: ${status.error.message}`);
          break;
        case 'slowConsumer':
          this.logger.warn(`NATS slow consumer on ${status.sub.getSubject()} (${status.pending} pending)`);
          break;
        default:
          break;
      }
    }
    this.connected = false;
  }
}
