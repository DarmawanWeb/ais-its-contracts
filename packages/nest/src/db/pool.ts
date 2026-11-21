import pg from 'pg';

import type { BaseConfig } from '../config/env-schema.js';

const SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/** What a service pool is built from. */
export interface DatabasePoolSettings {
  /** `DATABASE_URL`. */
  readonly connectionString: string;
  /** `DATABASE_SCHEMA`: the pool's `search_path` is `<schema>,public`. */
  readonly schema: string;
  /** `DATABASE_POOL_MAX`. */
  readonly max: number;
  /** `DATABASE_STATEMENT_TIMEOUT_MS` (`0` = none). */
  readonly statementTimeoutMs: number;
  /** `application_name` (shown in `pg_stat_activity`). */
  readonly applicationName: string;
  /** Wait for a free connection, ms. Default 10 s. */
  readonly connectionTimeoutMs?: number | undefined;
  /** Close idle connections after, ms. Default 30 s. */
  readonly idleTimeoutMs?: number | undefined;
}

/** Thrown when the configuration lacks `DATABASE_URL` / `DATABASE_SCHEMA`. */
export class DatabaseConfigError extends Error {
  override readonly name = 'DatabaseConfigError';
}

/** Pool settings of a service configuration. */
export function databasePoolSettings(config: BaseConfig): DatabasePoolSettings {
  if (config.DATABASE_SCHEMA === undefined) {
    throw new DatabaseConfigError(
      'DATABASE_SCHEMA is required by DatabaseModule',
    );
  }
  if (config.DATABASE_URL === undefined) {
    throw new DatabaseConfigError('DATABASE_URL is required by DatabaseModule');
  }
  return {
    connectionString: config.DATABASE_URL,
    schema: config.DATABASE_SCHEMA,
    max: config.DATABASE_POOL_MAX,
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: config.SERVICE_NAME,
  };
}

/**
 * `pg.Pool` options: `search_path=<schema>,public` and the statement timeout
 * as startup parameters (every connection gets them before its first query).
 */
export function poolConfig(settings: DatabasePoolSettings): pg.PoolConfig {
  if (!SCHEMA_PATTERN.test(settings.schema)) {
    throw new DatabaseConfigError(`Invalid schema name "${settings.schema}"`);
  }
  return {
    connectionString: settings.connectionString,
    max: settings.max,
    application_name: settings.applicationName,
    options: `-c search_path=${settings.schema},public`,
    ...(settings.statementTimeoutMs > 0
      ? { statement_timeout: settings.statementTimeoutMs }
      : {}),
    connectionTimeoutMillis: settings.connectionTimeoutMs ?? 10_000,
    idleTimeoutMillis: settings.idleTimeoutMs ?? 30_000,
  };
}

/**
 * Creates a lazy pool (no connection until the first query). Errors of idle
 * connections (database restart) are reported to `onError` instead of
 * crashing the process.
 */
export function createDatabasePool(
  settings: DatabasePoolSettings,
  onError: (error: Error) => void = () => undefined,
): pg.Pool {
  const pool = new pg.Pool(poolConfig(settings));
  pool.on('error', onError);
  return pool;
}
