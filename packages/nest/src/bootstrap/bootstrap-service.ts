import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import {
  type BaseConfig,
  DEFAULT_TRUSTED_PROXIES,
} from '../config/env-schema.js';
import type { FastifyAdapterOptions } from '../http/fastify-adapter.js';
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

/**
 * The warning {@link bootstrapService} logs when a production service
 * trusts the default `TRUSTED_PROXIES` (`loopback,linklocal,uniquelocal`):
 * any client on a private network can then choose its own IP with
 * `X-Forwarded-For` (throttles, audit `ip`). Production should trust the
 * gateway's address or CIDR only.
 *
 * @param trustProxy the adapter's `trustProxy` option, when set (it wins
 *   over `TRUSTED_PROXIES`).
 * @returns the warning, or `undefined` when there is nothing to warn about.
 */
export function trustedProxiesWarning(
  config: Pick<BaseConfig, 'NODE_ENV' | 'TRUSTED_PROXIES'>,
  trustProxy?: FastifyAdapterOptions['trustProxy'],
): string | undefined {
  if (config.NODE_ENV !== 'production' || trustProxy === false)
    return undefined;
  const effective =
    typeof trustProxy === 'string'
      ? trustProxy.split(',').map((entry) => entry.trim())
      : [...(trustProxy ?? config.TRUSTED_PROXIES)];
  const defaults = new Set(DEFAULT_TRUSTED_PROXIES);
  const isDefault =
    effective.length === defaults.size &&
    effective.every((entry) => defaults.has(entry));
  if (!isDefault) return undefined;
  return (
    `TRUSTED_PROXIES is the default (${DEFAULT_TRUSTED_PROXIES.join(',')}) in production: ` +
    'any client on a private network can set its own IP with X-Forwarded-For. ' +
    "Set TRUSTED_PROXIES to the gateway's address or CIDR."
  );
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
 * graceful shutdown on SIGTERM/SIGINT, then listens on `HOST:PORT`. In
 * production it warns when `TRUSTED_PROXIES` is the default
 * ({@link trustedProxiesWarning}).
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
  const proxies = trustedProxiesWarning(config, options.adapter?.trustProxy);
  if (proxies !== undefined) logger.warn(proxies);
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
