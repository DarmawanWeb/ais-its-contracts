import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';

import type { ConfigSchema } from '../config/define-config.js';
import { documentationConfig } from '../config/documentation-config.js';
import type { BaseConfig } from '../config/env-schema.js';
import { createFastifyAdapter } from '../http/fastify-adapter.js';
import {
  GLOBAL_PREFIX,
  PREFIX_EXCLUDED_ROUTES,
} from '../http/global-prefix.js';
import {
  buildOpenApiDocument,
  type OpenApiOptions,
  serializeOpenApiDocument,
  writeOpenApiDocument,
} from '../http/openapi.js';
import {
  type ImportableModule,
  PlatformRootModule,
} from './platform-root.module.js';

/** Options of {@link exportOpenApi}. */
export type ExportOpenApiOptions = {
  readonly appModule: ImportableModule;
  readonly openapi: OpenApiOptions;
  /** Output file (relative to the working directory), usually `openapi.json`. */
  readonly outFile?: string | undefined;
  /**
   * Compares the generated document with `outFile` instead of writing it and
   * throws {@link OpenApiDriftError} when they differ (CI: `pnpm openapi --check`).
   */
  readonly check?: boolean | undefined;
} & (
  | {
      /**
       * The service's configuration schema: the documentation config is
       * derived from it with {@link documentationConfig} (placeholders for
       * missing runtime-only variables). Preferred.
       */
      readonly configSchema: ConfigSchema;
      /** Variables to read; default `process.env`. */
      readonly env?: Readonly<Record<string, string | undefined>> | undefined;
      readonly config?: undefined;
    }
  | {
      /** An already validated configuration. */
      readonly config: BaseConfig;
      readonly configSchema?: undefined;
      readonly env?: undefined;
    }
);

/** Thrown by `exportOpenApi({ check: true })` when the committed document is stale. */
export class OpenApiDriftError extends Error {
  override readonly name = 'OpenApiDriftError';

  constructor(readonly file: string) {
    super(
      `${file} is out of date: run "pnpm openapi" and commit the regenerated document`,
    );
  }
}

/**
 * Builds the OpenAPI document of a service WITHOUT initializing it (spec §5
 * `pnpm openapi`): providers are constructed but no lifecycle hook runs —
 * neither `onModuleInit` / `onApplicationBootstrap` nor the shutdown hooks
 * — so no database, NATS or Redis connection is opened or closed. Writes
 * `outFile` (default `openapi.json`), or checks it with `check: true`.
 *
 * @throws {OpenApiDriftError} in check mode when `outFile` differs.
 * @example
 * // src/openapi.ts — "openapi": "node dist/openapi.js", CI: "node dist/openapi.js --check"
 * await exportOpenApi({ appModule: AppModule, configSchema, openapi, check: process.argv.includes('--check') });
 */
export async function exportOpenApi(
  options: ExportOpenApiOptions,
): Promise<OpenAPIObject> {
  const base: BaseConfig =
    options.config ?? documentationConfig(options.configSchema, options.env);
  // Quiet and synchronous logging: nothing may outlive the export.
  const config: BaseConfig = {
    ...base,
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
    const file = resolve(options.outFile ?? 'openapi.json');
    if (options.check === true) {
      const committed = await readFile(file, 'utf8').catch(() => undefined);
      if (committed !== serializeOpenApiDocument(document))
        throw new OpenApiDriftError(options.outFile ?? 'openapi.json');
    } else {
      await writeOpenApiDocument(document, file);
    }
    return document;
  } finally {
    // Only the (never listening) HTTP server is closed: `app.close()` would
    // run the shutdown hooks of providers that were never initialized.
    await app.getHttpAdapter().close();
  }
}
