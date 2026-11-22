/** Value written in place of redacted fields. */
export const REDACTED = '[REDACTED]';

/** Request / response headers that carry credentials. */
export const SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-internal-token',
] as const;

/** Payload fields that carry secrets, redacted at any of the first levels. */
export const SENSITIVE_FIELDS = [
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'mfaToken',
  'secret',
  'apiKey',
  'internalToken',
] as const;

const fieldPaths = (field: string): string[] => [
  field,
  `*.${field}`,
  `*.*.${field}`,
  `*.*.*.${field}`,
];

/**
 * Properties of logged errors (`err`) that echo the values a database
 * statement bound: drizzle's `DrizzleQueryError.params` and the driver's
 * `detail` (`Key (email)=(…) already exists`). A safety net: the kit logs
 * database errors through `sanitizeError` (`./db`), which drops both.
 */
export const SENSITIVE_ERROR_FIELDS = ['params', 'detail'] as const;

/**
 * pino `redact.paths` of the platform (spec §10: no secrets, tokens,
 * passwords or full API keys in logs): credential headers of the serialized
 * request/response, secret fields up to four levels deep, and the bound
 * values of logged database errors (`err.params`, `err.detail`).
 */
export const REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_HEADERS.flatMap((header) => [
    `req.headers["${header}"]`,
    `res.headers["${header}"]`,
    `headers["${header}"]`,
  ]),
  ...SENSITIVE_FIELDS.flatMap(fieldPaths),
  ...SENSITIVE_ERROR_FIELDS.map((field) => `err.${field}`),
];
