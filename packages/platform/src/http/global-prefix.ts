/** Prefix of every public route (spec §5). */
export const GLOBAL_PREFIX = 'api/v2';

/** Path of the Swagger UI (outside the prefix). */
export const DOCS_PATH = 'docs';

/** Path of the OpenAPI JSON document (outside the prefix). */
export const OPENAPI_JSON_PATH = 'openapi.json';

/**
 * Routes served outside `/api/v2` (spec §5): health, metrics, docs, the
 * OpenAPI document, `/internal/*` and `/.well-known/*` (path-to-regexp v8
 * syntax, `{/*path}` = optional sub-path).
 */
export const PREFIX_EXCLUDED_ROUTES: readonly string[] = [
  'health{/*path}',
  'metrics',
  `${DOCS_PATH}{/*path}`,
  OPENAPI_JSON_PATH,
  'internal{/*path}',
  '.well-known{/*path}',
];
