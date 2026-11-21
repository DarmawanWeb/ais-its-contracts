import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';

import { errorMessage } from '../common/retry.js';
import { InjectRedis, REDIS_OPTIONS } from './redis.tokens.js';

/** Options of `RedisModule.forRoot()`. */
export interface RedisModuleOptions {
  /** Prefix of every key (ioredis `keyPrefix`), e.g. `auth:`. Default none. */
  readonly keyPrefix?: string | undefined;
  /** How long startup waits for Valkey/Redis, ms. Default 30 s. */
  readonly connectTimeoutMs?: number | undefined;
}

/** Resolves when the client is ready; rejects after `timeoutMs`. */
function waitForReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      reject(new Error(`Redis not ready after ${timeoutMs} ms (status ${redis.status})`));
    }, timeoutMs);
    redis.once('ready', onReady);
  });
}

/**
 * Connection lifecycle of the lazy ioredis client: connects in
 * `onModuleInit` (bounded wait; ioredis keeps reconnecting with backoff
 * afterwards) and quits gracefully in `onApplicationShutdown`.
 */
@Injectable()
export class RedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Redis');
  private lastError: string | undefined;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @Inject(REDIS_OPTIONS) private readonly options: RedisModuleOptions,
  ) {
    redis.on('error', (error: Error) => {
      // Logged once per distinct error: ioredis repeats it on every reconnect attempt.
      if (error.message !== this.lastError) this.logger.warn(`Redis error: ${error.message}`);
      this.lastError = error.message;
    });
    redis.on('ready', () => {
      this.lastError = undefined;
    });
  }

  /** Connects and waits until the client is ready. */
  async onModuleInit(): Promise<void> {
    if (this.redis.status === 'wait') {
      this.redis.connect().catch((error: unknown) => {
        this.logger.warn(`Redis connection failed, retrying: ${errorMessage(error)}`);
      });
    }
    await waitForReady(this.redis, this.options.connectTimeoutMs ?? 30_000);
    this.logger.log('Connected to Redis');
  }

  /** Quits (or drops a connection that never opened). */
  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    if (this.redis.status !== 'ready') {
      this.redis.disconnect();
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
