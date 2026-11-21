import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { OpenAPIObject } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

import type { BaseConfig } from '../config/env-schema.js';
import {
  configureApp,
  type HttpFeatureOptions,
} from '../http/configure-app.js';
import {
  createFastifyAdapter,
  type FastifyAdapterOptions,
} from '../http/fastify-adapter.js';
import type { LoggingModuleOptions } from '../logging/logging.module.js';
import {
  type ImportableModule,
  PlatformRootModule,
} from './platform-root.module.js';

/** Options of {@link createPlatformApp}. */
export interface CreatePlatformAppOptions extends HttpFeatureOptions {
  /** The service's root module. */
  readonly appModule: ImportableModule;
  /** Validated configuration (`loadConfig()`). */
  readonly config: BaseConfig;
  readonly adapter?: FastifyAdapterOptions | undefined;
  readonly logging?: LoggingModuleOptions | undefined;
}

/** A created, configured (not yet initialized) application. */
export interface PlatformApp {
  readonly app: NestFastifyApplication;
  /** The OpenAPI document served at `/openapi.json`, when enabled. */
  readonly document: OpenAPIObject | undefined;
}

/**
 * Creates the Fastify application of a service with the platform root module
 * and HTTP conventions. Providers are instantiated but no lifecycle hook ran
 * yet, so no connection is open: call `init()` or `listen()` next.
 */
export async function createPlatformApp(
  options: CreatePlatformAppOptions,
): Promise<PlatformApp> {
  const app = await NestFactory.create<NestFastifyApplication>(
    PlatformRootModule.wrap(options.appModule, options.config, {
      logging: options.logging,
    }),
    createFastifyAdapter({
      bodyLimitBytes: options.adapter?.bodyLimitBytes,
      trustProxy: options.adapter?.trustProxy ?? options.config.TRUSTED_PROXIES,
    }),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- Nest declares its options as classes; plain objects are the documented usage
    {
      bufferLogs: true,
      abortOnError: false,
      forceCloseConnections: true,
      return503OnClosing: true,
    },
  );
  app.useLogger(app.get(Logger));
  const document = await configureApp(app, options.config, options);
  return { app, document };
}
