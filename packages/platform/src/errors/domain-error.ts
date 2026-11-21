import {
  ERROR_CODE_PATTERN,
  ERROR_DEFINITIONS,
  type ErrorCode,
  type FieldError,
  isErrorCode,
} from '@darmawanweb/seemp-contracts/api';

/** Shared error codes whose HTTP status is `Status`. */
export type ErrorCodeWithStatus<Status extends number> = {
  [Code in ErrorCode]: (typeof ERROR_DEFINITIONS)[Code]['status'] extends Status
    ? Code
    : never;
}[ErrorCode];

/**
 * A service-specific UPPER_SNAKE_CASE code (shared codes keep autocompletion:
 * `(string & {})` stops TypeScript from collapsing the union).
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- `string & {}` keeps literal autocompletion
export type CustomErrorCode = string & {};

/** Optional members of a {@link DomainError}. */
export interface DomainErrorOptions {
  /** Human-readable explanation of this occurrence (`detail`). */
  readonly detail?: string | undefined;
  /** Overrides the default title of the code. */
  readonly title?: string | undefined;
  /** Field-level problems (`errors`). */
  readonly errors?: readonly FieldError[] | undefined;
  /** Extension members added to the problem details (e.g. `{ mmsi }`). */
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
  /** Response headers to send with the problem (e.g. `Retry-After`). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Underlying error, logged but never sent to clients. */
  readonly cause?: unknown;
}

/** Options of a {@link DomainError} with a service-specific code. */
export interface CustomDomainErrorOptions extends DomainErrorOptions {
  /** HTTP status (required for codes that are not shared contracts codes). */
  readonly status: number;
  readonly title: string;
}

/**
 * Base class of expected business errors. The HTTP layer turns them into
 * RFC 9457 problem details (`type`, `title`, `status`, `detail`, `code`, …)
 * with the status of their code; anything that is not a `DomainError` (or a
 * Nest `HttpException`) becomes `500 INTERNAL_ERROR`.
 *
 * @example
 * throw new DomainError('VESSEL_NOT_FOUND', { detail: `No vessel with MMSI ${mmsi}` });
 * throw new DomainError('ZONE_GEOMETRY_INVALID', { status: 422, title: 'Invalid zone geometry' });
 */
export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  /** Stable UPPER_SNAKE_CASE code (`ProblemDetails.code`). */
  readonly code: string;
  /** HTTP status. */
  readonly status: number;
  /** Short summary of the problem type. */
  readonly title: string;
  /** Explanation of this occurrence. */
  readonly detail: string | undefined;
  /** Field-level problems. */
  readonly errors: readonly FieldError[] | undefined;
  /** Extension members of the problem details. */
  readonly extra: Readonly<Record<string, unknown>>;
  /** Response headers. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: ErrorCode, options?: DomainErrorOptions);
  constructor(code: CustomErrorCode, options: CustomDomainErrorOptions);
  constructor(code: string, options: DomainErrorOptions & { status?: number } = {}) {
    if (!ERROR_CODE_PATTERN.test(code)) {
      throw new RangeError(`Error code "${code}" is not UPPER_SNAKE_CASE`);
    }
    const definition = isErrorCode(code) ? ERROR_DEFINITIONS[code] : undefined;
    const status = options.status ?? definition?.status;
    const title = options.title ?? definition?.title;
    if (status === undefined || title === undefined) {
      throw new RangeError(
        `Error code "${code}" is not a shared code: pass its status and title`,
      );
    }
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`Invalid error status ${status}`);
    }
    super(options.detail ?? title, { cause: options.cause });
    this.code = code;
    this.status = status;
    this.title = title;
    this.detail = options.detail;
    this.errors = options.errors;
    this.extra = options.extra ?? {};
    this.headers = options.headers ?? {};
  }
}

/** Options of the {@link DomainError} subclasses. */
export interface SpecificErrorOptions<Code extends string> {
  /** A more specific code with the same status, e.g. `VESSEL_NOT_FOUND`. */
  readonly code?: Code | CustomErrorCode | undefined;
  readonly title?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
  readonly cause?: unknown;
}

function specific<Code extends string>(
  fallbackCode: ErrorCode,
  status: number,
  options: SpecificErrorOptions<Code>,
): { code: string; status: number; title: string } {
  const code = options.code ?? fallbackCode;
  const title =
    options.title ??
    (isErrorCode(code) ? ERROR_DEFINITIONS[code].title : ERROR_DEFINITIONS[fallbackCode].title);
  return { code, status, title };
}

