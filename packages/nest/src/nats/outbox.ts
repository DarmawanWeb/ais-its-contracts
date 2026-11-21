import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  type EventPayload,
  type EventType,
  InvalidEventError,
  makeEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { Counter, Gauge } from 'prom-client';

import { errorMessage } from '../common/retry.js';
import { quoteTableName } from '../db/idempotency.js';
import { PG_POOL } from '../db/tokens.js';
import { withTransaction } from '../db/transaction.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { EventSubjectMismatchError } from './errors.js';
import { EventPublisher } from './event-publisher.js';

/** Default table of the transactional outbox (resolved through `search_path`, i.e. the service schema). */
export const OUTBOX_TABLE = 'outbox';

/**
 * The DDL of the outbox table, for a service migration
 * (`migrations/NNNN_outbox.sql`). `id` is the envelope id (`Nats-Msg-Id`),
 * stable across relay retries.
 */
export function outboxTableSql(table: string = OUTBOX_TABLE): string {
  const name = quoteTableName(table);
  const bare = table.split('.').at(-1) ?? table;
  return [
    `CREATE TABLE IF NOT EXISTS ${name} (`,
    '  id uuid PRIMARY KEY,',
    '  type text NOT NULL,',
    '  entity_key text,',
    '  data jsonb NOT NULL,',
    '  created_at timestamptz NOT NULL DEFAULT now(),',
    '  attempts integer NOT NULL DEFAULT 0,',
    '  last_error text,',
    '  published_at timestamptz,',
    '  failed_at timestamptz',
    ');',
    `CREATE INDEX IF NOT EXISTS "${bare}_pending_idx" ON ${name} (created_at, id)`,
    '  WHERE published_at IS NULL AND failed_at IS NULL;',
    '',
  ].join('\n');
}

/** Anything `pg` can query: the pool or the client of an open transaction. */
export type OutboxQueryable = Pick<Pool | PoolClient, 'query'>;

/** Options of {@link enqueueEvent}. */
export interface EnqueueEventOptions {
  /** Envelope id; default a new UUID v7. */
  readonly id?: string | undefined;
  /** Envelope `subject` (entity key); default derived from the payload. */
  readonly entityKey?: string | undefined;
  /** Outbox table. Default {@link OUTBOX_TABLE}. */
  readonly table?: string | undefined;
}

/**
 * Adds an event to the transactional outbox inside the caller's
 * transaction (spec §13.3, §13.6): the row commits or rolls back with the
 * business change, and {@link OutboxRelay} publishes it afterwards, in
 * insertion order, with the row id as envelope id.
 *
 * @returns the envelope id.
 * @throws {InvalidEventError} when `data` violates the contract (nothing is written).
 * @example
 * await withTransaction(this.pool, async (client) => {
 *   await this.vessels.update(client, id, changes);
 *   await enqueueEvent(client, EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot);
 * });
 */
export async function enqueueEvent<Type extends EventType>(
  client: OutboxQueryable,
  type: Type,
  data: EventPayload<Type>,
  options: EnqueueEventOptions = {},
): Promise<string> {
  // Validates the payload and derives the default entity key.
  const envelope = makeEnvelope({
    type,
    source: 'outbox',
    data,
    id: options.id,
    subject: options.entityKey,
  });
  await client.query(
    `INSERT INTO ${quoteTableName(options.table ?? OUTBOX_TABLE)} (id, type, entity_key, data, created_at) ` +
      'VALUES ($1, $2, $3, $4::jsonb, $5)',
    [
      envelope.id,
      type,
      envelope.subject ?? null,
      JSON.stringify(envelope.data),
      new Date(envelope.time),
    ],
  );
  return envelope.id;
}

/** Options of {@link OutboxModule}. */
export interface OutboxModuleOptions {
  /** Outbox table. Default {@link OUTBOX_TABLE}. */
  readonly table?: string | undefined;
  /** Idle polling interval, ms. Default 500. */
  readonly pollIntervalMs?: number | undefined;
  /** Rows published per transaction. Default 100. */
  readonly batchSize?: number | undefined;
  /** How long published rows are kept, ms. Default 24 h. */
  readonly retentionMs?: number | undefined;
  /** Start the relay at bootstrap. Default `true` (`false` in tests that call {@link OutboxRelay.relayOnce}). */
  readonly autoStart?: boolean | undefined;
}

