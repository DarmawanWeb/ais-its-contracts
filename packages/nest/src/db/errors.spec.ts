import { DrizzleQueryError } from 'drizzle-orm/errors';
import pg from 'pg';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { errorMessage } from '../common/retry.js';
import { REDACT_PATHS } from '../logging/redaction.js';
import {
  databaseErrorInfo,
  isUniqueViolation,
  PG_SQLSTATES,
  SanitizedDatabaseError,
  sanitizeError,
  sqlStateOf,
} from './errors.js';

const EMAIL = 'alice.secret@example.com';
const QUERY =
  'insert into "auth"."users" ("id", "email") values (default, $1) returning "id"';

/** A pg `DatabaseError` as the driver throws it for a unique violation. */
function uniqueViolation(): pg.DatabaseError {
  const error = new pg.DatabaseError(
    'duplicate key value violates unique constraint "users_email_key"',
    120,
    'error',
  );
  Object.assign(error, {
    severity: 'ERROR',
    code: '23505',
    detail: `Key (email)=(${EMAIL}) already exists.`,
    schema: 'auth',
    table: 'users',
    constraint: 'users_email_key',
    routine: '_bt_check_unique',
    where: `SQL statement "INSERT … ${EMAIL}"`,
  });
  return error;
}

/** drizzle's wrapper: message and `params` hold the bound values. */
function drizzleError(cause: unknown = uniqueViolation()): DrizzleQueryError {
  return new DrizzleQueryError(QUERY, [EMAIL], cause as Error);
}

describe('sqlStateOf', () => {
  it('reads bare, drizzle-wrapped and nested causes, skipping non-SQLSTATE codes', () => {
    const bare = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
    });
    expect(sqlStateOf(bare)).toBe('40P01');
    expect(sqlStateOf(drizzleError(bare))).toBe('40P01');
    const nested = new Error('saving failed', {
      cause: Object.assign(new Error('wrapper'), {
        code: 'NOT_FOUND',
        cause: drizzleError(bare),
      }),
    });
    expect(sqlStateOf(nested)).toBe('40P01');
    expect(
      sqlStateOf(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })),
    ).toBeUndefined();
    expect(sqlStateOf('40P01')).toBeUndefined();
    expect(sqlStateOf(undefined)).toBeUndefined();
  });

  it('stops after 8 causes and survives cycles', () => {
    let error: Error = Object.assign(new Error('root'), { code: '40001' });
    for (let depth = 0; depth < 8; depth += 1)
      error = new Error(`level ${depth}`, { cause: error });
    expect(sqlStateOf(error)).toBeUndefined();
    const cyclic = new Error('a');
    cyclic.cause = new Error('b', { cause: cyclic });
    expect(sqlStateOf(cyclic)).toBeUndefined();
  });
});

describe('isUniqueViolation', () => {
  it('matches 23505 through drizzle, optionally by constraint', () => {
    expect(isUniqueViolation(drizzleError())).toBe(true);
    expect(isUniqueViolation(drizzleError(), 'users_email_key')).toBe(true);
    expect(isUniqueViolation(drizzleError(), 'users_pkey')).toBe(false);
    expect(
      isUniqueViolation(
        Object.assign(new Error('null'), {
          code: PG_SQLSTATES.NOT_NULL_VIOLATION,
        }),
      ),
    ).toBe(false);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
    // A sanitized error keeps what the mapping needs.
    expect(
      isUniqueViolation(sanitizeError(drizzleError()), 'users_email_key'),
    ).toBe(true);
  });
});

