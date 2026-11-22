import { describe, expect, it } from 'vitest';

import {
  OUTBOX_LAST_ERROR_MAX_LENGTH,
  type OutboxClaimedRow,
  outboxRetryDelayMs,
  planOutboxRuns,
  sanitizeOutboxError,
} from './outbox-plan.js';

/** A claimed row: `seq`, key and the seq of the key's previous pending row. */
const row = (
  seq: number,
  entityKey: string | null,
  previousSeq: number | null,
): OutboxClaimedRow => ({
  id: `row-${seq}`,
  seq: String(seq),
  entityKey,
  previousSeq: previousSeq === null ? null : String(previousSeq),
});

const ids = (rows: readonly OutboxClaimedRow[]): string[] =>
  rows.map((claimed) => claimed.id);

describe('planOutboxRuns (per-key outbox claim planning)', () => {
  it('keeps the contiguous run of every key that starts at its oldest pending row', () => {
    const plan = planOutboxRuns([
      row(1, 'a', null),
      row(2, 'b', null),
      row(3, 'a', 1),
      row(5, 'b', 2),
      row(6, 'a', 3),
    ]);
    expect(
      plan.runs.map((run) => ({ key: run.key, ids: ids(run.rows) })),
    ).toEqual([
      { key: 'a', ids: ['row-1', 'row-3', 'row-6'] },
      { key: 'b', ids: ['row-2', 'row-5'] },
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it('sorts by seq numerically, beyond the safe integer range', () => {
    const big = (n: bigint, previous: bigint | null): OutboxClaimedRow => ({
      id: `big-${n}`,
      seq: n.toString(),
      entityKey: 'k',
      previousSeq: previous === null ? null : previous.toString(),
    });
    const head = 9_007_199_254_740_993n;
    const plan = planOutboxRuns([big(head + 1n, head), big(head, null)]);
    expect(ids(plan.runs[0]?.rows ?? [])).toEqual([
      `big-${head}`,
      `big-${head + 1n}`,
    ]);
  });

  it('leaves a key whose oldest pending row is locked by another relay', () => {
    // Row 1 of key a was claimed elsewhere: 4 and 7 must wait for it.
    const plan = planOutboxRuns([
      row(2, 'b', null),
      row(4, 'a', 1),
      row(7, 'a', 4),
    ]);
    expect(plan.runs.map((run) => run.key)).toEqual(['b']);
    expect(ids(plan.deferred)).toEqual(['row-4', 'row-7']);
  });

  it('cuts a run where a row of the key is locked elsewhere', () => {
    // Row 3 of key a is locked by another relay: 1 goes, 5 and 6 wait.
    const plan = planOutboxRuns([
      row(1, 'a', null),
      row(5, 'a', 3),
      row(6, 'a', 5),
    ]);
    expect(ids(plan.runs[0]?.rows ?? [])).toEqual(['row-1']);
    expect(ids(plan.deferred)).toEqual(['row-5', 'row-6']);
  });

  it('defers rows behind a head that waits for its retry (not claimed)', () => {
    // Row 1 of key a failed and is not due: the claim query skips it, so
    // rows 2 and 3 arrive with a previous row that is not part of the pass.
    const plan = planOutboxRuns([
      row(2, 'a', 1),
      row(3, 'a', 2),
      row(4, 'c', null),
    ]);
    expect(plan.runs.map((run) => run.key)).toEqual(['c']);
    expect(ids(plan.deferred)).toEqual(['row-2', 'row-3']);
  });

  it('publishes rows without an entity key independently (unordered)', () => {
    const plan = planOutboxRuns([
      row(1, null, null),
      row(2, 'a', null),
      row(3, null, null),
    ]);
    expect(
      plan.runs.map((run) => ({ key: run.key, ids: ids(run.rows) })),
    ).toEqual([
      { key: null, ids: ['row-1'] },
      { key: null, ids: ['row-3'] },
      { key: 'a', ids: ['row-2'] },
    ]);
  });

  it('plans nothing for an empty claim', () => {
    expect(planOutboxRuns([])).toEqual({ runs: [], deferred: [] });
  });
});

describe('outboxRetryDelayMs (equal jitter)', () => {
  it('doubles from baseMs up to maxMs and stays within [ceiling / 2, ceiling]', () => {
    const retry = { baseMs: 1000, maxMs: 300_000 };
    const low = (attempts: number): number =>
      outboxRetryDelayMs(attempts, retry, () => 0);
    const high = (attempts: number): number =>
      outboxRetryDelayMs(attempts, retry, () => 0.999_999);
    expect([1, 2, 3, 4].map(low)).toEqual([500, 1000, 2000, 4000]);
    expect([1, 2, 3, 4].map(high)).toEqual([1000, 2000, 4000, 8000]);
    // Capped: 2^9 s > 300 s.
    expect(low(10)).toBe(150_000);
    expect(high(10)).toBe(300_000);
    expect(high(10_000)).toBe(300_000);
    for (let attempts = 1; attempts <= 30; attempts += 1) {
      const delay = outboxRetryDelayMs(attempts, retry);
      const ceiling = Math.min(300_000, 1000 * 2 ** (attempts - 1));
      expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('uses 1 s and 5 min by default and never goes below the base', () => {
    expect(outboxRetryDelayMs(1, {}, () => 0.999_999)).toBe(1000);
    expect(outboxRetryDelayMs(40, {}, () => 0.999_999)).toBe(300_000);
    expect(outboxRetryDelayMs(0, {}, () => 0)).toBe(500);
    // maxMs below baseMs is raised to baseMs.
    expect(
      outboxRetryDelayMs(5, { baseMs: 2000, maxMs: 10 }, () => 0.999_999),
    ).toBe(2000);
  });

  it('spreads rows that failed together', () => {
    const delays = new Set(
      Array.from({ length: 50 }, () => outboxRetryDelayMs(3)),
    );
    expect(delays.size).toBeGreaterThan(10);
  });
});

describe('sanitizeOutboxError', () => {
  it('removes control characters (NUL included) and URL credentials', () => {
    expect(
      sanitizeOutboxError(
        new Error(
          'connect to nats://relay:s3cret@nats:4222 failed\u0000\n\tretry',
        ),
      ),
    ).toBe('connect to nats://***@nats:4222 failed retry');
  });

  it('bounds the length and names unknown errors', () => {
    const long = sanitizeOutboxError(new Error('x'.repeat(5000)));
    expect(long).toHaveLength(OUTBOX_LAST_ERROR_MAX_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    expect(sanitizeOutboxError(new Error(''))).toBe('unknown error');
    expect(sanitizeOutboxError('plain text')).toBe('plain text');
  });
});
