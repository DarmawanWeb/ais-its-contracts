import { type DynamicModule, Logger, Module } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { APP_CONFIG } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import {
  DatabaseLifecycle,
  type DatabaseModuleOptions,
} from './database-lifecycle.js';
import { DatabaseHealthIndicator } from './database.health.js';
import { createDatabasePool, databasePoolSettings } from './pool.js';
import { DATABASE_OPTIONS, DRIZZLE_DB, PG_POOL } from './tokens.js';

/**
 * PostgreSQL access (spec §6): a lazy `pg.Pool` with
 * `search_path=<DATABASE_SCHEMA>,public`, `DATABASE_POOL_MAX` connections and
 * the statement timeout, a drizzle database on top, a readiness check, and
 * migrations on boot (`DB_MIGRATE_ON_BOOT`). Global: inject anywhere with
 * `@InjectPool()` / `@InjectDb()`.
 *
 * @example
 * DatabaseModule.forRoot({ schema }) // import * as schema from './db/schema.js'
 */
@Module({})
export class DatabaseModule {
  /** Registers the pool, drizzle, the lifecycle and the readiness check. */
  static forRoot(options: DatabaseModuleOptions = {}): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: DATABASE_OPTIONS, useValue: options },
        {
          provide: PG_POOL,
          useFactory: (config: BaseConfig) => {
            const logger = new Logger('Database');
            return createDatabasePool(databasePoolSettings(config), (error) => {
              logger.error(`Idle database connection failed: ${error.message}`);
            });
          },
          inject: [APP_CONFIG],
        },
        {
          provide: DRIZZLE_DB,
          useFactory: (pool: Pool) =>
            options.schema === undefined
              ? drizzle({ client: pool })
              : drizzle({ client: pool, schema: options.schema }),
          inject: [PG_POOL],
        },
        DatabaseLifecycle,
        DatabaseHealthIndicator,
      ],
      exports: [PG_POOL, DRIZZLE_DB],
    };
  }
}
