/**
 * Valkey/Redis (ioredis): `RedisModule`, `@InjectRedis()`, readiness and
 * rate limiters.
 *
 * @packageDocumentation
 */
export {
  FixedWindowRateLimiter,
  guardAttempt,
  type GuardAttemptOptions,
  type RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
  SlidingWindowRateLimiter,
} from './rate-limiter.js';
export { RedisLifecycle, type RedisModuleOptions } from './redis-lifecycle.js';
export { RedisHealthIndicator } from './redis.health.js';
export {
  createRedisClient,
  RedisModule,
  redisRetryDelay,
} from './redis.module.js';
export { InjectRedis, REDIS_CLIENT, REDIS_OPTIONS } from './redis.tokens.js';
/**
 * The client type injected by `@InjectRedis()` (re-exported so that services
 * need no direct `ioredis` dependency under pnpm's strict layout).
 */
export type { Redis, RedisOptions } from 'ioredis';
