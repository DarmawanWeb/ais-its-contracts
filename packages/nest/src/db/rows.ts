import pg from 'pg';

/** OID of `timestamptz` (pg-types `builtins.TIMESTAMPTZ`). */
const TIMESTAMPTZ_OID = 1184;

/** The part of `pg.types` (pg-types, untyped under pnpm's strict layout) used here. */
interface PgTypeParsers {
  getTypeParser(oid: number, format: 'text'): (value: string) => unknown;
}

/**
 * pg's TIMESTAMPTZ text parser (postgres-date unless the process replaced it
 * with `pg.types.setTypeParser`), looked up once.
 */
let timestampTzParser: ((value: string) => unknown) | undefined;

function parseTimestampTz(value: string): unknown {
  const parser = (timestampTzParser ??= (
    pg as unknown as { readonly types: PgTypeParsers }
  ).types.getTypeParser(TIMESTAMPTZ_OID, 'text'));
  return parser(value);
}

/** `YYYY-MM-DDThh:mm…` (ISO-8601 date-time). */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * A `timestamptz` / `timestamp` / `date` value of a raw row as a `Date`.
 *
 * drizzle (node-postgres) overrides pg's type parsers for EVERY query it
 * runs, `db.execute(sql\`…\`)` included: those three types (and `interval`)
 * arrive as the strings PostgreSQL sent (`2026-11-22 11:15:44.123+00`), so
 * `db.execute<{ time: Date }>(…)` is typed wrongly and `row.time.getTime()`
 * throws. Read such columns as `Date | string` and convert them with this
 * (pg's own `timestamptz` parser; a `timestamp` without time zone is local
 * time, as pg reads it; ISO-8601 strings with a `T`, as JSON functions
 * render timestamps, are accepted too). Rows of the query builder (`db.select()`) are
 * already mapped by the column types; rows of `pool.query` are parsed by pg.
 *
 * @throws {RangeError} for `infinity`, `-infinity` and unparsable values.
 * @example
 * const { rows } = await db.execute<{ last_seen: Date | string }>(sql`SELECT max(time) AS last_seen FROM positions`);
 * const lastSeen = rowDateOrNull(rows[0]?.last_seen);
 */
export function rowDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new RangeError('rowDate: invalid Date');
    return value;
  }
  const parsed = parseTimestampTz(value);
  if (parsed instanceof Date && !Number.isNaN(parsed.getTime())) return parsed;
  // ISO-8601 with a `T`, as JSON functions (`to_json(time)`) render timestamps.
  if (ISO_DATE_TIME.test(value)) {
    const iso = new Date(value);
    if (!Number.isNaN(iso.getTime())) return iso;
  }
  throw new RangeError(
    `rowDate: "${value.slice(0, 64)}" is not a finite timestamp`,
  );
}

/**
 * {@link rowDate} for nullable columns: `null` (or `undefined`, e.g. a
 * missing row) gives `null`.
 */
export function rowDateOrNull(
  value: Date | string | null | undefined,
): Date | null {
  return value === null || value === undefined ? null : rowDate(value);
}
