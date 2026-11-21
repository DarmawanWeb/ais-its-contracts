import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';

import type { BaseConfig } from '../config/env-schema.js';
import { createFastifyAdapter } from '../http/fastify-adapter.js';
import {
  GLOBAL_PREFIX,
  PREFIX_EXCLUDED_ROUTES,
} from '../http/global-prefix.js';
import {
  buildOpenApiDocument,
  type OpenApiOptions,
  writeOpenApiDocument,
} from '../http/openapi.js';
import {
  type ImportableModule,
  PlatformRootModule,
} from './platform-root.module.js';

/** Options of {@link exportOpenApi}. */
export interface ExportOpenApiOptions {
  readonly appModule: ImportableModule;
  readonly config: BaseConfig;
  readonly openapi: OpenApiOptions;
  /** Output file (relative to the working directory), usually `openapi.json`. */
  readonly outFile?: string | undefined;
}

/**
 * Builds the OpenAPI document of a service WITHOUT initializing it: no
 * lifecycle hook runs, so no database, NATS or Redis connection is opened
 * (spec §5 `pnpm openapi`). Writes `outFile` (default `openapi.json`).
 *
 * @example
 * // src/openapi.ts — "openapi": "node dist/openapi.js"
 * await exportOpenApi({ appModule: AppModule, config: loadConfig(configSchema), openapi });
 */
export async function exportOpenApi(
  options: ExportOpenApiOptions,
): Promise<OpenAPIObject> {
  // Quiet and synchronous logging: nothing may outlive the export.
  const config: BaseConfig = {
    ...options.config,
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
  };
  const app = await NestFactory.create<NestFastifyApplication>(
    PlatformRootModule.wrap(options.appModule, config),
    createFastifyAdapter(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- Nest declares its options as classes; plain objects are the documented usage
    { logger: false, abortOnError: false },
  );
  try {
    app.setGlobalPrefix(GLOBAL_PREFIX, {
      exclude: [...PREFIX_EXCLUDED_ROUTES],
    });
    const document = buildOpenApiDocument(app, options.openapi);
    await writeOpenApiDocument(
      document,
      resolve(options.outFile ?? 'openapi.json'),
    );
    return document;
  } finally {
    await app.close();
  }
}
