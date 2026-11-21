import fastifyCookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import type { FastifyMultipartOptions } from '@fastify/multipart';
import { HTTP_HEADERS } from '@darmawanweb/ais-its-contracts/auth';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';

import type { BaseConfig } from '../config/env-schema.js';
import { registerHttpMetrics } from '../metrics/http-metrics.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { GLOBAL_PREFIX, PREFIX_EXCLUDED_ROUTES } from './global-prefix.js';
import {
  buildOpenApiDocument,
  type OpenApiOptions,
  setupSwagger,
} from './openapi.js';

/** HTTP features of a service. */
export interface HttpFeatureOptions {
  /** OpenAPI metadata; `false` disables `/docs` and `/openapi.json`. */
  readonly openapi?: OpenApiOptions | false | undefined;
  /** Registers `@fastify/cookie` (auth: refresh token cookie). Default `false`. */
  readonly cookies?: boolean | undefined;
  /** Registers `@fastify/multipart` (uploads); options such as `limits`. Default `false`. */
  readonly multipart?: boolean | FastifyMultipartOptions | undefined;
}

/** Headers browsers may read from cross-origin responses. */
const EXPOSED_HEADERS = [
  HTTP_HEADERS.REQUEST_ID,
  'Retry-After',
  'WWW-Authenticate',
];

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
 * credentials), optional cookies and multipart, and Swagger.
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
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: 600,
  });
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