/** `404` — the resource does not exist (or is not visible to the principal). */
export class NotFoundError extends DomainError {
  override readonly name: string = 'NotFoundError';

  constructor(detail?: string, options: SpecificErrorOptions<ErrorCodeWithStatus<404>> = {}) {
    const { code, status, title } = specific('NOT_FOUND', 404, options);
    super(code, { status, title, detail, extra: options.extra, cause: options.cause });
  }
}

/** `409` — the request conflicts with the current state (duplicates, references). */
export class ConflictError extends DomainError {
  override readonly name: string = 'ConflictError';

  constructor(detail?: string, options: SpecificErrorOptions<ErrorCodeWithStatus<409>> = {}) {
    const { code, status, title } = specific('CONFLICT', 409, options);
    super(code, { status, title, detail, extra: options.extra, cause: options.cause });
  }
}

/** `403` — authenticated, but not allowed (permission, scope, tenant). */
export class ForbiddenError extends DomainError {
  override readonly name: string = 'ForbiddenError';

  constructor(detail?: string, options: SpecificErrorOptions<ErrorCodeWithStatus<403>> = {}) {
    const { code, status, title } = specific('FORBIDDEN', 403, options);
    super(code, { status, title, detail, extra: options.extra, cause: options.cause });
  }
}

/** Options of {@link UnauthorizedError}. */
export interface UnauthorizedErrorOptions
  extends SpecificErrorOptions<ErrorCodeWithStatus<401>> {
  /**
   * `WWW-Authenticate` challenge (RFC 6750), default `Bearer`; e.g.
   * `Bearer error="invalid_token", error_description="The access token expired"`.
   */
  readonly challenge?: string | undefined;
}

/** `401` — missing, malformed, expired or unknown credentials. */
export class UnauthorizedError extends DomainError {
  override readonly name: string = 'UnauthorizedError';

  constructor(detail?: string, options: UnauthorizedErrorOptions = {}) {
    const { code, status, title } = specific('UNAUTHORIZED', 401, options);
    super(code, {
      status,
      title,
      detail,
      extra: options.extra,
      cause: options.cause,
      headers: { 'WWW-Authenticate': options.challenge ?? 'Bearer' },
    });
  }
}

/** `400 VALIDATION_FAILED` with field-level `errors`. */
export class ValidationFailedError extends DomainError {
  override readonly name: string = 'ValidationFailedError';

  constructor(errors: readonly FieldError[], detail?: string) {
    super('VALIDATION_FAILED', {
      errors,
      detail:
        detail ??
        (errors.length === 1
          ? 'The request has 1 invalid field'
          : `The request has ${errors.length} invalid fields`),
    });
  }
}

/** `400 BAD_REQUEST` — a malformed request that is not a field validation error. */
export class BadRequestError extends DomainError {
  override readonly name: string = 'BadRequestError';

  constructor(detail?: string, options: SpecificErrorOptions<ErrorCodeWithStatus<400>> = {}) {
    const { code, status, title } = specific('BAD_REQUEST', 400, options);
    super(code, { status, title, detail, extra: options.extra, cause: options.cause });
  }
}

/** Options of {@link RateLimitedError}. */
export interface RateLimitedErrorOptions {
  /** Seconds until the client may retry (`Retry-After`). */
  readonly retryAfterSeconds?: number | undefined;
  readonly detail?: string | undefined;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/** `429 RATE_LIMITED`, with `Retry-After` when known. */
export class RateLimitedError extends DomainError {
  override readonly name: string = 'RateLimitedError';
  /** Seconds until the client may retry. */
  readonly retryAfterSeconds: number | undefined;

  constructor(options: RateLimitedErrorOptions = {}) {
    const retryAfter =
      options.retryAfterSeconds === undefined
        ? undefined
        : Math.max(0, Math.ceil(options.retryAfterSeconds));
    super('RATE_LIMITED', {
      detail: options.detail,
      extra: options.extra,
      headers: retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) },
    });
    this.retryAfterSeconds = retryAfter;
  }
}

/** `503 SERVICE_UNAVAILABLE` — a dependency (auth, database, …) cannot be reached. */
export class ServiceUnavailableError extends DomainError {
  override readonly name: string = 'ServiceUnavailableError';

  constructor(detail?: string, options: { readonly cause?: unknown } = {}) {
    super('SERVICE_UNAVAILABLE', { detail, cause: options.cause });
  }
}
