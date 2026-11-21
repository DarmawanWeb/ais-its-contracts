import { Inject } from '@nestjs/common';

/** Injection token of the ioredis client. */
export const REDIS_CLIENT = 'SEEMP_REDIS_CLIENT';

/** Injection token of the `RedisModule` options. */
export const REDIS_OPTIONS = 'SEEMP_REDIS_OPTIONS';

/** Injects the ioredis client (`Redis` from `ioredis`). */
export function InjectRedis(): PropertyDecorator & ParameterDecorator {
  return Inject(REDIS_CLIENT);
}
