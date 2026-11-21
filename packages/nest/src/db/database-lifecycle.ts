import { resolve } from 'node:path';

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { errorMessage, retryUntilDeadline } from '../common/retry.js';
import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { type MigrationLogger, runMigrations } from './migrator/migrator.js';
import { databasePoolSettings } from './pool.js';
import { DATABASE_OPTIONS, InjectPool } from './tokens.js';

/** Options of `DatabaseModule.forRoot()`. */
export interface DatabaseModuleOptions {
  /** Drizzle schema module (`import * as schema from './db/schema.js'`) for relational queries. */
  readonly schema?: Record<string, unknown> | undefined;
  /** Directory of the SQL migrations. Default `<cwd>/migrations`. */
  readonly migrationsDir?: string | undefined;
  /** Overrides `DB_MIGRATE_ON_BOOT`. */
  readonly migrateOnBoot?: boolean | undefined;
  /** How long startup waits for the database, ms. Default 30 s. */
  readonly connectTimeoutMs?: number | undefined;
}

/**
 * Connection lifecycle of the pool: on init it waits for the database
 * (bounded retries), checks the schema and runs the migrations when
 * `DB_MIGRATE_ON_BOOT` — all before the HTTP port opens; on shutdown, after
 * the HTTP server stopped, it closes the pool.
 */
@Injectable()
export class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Database');
  private closed = false;

  constructor(
    @InjectPool() private readonly pool: Pool,
    @InjectConfig() private readonly config: BaseConfig,
    @Inject(DATABASE_OPTIONS) private readonly options: DatabaseModuleOptions,
  ) {}

  /** Waits for the database and applies the migrations. */
  async onModuleInit(): Promise<void> {
    const { schema } = databasePoolSettings(this.config);
    await retryUntilDeadline(() => this.pool.query('SELECT 1'), {
      deadlineMs: this.options.connectTimeoutMs ?? 30_000,
      onRetry: (error, attempt, delayMs) => {
        this.logger.warn(
          `Database not reachable (attempt ${attempt}: ${errorMessage(error)}), retrying in ${delayMs} ms`,
        );
      },
    });
    if (this.options.migrateOnBoot ?? this.config.DB_MIGRATE_ON_BOOT) {
      const logger: MigrationLogger = {
        info: (message) => {
          this.logger.log(message);
        },
        warn: (message) => {
          this.logger.warn(message);
        },
      };
      await runMigrations({
        pool: this.pool,
        schema,
        dir: this.options.migrationsDir ?? resolve('migrations'),
        logger,
      });
    }
  }

  /** Closes the pool (idempotent; safe when the application never started). */
  async onApplicationShutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
