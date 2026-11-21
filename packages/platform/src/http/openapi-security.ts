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
