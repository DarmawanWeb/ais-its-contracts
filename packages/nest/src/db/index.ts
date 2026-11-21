/**
 * PostgreSQL + TimescaleDB + PostGIS access (spec §6): `DatabaseModule`,
 * injection decorators, transactions, PostGIS helpers for drizzle and the
 * forward-only SQL migrator.
 *
 * @packageDocumentation
 */
export {
  DatabaseLifecycle,
  type DatabaseModuleOptions,
} from './database-lifecycle.js';
export { DatabaseHealthIndicator } from './database.health.js';
export { DatabaseModule } from './database.module.js';
export {
  type IdempotencyKey,
  type IdempotencyOptions,
  type IdempotentResult,
  InvalidTableNameError,
  PROCESSED_EVENTS_TABLE,
  processedEventsTableSql,
  pruneProcessedEvents,
  quoteTableName,
  withIdempotency,
} from './idempotency.js';
export { type MigrationsCliOptions, runMigrationsCli } from './migrator/cli.js';
export {
  MIGRATION_FILE_PATTERN,
  migrationChecksum,
  type MigrationFile,
  MigrationFileError,
  NO_TRANSACTION_MARKER,
  parseMigration,
  readMigrationFiles,
} from './migrator/migration-files.js';
export {
  type AppliedMigration,
  MigrationChecksumMismatchError,
  MigrationOrderError,
  MigrationFailedError,
  migrationLockKey,
  type MigrationLogger,
  type MigrationReport,
  MigrationSchemaMissingError,
  runMigrations,
  type RunMigrationsOptions,
} from './migrator/migrator.js';
export { splitSqlStatements } from './migrator/sql-splitter.js';
export {
  createDatabasePool,
  DatabaseConfigError,
  type DatabasePoolSettings,
  databasePoolSettings,
  poolConfig,
} from './pool.js';
export {
  bboxEnvelope,
  bboxEnvelopeGeography,
  distanceM,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated alias kept for compatibility
  distanceMeters,
  geoJsonToGeography,
  type GeoJsonGeometry,
  type GeoJsonGeometryType,
  type GeoJsonPoint,
  geography,
  geographyAsGeoJson,
  geographyIntersectsBBox,
  type GeographySubtype,
  pointGeography,
  withinM,
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated alias kept for compatibility
  withinMeters,
} from './postgis.js';
export {
  type Database,
  DATABASE_OPTIONS,
  DRIZZLE_DB,
  InjectDb,
  InjectPool,
  PG_POOL,
} from './tokens.js';
export {
  type IsolationLevel,
  type TransactionOptions,
  withTransaction,
} from './transaction.js';
/**
 * The `pg` types of `@InjectPool()` and `withTransaction()` (re-exported so
 * that services need no direct `pg` / `@types/pg` dependency under pnpm's
 * strict layout).
 */
export type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
