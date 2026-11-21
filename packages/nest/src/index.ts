/**
 * `@darmawanweb/ais-its-nest` — the NestJS 12 kit of every AIS Maritime
 * Intelligence service. This entry holds the bootstrap, configuration,
 * errors and logging; feature modules live in the subpaths `./http`, `./db`,
 * `./nats`, `./redis`, `./auth`, `./audit`, `./health`, `./metrics`,
 * `./telemetry`, `./internal-http`, `./analytics` and `./testing`.
 *
 * @packageDocumentation
 */
export {
  bootstrapService,
  type BootstrapServiceOptions,
  exportOpenApi,
  type ExportOpenApiOptions,
  type ImportableModule,
  OpenApiDriftError,
  SHUTDOWN_SIGNALS,
} from './bootstrap/index.js';
export * from './config/index.js';
export * from './errors/index.js';
export * from './logging/index.js';
export type { OpenApiOptions, OpenApiTag } from './http/openapi.js';
