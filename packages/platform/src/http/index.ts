/**
 * HTTP building blocks of the platform (used by `bootstrapService()` and the
 * test helpers): problem details filter, validation pipe, global prefix,
 * OpenAPI, the Fastify adapter and app configuration.
 *
 * @packageDocumentation
 */
export { configureApp, type HttpFeatureOptions } from './configure-app.js';
export {
  createFastifyAdapter,
  DEFAULT_BODY_LIMIT_BYTES,
  type FastifyAdapterOptions,
} from './fastify-adapter.js';
export {
  DOCS_PATH,
  GLOBAL_PREFIX,
  OPENAPI_JSON_PATH,
  PREFIX_EXCLUDED_ROUTES,
} from './global-prefix.js';
export {
  addProblemResponses,
  buildOpenApiDocument,
  type OpenApiOptions,
  type OpenApiTag,
  PROBLEM_DETAILS_SCHEMA_NAME,
  setupSwagger,
  writeOpenApiDocument,
} from './openapi.js';
export { SECURITY_SCHEMES } from './openapi-security.js';
export { ProblemDetailsFilter, WS_EXCEPTION_EVENT } from './problem-details.filter.js';
export { createValidationPipe, validationErrorsToFieldErrors } from './validation.js';
export {
  type CreatePlatformAppOptions,
  createPlatformApp,
  type ImportableModule,
  type PlatformApp,
  PlatformRootModule,
} from '../bootstrap/index.js';
