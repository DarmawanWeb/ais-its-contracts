import type { Pool, PoolClient } from 'pg';

import { errorMessage } from '../../common/retry.js';
import { type MigrationFile, readMigrationFiles } from './migration-files.js';
import { splitSqlStatements } from './sql-splitter.js';

/** Where the migrator reports progress (pino and console loggers fit). */
export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Options of {@link runMigrations}. */
export interface RunMigrationsOptions {
  /** Pool connected as the schema owner (`<schema>_svc`). */
  readonly pool: Pool;
  /** The service schema (`DATABASE_SCHEMA`); must exist (created by the infrastructure). */
  readonly schema: string;
  /** Directory of the `NNNN_name.sql` files. */
  readonly dir: string;
  readonly logger?: MigrationLogger | undefined;
}

/** An applied migration. */
export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly durationMs: number;
}

/** Outcome of {@link runMigrations}. */
export interface MigrationReport {
  /** Migrations applied by this run, in order. */
  readonly applied: readonly AppliedMigration[];
  /** Migrations that were already applied. */
  readonly alreadyApplied: number;
}

/** A recorded migration whose file changed after it was applied. */
export class MigrationChecksumMismatchError extends Error {
  override readonly name = 'MigrationChecksumMismatchError';

  constructor(
    readonly version: number,
    readonly fileName: string,
    readonly recordedChecksum: string,
    readonly fileChecksum: string,
  ) {
    super(
      `Migration ${fileName} was modified after it was applied (checksum ${recordedChecksum} recorded, ${fileChecksum} on disk). ` +
        'Applied migrations are immutable: revert the file and add a new migration.',
    );
  }
}

/** A migration that failed to apply. */
export class MigrationFailedError extends Error {
  override readonly name = 'MigrationFailedError';

  constructor(
    readonly migration: Pick<MigrationFile, 'version' | 'fileName' | 'transactional'>,
    detail: string,
    cause: unknown,
  ) {
    super(
      `Migration ${migration.fileName} failed: ${detail}` +
        (migration.transactional
          ? ' (rolled back)'
          : ' (no-transaction migration: earlier statements stay applied, fix the database before retrying)'),
      { cause },
    );
  }
}

/** The schema is missing (it is created by the infrastructure bootstrap). */
export class MigrationSchemaMissingError extends Error {
  override readonly name = 'MigrationSchemaMissingError';

  constructor(readonly schema: string) {
    super(
      `Schema "${schema}" does not exist. Service schemas and their owner roles are created by ` +
        'the infrastructure (infra/postgres/bootstrap.sql), not by migrations.',
    );
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Advisory lock key of a schema's migrations (`hashtextextended` input). */
export function migrationLockKey(schema: string): string {
  return `seemp.migrations:${schema}`;
}

/** 1-based line of a character position reported by PostgreSQL. */
function lineOf(sql: string, position: string | undefined): number | undefined {
  const offset = position === undefined ? Number.NaN : Number(position);
  if (!Number.isInteger(offset) || offset < 1) return undefined;
  return sql.slice(0, offset - 1).split('\n').length;
}

function describeError(error: unknown, sql: string): string {
  const position =
    typeof error === 'object' && error !== null && 'position' in error && typeof error.position === 'string'
      ? error.position
      : undefined;
  const line = lineOf(sql, position);
  return line === undefined ? errorMessage(error) : `${errorMessage(error)} (line ${line})`;
}

async function applyMigration(
  client: PoolClient,
  table: string,
  migration: MigrationFile,
): Promise<number> {
  const startedAt = performance.now();
  const record = (): Promise<unknown> =>
    client.query(`INSERT INTO ${table} (version, name, checksum) VALUES ($1, $2, $3)`, [
      migration.version,
      migration.name,
      migration.checksum,
    ]);

  if (migration.transactional) {
    await client.query('BEGIN');
    try {
      // Simple query protocol: the whole file runs as one batch in the transaction.
      await client.query(migration.sql);
      await record();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new MigrationFailedError(migration, describeError(error, migration.sql), error);
    }
  } else {
    // One statement at a time: a multi-statement query is an implicit
    // transaction, which e.g. continuous aggregates refuse.
    const statements = splitSqlStatements(migration.sql);
    for (const [index, statement] of statements.entries()) {
      try {
        await client.query(statement);
      } catch (error) {
        throw new MigrationFailedError(
          migration,
          `statement ${index + 1} of ${statements.length}: ${describeError(error, statement)}`,
          error,
        );
      }
    }
    await record();
  }
  return Math.round(performance.now() - startedAt);
}

/**
 * Forward-only SQL migrator (spec §6). Under a PostgreSQL advisory lock (one
 * runner per schema at a time, others wait), it records migrations in
 * `<schema>.schema_migrations(version, name, checksum, applied_at)`, refuses
 * to start when an applied file changed (SHA-256), and applies the pending
 * `NNNN_name.sql` files in order — each in its own transaction, or statement
 * by statement for files starting with `-- seemp:no-transaction`.
 *
 * @throws {MigrationChecksumMismatchError} when an applied migration changed.
 * @throws {MigrationFailedError} when a migration fails.
 * @throws {MigrationSchemaMissingError} when the schema does not exist.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationReport> {
  const { schema, logger } = options;
  if (!IDENTIFIER.test(schema)) throw new RangeError(`Invalid schema name "${schema}"`);
  const table = `"${schema}".schema_migrations`;
  const migrations = await readMigrationFiles(options.dir);
  const lockKey = migrationLockKey(schema);

  const client = await options.pool.connect();
  try {
    const exists = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists',
      [schema],
    );
    if (exists.rows[0]?.exists !== true) throw new MigrationSchemaMissingError(schema);

    // Migrations may legitimately run longer than the pool's statement timeout.
    await client.query('SET statement_timeout = 0');
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockKey]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${table} (
           version integer PRIMARY KEY,
           name text NOT NULL,
           checksum text NOT NULL,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const recorded = await client.query<{ version: number; checksum: string }>(
        `SELECT version, checksum FROM ${table} ORDER BY version`,
      );
      const checksums = new Map(recorded.rows.map((row) => [row.version, row.checksum]));

      for (const migration of migrations) {
        const checksum = checksums.get(migration.version);
        if (checksum !== undefined && checksum !== migration.checksum) {
          throw new MigrationChecksumMismatchError(migration.version, migration.fileName, checksum, migration.checksum);
        }
      }
      const known = new Set(migrations.map((migration) => migration.version));
      for (const version of checksums.keys()) {
        if (!known.has(version)) {
          logger?.warn(`Migration ${String(version).padStart(4, '0')} is recorded in ${table} but its file is missing`);
        }
      }

      const pending = migrations.filter((migration) => !checksums.has(migration.version));
      const applied: AppliedMigration[] = [];
      for (const migration of pending) {
        logger?.info(`Applying migration ${migration.fileName}`);
        const durationMs = await applyMigration(client, table, migration);
        applied.push({ version: migration.version, name: migration.name, durationMs });
        logger?.info(`Applied migration ${migration.fileName} in ${durationMs} ms`);
      }
      if (applied.length === 0) logger?.info(`Schema "${schema}" is up to date (${migrations.length} migrations)`);
      return { applied, alreadyApplied: migrations.length - pending.length };
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]).catch(() => undefined);
    }
  } finally {
    // The session state (timeouts, locks) must not leak into the pool.
    client.release(true);
  }
}
