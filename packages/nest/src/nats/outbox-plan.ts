import { errorMessage } from '../common/retry.js';

/**
 * A row claimed by one per-key relay pass, as the planner sees it.
 * Sequences are decimal strings (PostgreSQL `bigint` as `pg` returns it).
 */
export interface OutboxClaimedRow {
  readonly id: string;
  /** Commit-order sequence of the row (`seq`). */
  readonly seq: string;
  /** Ordering key (`entity_key`); `null` rows are unordered. */
  readonly entityKey: string | null;
  /**
   * `seq` of the nearest older pending row of the same key (claimed by this
   * pass or not), `null` when the row is the oldest pending row of its key.
   */
  readonly previousSeq: string | null;
}

/** Rows of one ordering key that a pass publishes, oldest first. */
export interface OutboxKeyRun<Row extends OutboxClaimedRow> {
  /** The entity key; `null` for a single unordered row. */
  readonly key: string | null;
  readonly rows: readonly Row[];
}

/** Result of {@link planOutboxRuns}. */
export interface OutboxPlan<Row extends OutboxClaimedRow> {
  /** Runs to publish: keys sequentially within a run, runs concurrently. */
  readonly runs: readonly OutboxKeyRun<Row>[];
  /**
   * Claimed rows left for a later pass: an older pending row of their key is
   * not part of this pass (claimed by another relay), so publishing them now
   * could overtake it.
   */
  readonly deferred: readonly Row[];
}

function compareSeq(a: string, b: string): number {
  const left = BigInt(a);
  const right = BigInt(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Plans one per-key relay pass from the rows it claimed (`FOR UPDATE SKIP
 * LOCKED`, oldest `seq` first): for every entity key, only the claimed rows
 * that form the key's oldest pending run are published, i.e. the key's
 * head followed by the claimed rows that directly follow each other among
 * the key's pending rows. A key whose head is locked by another relay (or
 * whose run is interrupted by a row locked elsewhere) is left at that
 * point, so a key is never published out of order and never by two relays
 * at once. Rows without a key are unordered: each one is its own run.
 */
export function planOutboxRuns<Row extends OutboxClaimedRow>(
  claimed: readonly Row[],
): OutboxPlan<Row> {
  const sorted = [...claimed].sort((a, b) => compareSeq(a.seq, b.seq));
  const runs: OutboxKeyRun<Row>[] = [];
  const deferred: Row[] = [];
  const byKey = new Map<string, Row[]>();
  for (const row of sorted) {
    if (row.entityKey === null) {
      runs.push({ key: null, rows: [row] });
      continue;
    }
    const rows = byKey.get(row.entityKey);
    if (rows === undefined) byKey.set(row.entityKey, [row]);
    else rows.push(row);
  }
  for (const [key, rows] of byKey) {
    const kept: Row[] = [];
    let expectedPrevious: string | null = null;
    let index = 0;
    for (; index < rows.length; index += 1) {
      const row = rows[index];
      if (row?.previousSeq !== expectedPrevious) break;
      kept.push(row);
      expectedPrevious = row.seq;
    }
    deferred.push(...rows.slice(index));
    if (kept.length > 0) runs.push({ key, rows: kept });
  }
  return { runs, deferred };
}

/** Retry backoff of the outbox relay (`OutboxModuleOptions.retry`). */
export interface OutboxRetryOptions {
  /** Delay of the first retry, ms (before jitter). Default 1 000. */
  readonly baseMs?: number | undefined;
  /** Longest delay, ms. Default 300 000 (5 min). */
  readonly maxMs?: number | undefined;
}

/** Default {@link OutboxRetryOptions.baseMs}. */
export const DEFAULT_OUTBOX_RETRY_BASE_MS = 1000;

/** Default {@link OutboxRetryOptions.maxMs}. */
export const DEFAULT_OUTBOX_RETRY_MAX_MS = 300_000;

/**
 * Delay before the next attempt of a row whose publication failed, ms:
 * exponential (`baseMs · 2^(attempts − 1)`, at most `maxMs`) with equal
 * jitter, i.e. uniformly between half the exponential delay and all of it,
 * so rows that failed together do not retry together.
 *
 * @param attempts failed attempts of the row so far, this one included (≥ 1).
 * @param random a `[0, 1)` source; default `Math.random`.
 */
export function outboxRetryDelayMs(
  attempts: number,
  retry: OutboxRetryOptions = {},
  random: () => number = Math.random,
): number {
  const baseMs = retry.baseMs ?? DEFAULT_OUTBOX_RETRY_BASE_MS;
  const maxMs = Math.max(baseMs, retry.maxMs ?? DEFAULT_OUTBOX_RETRY_MAX_MS);
  const exponent = Math.min(Math.max(0, Math.floor(attempts) - 1), 52);
  const ceiling = Math.min(maxMs, baseMs * 2 ** exponent);
  const half = ceiling / 2;
  return Math.round(half + random() * half);
}

/** Longest `last_error` the relay stores. */
export const OUTBOX_LAST_ERROR_MAX_LENGTH = 1000;

/**
 * The text stored in `last_error` for a failed publication: the error
 * message without control characters (PostgreSQL `text` refuses NUL),
 * without credentials of URLs (`nats://user:secret@host` becomes
 * `nats://***@host`), at most {@link OUTBOX_LAST_ERROR_MAX_LENGTH}
 * characters.
 */
export function sanitizeOutboxError(error: unknown): string {
  const text = errorMessage(error)
    // eslint-disable-next-line no-control-regex -- control characters are what is removed
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(\/\/)[^\s/@]+@/g, '$1***@')
    .trim();
  const message = text === '' ? 'unknown error' : text;
  return message.length > OUTBOX_LAST_ERROR_MAX_LENGTH
    ? `${message.slice(0, OUTBOX_LAST_ERROR_MAX_LENGTH - 1)}…`
    : message;
}
