import pg from 'pg';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,50}$/;

/** Options of {@link provisionServiceSchema}. */
export interface ProvisionSchemaOptions {
  /** Password of `<schema>_svc`. Default: the role name (development convention). */
  readonly password?: string | undefined;
}

/**
 * Replicates the infrastructure bootstrap for one service (spec §6,
 * `infra/postgres/bootstrap.sql`), as the superuser of `adminUrl`: the
 * `timescaledb`, `postgis` and `pgcrypto` extensions in `public`, the login
 * role `<schema>_svc` (no superuser, no CREATEDB/CREATEROLE), the schema owned
 * by it, `CONNECT`/`TEMPORARY` on the database, `USAGE` on `public` and the
 * role's `search_path`. Idempotent and serialized by an advisory lock, so
 * parallel test files can call it.
 *
 * @returns the service `DATABASE_URL` (`postgres://<schema>_svc:<password>@…`).
 */
export async function provisionServiceSchema(
  adminUrl: string,
  schema: string,
  options: ProvisionSchemaOptions = {},
): Promise<string> {
  if (!IDENTIFIER.test(schema)) throw new RangeError(`Invalid schema name "${schema}"`);
  const role = `${schema}_svc`;
  const password = options.password ?? role;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const database = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]?.db;
    if (database === undefined) throw new Error('Cannot read the current database');
    const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
    await client.query("SELECT pg_advisory_lock(hashtext('seemp.test.provision'))");
    try {
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS timescaledb WITH SCHEMA public;
        CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;
        CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        DO $provision$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal(role)}) THEN
            CREATE ROLE "${role}" LOGIN PASSWORD ${literal(password)};
          ELSE
            ALTER ROLE "${role}" LOGIN PASSWORD ${literal(password)};
          END IF;
        END
        $provision$;
        ALTER ROLE "${role}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION "${role}";
        ALTER SCHEMA "${schema}" OWNER TO "${role}";
        GRANT CONNECT, TEMPORARY ON DATABASE "${database}" TO "${role}";
        GRANT USAGE ON SCHEMA public TO "${role}";
        ALTER ROLE "${role}" SET search_path = "${schema}", public;
      `);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('seemp.test.provision'))");
    }
  } finally {
    await client.end();
  }
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** Drops a provisioned schema and its role (tests that need a clean slate). */
export async function dropServiceSchema(adminUrl: string, schema: string): Promise<void> {
  if (!IDENTIFIER.test(schema)) throw new RangeError(`Invalid schema name "${schema}"`);
  const role = `${schema}_svc`;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`
      DROP SCHEMA IF EXISTS "${schema}" CASCADE;
      DO $drop$
      BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
          EXECUTE format('REASSIGN OWNED BY %I TO CURRENT_USER', '${role}');
          EXECUTE format('DROP OWNED BY %I', '${role}');
          EXECUTE format('DROP ROLE %I', '${role}');
        END IF;
      END
      $drop$;
    `);
  } finally {
    await client.end();
  }
}
