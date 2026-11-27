/**
 * Names of the OpenAPI security schemes declared by the platform; the auth
 * decorators reference them on operations.
 */
export const SECURITY_SCHEMES = {
  /** `Authorization: Bearer <access token>` (default requirement of every operation). */
  BEARER: 'bearer',
  /** `X-API-Key: sk_<id>_<secret>` (operations decorated with `@AllowApiKey`). */
  API_KEY: 'apiKey',
  /** `X-Internal-Token` (service-to-service `/internal/*` operations). */
  INTERNAL_TOKEN: 'internalToken',
} as const;

/** OpenAPI extension listing the roles an operation requires (`@RequirePlatformAdmin`). */
export const PLATFORM_ADMIN_ROLES_EXTENSION = 'x-required-roles';

/**
 * Sentence `buildOpenApiDocument` adds to the description of operations that
 * require a platform administrator (`x-required-roles: ["super_admin"]`) and
 * accept API keys (`@AllowApiKey`, `x-api-key-scopes`): the `AuthGuard`
 * verifies the key, then refuses it with `403 PLATFORM_ADMIN_REQUIRED`.
 */
export const PLATFORM_ADMIN_DESCRIPTION =
  'Requires a platform administrator (super_admin); other users and API keys get 403 PLATFORM_ADMIN_REQUIRED.';

/**
 * Sentence `buildOpenApiDocument` adds to the description of operations that
 * require a platform administrator but do not accept API keys (no
 * `@AllowApiKey`): the `AuthGuard` answers an `X-API-Key` with `401
 * INVALID_API_KEY` before the administrator check.
 */
export const PLATFORM_ADMIN_WITHOUT_API_KEYS_DESCRIPTION =
  'Requires a platform administrator (super_admin); other users get 403 PLATFORM_ADMIN_REQUIRED, and API keys are not accepted on this route (401 INVALID_API_KEY).';

/** OpenAPI extension with the API key scopes of an `@AllowApiKey` operation. */
export const API_KEY_SCOPES_EXTENSION = 'x-api-key-scopes';
