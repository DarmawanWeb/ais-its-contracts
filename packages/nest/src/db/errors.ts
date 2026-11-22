/**
 * SQLSTATE codes the platform reacts to (PostgreSQL "Appendix A. Error
 * Codes"). Compare them with {@link sqlStateOf}, which also finds the code of
 * a driver error wrapped by drizzle.
 */
export const PG_SQLSTATES = {
  /** `23502 not_null_violation`. */
  NOT_NULL_VIOLATION: '23502',
  /** `23503 foreign_key_violation`. */
  FOREIGN_KEY_VIOLATION: '23503',
  /** `23505 unique_violation` (see {@link isUniqueViolation}). */
  UNIQUE_VIOLATION: '23505',
  /** `23514 check_violation`. */
  CHECK_VIOLATION: '23514',
  /** `40001 serialization_failure`: retry the transaction. */
  SERIALIZATION_FAILURE: '40001',
  /** `40P01 deadlock_detected`: retry the transaction. */
  DEADLOCK_DETECTED: '40P01',
  /**
   * `55P03 lock_not_available`: `NOWAIT` / `lock_timeout`, and TimescaleDB's
   * "could not refresh continuous aggregate … due to a concurrent refresh"
   * (see `refreshContinuousAggregate`).
   */
  LOCK_NOT_AVAILABLE: '55P03',
  /** `57014 query_canceled`, e.g. the statement timeout. */
  QUERY_CANCELED: '57014',
} as const;

/** A SQLSTATE of {@link PG_SQLSTATES}. */
export type PgSqlState = (typeof PG_SQLSTATES)[keyof typeof PG_SQLSTATES];

/** How deep cause chains are followed (wrappers of wrappers of driver errors). */
const MAX_CAUSE_DEPTH = 8;

/** Five digits or upper-case letters (SQLSTATE classes and conditions). */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/** A string property of `value`, when it has one. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value))
    return undefined;
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

/** `error` followed by its causes, at most {@link MAX_CAUSE_DEPTH} entries, no cycles. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (
    current !== undefined &&
    current !== null &&
    chain.length < MAX_CAUSE_DEPTH &&
    !chain.includes(current)
  ) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/**
 * The SQLSTATE of a database error: the `code` of the error itself or of the
 * first error of its cause chain (at most 8 deep) that carries one. drizzle
 * wraps driver errors in `DrizzleQueryError`, whose `cause` holds the code.
 * Codes that are not SQLSTATEs (`ECONNREFUSED`, a `DomainError` code) are
 * skipped.
 *
 * @returns e.g. `'40P01'`, or `undefined` when no error of the chain has one.
 * @example
 * if (sqlStateOf(error) === PG_SQLSTATES.FOREIGN_KEY_VIOLATION) throw new NotFoundError('No such vessel type');
 */
export function sqlStateOf(error: unknown): string | undefined {
  for (const entry of causeChain(error)) {
    const code = stringField(entry, 'code');
    if (code !== undefined && SQLSTATE_PATTERN.test(code)) return code;
  }
  return undefined;
}

/**
 * `true` when `error` (or one of its causes, see {@link sqlStateOf}) is a
 * PostgreSQL unique violation (`23505`), of the named constraint when
 * `constraint` is given.
 *
 * @example
 * catch (error) {
 *   if (isUniqueViolation(error, 'vessels_mmsi_key')) throw new ConflictError('MMSI already registered', { code: 'MMSI_ALREADY_EXISTS' });
 *   throw error;
 * }
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  for (const entry of causeChain(error)) {
    const code = stringField(entry, 'code');
    if (code === undefined || !SQLSTATE_PATTERN.test(code)) continue;
    if (code !== PG_SQLSTATES.UNIQUE_VIOLATION) return false;
    return (
      constraint === undefined ||
      stringField(entry, 'constraint') === constraint
    );
  }
  return false;
}

/**
 * What may be logged and shown about a database error: everything that
 * identifies the failure, nothing that echoes the values a statement bound.
 */
export interface DatabaseErrorInfo {
  /**
   * The driver's primary message, e.g. `duplicate key value violates unique
   * constraint "users_email_key"`; never drizzle's `Failed query: … params: …`.
   */
  readonly message: string;
  /** SQLSTATE (or the driver's error code, e.g. `ECONNRESET`), when there is one. */
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly schema: string | undefined;
  /** PostgreSQL source routine that raised the error (e.g. `_bt_check_unique`). */
  readonly routine: string | undefined;
  /** SQL text of the failed drizzle query, with `$n` placeholders and without the parameters. */
  readonly query: string | undefined;
}

/**
 * A database error without the bound values (see {@link sanitizeError}):
 * the message is the driver's primary message; `code`, `constraint`,
 * `table`, `column`, `schema`, `routine` and the parameterless SQL `query`
 * are kept, so {@link sqlStateOf} and {@link isUniqueViolation} still work on
 * it; drizzle's `params`, the driver's `detail` (`Key (email)=(…) already
 * exists`, `Failing row contains (…)`), `where`, `internalQuery` and the
 * original cause chain are dropped. Its stack keeps the frames of the
 * original error.
 */
export class SanitizedDatabaseError extends Error implements DatabaseErrorInfo {
  override readonly name = 'SanitizedDatabaseError';
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly schema: string | undefined;
  readonly routine: string | undefined;
  readonly query: string | undefined;

  /**
   * @param info what is kept of the original error.
   * @param original the original error, whose stack frames (never its
   *   message) are kept.
   */
  constructor(info: DatabaseErrorInfo, original?: unknown) {
    super(info.message);
    this.code = info.code;
    this.constraint = info.constraint;
    this.table = info.table;
    this.column = info.column;
    this.schema = info.schema;
    this.routine = info.routine;
    this.query = info.query;
    const frames = stackFrames(original);
    if (frames !== undefined)
      this.stack = `${this.name}: ${this.message}\n${frames}`;
  }
}

