import type { Pool, PoolClient } from 'pg';

/** Transaction isolation levels. */
export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

/** Options of {@link withTransaction}. */
export interface TransactionOptions {
  readonly isolationLevel?: IsolationLevel | undefined;
  readonly readOnly?: boolean | undefined;
  /**
   * Re-runs `fn` this many times on serialization failures (`40001`) and
   * deadlocks (`40P01`). Default 0. `fn` must then be safe to repeat.
   */
  readonly retries?: number | undefined;
}

/** SQLSTATEs worth retrying a transaction for. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);

function sqlState(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function beginStatement(options: TransactionOptions): string {
  const parts = ['BEGIN'];
  if (options.isolationLevel !== undefined) parts.push(`ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`);
  if (options.readOnly === true) parts.push('READ ONLY');
  return parts.join(' ');
}

/**
 * Runs `fn` in a transaction on a dedicated pool client: `COMMIT` when it
 * resolves, `ROLLBACK` when it throws (the error is rethrown). With drizzle,
 * prefer `db.transaction(async (tx) => …)`; this helper is for raw `pg`.
 *
 * @example
 * const id = await withTransaction(pool, async (client) => {
 *   const { rows } = await client.query('INSERT INTO vessels … RETURNING id');
 *   await client.query('INSERT INTO vessel_dimensions …');
 *   return rows[0].id;
 * });
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
      const state = sqlState(error);
      if (state === undefined || !RETRYABLE_SQLSTATES.has(state) || attempt >= retries) throw error;
    } finally {
      client.release(broken);
    }
  }
}
