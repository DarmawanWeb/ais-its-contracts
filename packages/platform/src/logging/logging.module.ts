import type { IncomingMessage, ServerResponse } from 'node:http';

import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { DestinationStream, Level } from 'pino';
import type { Options as PinoHttpOptions } from 'pino-http';

import { APP_CONFIG } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { buildLoggerOptions, loggerSettingsFromConfig } from './logger.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

/** The request record pino-http passes to `serializers.req`. */
interface SerializedRequest {
  readonly method: string;
  readonly url: string;
  readonly remoteAddress?: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/** The response record pino-http passes to `serializers.res`. */
interface SerializedResponse {
  readonly statusCode: number;
}

/** Paths whose successful requests are not logged by default. */
export const QUIET_PATHS: readonly string[] = ['/health/live', '/health/ready', '/metrics'];

/** Options of {@link LoggingModule.forRoot}. */
export interface LoggingModuleOptions {
  /** Receives the JSON lines instead of stdout (tests). */
  readonly destination?: DestinationStream | undefined;
  /** Paths whose successful requests are not logged. */
  readonly quietPaths?: readonly string[] | undefined;
}

/**
 * Path of a raw request. Middleware mounted on a sub-path (middie) sees a
 * mount-relative `url`; `originalUrl` keeps the full one.
 */
function pathOf(request: IncomingMessage & { readonly originalUrl?: string | undefined }): string {
  return (request.originalUrl ?? request.url ?? '').split('?', 1)[0] ?? '';
}

/** Level of the "request completed" line: 5xx error, 4xx warn, else info. */
function requestLogLevel(
  _request: IncomingMessage,
  response: ServerResponse,
  error?: Error,
): Level {
  if (error !== undefined || response.statusCode >= 500) return 'error';
  if (response.statusCode >= 400) return 'warn';
  return 'info';
}

/** nestjs-pino parameters of the platform (spec §10). */
export function buildHttpLoggerParams(
  config: BaseConfig,
  options: LoggingModuleOptions = {},
): Params {
  const { options: loggerOptions, prettyUnavailable } = buildLoggerOptions({
    ...loggerSettingsFromConfig(config),
    pretty: options.destination === undefined ? config.LOG_PRETTY : false,
  });
  const quiet = new Set(options.quietPaths ?? QUIET_PATHS);
  const httpOptions: PinoHttpOptions = {
    ...loggerOptions,
    customAttributeKeys: { reqId: 'requestId' },
    // Fastify already resolved the id (see `createFastifyAdapter`); middie
    // copies it to the raw request. The fallback covers other adapters.
    genReqId: (request) => request.id ?? resolveRequestId(request.headers[REQUEST_ID_HEADER]),
    quietReqLogger: true,
    customLogLevel: requestLogLevel,
    // Lean request/response records: no headers (credentials, cookies) at all.
    serializers: {
      req: (request: SerializedRequest) => ({
        method: request.method,
        url: request.url,
        remoteAddress: request.remoteAddress,
        userAgent: request.headers['user-agent'],
      }),
      res: (response: SerializedResponse) => ({ statusCode: response.statusCode }),
    },
    autoLogging: { ignore: (request) => quiet.has(pathOf(request)) },
  };
  if (prettyUnavailable) {
    process.emitWarning('LOG_PRETTY is enabled but pino-pretty is not installed: logging JSON');
  }
  return {
    pinoHttp:
      options.destination === undefined ? httpOptions : [httpOptions, options.destination],
    assignResponse: true,
  };
}

/**
 * Structured logging (nestjs-pino): JSON lines with `service`, `version`,
 * `requestId`, `traceId` and `principal`, credentials redacted, pretty output
 * when `LOG_PRETTY`. Imported by `bootstrapService()` / `buildTestApp()`;
 * inject `PinoLogger` or use Nest's `Logger` in application code.
 */
@Module({})
export class LoggingModule {
  /** Registers the global nestjs-pino logger configured from `APP_CONFIG`. */
  static forRoot(options: LoggingModuleOptions = {}): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRootAsync({
          inject: [APP_CONFIG],
          useFactory: (config: BaseConfig) => buildHttpLoggerParams(config, options),
        }),
      ],
      exports: [LoggerModule],
    };
  }
}
