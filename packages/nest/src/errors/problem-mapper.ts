import { STATUS_CODES } from 'node:http';

import {
  ERROR_DEFINITIONS,
  type ErrorCode,
  type FieldError,
  isErrorCode,
  type ProblemDetails,
  problemTypeUri,
} from '@darmawanweb/ais-its-contracts/api';
import { HttpException } from '@nestjs/common';

import { DomainError } from './domain-error.js';

/** Request facts added to every problem. */
export interface ProblemContext {
  /** Request path (without the query string). */
  readonly instance?: string | undefined;
  /** Request id (`X-Request-Id`). */
  readonly requestId?: string | undefined;
  /** Trace id of the active span; defaults to the request id. */
  readonly traceId?: string | undefined;
  /**
   * Whether messages of unexpected (5xx) errors may be sent to the client.
   * `false` in production: clients only see a generic detail.
   */
  readonly exposeInternalErrors: boolean;
}

/** A problem ready to be sent: status, body and extra headers. */
export interface ProblemResponse {
  readonly status: number;
  readonly body: ProblemDetails;
  readonly headers: Readonly<Record<string, string>>;
  /** `true` for unexpected errors that must be logged with their stack. */
  readonly unexpected: boolean;
}

/** Codes of the HTTP statuses without a shared contracts code. */
const STATUS_CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Error code of a bare HTTP status: the shared code when there is one, else
 * the reason phrase in UPPER_SNAKE_CASE (`405` → `METHOD_NOT_ALLOWED`).
 */
export function errorCodeForStatus(status: number): string {
  const shared = STATUS_CODE_BY_STATUS[status];
  if (shared !== undefined) return shared;
  const phrase = STATUS_CODES[status];
  if (phrase === undefined)
    return status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST';
  return phrase
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function titleFor(code: string, status: number): string {
  if (isErrorCode(code)) return ERROR_DEFINITIONS[code].title;
  return STATUS_CODES[status] ?? 'Error';
}

function withContext(
  base: ProblemDetails,
  context: ProblemContext,
): ProblemDetails {
  const traceId = context.traceId ?? context.requestId;
  return {
    ...base,
    ...(context.instance === undefined ? {} : { instance: context.instance }),
    ...(traceId === undefined ? {} : { traceId }),
    ...(context.requestId === undefined
      ? {}
      : { requestId: context.requestId }),
  };
}

/** Reads the message of an `HttpException` response (`string` or `{ message }`). */
function httpExceptionDetail(exception: HttpException): string | undefined {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && 'message' in response) {
    const { message } = response;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return exception.message;
}

/** Reads `errors` of an `HttpException` created with a problem-shaped body. */
function httpExceptionErrors(
  exception: HttpException,
): FieldError[] | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('errors' in response)) return undefined;
  const { errors } = response;
  if (!Array.isArray(errors)) return undefined;
  const items: readonly unknown[] = errors;
  return items.filter(
    (item): item is FieldError =>
      typeof item === 'object' &&
      item !== null &&
      'field' in item &&
      typeof item.field === 'string' &&
      'message' in item &&
      typeof item.message === 'string',
  );
}

/**
 * HTTP status of framework errors that are not Nest exceptions, e.g. Fastify's
 * `FST_ERR_CTP_BODY_TOO_LARGE` (413) or `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415),
 * which carry a numeric `statusCode`.
 */
function frameworkStatus(error: unknown): number | undefined {
  if (!(error instanceof Error) || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
    ? statusCode
    : undefined;
}

/**
 * Maps any thrown value to RFC 9457 problem details (spec §5):
 * {@link DomainError}s keep their code, status and extensions; Nest
 * `HttpException`s and framework errors with a 4xx `statusCode` (Fastify)
 * get the code of their status; anything else is `500 INTERNAL_ERROR`, with a generic detail unless
 * `context.exposeInternalErrors`. Stacks are never part of the body.
 */
export function toProblemResponse(
  error: unknown,
  context: ProblemContext,
): ProblemResponse {
  if (error instanceof DomainError) {
    const body = withContext(
      {
        ...error.extra,
        type: problemTypeUri(error.code),
        title: error.title,
        status: error.status,
        code: error.code,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        ...(error.errors === undefined ? {} : { errors: [...error.errors] }),
      },
      context,
    );
    return {
      status: error.status,
      body,
      headers: error.headers,
      unexpected: error.status >= 500,
    };
  }

  if (error instanceof HttpException) {
    const status = error.getStatus();
    const code = errorCodeForStatus(status);
    const unexpected = status >= 500;
    const detail =
      unexpected && !context.exposeInternalErrors
        ? undefined
        : httpExceptionDetail(error);
    const errors = httpExceptionErrors(error);
    const body = withContext(
      {
        type: problemTypeUri(code),
        title: titleFor(code, status),
        status,
        code,
        ...(detail === undefined ? {} : { detail }),
        ...(errors === undefined ? {} : { errors }),
      },
      context,
    );
    return { status, body, headers: {}, unexpected };
  }

  const status = frameworkStatus(error);
  if (status !== undefined && status < 500) {
    const code = errorCodeForStatus(status);
    return {
      status,
      body: withContext(
        {
          type: problemTypeUri(code),
          title: titleFor(code, status),
          status,
          code,
          ...(error instanceof Error ? { detail: error.message } : {}),
        },
        context,
      ),
      headers: {},
      unexpected: false,
    };
  }

  const detail =
    context.exposeInternalErrors && error instanceof Error
      ? error.message
      : 'An unexpected error occurred';
  return {
    status: 500,
    body: withContext(
      {
        type: problemTypeUri('INTERNAL_ERROR'),
        title: ERROR_DEFINITIONS.INTERNAL_ERROR.title,
        status: 500,
        code: 'INTERNAL_ERROR',
        detail,
      },
      context,
    ),
    headers: {},
    unexpected: true,
  };
}
