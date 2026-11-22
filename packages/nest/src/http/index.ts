/**
 * HTTP building blocks of the platform (used by `bootstrapService()` and the
 * test helpers): problem details filter, validation pipe and validators,
 * path parameter decorators, global prefix, OpenAPI, the Fastify adapter,
 * app configuration, the client IP, and the list and query conventions of
 * spec §5 (page / cursor / time range / bbox DTOs, response builders and
 * their OpenAPI decorators).
 *
 * @packageDocumentation
 */
export { type ClientIpSource, clientIp } from './client-ip.js';
export {
  configureApp,
  type CorsFeatureOptions,
  DEFAULT_EXPOSED_HEADERS,
  exposedHeadersOf,
  type HttpFeatureOptions,
} from './configure-app.js';
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
  addPlatformAdminDescriptions,
  addProblemResponses,
  assertSecuritySchemesDeclared,
  buildOpenApiDocument,
  type OpenApiOptions,
  OpenApiSecurityError,
  type OpenApiTag,
  PROBLEM_DETAILS_SCHEMA_NAME,
  REFRESH_COOKIE_SECURITY_SCHEME,
  serializeOpenApiDocument,
  setupSwagger,
  writeOpenApiDocument,
} from './openapi.js';
export {
  PLATFORM_ADMIN_DESCRIPTION,
  PLATFORM_ADMIN_ROLES_EXTENSION,
  SECURITY_SCHEMES,
} from './openapi-security.js';
export {
  ApiCursorResponse,
  ApiPageResponse,
  BBoxQueryDto,
  bboxOf,
  CursorPageInfoDto,
  cursorPage,
  CursorQueryDto,
  decodeQueryCursor,
  IsBBox,
  MAX_CURSOR_LENGTH,
  MAX_PAGE,
  PageMetaDto,
  pageOffsetOf,
  PageQueryDto,
  paginate,
  resolveQueryTimeRange,
  TimeRangeQueryDto,
} from './pagination.js';
export {
  IntParam,
  type IntParamOptions,
  MmsiParam,
  parseIntParam,
  parseMmsiParam,
  parseUuidParam,
  type PathParamOptions,
  UuidParam,
} from './path-params.js';
export {
  ProblemDetailsFilter,
  WS_EXCEPTION_EVENT,
} from './problem-details.filter.js';
export {
  createValidationPipe,
  IsOptionalNotNull,
  validationErrorsToFieldErrors,
} from './validation.js';
export {
  type CreatePlatformAppOptions,
  createPlatformApp,
  type ImportableModule,
  type PlatformApp,
  PlatformRootModule,
} from '../bootstrap/index.js';
