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
 * require a platform administrator (`x-required-roles: ["super_admin"]`).
 */
export const PLATFORM_ADMIN_DESCRIPTION =
  'Requires a platform administrator (super_admin); other users and API keys get 403 PLATFORM_ADMIN_REQUIRED.';
