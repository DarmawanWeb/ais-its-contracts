import { resolve } from 'node:path';

import {
  baseConfigSchema,
  type ConfigSchema,
  loadConfig,
} from '../../config/define-config.js';
import {
  createLogger,
  loggerSettingsFromConfig,
} from '../../logging/logger.js';
import { createDatabasePool, databasePoolSettings } from '../pool.js';
import { type MigrationReport, runMigrations } from './migrator.js';

/** Options of {@link runMigrationsCli}. */
export interface MigrationsCliOptions {
  /** The service's config schema (default: the common variables only). */
  readonly configSchema?: ConfigSchema | undefined;
  /** Migrations directory. Default `<cwd>/migrations`. */
  readonly dir?: string | undefined;
}

/**
 * Entry point of a service's `pnpm migrate`: loads the configuration, applies
 * the pending migrations of `DATABASE_SCHEMA` and closes the pool. Sets
 * `process.exitCode = 1` on failure (the error is logged).
 *
 * @example
 * // src/migrate.ts — "migrate": "node dist/migrate.js"
 * import { runMigrationsCli } from '@darmawanweb/ais-its-nest/db';
 * import { configSchema } from './config.js';
 * await runMigrationsCli({ configSchema });
 */
export async function runMigrationsCli(
  options: MigrationsCliOptions = {},
): Promise<MigrationReport | undefined> {
  const config = loadConfig(options.configSchema ?? baseConfigSchema);
  const logger = createLogger({
    ...loggerSettingsFromConfig(config),
    service: `${config.SERVICE_NAME}-migrate`,
  });
  let pool;
  try {
    const settings = databasePoolSettings(config);
    pool = createDatabasePool(settings, (error) => {
      logger.error({ err: error }, 'Idle database connection failed');
    });
    const report = await runMigrations({
      pool,
      schema: settings.schema,
      dir: options.dir ?? resolve('migrations'),
      logger: {
        info: (message) => {
          logger.info(message);
        },
        warn: (message) => {
          logger.warn(message);
        },
      },
    });
    logger.info(
      {
        applied: report.applied.map((migration) => migration.version),
        alreadyApplied: report.alreadyApplied,
      },
      `Migrations done: ${report.applied.length} applied`,
    );
    return report;
  } catch (error) {
    logger.error({ err: error }, 'Migrations failed');
    process.exitCode = 1;
    return undefined;
  } finally {
    await pool?.end();
  }
}
