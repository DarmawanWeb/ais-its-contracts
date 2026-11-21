import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RedisVesselStateMirror,
  VesselStateStore,
} from '../src/analytics/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import { RateLimitedError } from '../src/errors/index.js';
import {
  FixedWindowRateLimiter,
  guardAttempt,
  REDIS_CLIENT,
  RedisModule,
  SlidingWindowRateLimiter,
} from '../src/redis/index.js';
import { buildTestApp, createTestConfig } from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

describe('RedisModule and rate limiters', () => {
  let app: NestFastifyApplication;
  let redis: Redis;

  beforeAll(async () => {
    @Module({ imports: [RedisModule.forRoot()] })
    class AppModule {}
    app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'redis-test',
        REDIS_URL: testInfra().redisUrl,
      }),
    });
    redis = app.get<Redis>(REDIS_CLIENT);
  });

  afterAll(async () => {
    await app.close();
    expect(redis.status).toBe('end');
  });

  it('connects on init and reports readiness', async () => {
    expect(redis.status).toBe('ready');
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.json()).toMatchObject({
      status: 'ok',
      info: { redis: { status: 'up' } },
    });
  });

  it('fixed window: counts atomically under concurrency and resets with the window', async () => {
    const limiter = new FixedWindowRateLimiter(redis, {
      name: uniqueName('fixed'),
      limit: 5,
      windowMs: 1_000,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume('user-1')),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    const denied = results.find((result) => !result.allowed);
    expect(denied).toMatchObject({ remaining: 0, limit: 5 });
    expect(denied?.retryAfterMs).toBeGreaterThan(0);
    expect(denied?.resetAt.getTime()).toBeGreaterThan(Date.now());
    expect((await limiter.peek('user-1')).allowed).toBe(false);
    expect((await limiter.peek('user-2')).remaining).toBe(5);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await limiter.consume('user-1')).toMatchObject({
      allowed: true,
      remaining: 4,
    });
    await limiter.reset('user-1');
    expect((await limiter.peek('user-1')).remaining).toBe(5);
  });

  it('guardAttempt: concurrent failing attempts never exceed the limit; successes are refunded', async () => {
    for (const Limiter of [FixedWindowRateLimiter, SlidingWindowRateLimiter]) {
      const limiter = new Limiter(redis, {
        name: uniqueName('guard'),
        limit: 5,
        windowMs: 15 * 60_000,
      });
      let checks = 0;
      const wrongPassword = async (): Promise<never> => {
        checks += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error('INVALID_CREDENTIALS');
      };
      const outcomes = await Promise.allSettled(
        Array.from({ length: 200 }, () =>
          guardAttempt(limiter, 'victim@example.com', wrongPassword),
        ),
      );
      expect(checks).toBe(5);
      const limited = outcomes.filter(
        (outcome) =>
          outcome.status === 'rejected' &&
          outcome.reason instanceof RateLimitedError,
      );
      expect(limited).toHaveLength(195);

      // A successful attempt does not use up capacity.
      const other = 'someone@example.com';
      for (let attempt = 0; attempt < 10; attempt += 1)
        expect(
          await guardAttempt(limiter, other, () => Promise.resolve('ok')),
        ).toBe('ok');
      expect((await limiter.peek(other)).remaining).toBe(5);
    }
  });

  it('sliding window: never exceeds the limit in any window and only records allowed requests', async () => {
    const limiter = new SlidingWindowRateLimiter(redis, {
      name: uniqueName('sliding'),
      limit: 3,
      windowMs: 600,
    });
    const burst = await Promise.all(
      Array.from({ length: 10 }, () => limiter.consume('key')),
    );
    expect(burst.filter((result) => result.allowed)).toHaveLength(3);
    expect(
      burst.find((result) => !result.allowed)?.retryAfterMs,
    ).toBeGreaterThan(0);
    expect(await limiter.consume('key', 2)).toMatchObject({ allowed: false });
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(await limiter.consume('key', 2)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(() => limiter.consume('key', 0)).toThrow(RangeError);
  });

  it('mirrors vessel states for warm restarts', async () => {
    const prefix = `${uniqueName('state')}:`;
    const writer = new VesselStateStore({
      mirror: new RedisVesselStateMirror(redis, { keyPrefix: prefix }),
    });
    const time = new Date('2026-01-01T00:00:00.000Z');
    const position = {
      mmsi: 525005223,
      time,
      source: 'primary' as const,
      lat: 1.1,
      lon: 104,
      sog: 9.5,
      cog: 45,
      hdg: 44,
      navstatus: 0 as const,
      predictedNavstatus: 0 as const,
      coastDistanceM: 1200,
      previous: null,
    };
    writer.upsert(position);
    writer.upsert({ ...position, mmsi: 525005224 });
    await writer.flush();
    const reader = new VesselStateStore({
      mirror: new RedisVesselStateMirror(redis, { keyPrefix: prefix }),
    });
    expect(await reader.warmUp()).toBe(2);
    expect(reader.get(525005223)).toMatchObject({
      lat: 1.1,
      lon: 104,
      time,
      coastDistanceM: 1200,
    });
    reader.delete(525005224);
    await reader.flush();
    expect(
      await new VesselStateStore({
        mirror: new RedisVesselStateMirror(redis, { keyPrefix: prefix }),
      }).warmUp(),
    ).toBe(1);
  });
});
