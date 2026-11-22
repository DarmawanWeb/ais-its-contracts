import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** File name of a migration: `NNNN_snake_case.sql` (spec §6). */
export const MIGRATION_FILE_PATTERN =
  /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/** First-line marker of migrations that must run outside a transaction. */
export const NO_TRANSACTION_MARKER = '-- aisits:no-transaction';

/** A migration read from disk. */
export interface MigrationFile {
  /** `NNNN` as a number. */
  readonly version: number;
  /** The snake_case part of the file name. */
  readonly name: string;
  readonly fileName: string;
  /** SQL with line endings normalized to `\n`. */
  readonly sql: string;
  /** SHA-256 (hex) of `sql`. */
  readonly checksum: string;
  /** `true` when the first line is {@link NO_TRANSACTION_MARKER}. */
  readonly transactional: boolean;
}

/** Thrown for unreadable, misnamed or duplicated migration files. */
export class MigrationFileError extends Error {
  override readonly name: string = 'MigrationFileError';
}

/**
 * The migrations directory does not exist. Its default, `migrations`, is
 * resolved against the working directory of the process, so a service
 * started from another directory (`node /srv/fleet/dist/main.js`) does not
 * find it: pass `migrationsDir` (`DatabaseModule.forRoot`) and `dir`
 * (`runMigrationsCli`) as absolute paths derived from the module location,
 * e.g. `fileURLToPath(new URL('../migrations', import.meta.url))`.
 */
export class MigrationsDirectoryNotFoundError extends MigrationFileError {
  override readonly name: string = 'MigrationsDirectoryNotFoundError';

  /**
   * @param directory the absolute directory that was looked up.
   * @param cwd the working directory it was resolved against.
   */
  constructor(
    readonly directory: string,
    readonly cwd: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `Migrations directory "${directory}" does not exist (working directory "${cwd}"). ` +
        'Pass the absolute directory as migrationsDir (DatabaseModule.forRoot) or dir (runMigrationsCli), ' +
        "e.g. fileURLToPath(new URL('../migrations', import.meta.url)), instead of relying on the working directory.",
      options,
    );
  }
}

/** SHA-256 (hex) of a migration's normalized SQL. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Parses a migration file's content (line endings normalized). */
export function parseMigration(
  fileName: string,
  content: string,
): MigrationFile {
  const match = MIGRATION_FILE_PATTERN.exec(fileName);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new MigrationFileError(
      `Invalid migration file name "${fileName}": expected NNNN_snake_case.sql (e.g. 0001_init.sql)`,
    );
  }
  const sql = content.replace(/\r\n?/g, '\n');
  const firstLine = sql.split('\n', 1)[0]?.trim() ?? '';
  return {
    version: Number(match[1]),
    name: match[2],
    fileName,
    sql,
    checksum: migrationChecksum(sql),
    transactional: firstLine !== NO_TRANSACTION_MARKER,
  };
}

/**
 * Reads the `.sql` files of a migrations directory in version order. Other
 * files (README, …) are ignored; misnamed `.sql` files and duplicate
 * versions are errors.
 *
 * @throws {MigrationsDirectoryNotFoundError} when `dir` does not exist.
 * @throws {MigrationFileError} for an unreadable directory and invalid files.
 */
export async function readMigrationFiles(
  dir: string,
): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new MigrationsDirectoryNotFoundError(resolve(dir), process.cwd(), {
        cause: error,
      });
    throw new MigrationFileError(
      `Cannot read the migrations directory "${dir}"`,
      { cause: error },
    );
  }
  const migrations = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.sql'))
      .map(async (entry) =>
        parseMigration(entry, await readFile(join(dir, entry), 'utf8')),
      ),
  );
  migrations.sort((a, b) => a.version - b.version);
  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (current !== undefined && previous?.version === current.version) {
      throw new MigrationFileError(
        `Duplicate migration version ${current.version}: ${previous.fileName} and ${current.fileName}`,
      );
    }
  }
  return migrations;
}
