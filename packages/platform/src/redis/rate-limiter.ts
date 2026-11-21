import { createHash, randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

/** Outcome of a rate limit check. */
export interface RateLimitResult {
  /** `true` when the request fits in the limit (and was counted). */
  readonly allowed: boolean;
  /** Requests left in the current window. */
  readonly remaining: number;
  /** When capacity is restored (fixed: window end; sliding: oldest entry expiry). */
  readonly resetAt: Date;
  /** `0` when allowed, else how long to wait before retrying, ms. */
  readonly retryAfterMs: number;
  readonly limit: number;
}

/** Options of a rate limiter. */
export interface RateLimiterOptions {
  /** Name of the limit, part of the keys: `ratelimit:<name>:<key>`. */
  readonly name: string;
  /** Requests allowed per window. */
  readonly limit: number;
  /** Window length, ms. */
  readonly windowMs: number;
}

/** A rate limiter keyed by an identity (account, IP, API key, …). */
export interface RateLimiter {
  /** Counts `cost` requests for `key` (only when they fit, for the sliding limiter). */
  consume(key: string, cost?: number): Promise<RateLimitResult>;
  /** Reads the current state without counting. */
  peek(key: string): Promise<RateLimitResult>;
  /** Forgets `key` (e.g. after a successful login). */
  reset(key: string): Promise<void>;
}

/** Runs a Lua script by SHA, loading it on `NOSCRIPT`. */
class LuaScript {
  private readonly sha: string;

  constructor(private readonly source: string) {
    this.sha = createHash('sha1').update(source).digest('hex');
  }

  async run(redis: Redis, keys: readonly string[], args: readonly (string | number)[]): Promise<unknown> {
    try {
      return await redis.evalsha(this.sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
      return redis.eval(this.source, keys.length, ...keys, ...args);
    }
  }
}

function numbers(value: unknown, count: number): number[] {
  if (!Array.isArray(value) || value.length < count) throw new TypeError('Unexpected rate limiter script result');
  return value.slice(0, count).map((item) => Number(item));
}

function validate(options: RateLimiterOptions): void {
  if (!/^[a-z0-9:_-]+$/i.test(options.name)) throw new RangeError(`Invalid rate limit name "${options.name}"`);
  if (!Number.isInteger(options.limit) || options.limit < 1) throw new RangeError('limit must be a positive integer');
  if (!Number.isInteger(options.windowMs) || options.windowMs < 1) throw new RangeError('windowMs must be a positive integer');
}

function validCost(cost: number): number {
  if (!Number.isInteger(cost) || cost < 1) throw new RangeError('cost must be a positive integer');
  return cost;
}

const FIXED_WINDOW_SCRIPT = `
local cost = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local current
if cost > 0 then
  current = redis.call('INCRBY', KEYS[1], cost)
  if current == cost then redis.call('PEXPIRE', KEYS[1], window) end
else
  current = tonumber(redis.call('GET', KEYS[1]) or '0')
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  if current > 0 then redis.call('PEXPIRE', KEYS[1], window) end
  ttl = window
end
return { current, ttl }
`;

/**
 * Fixed window counter (`INCRBY` + `PEXPIRE`, atomic): at most `limit`
 * requests per `windowMs` window starting at the first request. Every
 * consumed request is counted, allowed or not. Cheap; allows bursts of up to
 * 2 × limit across a window boundary.
 *
 * @example
 * const logins = new FixedWindowRateLimiter(redis, { name: 'login-email', limit: 5, windowMs: 15 * 60_000 });
 * if (!(await logins.peek(email)).allowed) throw new RateLimitedError({ retryAfterSeconds: … });
 */
export class FixedWindowRateLimiter implements RateLimiter {
  private readonly script = new LuaScript(FIXED_WINDOW_SCRIPT);

  constructor(
    private readonly redis: Redis,
    private readonly options: RateLimiterOptions,
  ) {
    validate(options);
  }

  /** @inheritdoc */
  consume(key: string, cost = 1): Promise<RateLimitResult> {
    return this.call(key, validCost(cost));
  }

  /** @inheritdoc */
  peek(key: string): Promise<RateLimitResult> {
    return this.call(key, 0);
  }

  /** @inheritdoc */
  async reset(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }

  private key(key: string): string {
    return `ratelimit:${this.options.name}:${key}`;
  }

  private async call(key: string, cost: number): Promise<RateLimitResult> {
    const [count = 0, ttl = 0] = numbers(await this.script.run(this.redis, [this.key(key)], [cost, this.options.windowMs]), 2);
    const { limit } = this.options;
    const allowed = cost === 0 ? count < limit : count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(Date.now() + ttl),
      retryAfterMs: allowed ? 0 : ttl,
      limit,
    };
  }
}

const SLIDING_WINDOW_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local window = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if cost == 0 then
  if count < limit then allowed = 1 end
elseif count + cost <= limit then
  for i = 1, cost do redis.call('ZADD', KEYS[1], now, ARGV[4] .. ':' .. i) end
  count = count + cost
  allowed = 1
end
if count > 0 then redis.call('PEXPIRE', KEYS[1], window) end
local reset = now + window
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if oldest[2] then reset = tonumber(oldest[2]) + window end
return { allowed, count, reset, now }
`;

/**
 * Sliding window log (sorted set of request timestamps, atomic, server
 * clock): at most `limit` requests in any `windowMs` interval. Only allowed
 * requests are recorded. Exact; memory grows with `limit` per key.
 *
 * @example
 * const ingest = new SlidingWindowRateLimiter(redis, { name: 'ingest', limit: 600, windowMs: 60_000 });
 * const result = await ingest.consume(apiKeyId);
 * if (!result.allowed) throw new RateLimitedError({ retryAfterSeconds: result.retryAfterMs / 1000 });
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  private readonly script = new LuaScript(SLIDING_WINDOW_SCRIPT);

  constructor(
    private readonly redis: Redis,
    private readonly options: RateLimiterOptions,
  ) {
    validate(options);
  }

  /** @inheritdoc */
  consume(key: string, cost = 1): Promise<RateLimitResult> {
    return this.call(key, validCost(cost));
  }

  /** @inheritdoc */
  peek(key: string): Promise<RateLimitResult> {
    return this.call(key, 0);
  }

  /** @inheritdoc */
  async reset(key: string): Promise<void> {
    await this.redis.del(this.key(key));
  }

  private key(key: string): string {
    return `ratelimit:${this.options.name}:${key}`;
  }

  private async call(key: string, cost: number): Promise<RateLimitResult> {
    const result = await this.script.run(
      this.redis,
      [this.key(key)],
      [this.options.windowMs, this.options.limit, cost, randomUUID()],
    );
    const [allowedFlag = 0, count = 0, reset = 0, now = 0] = numbers(result, 4);
    const allowed = allowedFlag === 1;
    const { limit } = this.options;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(reset),
      retryAfterMs: allowed ? 0 : Math.max(0, reset - now),
      limit,
    };
  }
}
