import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { withTransaction } from './transaction.js';

/** A pool whose clients record their statements and releases. */
function fakePool(): {
  readonly pool: Pool;
  readonly statements: string[];
  readonly releases: boolean[];
} {
  const statements: string[] = [];
  const releases: boolean[] = [];
  const client = {
    query: (text: string) => {
      statements.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: (broken?: boolean) => {
      releases.push(broken === true);
    },
  } as unknown as PoolClient;
  const pool = {
    connect: () => Promise.resolve(client),
  } as unknown as Pool;
  return { pool, statements, releases };
}

const deadlock = (): Error =>
  Object.assign(new Error('deadlock detected'), { code: '40P01' });

/** Counts the attempts of `failure` thrown `failures` times before success. */
async function attemptsUntilSuccess(
  failure: () => Error,
  options: Parameters<typeof withTransaction>[2],
  failures = Number.POSITIVE_INFINITY,
): Promise<{ attempts: number; outcome: unknown }> {
  const { pool } = fakePool();
  let attempts = 0;
  const outcome = await withTransaction(
    pool,
    () => {
      attempts += 1;
      return attempts <= failures
        ? Promise.reject(failure())
        : Promise.resolve('done');
    },
    options,
  ).catch((error: unknown) => error);
  return { attempts, outcome };
}

describe('withTransaction retries (CORE-2)', () => {
  it('retries bare, drizzle-wrapped and nested deadlocks alike', async () => {
    const wrapped = () => new DrizzleQueryError('update x', [1], deadlock());
    const nested = () => new Error('saving failed', { cause: wrapped() });
    for (const failure of [deadlock, wrapped, nested]) {
      const { attempts, outcome } = await attemptsUntilSuccess(failure, {
        retries: 3,
        retryDelayMs: 0,
      });
      expect(attempts).toBe(4);
      expect(outcome).toBeInstanceOf(Error);
    }
    const serialization = () =>
      new DrizzleQueryError(
        'update x',
        [],
        Object.assign(new Error('could not serialize access'), {
          code: '40001',
        }),
      );
    expect(
      await attemptsUntilSuccess(
        serialization,
        { retries: 3, retryDelayMs: 0 },
        2,
      ),
    ).toEqual({ attempts: 3, outcome: 'done' });
  });

  it('does not retry other errors, nor without retries', async () => {
    const unique = () =>
      new DrizzleQueryError(
        'insert',
        [],
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
    expect(
      (await attemptsUntilSuccess(unique, { retries: 3, retryDelayMs: 0 }))
        .attempts,
    ).toBe(1);
    expect((await attemptsUntilSuccess(deadlock, {})).attempts).toBe(1);
  });

  it('rolls back, releases the client and waits retryDelayMs between attempts', async () => {
    const { pool, statements, releases } = fakePool();
    const delays: number[] = [];
    let attempts = 0;
    const startedAt = Date.now();
    const result = await withTransaction(
      pool,
      () => {
        attempts += 1;
        return attempts < 3 ? Promise.reject(deadlock()) : Promise.resolve(7);
      },
      {
        retries: 2,
        isolationLevel: 'serializable',
        retryDelayMs: (retry) => {
          delays.push(retry);
          return 20;
        },
      },
    );
    expect(result).toBe(7);
    expect(delays).toEqual([1, 2]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
    expect(statements).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'ROLLBACK',
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'ROLLBACK',
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'COMMIT',
    ]);
    expect(releases).toEqual([false, false, false]);
  });

  it('pauses 10–50 ms by default', async () => {
    const startedAt = performance.now();
    const { attempts } = await attemptsUntilSuccess(
      deadlock,
      { retries: 1 },
      1,
    );
    expect(attempts).toBe(2);
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(9);
    expect(elapsed).toBeLessThan(500);
  });
});
