import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import type { OpenApiOptions } from '../http/openapi.js';
import {
  type CreatePlatformAppOptions,
  createPlatformApp,
} from './create-app.js';

/** Options of {@link bootstrapService}. */
export interface BootstrapServiceOptions extends Omit<
  CreatePlatformAppOptions,
  'openapi'
> {
  /** OpenAPI metadata of `/docs` and `/openapi.json`; `false` disables them. */
  readonly openapi: OpenApiOptions | false;
  /** Last-minute customization before the application starts (extra plugins, adapters). */
  readonly configure?:
    ((app: NestFastifyApplication) => void | Promise<void>) | undefined;
}

/** Signals that trigger a graceful shutdown. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Force-exits when a graceful shutdown takes longer than `timeoutMs`
 * (stuck connection, endless handler). The timer does not keep the process alive.
 */
function installShutdownDeadline(timeoutMs: number): void {
  if (timeoutMs <= 0) return;
  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      setTimeout(() => {
        process.stderr.write(
          `Graceful shutdown exceeded ${timeoutMs} ms, exiting\n`,
        );
        process.exit(1);
      }, timeoutMs).unref();
    });
  }
}

/**
 * Starts a service (spec §5): Fastify app with the platform root module
 * (config, logging, metrics, health, validation, problem details), global
 * prefix `api/v2`, helmet, CORS, Swagger at `/docs` + `/openapi.json`,
 * graceful shutdown on SIGTERM/SIGINT, then listens on `HOST:PORT`.
 * Connections are opened by the modules' lifecycle hooks (`onModuleInit`),
 * migrations run before the port is opened.
 *
 * @example
 * await bootstrapService({
 *   appModule: AppModule,
 *   config,
 *   openapi: { title: 'AIS-ITS fleet service', version: '0.1.0', tags: ['vessels'] },
 * });
 */
export async function bootstrapService(
  options: BootstrapServiceOptions,
): Promise<NestFastifyApplication> {
  const { config } = options;
  const logger = new Logger('Bootstrap');
  const { app } = await createPlatformApp(options);
  try {
    await options.configure?.(app);
    app.enableShutdownHooks([...SHUTDOWN_SIGNALS], { useProcessExit: true });
    installShutdownDeadline(config.SHUTDOWN_TIMEOUT_MS);
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    logger.error(error);
    await app.close().catch(() => undefined);
    throw error;
  }
  const url = await app.getUrl();
  logger.log(
    `${config.SERVICE_NAME} ${config.SERVICE_VERSION} listening on ${url}` +
      (options.openapi === false ? '' : ` (docs: ${url}/docs)`),
  );
  return app;
}
