import * as z from 'zod';

import { UuidSchema } from '../domain/id.js';

/** Scopes that can be granted to an API key (machine clients). */
export const API_KEY_SCOPES = [
  'ais:ingest',
  'telemetry:ingest',
  'ais:read',
] as const;

/** An API key scope. */
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Zod schema of {@link ApiKeyScope}. */
export const ApiKeyScopeSchema = z
  .enum(API_KEY_SCOPES)
  .describe('API key scope');

/** Returns `true` when `value` is a known API key scope. */
export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return API_KEY_SCOPES.some((scope) => scope === value);
}

/**
 * The known scopes among `values`, deduplicated, in input order. Unknown
 * scopes (granted by a newer auth service) are dropped, never rejected, so
 * consumers on an older contracts version keep working (forward compatible,
 * like access token roles).
 */
export function parseScopes(values: readonly string[]): ApiKeyScope[] {
  return [...new Set(values.filter(isApiKeyScope))];
}

/** Alphabet of the API key id and secret (base62: digits, upper, lower). */
export const BASE62_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Literal prefix of every API key. */
export const API_KEY_PREFIX = 'sk_';

/** Length of the public key id. */
export const API_KEY_ID_LENGTH = 10;

/** Length of the secret part. */
export const API_KEY_SECRET_LENGTH = 32;

/** Full API key format: `sk_<10 base62 id>_<32 base62 secret>`. */
export const API_KEY_PATTERN = /^sk_([0-9A-Za-z]{10})_([0-9A-Za-z]{32})$/;

const BASE62_PATTERN = /^[0-9A-Za-z]+$/;

/** Zod schema of a well-formed API key (format only, not its validity). */
export const ApiKeySchema = z
  .string()
  .regex(API_KEY_PATTERN)
  .describe('API key sk_<id>_<secret>');

/** The two random parts of an API key. */
export interface ApiKeyParts {
  /** Public id (10 base62 characters). */
  readonly id: string;
  /** Secret (32 base62 characters). */
  readonly secret: string;
}

/** A parsed API key. */
export interface ParsedApiKey extends ApiKeyParts {
  /** Public lookup prefix `sk_<id>`, stored unhashed (`api_keys.prefix`). */
  readonly prefix: string;
}

const isBase62OfLength = (value: string, length: number): boolean =>
  value.length === length && BASE62_PATTERN.test(value);

/** Public lookup prefix of a key id: `sk_<id>`. */
export function apiKeyPrefix(id: string): string {
  return `${API_KEY_PREFIX}${id}`;
}

/**
 * Assembles an API key from its parts. Random generation stays in the auth
 * service; this only enforces the format.
 *
 * @throws {RangeError} when a part has the wrong length or alphabet.
 */
export function formatApiKey(parts: ApiKeyParts): string {
  if (!isBase62OfLength(parts.id, API_KEY_ID_LENGTH)) {
    throw new RangeError(
      `API key id must be ${API_KEY_ID_LENGTH} base62 characters`,
    );
  }
  if (!isBase62OfLength(parts.secret, API_KEY_SECRET_LENGTH)) {
    throw new RangeError(
      `API key secret must be ${API_KEY_SECRET_LENGTH} base62 characters`,
    );
  }
  return `${apiKeyPrefix(parts.id)}_${parts.secret}`;
}

/**
 * Parses an API key.
 *
 * @returns its parts, or `null` when `key` is not a well-formed API key.
 */
export function parseApiKey(key: string): ParsedApiKey | null {
  const match = API_KEY_PATTERN.exec(key);
  const id = match?.[1];
  const secret = match?.[2];
  if (id === undefined || secret === undefined) return null;
  return { id, secret, prefix: apiKeyPrefix(id) };
}

/** Returns `true` when `value` is a well-formed API key. */
export function isApiKey(value: unknown): boolean {
  return typeof value === 'string' && API_KEY_PATTERN.test(value);
}

/**
 * Log-safe representation of an API key: the public prefix only
 * (`sk_<id>_…`), or `[redacted]` when the value is not a key.
 */
export function maskApiKey(key: string): string {
  const parsed = parseApiKey(key);
  return parsed === null ? '[redacted]' : `${parsed.prefix}_…`;
}

/** Body of `POST /internal/api-keys/introspect`. */
export const ApiKeyIntrospectionRequestSchema = z.object({
  key: z.string().min(1),
});

/** Request body of the API key introspection endpoint. */
export type ApiKeyIntrospectionRequest = z.infer<
  typeof ApiKeyIntrospectionRequestSchema
>;

/** Response of `POST /internal/api-keys/introspect`. */
export const ApiKeyIntrospectionResultSchema = z.discriminatedUnion('active', [
  z.object({
    active: z.literal(true),
    keyId: UuidSchema,
    orgId: UuidSchema,
    scopes: z
      .array(z.string())
      .transform((values) => parseScopes(values))
      .describe('Granted scopes; unknown (newer) scopes are dropped'),
    name: z.string(),
  }),
  z.object({ active: z.literal(false) }),
]);

/** Introspection result: an active key with its tenant and scopes, or inactive. */
export type ApiKeyIntrospectionResult = z.infer<
  typeof ApiKeyIntrospectionResultSchema
>;