/** Injection token of {@link OutboxModuleOptions}. */
export const OUTBOX_OPTIONS = 'AISITS_OUTBOX_OPTIONS';

interface OutboxRow {
  readonly id: string;
  readonly type: EventType;
  readonly entity_key: string | null;
  readonly data: unknown;
  readonly created_at: Date;
}

/** Errors that will never succeed for a row: it is marked failed instead of blocking the outbox. */
function isPoison(error: unknown): boolean {
  return (
    error instanceof InvalidEventError ||
    error instanceof EventSubjectMismatchError
  );
}

/** Signed 64-bit advisory lock key of an outbox table. */
function lockKey(table: string): string {
  return createHash('sha256')
    .update(`aisits:outbox:${table}`)
    .digest()
    .readBigInt64BE(0)
    .toString();
}

/** Result of one relay pass. */
export interface OutboxRelayResult {
  /** Rows published. */
  readonly published: number;
  /** Rows marked failed (payload no longer valid). */
  readonly rejected: number;
  /** `true` when another instance held the relay lock. */
  readonly skipped: boolean;
  /** Publication failed (retried next pass, order kept). */
  readonly failed: boolean;
}

/**
 * Publishes the outbox (spec §13.3, §13.6): one instance at a time (a
 * transaction-scoped advisory lock), oldest rows first, stopping at the first
 * publication failure so per-entity order holds (`FLEET`/`GEO` keep only the
 * latest message per subject). Rows whose payload no longer validates are
 * marked `failed_at` and skipped. Published rows are deleted after
 * `retentionMs`. Metrics: `aisits_outbox_relayed_total{type,outcome}`,
 * `aisits_outbox_pending`, `aisits_outbox_oldest_pending_seconds`.
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('Outbox');
  private readonly table: string;
  private readonly key: string;
  private readonly relayed: Counter<'type' | 'outcome'>;
  private readonly pending: Gauge;
  private readonly oldest: Gauge;
  private loop: Promise<void> | undefined;
  private readonly stop = new AbortController();
  private wake: (() => void) | undefined;
  private lastCleanup = 0;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly publisher: EventPublisher,
    @Inject(OUTBOX_OPTIONS) private readonly options: OutboxModuleOptions,
    @Optional() @Inject(MetricsService) metrics: MetricsService | null = null,
  ) {
    this.table = quoteTableName(options.table ?? OUTBOX_TABLE);
    this.key = lockKey(options.table ?? OUTBOX_TABLE);
    const registry = metrics ?? new MetricsService();
    this.relayed = registry.counter({
      name: 'outbox_relayed_total',
      help: 'Outbox rows relayed by event type and outcome (published, failed, rejected).',
      labelNames: ['type', 'outcome'],
    });
    this.pending = registry.gauge({
      name: 'outbox_pending',
      help: 'Outbox rows waiting to be published.',
    });
    this.oldest = registry.gauge({
      name: 'outbox_oldest_pending_seconds',
      help: 'Age of the oldest outbox row waiting to be published, seconds.',
    });
  }

  /** Starts the relay loop (after migrations, which run in `onModuleInit`). */
  onApplicationBootstrap(): void {
    if (this.options.autoStart === false) return;
    this.loop = this.run();
  }

  /** Stops the loop after the current pass. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stop.abort();
    this.wake?.();
    await this.loop?.catch(() => undefined);
  }

  /** Wakes the relay now (e.g. right after committing an enqueue) instead of at the next poll. */
  notify(): void {
    this.wake?.();
  }

  /** Publishes up to `batchSize` pending rows in order; never throws for publication failures. */
  async relayOnce(): Promise<OutboxRelayResult> {
    const batchSize = this.options.batchSize ?? 100;
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock($1::bigint) AS locked',
        [this.key],
      );
      if (locked.rows[0]?.locked !== true)
        return { published: 0, rejected: 0, skipped: true, failed: false };
      const { rows } = await client.query<OutboxRow>(
        `SELECT id, type, entity_key, data, created_at FROM ${this.table} ` +
          'WHERE published_at IS NULL AND failed_at IS NULL ORDER BY created_at, id LIMIT $1',
        [batchSize],
      );
      const published: string[] = [];
      let rejected = 0;
      let failed = false;
      for (const row of rows) {
        try {
          await this.publisher.publishEvent(
            row.type,
            // Stored by enqueueEvent from a validated payload; validated again on publish.
            row.data as EventPayload<EventType>,
            {
              id: row.id,
              time: row.created_at,
              entityKey: row.entity_key ?? undefined,
            },
          );
          published.push(row.id);
          this.relayed.inc({ type: row.type, outcome: 'published' });
        } catch (error) {
          if (isPoison(error)) {
            rejected += 1;
            this.relayed.inc({ type: row.type, outcome: 'rejected' });
            this.logger.error(
              `Outbox row ${row.id} (${row.type}) can never be published, marked failed: ${errorMessage(error)}`,
            );
            await client.query(
              `UPDATE ${this.table} SET attempts = attempts + 1, last_error = $2, failed_at = now() WHERE id = $1`,
              [row.id, errorMessage(error).slice(0, 1000)],
            );
            continue;
          }
          failed = true;
          this.relayed.inc({ type: row.type, outcome: 'failed' });
          this.logger.warn(
            `Publishing outbox row ${row.id} (${row.type}) failed, retrying: ${errorMessage(error)}`,
          );
          await client.query(
            `UPDATE ${this.table} SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            [row.id, errorMessage(error).slice(0, 1000)],
          );
          break;
        }
      }
      if (published.length > 0) {
        await client.query(
          `UPDATE ${this.table} SET published_at = now() WHERE id = ANY($1::uuid[])`,
          [published],
        );
      }
      await this.updateGauges(client);
      return { published: published.length, rejected, skipped: false, failed };
    });
  }

  /** Deletes rows published longer than `retentionMs` ago; returns how many. */
  async cleanup(): Promise<number> {
    const retentionMs = this.options.retentionMs ?? 24 * 3_600_000;
    const result = await this.pool.query(
      `DELETE FROM ${this.table} WHERE published_at < $1`,
      [new Date(Date.now() - retentionMs)],
    );
    return result.rowCount ?? 0;
  }

  private async updateGauges(client: PoolClient): Promise<void> {
    const { rows } = await client.query<{
      pending: string;
      oldest: Date | null;
    }>(
      `SELECT count(*) AS pending, min(created_at) AS oldest FROM ${this.table} ` +
        'WHERE published_at IS NULL AND failed_at IS NULL',
    );
    const row = rows[0];
    this.pending.set(Number(row?.pending ?? 0));
    this.oldest.set(
      row?.oldest === undefined || row.oldest === null
        ? 0
        : (Date.now() - row.oldest.getTime()) / 1000,
    );
  }

  /** Read through a method: the signal changes while the loop awaits. */
  private isStopping(): boolean {
    return this.stop.signal.aborted;
  }

  private async run(): Promise<void> {
    const pollMs = this.options.pollIntervalMs ?? 500;
    let backoffMs = pollMs;
    while (!this.isStopping()) {
      let busy = false;
      try {
        const result = await this.relayOnce();
        busy =
          result.published + result.rejected >= (this.options.batchSize ?? 100);
        backoffMs = result.failed ? Math.min(backoffMs * 2, 30_000) : pollMs;
        if (Date.now() - this.lastCleanup > 10 * 60_000) {
          this.lastCleanup = Date.now();
          await this.cleanup();
        }
      } catch (error) {
        backoffMs = Math.min(backoffMs * 2, 30_000);
        this.logger.error(`Outbox relay pass failed: ${errorMessage(error)}`);
      }
      if (busy || this.isStopping()) continue;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        void sleep(backoffMs, undefined, {
          signal: this.stop.signal,
          ref: false,
        })
          .catch(() => undefined)
          .then(resolve);
      });
      this.wake = undefined;
    }
  }
}

/**
 * The transactional outbox relay (requires `DatabaseModule` and
 * `NatsModule`; list the target streams in `NatsModule.forRoot({ streams })`).
 * Create the table with {@link outboxTableSql} in a migration and add rows
 * with {@link enqueueEvent} inside your transactions.
 */
@Module({})
export class OutboxModule {
  static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    return {
      module: OutboxModule,
      providers: [{ provide: OUTBOX_OPTIONS, useValue: options }, OutboxRelay],
      exports: [OutboxRelay],
    };
  }
}
