import { type DynamicModule, Module } from '@nestjs/common';
import { Redis } from 'ioredis';

import { APP_CONFIG } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { RedisLifecycle, type RedisModuleOptions } from './redis-lifecycle.js';
import { RedisHealthIndicator } from './redis.health.js';
import { REDIS_CLIENT, REDIS_OPTIONS } from './redis.tokens.js';

/** Reconnect delay of ioredis by attempt: 200 ms steps, capped at 5 s. */
export function redisRetryDelay(attempt: number): number {
  return Math.min(attempt * 200, 5000);
}

/** A lazy ioredis client for `REDIS_URL` (no connection until `connect()`). */
export function createRedisClient(
  config: Pick<BaseConfig, 'REDIS_URL' | 'SERVICE_NAME'>,
  options: RedisModuleOptions = {},
): Redis {
  return new Redis(config.REDIS_URL, {
    lazyConnect: true,
    connectionName: config.SERVICE_NAME,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy: redisRetryDelay,
    ...(options.keyPrefix === undefined
      ? {}
      : { keyPrefix: options.keyPrefix }),
  });
}

/**
 * Valkey/Redis (spec §2: ioredis): a lazy client for `REDIS_URL` connected in
 * `onModuleInit` and quit on shutdown, with a readiness check. Global: inject
 * with `@InjectRedis()`.
 *
 * @example
 * RedisModule.forRoot()
 * constructor(@InjectRedis() private readonly redis: Redis) {}
 */
@Module({})
export class RedisModule {
  /** Registers the client, its lifecycle and the readiness check. */
  static forRoot(options: RedisModuleOptions = {}): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      providers: [
        { provide: REDIS_OPTIONS, useValue: options },
        {
          provide: REDIS_CLIENT,
          useFactory: (config: BaseConfig) =>
            createRedisClient(config, options),
          inject: [APP_CONFIG],
        },
        RedisLifecycle,
        RedisHealthIndicator,
      ],
      exports: [REDIS_CLIENT],
    };
  }
}
