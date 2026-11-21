import { Injectable } from '@nestjs/common';
import type { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import type { Redis } from 'ioredis';

import { ReadinessCheck, type ReadinessIndicator } from '../health/readiness.js';
import { InjectRedis } from './redis.tokens.js';

/** Readiness of Valkey/Redis: `PING` within 2 s. */
@ReadinessCheck()
@Injectable()
export class RedisHealthIndicator implements ReadinessIndicator {
  readonly healthKey = 'redis';

  constructor(@InjectRedis() private readonly redis: Redis) {}

  /** @inheritdoc */
  check(health: HealthIndicatorService): PromiseLike<HealthIndicatorResult> {
    return health
      .check(this.healthKey)
      .attempt(async () => {
        if (this.redis.status !== 'ready') throw new Error(`Redis is ${this.redis.status}`);
        await this.redis.ping();
      })
      .withTimeout(2000);
  }
}