describe('databaseErrorInfo / sanitizeError (CORE-1)', () => {
  it('keeps the driver message, SQLSTATE, names and SQL text, drops the bound values', () => {
    const original = drizzleError();
    // The proof: drizzle exposes the value in the message and in `params`.
    expect(original.message).toContain(EMAIL);
    expect(Object.keys(original)).toEqual(['query', 'params', 'cause']);

    const info = databaseErrorInfo(original);
    expect(info).toEqual({
      message:
        'duplicate key value violates unique constraint "users_email_key"',
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
      column: undefined,
      schema: 'auth',
      routine: '_bt_check_unique',
      query: QUERY,
    });
    const sanitized = sanitizeError(original);
    expect(sanitized).toBeInstanceOf(SanitizedDatabaseError);
    expect(sanitized.message).toBe(info?.message);
    expect(sanitized.cause).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain(EMAIL);
    expect(sanitized.stack).not.toContain(EMAIL);
    expect(sanitized.stack).toMatch(/^SanitizedDatabaseError: duplicate key/);
    expect(sanitized.stack).toContain('errors.spec.ts');
    expect(sqlStateOf(sanitized)).toBe('23505');
    expect(databaseErrorInfo(sanitized)).toEqual(info);
    expect(sanitizeError(sanitized)).toBe(sanitized);
  });

  it('sanitizes bare driver errors and drizzle errors without a driver cause', () => {
    const bare = sanitizeError(uniqueViolation());
    expect(bare).toBeInstanceOf(SanitizedDatabaseError);
    expect(JSON.stringify(bare)).not.toContain(EMAIL);
    const connection = databaseErrorInfo(
      drizzleError(new Error('Connection terminated unexpectedly')),
    );
    expect(connection).toMatchObject({
      message: 'Connection terminated unexpectedly',
      code: undefined,
      query: QUERY,
    });
  });

  it('copies wrappers with a sanitized cause and leaves other errors alone', () => {
    class SavingFailed extends Error {
      override readonly name = 'SavingFailed';
      readonly entity = 'user';
    }
    const wrapper = new SavingFailed('Saving the user failed', {
      cause: drizzleError(),
    });
    const copy = sanitizeError(wrapper);
    expect(copy).not.toBe(wrapper);
    expect(copy).toBeInstanceOf(SavingFailed);
    expect(copy).toMatchObject({
      name: 'SavingFailed',
      message: 'Saving the user failed',
      entity: 'user',
    });
    expect(copy.stack).toBe(wrapper.stack);
    expect(copy.cause).toBeInstanceOf(SanitizedDatabaseError);
    expect(wrapper.cause).toBeInstanceOf(DrizzleQueryError);

    const plain = new Error('database password is hunter2');
    expect(sanitizeError(plain)).toBe(plain);
    expect(sanitizeError('text')).toBe('text');
    expect(databaseErrorInfo(plain)).toBeUndefined();
    // A wrapper's info is the one of the database error it wraps.
    expect(databaseErrorInfo(wrapper)?.code).toBe('23505');
  });

  it('gives errorMessage() the driver message (dead letter headers, outbox.last_error)', () => {
    expect(errorMessage(drizzleError())).toBe(
      'duplicate key value violates unique constraint "users_email_key"',
    );
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage(42)).toBe('42');
    expect(
      errorMessage(new Error('Saving failed', { cause: drizzleError() })),
    ).toBe('Saving failed');
  });

  it('keeps bound values out of pino lines, also as a redaction safety net', () => {
    const lines: string[] = [];
    const logger = pino(
      { redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } },
      { write: (line: string) => lines.push(line) },
    );
    logger.error({ err: sanitizeError(drizzleError()) }, 'insert failed');
    logger.error(
      { err: sanitizeError(new Error('wrapped', { cause: drizzleError() })) },
      'wrapped failure',
    );
    // Unsanitized errors logged by services: params and detail are redacted.
    logger.error({ err: drizzleError() }, 'raw');
    logger.error({ err: uniqueViolation() }, 'raw driver error');
    expect(lines).toHaveLength(4);
    for (const line of lines.slice(0, 2)) expect(line).not.toContain(EMAIL);
    const raw = JSON.parse(lines[2] ?? '{}') as { err: { params: unknown } };
    expect(raw.err.params).toBe('[REDACTED]');
    const driver = JSON.parse(lines[3] ?? '{}') as { err: { detail: unknown } };
    expect(driver.err.detail).toBe('[REDACTED]');
  });
});
