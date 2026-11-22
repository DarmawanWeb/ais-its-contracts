import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import type { FastifyMultipartOptions } from '@fastify/multipart';
import { HTTP_HEADERS } from '@darmawanweb/ais-its-contracts/auth';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { RawServerDefault } from 'fastify';

import type { BaseConfig } from '../config/env-schema.js';
import { registerHttpMetrics } from '../metrics/http-metrics.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { GLOBAL_PREFIX, PREFIX_EXCLUDED_ROUTES } from './global-prefix.js';
import {
  buildOpenApiDocument,
  type OpenApiOptions,
  setupSwagger,
} from './openapi.js';

/** CORS settings of a service (the origins come from `CORS_ORIGINS`). */
export interface CorsFeatureOptions {
  /**
   * Response headers cross-origin browser clients may read, in addition to
   * {@link DEFAULT_EXPOSED_HEADERS} (e.g. `X-Total-Count`, `X-Truncated`);
   * duplicates are dropped (case-insensitive).
   */
  readonly exposedHeaders?: readonly string[] | undefined;
}

/** HTTP features of a service. */
export interface HttpFeatureOptions {
  /** OpenAPI metadata; `false` disables `/docs` and `/openapi.json`. */
  readonly openapi?: OpenApiOptions | false | undefined;
  /** Registers `@fastify/cookie` (auth: refresh token cookie). Default `false`. */
  readonly cookies?: boolean | undefined;
  /** Registers `@fastify/multipart` (uploads); options such as `limits`. Default `false`. */
  readonly multipart?: boolean | FastifyMultipartOptions | undefined;
  /** CORS settings beyond the platform defaults. */
  readonly cors?: CorsFeatureOptions | undefined;
}

/**
 * Headers browsers may read from cross-origin responses of every service:
 * the request id, `Retry-After`, `WWW-Authenticate`, `ETag` and `Location`.
 */
export const DEFAULT_EXPOSED_HEADERS: readonly string[] = [
  HTTP_HEADERS.REQUEST_ID,
  'Retry-After',
  'WWW-Authenticate',
  'ETag',
  'Location',
];

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * `Access-Control-Expose-Headers` of a service: {@link DEFAULT_EXPOSED_HEADERS}
 * followed by `extra`, without duplicates (case-insensitive, first spelling
 * kept).
 *
 * @throws {RangeError} for a value that is not a header name, and for `*`
 *   (a literal header name in credentialed CORS, never a wildcard).
 */
export function exposedHeadersOf(extra: readonly string[] = []): string[] {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...DEFAULT_EXPOSED_HEADERS, ...extra]) {
    const header = raw.trim();
    if (!HEADER_NAME.test(header) || header === '*')
      throw new RangeError(
        `Invalid exposed header "${raw}": expected a header name (no lists, no wildcard)`,
      );
    const key = header.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    headers.push(header);
  }
  return headers;
}

/**
 * Replaces the `application/json` body parser: an empty body (a bodiless
 * `POST /alerts/:id/ack` from a client that always sends
 * `Content-Type: application/json`) parses to `undefined` instead of
 * Fastify's `400 FST_ERR_CTP_EMPTY_JSON_BODY`; anything else goes to
 * Fastify's default JSON parser with the server's body limit and
 * prototype-poisoning protection (`__proto__` / `constructor` keys are
 * refused with `400`). Routes expecting a DTO then answer
 * `400 VALIDATION_FAILED`.
 */
function registerJsonBodyParser(app: NestFastifyApplication): void {
  const fastify = app.getHttpAdapter().getInstance();
  const { bodyLimit, onProtoPoisoning, onConstructorPoisoning } =
    fastify.initialConfig;
  const parseJson = fastify.getDefaultJsonParser(
    onProtoPoisoning ?? 'error',
    onConstructorPoisoning ?? 'error',
  );
  // Through Nest, which would otherwise register its own JSON parser at init.
  app.useBodyParser<RawServerDefault>(
    'application/json',
    bodyLimit === undefined ? {} : { bodyLimit },
    (request, body, done) => {
      if (body.length === 0) {
        done(null, undefined);
        return;
      }
      void parseJson(request, body.toString('utf8'), done);
    },
  );
}

/**
 * Content Security Policy for a JSON API whose only HTML page is Swagger UI
 * (external scripts, inline styles, data: images).
 */
const CONTENT_SECURITY_POLICY = {
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    fontSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
  },
};

/**
 * Applies the platform HTTP conventions to a created (not yet initialized)
 * application: global prefix `api/v2` with its exclusions, `X-Request-Id`
 * response header, HTTP metrics, helmet, CORS from `CORS_ORIGINS` (with
 * credentials and the exposed headers), the JSON body parser (empty bodies
 * allowed), optional cookies and multipart, and Swagger.
 *
 * A service that needs its own `application/json` parser removes the
 * platform's first, in `configure`:
 * `app.getHttpAdapter().getInstance().removeContentTypeParser('application/json')`.
 *
 * @returns the OpenAPI document, when enabled.
 */
export async function configureApp(
  app: NestFastifyApplication,
  config: BaseConfig,
  options: HttpFeatureOptions = {},
): Promise<OpenAPIObject | undefined> {
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: [...PREFIX_EXCLUDED_ROUTES] });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request, reply, done) => {
    reply.header(HTTP_HEADERS.REQUEST_ID, request.id);
    done();
  });
  const metrics = app.get(MetricsService, { strict: false });
  registerHttpMetrics(fastify, metrics);

  await app.register(helmet, {
    contentSecurityPolicy: CONTENT_SECURITY_POLICY,
  });
  app.enableCors({
    origin: [...config.CORS_ORIGINS],
    credentials: true,
    exposedHeaders: exposedHeadersOf(options.cors?.exposedHeaders),
    maxAge: 600,
  });
  registerJsonBodyParser(app);
  if (options.cookies === true) await app.register(fastifyCookie);
  if (options.multipart !== undefined && options.multipart !== false) {
    const { default: multipart } = await import('@fastify/multipart');
    await app.register(
      multipart,
      options.multipart === true ? {} : options.multipart,
    );
  }

  if (options.openapi === undefined || options.openapi === false)
    return undefined;
  const document = buildOpenApiDocument(app, options.openapi);
  setupSwagger(app, document, options.openapi.title);
  return document;
}
