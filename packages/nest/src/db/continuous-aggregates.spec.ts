import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { refreshContinuousAggregate } from './continuous-aggregates.js';

const concurrentRefresh = (): Error =>
  Object.assign(
    new Error(
      'could not refresh continuous aggregate "cii_daily" due to a concurrent refresh',
    ),
    { code: '55P03', severity: 'ERROR' },
  );

/** A pool whose CALLs fail with `failures` errors first. */
function fakePool(failures: readonly Error[]): {
  readonly pool: Pick<Pool, 'connect'>;
  readonly calls: { text: string; values: unknown[] | undefined }[];
  readonly releases: boolean[];
} {
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  const releases: boolean[] = [];
  const pending = [...failures];
  const client = {
    query: (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const failure = text.startsWith('CALL') ? pending.shift() : undefined;
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve({ rows: [] });
    },
    release: (broken?: boolean) => {
      releases.push(broken === true);
    },
  };
  return {
    pool: { connect: () => Promise.resolve(client) } as unknown as Pick<
      Pool,
      'connect'
    >,
    calls,
    releases,
  };
}

describe('refreshContinuousAggregate (CORE-18)', () => {
  it('binds the view and the window and retries concurrent refreshes', async () => {
    const { pool, calls, releases } = fakePool([
      concurrentRefresh(),
      concurrentRefresh(),
    ]);
    const retries: number[] = [];
    const from = new Date('2026-01-01T00:00:00Z');
    const result = await refreshContinuousAggregate(
      pool,
      'emission.cii_daily',
      from,
      null,
      {
        retryDelayMs: 1,
        onRetry: (_error, retry) => retries.push(retry),
      },
    );
    expect(result).toEqual({ attempts: 3 });
    expect(retries).toEqual([1, 2]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      text: 'CALL refresh_continuous_aggregate($1::text::regclass, $2::timestamptz, $3::timestamptz)',
      values: ['emission.cii_daily', '2026-01-01T00:00:00.000Z', null],
    });
    expect(releases).toEqual([false, false, false]);
  });

  it('throws other errors at once and the last rejection after the retries', async () => {
    const other = Object.assign(new Error('relation does not exist'), {
      code: '42P01',
      severity: 'ERROR',
    });
    const failing = fakePool([other]);
    await expect(
      refreshContinuousAggregate(failing.pool, 'nope', null, null),
    ).rejects.toBe(other);
    expect(failing.calls).toHaveLength(1);

    const busy = fakePool([
      concurrentRefresh(),
      concurrentRefresh(),
      concurrentRefresh(),
    ]);
    await expect(
      refreshContinuousAggregate(busy.pool, 'cii_daily', null, null, {
        retries: 2,
        retryDelayMs: () => 0,
      }),
    ).rejects.toMatchObject({ code: '55P03' });
    expect(busy.calls).toHaveLength(3);
  });

  it('sets and restores the statement timeout on the dedicated client', async () => {
    const { pool, calls } = fakePool([]);
    await refreshContinuousAggregate(pool, 'cii_annual', '2023-01-01', null, {
      statementTimeoutMs: 0,
    });
    expect(calls.map((call) => call.text.split(' ', 2).join(' '))).toEqual([
      'SET statement_timeout',
      'CALL refresh_continuous_aggregate($1::text::regclass,',
      'RESET statement_timeout',
    ]);
    await expect(
      refreshContinuousAggregate(pool, ' ', null, null),
    ).rejects.toThrow(RangeError);
    await expect(
      refreshContinuousAggregate(pool, 'v', null, null, { retries: -1 }),
    ).rejects.toThrow(/retries/);
  });
});
