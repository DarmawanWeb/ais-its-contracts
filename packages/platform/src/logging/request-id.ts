import { randomUUID } from 'node:crypto';

/** Lower-case name of the request id header (`X-Request-Id`). */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Accepted incoming request ids: 1–128 visible characters that are safe in
 * logs and headers (letters, digits, `.`, `_`, `:`, `-`). Anything else is
 * replaced by a fresh UUID so that clients cannot inject log lines.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Request id of an incoming request (spec §5): the `X-Request-Id` header
 * when present and well-formed, otherwise a new UUID.
 */
export function resolveRequestId(header: string | readonly string[] | undefined): string {
  const value = typeof header === 'string' ? header : header?.[0];
  return value !== undefined && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}
