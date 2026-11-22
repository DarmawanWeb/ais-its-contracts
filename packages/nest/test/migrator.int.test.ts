import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { Module } from '@nestjs/common';

import { baseConfigSchema } from '../src/config/index.js';
import {
  createDatabasePool,
  DatabaseModule,
  MigrationChecksumMismatchError,
  MigrationFailedError,
  MigrationFileError,
  MigrationOrderError,
  MigrationSchemaMissingError,
  MigrationsDirectoryNotFoundError,
  migrationChecksum,
  runMigrations,
  runMigrationsCli,
} from '../src/db/index.js';
import {
  buildTestApp,
  createTestConfig,
  provisionServiceSchema,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

interface Fixture {
  readonly schema: string;
  readonly url: string;
  readonly pool: Pool;
  readonly dir: string;
}

const fixtures: Fixture[] = [];

async function fixture(
  files: Readonly<Record<string, string>>,
): Promise<Fixture> {
  const schema = uniqueName('mig');
  const url = await provisionServiceSchema(
    testInfra().postgresAdminUrl,
    schema,
  );
  const pool = createDatabasePool({
    connectionString: url,
    schema,
    max: 8,
    statementTimeoutMs: 15_000,
    applicationName: 'migrator-test',
  });
  const dir = await mkdtemp(join(tmpdir(), 'aisits-migrations-'));
  for (const [name, sql] of Object.entries(files))
    await writeFile(join(dir, name), sql);
  const created = { schema, url, pool, dir };
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  for (const { pool, dir } of fixtures.splice(0)) {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  for (const { pool, dir } of fixtures.splice(0)) {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});

const INIT = `CREATE TABLE things (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
INSERT INTO things (name) VALUES ('first; with a semicolon'), ($$dollar 'quoted'$$);
`;
const ADD_COLUMN =
  'ALTER TABLE things ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();\n';

describe('runMigrations', () => {
  it('applies pending migrations in order, records them, and is idempotent', async () => {
    const { pool, schema, dir } = await fixture({
      '0002_add_created_at.sql': ADD_COLUMN,
      '0001_init.sql': INIT,
      'README.md': 'ignored',
    });
    const messages: string[] = [];
    const logger = {
      info: (message: string) => messages.push(message),
      warn: (message: string) => messages.push(message),
    };

    const first = await runMigrations({ pool, schema, dir, logger });
    expect(first.applied.map((migration) => migration.version)).toEqual([1, 2]);
    expect(first.alreadyApplied).toBe(0);
    expect(messages).toContain('Applying migration 0001_init.sql');

    const recorded = await pool.query<{
      version: number;
      name: string;
      checksum: string;
      applied_at: Date;
    }>(
      `SELECT version, name, checksum, applied_at FROM "${schema}".schema_migrations ORDER BY version`,
    );
    expect(
      recorded.rows.map(({ version, name, checksum }) => ({
        version,
        name,
        checksum,
      })),
    ).toEqual([
      { version: 1, name: 'init', checksum: migrationChecksum(INIT) },
      {
        version: 2,
        name: 'add_created_at',
        checksum: migrationChecksum(ADD_COLUMN),
      },
    ]);
    expect(recorded.rows[0]?.applied_at).toBeInstanceOf(Date);

    // Unqualified names resolve to the service schema (search_path).
    const table = await pool.query<{ schema: string }>(
      "SELECT relnamespace::regnamespace::text AS schema FROM pg_class WHERE oid = to_regclass('things')",
    );
    expect(table.rows).toEqual([{ schema }]);
    expect(
      (await pool.query('SELECT name, created_at FROM things')).rowCount,
    ).toBe(2);

    const second = await runMigrations({ pool, schema, dir });
    expect(second).toEqual({ applied: [], alreadyApplied: 2 });
  });

  it('refuses to run when an applied migration changed', async () => {
    const { pool, schema, dir } = await fixture({ '0001_init.sql': INIT });
    await runMigrations({ pool, schema, dir });
    await writeFile(join(dir, '0001_init.sql'), `${INIT}-- edited\n`);
    await writeFile(join(dir, '0002_add_created_at.sql'), ADD_COLUMN);
    await expect(runMigrations({ pool, schema, dir })).rejects.toBeInstanceOf(
      MigrationChecksumMismatchError,
    );
    // Nothing after the mismatch was applied.
    const columns = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'things' AND column_name = 'created_at'",
      [schema],
    );
    expect(columns.rowCount).toBe(0);
  });

  it('ignores line-ending differences in the checksum', async () => {
    const { pool, schema, dir } = await fixture({ '0001_init.sql': INIT });
    await runMigrations({ pool, schema, dir });
    await writeFile(join(dir, '0001_init.sql'), INIT.replaceAll('\n', '\r\n'));
    await expect(runMigrations({ pool, schema, dir })).resolves.toEqual({
      applied: [],
      alreadyApplied: 1,
    });
  });

  it('rolls back a failing migration and reports the line', async () => {
    const { pool, schema, dir } = await fixture({
      '0001_init.sql': INIT,
      '0002_broken.sql':
        'CREATE TABLE partial (id int);\nSELECT * FROM missing_table;\n',
    });
    const error = await runMigrations({ pool, schema, dir }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(MigrationFailedError);
    expect((error as Error).message).toMatch(
      /0002_broken\.sql failed: .*missing_table.*\(line 2\).*rolled back/,
    );
    expect(
      (
        await pool.query(
          "SELECT 1 FROM pg_tables WHERE tablename = 'partial' AND schemaname = $1",
          [schema],
        )
      ).rowCount,
    ).toBe(0);
    const recorded = await pool.query(
      `SELECT version FROM "${schema}".schema_migrations`,
    );
    expect(recorded.rows).toEqual([{ version: 1 }]);
  });

  it('serializes concurrent runners with an advisory lock (each migration applied once)', async () => {
    const { pool, schema, dir } = await fixture({
      '0001_runs.sql':
        'CREATE TABLE runs (pid int NOT NULL);\nINSERT INTO runs VALUES (pg_backend_pid());\nSELECT pg_sleep(0.3);\n',
      '0002_more.sql': 'INSERT INTO runs VALUES (pg_backend_pid());\n',
    });
    const reports = await Promise.all(
      Array.from({ length: 4 }, () => runMigrations({ pool, schema, dir })),
    );
    expect(reports.map((report) => report.applied.length).sort()).toEqual([
      0, 0, 0, 2,
    ]);
    expect((await pool.query('SELECT pid FROM runs')).rowCount).toBe(2);
  });

  it('runs "-- aisits:no-transaction" migrations statement by statement (continuous aggregate)', async () => {
    const hypertable = `CREATE TABLE readings (
  time timestamptz NOT NULL,
  device text NOT NULL,
  value double precision NOT NULL
);
SELECT create_hypertable('readings', by_range('time', INTERVAL '1 day'));
`;
    const continuous = `-- aisits:no-transaction
-- Materializing a continuous aggregate (WITH DATA, refresh) cannot run in a transaction block.
CREATE MATERIALIZED VIEW readings_hourly WITH (timescaledb.continuous) AS
  SELECT time_bucket(INTERVAL '1 hour', time) AS bucket, device, avg(value) AS avg_value
  FROM readings
  GROUP BY bucket, device
  WITH DATA;
SELECT add_continuous_aggregate_policy('readings_hourly',
  start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour');
CALL refresh_continuous_aggregate('readings_hourly', NULL, now() - INTERVAL '1 hour');
`;
    const { pool, schema, dir } = await fixture({
      '0001_readings.sql': hypertable,
      '0002_readings_hourly.sql': continuous,
    });
    const report = await runMigrations({ pool, schema, dir });
    expect(report.applied.map((migration) => migration.name)).toEqual([
      'readings',
      'readings_hourly',
    ]);
    const aggregates = await pool.query<{ view_name: string }>(
      'SELECT view_name FROM timescaledb_information.continuous_aggregates WHERE view_schema = $1',
      [schema],
    );
    expect(aggregates.rows).toEqual([{ view_name: 'readings_hourly' }]);
    await pool.query(
      "INSERT INTO readings VALUES (now() - INTERVAL '2 hours', 'meter-1', 3), (now() - INTERVAL '2 hours', 'meter-1', 5)",
    );
    await pool.query(
      "CALL refresh_continuous_aggregate('readings_hourly', NULL, now() - INTERVAL '1 hour')",
    );
    const averages = await pool.query<{ avg_value: number }>(
      'SELECT avg_value FROM readings_hourly',
    );
    expect(averages.rows).toEqual([{ avg_value: 4 }]);
  });

  it('needs the marker: the same continuous aggregate fails inside a transaction', async () => {
    const { pool, schema, dir } = await fixture({
      '0001_readings.sql':
        "CREATE TABLE readings (time timestamptz NOT NULL, value double precision);\nSELECT create_hypertable('readings', by_range('time'));\n",
      '0002_readings_hourly.sql':
        "CREATE MATERIALIZED VIEW readings_hourly WITH (timescaledb.continuous) AS SELECT time_bucket(INTERVAL '1 hour', time) AS bucket, avg(value) FROM readings GROUP BY bucket WITH DATA;\n",
    });
    await expect(runMigrations({ pool, schema, dir })).rejects.toThrow(
      /transaction block/,
    );
    // The failed migration left nothing behind.
    const leftovers = await pool.query(
      "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'readings_hourly' AND n.nspname = $1",
      [schema],
    );
    expect(leftovers.rowCount).toBe(0);
  });

  it('reports a missing schema and misnamed files clearly', async () => {
    const { pool, dir } = await fixture({ '0001_init.sql': INIT });
    const missing = runMigrations({ pool, schema: 'does_not_exist', dir });
    await expect(missing).rejects.toBeInstanceOf(MigrationSchemaMissingError);
    await expect(missing).rejects.toThrow(/does_not_exist/);
    await writeFile(join(dir, '1_bad.sql'), 'SELECT 1;');
    const misnamed = runMigrations({ pool, schema: 'does_not_exist', dir });
    await expect(misnamed).rejects.toBeInstanceOf(MigrationFileError);
    await expect(misnamed).rejects.toThrow(/1_bad\.sql/);
  });

  it('refuses a migration numbered below the newest applied one, unless allowed', async () => {
    const { pool, dir, schema } = await fixture({
      '0001_init.sql': INIT,
      '0003_third.sql': 'CREATE TABLE third (id int);',
    });
    expect(
      (await runMigrations({ pool, schema, dir })).applied.map(
        (m) => m.version,
      ),
    ).toEqual([1, 3]);
    // Merged from another branch after 0003 was deployed:
    await writeFile(
      join(dir, '0002_second.sql'),
      'CREATE TABLE second (id int);',
    );
    const refused = runMigrations({ pool, schema, dir });
    await expect(refused).rejects.toBeInstanceOf(MigrationOrderError);
    await expect(refused).rejects.toThrow(/0002_second\.sql.*0003/);
    expect(
      (
        await runMigrations({ pool, schema, dir, allowOutOfOrder: true })
      ).applied.map((m) => m.version),
    ).toEqual([2]);
  });
});

describe('runMigrationsCli', () => {
  it('migrates DATABASE_SCHEMA from the environment and closes its pool', async () => {
    const { schema, url, dir, pool } = await fixture({ '0001_init.sql': INIT });
    const saved = { ...process.env };
    Object.assign(process.env, {
      SERVICE_NAME: 'cli-test',
      DATABASE_URL: url,
      DATABASE_SCHEMA: schema,
      LOG_LEVEL: 'silent',
      LOG_PRETTY: 'false',
    });
    try {
      const report = await runMigrationsCli({ dir });
      expect(report?.applied.map((migration) => migration.version)).toEqual([
        1,
      ]);
      expect(process.exitCode ?? 0).toBe(0);
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM things')).rows,
      ).toEqual([{ count: 2 }]);
    } finally {
      process.env = saved;
    }
  });
});

describe('migrations directory (CORE-19)', () => {
  it('boots from another working directory only with migrationsDir', async () => {
    const { schema, url, dir, pool } = await fixture({ '0001_init.sql': INIT });
    const elsewhere = await mkdtemp(join(tmpdir(), 'kit-elsewhere-'));
    const previous = process.cwd();
    const boot = async (migrationsDir?: string) => {
      @Module({
        imports: [
          DatabaseModule.forRoot(
            migrationsDir === undefined ? {} : { migrationsDir },
          ),
        ],
      })
      class AppModule {}
      return buildTestApp(AppModule, {
        config: createTestConfig(baseConfigSchema, {
          DATABASE_URL: url,
          DATABASE_SCHEMA: schema,
          DB_MIGRATE_ON_BOOT: 'true',
        }),
      });
    };
    process.chdir(elsewhere);
    try {
      const error = await boot().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MigrationsDirectoryNotFoundError);
      expect(error).toMatchObject({
        directory: join(elsewhere, 'migrations'),
        cwd: elsewhere,
      });
      expect((error as Error).message).toMatch(/migrationsDir/);

      const app = await boot(dir);
      await app.close();
      expect(
        (await pool.query('SELECT count(*)::int AS count FROM things')).rows,
      ).toEqual([{ count: 2 }]);
    } finally {
      process.chdir(previous);
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
