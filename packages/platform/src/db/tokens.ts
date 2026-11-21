import { Inject } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Injection token of the service's `pg.Pool`. */
export const PG_POOL = 'SEEMP_PG_POOL';

/** Injection token of the drizzle database. */
export const DRIZZLE_DB = 'SEEMP_DRIZZLE_DB';

/** Injection token of the `DatabaseModule` options. */
export const DATABASE_OPTIONS = 'SEEMP_DATABASE_OPTIONS';

/**
 * The drizzle database of a service (`drizzle-orm/node-postgres`); pass the
 * service's schema module for relational queries: `Database<typeof schema>`.
 */
export type Database<TSchema extends Record<string, unknown> = Record<string, never>> =
  NodePgDatabase<TSchema>;

/** Injects the `pg.Pool` (`search_path=<schema>,public`). */
export function InjectPool(): PropertyDecorator & ParameterDecorator {
  return Inject(PG_POOL);
}

/** Injects the drizzle {@link Database}. */
export function InjectDb(): PropertyDecorator & ParameterDecorator {
  return Inject(DRIZZLE_DB);
}
