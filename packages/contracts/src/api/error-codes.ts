/** HTTP status and default title of an error code. */
export interface ErrorDefinition {
  readonly status: number;
  readonly title: string;
}

/**
 * Stable error codes shared across services (`ProblemDetails.code`) with their
 * HTTP status and default title. Services may add service-specific codes; a
 * code is never renamed or reassigned to another status.
 */
export const ERROR_DEFINITIONS = {
  VALIDATION_FAILED: { status: 400, title: 'Validation failed' },
  BAD_REQUEST: { status: 400, title: 'Bad request' },
  INVALID_TOKEN: { status: 400, title: 'Invalid or expired token' },
  UNAUTHORIZED: { status: 401, title: 'Unauthorized' },
  INVALID_CREDENTIALS: { status: 401, title: 'Invalid credentials' },
  MFA_REQUIRED: {
    status: 401,
    title: 'Multi-factor authentication required',
  },
  INVALID_MFA_CODE: { status: 401, title: 'Invalid MFA code' },
  INVALID_API_KEY: { status: 401, title: 'Invalid API key' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  INSUFFICIENT_SCOPE: { status: 403, title: 'Insufficient API key scope' },
  /**
   * The route is restricted to platform administrators (`super_admin`),
   * whatever the permissions of the organization roles (spec 8.4); raised by
   * the kit's `@RequirePlatformAdmin()`.
   */
  PLATFORM_ADMIN_REQUIRED: {
    status: 403,
    title: 'Platform administrator required',
  },
  ACCOUNT_DISABLED: { status: 403, title: 'Account disabled' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  VESSEL_NOT_FOUND: { status: 404, title: 'Vessel not found' },
  CII_NOT_AVAILABLE: { status: 404, title: 'CII not available' },
  ORGANIZATION_NOT_FOUND: { status: 404, title: 'Organization not found' },
  USER_NOT_FOUND: { status: 404, title: 'User not found' },
  API_KEY_NOT_FOUND: { status: 404, title: 'API key not found' },
  DEVICE_NOT_FOUND: { status: 404, title: 'Device not found' },
  ZONE_NOT_FOUND: { status: 404, title: 'Zone not found' },
  SAFETY_EVENT_NOT_FOUND: { status: 404, title: 'Safety event not found' },
  SURVEILLANCE_EVENT_NOT_FOUND: {
    status: 404,
    title: 'Surveillance event not found',
  },
  ALERT_NOT_FOUND: { status: 404, title: 'Alert not found' },
  ALERT_RULE_NOT_FOUND: { status: 404, title: 'Alert rule not found' },
  CONFLICT: { status: 409, title: 'Conflict' },
  EMAIL_ALREADY_EXISTS: { status: 409, title: 'E-mail already registered' },
  MMSI_ALREADY_EXISTS: { status: 409, title: 'MMSI already registered' },
  REFERENCE_IN_USE: { status: 409, title: 'Reference data in use' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  RATE_LIMITED: { status: 429, title: 'Too many requests' },
  INTERNAL_ERROR: { status: 500, title: 'Internal server error' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
} as const satisfies Readonly<Record<string, ErrorDefinition>>;

/** A shared error code. */
export type ErrorCode = keyof typeof ERROR_DEFINITIONS;

/** Every shared error code, as an enum-like object (`ERROR_CODES.NOT_FOUND`). */
export const ERROR_CODES = Object.freeze(
  Object.fromEntries(
    Object.keys(ERROR_DEFINITIONS).map((code) => [code, code]),
  ),
) as { readonly [Code in ErrorCode]: Code };

/** Format of every error code, shared or service-specific: UPPER_SNAKE_CASE. */
export const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

/** Returns `true` when `value` is one of the shared {@link ErrorCode}s. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_DEFINITIONS, value);
}
