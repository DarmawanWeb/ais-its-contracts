import { setTimeout as sleep } from 'node:timers/promises';

import type { Pool } from 'pg';

import { PG_SQLSTATES, sqlStateOf } from './errors.js';

/** Options of {@link refreshContinuousAggregate}. */
export interface RefreshContinuousAggregateOptions {
  /**
   * Retries of a refresh that TimescaleDB rejected because it overlaps a
   * refresh in progress (SQLSTATE `55P03`). Default 5.
   */
  readonly retries?: number | undefined;
  /**
   * Pause before each retry, ms: a number, or a function of the retry number
   * (1 for the first). Default: exponential backoff with equal jitter, from
   * 125–250 ms for the first retry, doubling, capped at 2.5–5 s.
   */
  readonly retryDelayMs?: number | ((retry: number) => number) | undefined;
  /**
   * `statement_timeout` of the refresh, ms (`0` = none). Default: the pool's
   * (`DATABASE_STATEMENT_TIMEOUT_MS`). Restored before the client returns to
   * the pool.
   */
  readonly statementTimeoutMs?: number | undefined;
  /** Called before each retry (logging). */
  readonly onRetry?:
    ((error: unknown, retry: number, delayMs: number) => void) | undefined;
}

/** Outcome of {@link refreshContinuousAggregate}. */
export interface RefreshContinuousAggregateResult {
  /** Refresh calls made (1 when the first one succeeded). */
  readonly attempts: number;
}

/** Default number of retries of a concurrent-refresh rejection. */
export const DEFAULT_REFRESH_RETRIES = 5;

/** Default pause before retry `retry`: equal jitter on 250 ms × 2^(retry-1), capped at 5 s. */
function defaultRetryDelayMs(retry: number): number {
  const ceiling = Math.min(5_000, 250 * 2 ** Math.max(0, retry - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** A window bound: a `Date`, an ISO-8601 string, or `null` for an open end. */
export type RefreshWindowBound = Date | string | null;

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

/**
 * Refreshes a TimescaleDB continuous aggregate over `[from, to)`
 * (`CALL refresh_continuous_aggregate(view, from, to)`, `null` = open end)
 * on a dedicated pool client, outside any transaction (TimescaleDB refuses
 * the call inside one).
 *
 * TimescaleDB (2.2x+) rejects a refresh that overlaps one in progress at
 * once with SQLSTATE `55P03` ("could not refresh continuous aggregate … due
 * to a concurrent refresh") instead of waiting, and a policy job starts as
 * soon as `add_continuous_aggregate_policy` is called: such rejections are
 * retried with jittered backoff; any other error, and the last rejection,
 * are thrown. The view name is bound as a `regclass` (`view` or
 * `schema.view`, resolved with the search path), never interpolated.
 *
 * In `-- aisits:no-transaction` migrations, materialize an aggregate
 * (`CALL refresh_continuous_aggregate(...)`) BEFORE adding its policy, so
 * the two never overlap.
 *
 * @example
 * await refreshContinuousAggregate(pool, 'cii_daily', new Date(Date.now() - 400 * DAY_MS), startOfToday, {
 *   onRetry: (error, retry, delayMs) => logger.debug(`Concurrent refresh, retry ${retry} in ${delayMs} ms`),
 * });
 */
export async function refreshContinuousAggregate(
  pool: Pick<Pool, 'connect'>,
  view: string,
  from: RefreshWindowBound,
  to: RefreshWindowBound,
  options: RefreshContinuousAggregateOptions = {},
): Promise<RefreshContinuousAggregateResult> {
  if (view.trim() === '')
    throw new RangeError('The continuous aggregate name is empty');
  const retries = nonNegativeInteger(
    options.retries ?? DEFAULT_REFRESH_RETRIES,
    'retries',
  );
  const timeout =
    options.statementTimeoutMs === undefined
      ? undefined
      : nonNegativeInteger(options.statementTimeoutMs, 'statementTimeoutMs');
  const bounds = [from, to].map((bound) =>
    bound instanceof Date ? bound.toISOString() : bound,
  );
  for (let attempt = 1; ; attempt += 1) {
    try {
      await refreshOnce(pool, view, bounds, timeout);
      return { attempts: attempt };
    } catch (error) {
      if (
        sqlStateOf(error) !== PG_SQLSTATES.LOCK_NOT_AVAILABLE ||
        attempt > retries
      )
        throw error;
      const option = options.retryDelayMs;
      const delay = Math.max(
        0,
        option === undefined
          ? defaultRetryDelayMs(attempt)
          : typeof option === 'number'
            ? option
            : option(attempt),
      );
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}

async function refreshOnce(
  pool: Pick<Pool, 'connect'>,
  view: string,
  bounds: readonly (string | null)[],
  statementTimeoutMs: number | undefined,
): Promise<void> {
  const client = await pool.connect();
  let broken = false;
  try {
    if (statementTimeoutMs !== undefined)
      await client.query(`SET statement_timeout = ${statementTimeoutMs}`);
    try {
      await client.query(
        'CALL refresh_continuous_aggregate($1::text::regclass, $2::timestamptz, $3::timestamptz)',
        [view, ...bounds],
      );
    } finally {
      if (statementTimeoutMs !== undefined) {
        await client.query('RESET statement_timeout').catch(() => {
          broken = true;
        });
      }
    }
  } finally {
    client.release(broken);
  }
}