/** The `    at …` lines of an error's stack (its message may span lines). */
function stackFrames(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.stack === undefined) return undefined;
  const lines = error.stack.split('\n');
  const first = lines.findIndex((line) => /^\s+at\s/.test(line));
  return first === -1 ? undefined : lines.slice(first).join('\n');
}

/** drizzle's `DrizzleQueryError` (by shape: several drizzle copies may be loaded). */
function isDrizzleQueryError(
  error: unknown,
): error is Error & { readonly query: string; readonly cause?: unknown } {
  return (
    error instanceof Error &&
    stringField(error, 'query') !== undefined &&
    'params' in error &&
    Array.isArray(error.params) &&
    error.message.startsWith('Failed query:')
  );
}

/** A driver error with a SQLSTATE (`pg`'s `DatabaseError`, postgres.js `PostgresError`). */
function isDriverError(error: unknown): error is Error {
  const code = stringField(error, 'code');
  return (
    error instanceof Error &&
    code !== undefined &&
    SQLSTATE_PATTERN.test(code) &&
    stringField(error, 'severity') !== undefined
  );
}

/** `true` for the errors {@link sanitizeError} replaces (not their wrappers). */
function isDatabaseError(error: unknown): boolean {
  return (
    error instanceof SanitizedDatabaseError ||
    isDrizzleQueryError(error) ||
    isDriverError(error)
  );
}

/**
 * What may be logged about a database error ({@link DatabaseErrorInfo}):
 * drizzle's `DrizzleQueryError` and the cause chain (at most 8 deep) are
 * unwrapped down to the driver error, whose primary message, SQLSTATE,
 * constraint, table, column, schema and routine are kept, with the SQL text
 * of the drizzle query (placeholders only); bound parameters, `detail` and
 * `where` are not.
 *
 * @returns `undefined` when neither `error` nor one of its causes is a
 *   database error.
 */
export function databaseErrorInfo(
  error: unknown,
): DatabaseErrorInfo | undefined {
  const chain = causeChain(error);
  const sanitized = chain.find(
    (entry): entry is SanitizedDatabaseError =>
      entry instanceof SanitizedDatabaseError,
  );
  if (sanitized !== undefined) {
    const { message, code, constraint, table, column, schema, routine } =
      sanitized;
    return {
      message,
      code,
      constraint,
      table,
      column,
      schema,
      routine,
      query: sanitized.query,
    };
  }
  const queryIndex = chain.findIndex(isDrizzleQueryError);
  const driver = chain.find(isDriverError);
  if (queryIndex === -1 && driver === undefined) return undefined;
  const query =
    queryIndex === -1 ? undefined : stringField(chain[queryIndex], 'query');
  // Without a driver error: the cause drizzle wrapped (a connection error).
  const reason = driver ?? chain[queryIndex + 1];
  return {
    message:
      reason instanceof Error && reason.message !== ''
        ? reason.message
        : 'Database query failed',
    code: stringField(reason, 'code'),
    constraint: stringField(driver, 'constraint'),
    table: stringField(driver, 'table'),
    column: stringField(driver, 'column'),
    schema: stringField(driver, 'schema'),
    routine: stringField(driver, 'routine'),
    query,
  };
}

/**
 * `error` without the values its database statement bound, for logs, dead
 * letter headers and problem details (spec §10: no secrets or personal data
 * in logs):
 *
 * - a database error itself (drizzle's `DrizzleQueryError`, whose message
 *   and `params` hold every bound value, or a driver error, whose `detail`
 *   repeats key values) becomes a {@link SanitizedDatabaseError};
 * - any other error whose cause chain holds one is copied (same prototype
 *   and properties) with that cause sanitized — pino appends the messages
 *   and stacks of causes to the logged error;
 * - everything else is returned unchanged.
 *
 * @example
 * this.logger.error({ err: sanitizeError(error) }, 'Saving the vessel failed');
 */
export function sanitizeError(error: Error): Error;
export function sanitizeError(error: unknown): unknown;
export function sanitizeError(error: unknown): unknown {
  return sanitizeAt(error, 0);
}

function sanitizeAt(error: unknown, depth: number): unknown {
  if (error instanceof SanitizedDatabaseError) return error;
  if (isDatabaseError(error)) {
    const info = databaseErrorInfo(error);
    return info === undefined ? error : new SanitizedDatabaseError(info, error);
  }
  if (!(error instanceof Error) || depth >= MAX_CAUSE_DEPTH) return error;
  const { cause } = error;
  if (cause === undefined || cause === null) return error;
  const sanitizedCause = sanitizeAt(cause, depth + 1);
  if (sanitizedCause === cause) return error;
  const copy = Object.create(Object.getPrototypeOf(error) as object) as Error;
  for (const key of Reflect.ownKeys(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor !== undefined) Object.defineProperty(copy, key, descriptor);
  }
  // V8 serves `stack` through an accessor bound to the original error.
  Object.defineProperty(copy, 'stack', {
    value: error.stack,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(copy, 'cause', {
    value: sanitizedCause,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return copy;
}

/**
 * The message of a thrown value for logs and headers: the driver's primary
 * message for a database error ({@link databaseErrorInfo}), else the
 * error's own message, else `String(value)`.
 */
export function safeErrorMessage(error: unknown): string {
  if (isDatabaseError(error)) {
    const info = databaseErrorInfo(error);
    if (info !== undefined) return info.message;
  }
  return error instanceof Error ? error.message : String(error);
}
