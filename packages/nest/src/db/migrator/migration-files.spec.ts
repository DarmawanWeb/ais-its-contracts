import { describe, expect, it } from 'vitest';

import {
  migrationChecksum,
  MigrationFileError,
  NO_TRANSACTION_MARKER,
  parseMigration,
} from './migration-files.js';
import { migrationLockKey } from './migrator.js';
import { splitSqlStatements } from './sql-splitter.js';

describe('migration files (spec §6)', () => {
  it('parses NNNN_snake_case.sql names and normalizes line endings before hashing', () => {
    const migration = parseMigration(
      '0002_add_zones.sql',
      'CREATE TABLE a ();\r\nCREATE TABLE b ();\r\n',
    );
    expect(migration).toMatchObject({
      version: 2,
      name: 'add_zones',
      transactional: true,
    });
    expect(migration.sql).toBe('CREATE TABLE a ();\nCREATE TABLE b ();\n');
    expect(migration.checksum).toBe(
      migrationChecksum('CREATE TABLE a ();\nCREATE TABLE b ();\n'),
    );
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
    for (const name of [
      '2_x.sql',
      '0001-init.sql',
      '0001_Init.sql',
      '0001_init.SQL',
    ]) {
      expect(() => parseMigration(name, '')).toThrow(MigrationFileError);
    }
  });

  it('recognizes the no-transaction marker on the first line only', () => {
    expect(NO_TRANSACTION_MARKER).toBe('-- aisits:no-transaction');
    expect(
      parseMigration(
        '0003_caggs.sql',
        `${NO_TRANSACTION_MARKER}\nCREATE MATERIALIZED VIEW x AS SELECT 1;`,
      ).transactional,
    ).toBe(false);
    expect(
      parseMigration('0003_caggs.sql', `SELECT 1;\n${NO_TRANSACTION_MARKER}`)
        .transactional,
    ).toBe(true);
    expect(migrationLockKey('safety')).toBe('aisits.migrations:safety');
  });
});

describe('splitSqlStatements', () => {
  it('splits at top-level semicolons only', () => {
    const sql = `
      -- comment; with a semicolon
      CREATE TABLE t (note text DEFAULT 'a;b', "odd;name" int);
      /* block; /* nested; */ comment */
      INSERT INTO t VALUES (E'it\\'s; fine', 1);
      DO $body$ BEGIN PERFORM 1; PERFORM 2; END $body$;
      CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;
      ;
      -- trailing comment only
    `;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain(`'a;b'`);
    expect(statements[1]).toContain(`E'it\\'s; fine'`);
    expect(statements[2]).toContain('PERFORM 2; END $body$');
    expect(statements[3]).toContain('$$ SELECT 1; $$');
  });
});
