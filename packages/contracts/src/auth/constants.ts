/** Default JWT issuer (`AUTH_ISSUER`). */
export const DEFAULT_AUTH_ISSUER = 'ais-its-auth';

/** Default JWT audience (`AUTH_AUDIENCE`). */
export const DEFAULT_AUTH_AUDIENCE = 'ais-its-api';

/** JWS algorithm of access tokens (Ed25519). */
export const ACCESS_TOKEN_ALGORITHM = 'EdDSA';

/** `typ` claim of access tokens. */
export const ACCESS_TOKEN_TYPE = 'access';

/** Default access token lifetime in seconds (`ACCESS_TOKEN_TTL`). */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

/** Lifetime of the MFA challenge token returned by login, in seconds. */
export const MFA_TOKEN_TTL_SECONDS = 300;

/** Name of the refresh token cookie. */
export const REFRESH_TOKEN_COOKIE = 'aisits_rt';

/** `Path` attribute of the refresh token cookie. */
export const REFRESH_TOKEN_COOKIE_PATH = '/api/v2/auth';

/** Default refresh token lifetime in days (`REFRESH_TOKEN_TTL_DAYS`). */
export const REFRESH_TOKEN_TTL_DAYS = 30;

/** JWKS path of the auth service (outside the `/api/v2` prefix). */
export const JWKS_PATH = '/.well-known/jwks.json';

/** Internal API key introspection path of the auth service. */
export const API_KEY_INTROSPECTION_PATH = '/internal/api-keys/introspect';

/** How long services cache an API key introspection result, in milliseconds. */
export const API_KEY_INTROSPECTION_CACHE_TTL_MS = 60_000;

/** HTTP header names used across the platform. */
export const HTTP_HEADERS = {
  AUTHORIZATION: 'Authorization',
  API_KEY: 'X-API-Key',
  INTERNAL_TOKEN: 'X-Internal-Token',
  REQUEST_ID: 'X-Request-Id',
  /** Set by `GET /auth/verify` for the gateway `forwardAuth`. */
  USER_ID: 'X-User-Id',
  /** Set by `GET /auth/verify` for the gateway `forwardAuth`. */
  ORG_ID: 'X-Org-Id',
  /** Set by `GET /auth/verify` (comma separated) for the gateway `forwardAuth`. */
  ROLES: 'X-Roles',
  /** HMAC signature of outgoing webhooks: `sha256=<hex>` (spec 13.9). */
  WEBHOOK_SIGNATURE: 'X-AIS-ITS-Signature',
  /** Timestamp of outgoing webhooks, covered by the signature (spec 13.9). */
  WEBHOOK_TIMESTAMP: 'X-AIS-ITS-Timestamp',
} as const;

const BEARER_PATTERN = /^Bearer[ \t]+(\S+)[ \t]*$/i;

/**
 * Extracts the token of an `Authorization: Bearer <token>` header value.
 *
 * @returns the token, or `null` when the header is missing or not a bearer header.
 */
export function parseBearerToken(
  authorization: string | null | undefined,
): string | null {
  if (authorization === null || authorization === undefined) return null;
  return BEARER_PATTERN.exec(authorization)?.[1] ?? null;
}
