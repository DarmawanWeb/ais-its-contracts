import type { Pool, PoolClient } from 'pg';

import { type TransactionOptions, withTransaction } from './transaction.js';

/** Default table of {@link withIdempotency} (resolved through `search_path`, i.e. the service schema). */
export const PROCESSED_EVENTS_TABLE = 'processed_events';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Thrown for a table name that is not a plain (optionally schema-qualified) lowercase identifier. */
export class InvalidTableNameError extends Error {
  override readonly name = 'InvalidTableNameError';
}

/** Quotes `table` or `schema.table` after checking it is a plain lowercase identifier. */
export function quoteTableName(table: string): string {
  const parts = table.split('.');
  if (parts.length > 2 || parts.some((part) => !IDENTIFIER.test(part))) {
    throw new InvalidTableNameError(
      `"${table}" is not a lowercase SQL identifier (optionally schema-qualified)`,
    );
  }
  return parts.map((part) => `"${part}"`).join('.');
}

/**
 * The DDL of the inbox table of {@link withIdempotency}, for a service
 * migration (`migrations/NNNN_processed_events.sql`).
 *
 * @example
 * -- migrations/0002_processed_events.sql: paste the output of processedEventsTableSql()
 */
export function processedEventsTableSql(
  table: string = PROCESSED_EVENTS_TABLE,
): string {
  const name = quoteTableName(table);
  const bare = table.split('.').at(-1) ?? table;
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (`,
    '  consumer text NOT NULL,',
    '  event_id uuid NOT NULL,',
    '  processed_at timestamptz NOT NULL DEFAULT now(),',
    '  PRIMARY KEY (consumer, event_id)',
    ');',
    `CREATE INDEX IF NOT EXISTS "${bare}_processed_at_idx" ON ${name} (processed_at);`,
    '',
  ].join('\n');
}

/** Identity of one handled event: the consumer and the envelope id. */
export interface IdempotencyKey {
  /** Durable consumer (or any stable handler name). */
  readonly consumer: string;
  /** Envelope `id` (UUID v7). */
  readonly eventId: string;
}

/** Options of {@link withIdempotency}. */
export interface IdempotencyOptions {
  /** Inbox table. Default {@link PROCESSED_EVENTS_TABLE}. */
  readonly table?: string | undefined;
  readonly transaction?: TransactionOptions | undefined;
}

/** Result of {@link withIdempotency}. */
export type IdempotentResult<T> =
  | { readonly duplicate: false; readonly value: T }
  | { readonly duplicate: true };

/**
 * Runs `fn` at most once per `(consumer, eventId)` (spec §7.1: handlers
 * MUST be idempotent): the event id is recorded in the inbox table in the
 * same transaction as `fn`'s writes, so a redelivered or duplicated event is
 * skipped, and a failing `fn` records nothing (the redelivery runs it again).
 * Concurrent deliveries of one event wait for each other on the primary key.
 * Create the table with {@link processedEventsTableSql}; prune it with
 * {@link pruneProcessedEvents}.
 *
 * @example
 * @EventHandler({ consumer: 'notification-alerts' })
 * async onAlert(event: EventEnvelope<AlertRaisedV1>, context: EventContext): Promise<void> {
 *   await withIdempotency(this.pool, { consumer: context.consumer, eventId: event.id }, (client) =>
 *     this.alerts.insert(client, event.data),
 *   );
 * }
 */
export async function withIdempotency<T>(
  pool: Pool,
  key: IdempotencyKey,
  fn: (client: PoolClient) => Promise<T>,
  options: IdempotencyOptions = {},
): Promise<IdempotentResult<T>> {
  const table = quoteTableName(options.table ?? PROCESSED_EVENTS_TABLE);
  return withTransaction(
    pool,
    async (client): Promise<IdempotentResult<T>> => {
      const inserted = await client.query(
        `INSERT INTO ${table} (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [key.consumer, key.eventId],
      );
      if (inserted.rowCount === 0) return { duplicate: true };
      return { duplicate: false, value: await fn(client) };
    },
    options.transaction,
  );
}

/**
 * Deletes inbox rows older than `olderThan` (keep them longer than the
 * longest redelivery window, e.g. the stream's max age).
 *
 * @returns how many rows were deleted.
 */
export async function pruneProcessedEvents(
  pool: Pool,
  olderThan: Date,
  table: string = PROCESSED_EVENTS_TABLE,
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM ${quoteTableName(table)} WHERE processed_at < $1`,
    [olderThan],
  );
  return result.rowCount ?? 0;
}
