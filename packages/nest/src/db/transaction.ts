import { setTimeout as sleep } from 'node:timers/promises';

import type { Pool, PoolClient } from 'pg';

import { PG_SQLSTATES, sqlStateOf } from './errors.js';

/** Transaction isolation levels. */
export type IsolationLevel =
  'read committed' | 'repeatable read' | 'serializable';

/** Options of {@link withTransaction}. */
export interface TransactionOptions {
  readonly isolationLevel?: IsolationLevel | undefined;
  readonly readOnly?: boolean | undefined;
  /**
   * Re-runs `fn` this many times on serialization failures (`40001`) and
   * deadlocks (`40P01`), also when drizzle wrapped the driver error (the
   * SQLSTATE is read with `sqlStateOf`). Default 0. `fn` must then be safe
   * to repeat.
   */
  readonly retries?: number | undefined;
  /**
   * Pause before each re-run, ms: a number, or a function of the retry
   * number (1 for the first re-run). The client is released while waiting.
   * Default: a random 10–50 ms, so that the transactions that collided do
   * not collide again in lockstep.
   */
  readonly retryDelayMs?: number | ((retry: number) => number) | undefined;
}

/** SQLSTATEs worth retrying a transaction for. */
const RETRYABLE_SQLSTATES: ReadonlySet<string | undefined> = new Set([
  PG_SQLSTATES.SERIALIZATION_FAILURE,
  PG_SQLSTATES.DEADLOCK_DETECTED,
]);

/** Default pause before a re-run: 10–50 ms. */
function jitteredRetryDelayMs(): number {
  return 10 + Math.floor(Math.random() * 41);
}

/** The pause before re-run `retry` (≥ 0 ms). */
function retryDelayOf(options: TransactionOptions, retry: number): number {
  const option = options.retryDelayMs;
  const delay =
    option === undefined
      ? jitteredRetryDelayMs()
      : typeof option === 'number'
        ? option
        : option(retry);
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

function beginStatement(options: TransactionOptions): string {
  const parts = ['BEGIN'];
  if (options.isolationLevel !== undefined)
    parts.push(`ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`);
  if (options.readOnly === true) parts.push('READ ONLY');
  return parts.join(' ');
}

/**
 * Runs `fn` in a transaction on a dedicated pool client: `COMMIT` when it
 * resolves, `ROLLBACK` when it throws (the error is rethrown). With
 * `retries`, a transaction that failed with a serialization failure or a
 * deadlock — thrown by `pg` directly or by drizzle on the same client — is
 * rolled back and re-run on a fresh client after `retryDelayMs`.
 *
 * @example
 * const id = await withTransaction(pool, async (client) => {
 *   const { rows } = await client.query('INSERT INTO vessels … RETURNING id');
 *   await client.query('INSERT INTO vessel_dimensions …');
 *   return rows[0].id;
 * });
 * @example
 * // drizzle on the transaction's client; deadlocks are retried twice
 * await withTransaction(pool, (client) => drizzle({ client }).update(vessels).set(changes).where(…), { retries: 2 });
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const retries = Math.max(0, options.retries ?? 0);
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(beginStatement(options));
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      if (!RETRYABLE_SQLSTATES.has(sqlStateOf(error)) || attempt >= retries)
        throw error;
    } finally {
      client.release(broken);
    }
    await sleep(retryDelayOf(options, attempt + 1));
  }
}
