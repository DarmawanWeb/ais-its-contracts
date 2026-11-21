import type { InjectionToken, Type } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import type * as z from 'zod';

import {
  type ImportableModule,
  PlatformRootModule,
} from '../bootstrap/platform-root.module.js';
import {
  type baseConfigSchema,
  type ConfigSchema,
  loadConfig,
} from '../config/define-config.js';
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

/** Replaces a provider of the application under test. */
export type ProviderOverride =
  | { readonly provide: InjectionToken; readonly useValue: unknown }
  | { readonly provide: InjectionToken; readonly useClass: Type<unknown> }
  | {
      readonly provide: InjectionToken;
      readonly useFactory: (...args: never[]) => unknown;
      readonly inject?: readonly InjectionToken[] | undefined;
    };

/** Options of {@link buildTestApp}. */
export interface BuildTestAppOptions extends HttpFeatureOptions {
  /** Validated configuration, e.g. from {@link createTestConfig}. */
  readonly config: BaseConfig;
  /** Provider overrides (fakes, test key resolvers, …). */
  readonly overrides?: readonly ProviderOverride[] | undefined;
  /** Logging destination (tests capture lines with it). */
  readonly logging?: LoggingModuleOptions | undefined;
  readonly adapter?: FastifyAdapterOptions | undefined;
  /** Customization before `init()`. */
  readonly configure?:
    ((app: NestFastifyApplication) => void | Promise<void>) | undefined;
}

/** Applies one override to a testing module builder. */
function applyOverride(
  builder: TestingModuleBuilder,
  override: ProviderOverride,
): TestingModuleBuilder {
  const target = builder.overrideProvider(override.provide);
  if ('useValue' in override) return target.useValue(override.useValue);
  if ('useClass' in override) return target.useClass(override.useClass);
  return target.useFactory({
    factory: override.useFactory,
    inject: [...(override.inject ?? [])],
  });
}

/**
 * Builds and initializes a service exactly as `bootstrapService()` does
 * (platform root module, global prefix, validation, problem details, helmet,
 * CORS, metrics, health, Swagger), without listening: use `app.inject()`.
 * Lifecycle hooks run, so connections open and migrations apply — point the
 * configuration at test containers. Close it with `app.close()`.
 *
 * @example
 * const app = await buildTestApp(AppModule, { config, overrides: [{ provide: Clock, useValue: fixedClock }] });
 * const response = await app.inject({ method: 'GET', url: '/api/v2/vessels', headers: { authorization: `Bearer ${token}` } });
 */
export async function buildTestApp(
  appModule: ImportableModule,
  options: BuildTestAppOptions,
): Promise<NestFastifyApplication> {
  let builder = Test.createTestingModule({
    imports: [
      PlatformRootModule.wrap(appModule, options.config, {
        logging: options.logging,
      }),
    ],
  });
  for (const override of options.overrides ?? [])
    builder = applyOverride(builder, override);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter({
      bodyLimitBytes: options.adapter?.bodyLimitBytes,
      trustProxy:
        options.adapter?.trustProxy ?? options.config.TRUSTED_PROXIES,
    }),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- Nest declares its options as classes; plain objects are the documented usage
    { bufferLogs: true },
  );
  try {
    app.useLogger(app.get(Logger));
    await configureApp(app, options.config, {
      openapi: options.openapi ?? { title: 'Test', version: '0.0.0' },
      cookies: options.cookies,
      multipart: options.multipart,
    });
    await options.configure?.(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  } catch (error) {
    // Close what the hooks that did run opened (pools, NATS), or the test
    // worker hangs on them.
    await app.close().catch(() => undefined);
    throw error;
  }
  return app;
}

/**
 * Test defaults merged under the given variables. `SERVICE_NAME` is not
 * among them: the service's own default applies, and
 * {@link TEST_SERVICE_NAME} only when the schema has none.
 */
export const TEST_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  SERVICE_VERSION: '0.0.0-test',
  LOG_LEVEL: 'silent',
  LOG_PRETTY: 'false',
  DB_MIGRATE_ON_BOOT: 'false',
};

/** `SERVICE_NAME` of tests whose schema has no default for it. */
export const TEST_SERVICE_NAME = 'test-service';

/**
 * Validates a test configuration from `env` (never `process.env` or `.env`):
 * `NODE_ENV=test`, silent logs and no migrations unless overridden. The
 * schema's own `SERVICE_NAME` default is kept (events, audit subjects and
 * projection names match production); {@link TEST_SERVICE_NAME} is used
 * only when the schema has none and `env` sets none.
 *
 * @example
 * const config = createTestConfig(configSchema, { DATABASE_URL: url, DATABASE_SCHEMA: 'fleet', NATS_URL: infra.nats.url });
 */
export function createTestConfig<
  Schema extends ConfigSchema = typeof baseConfigSchema,
>(
  schema: Schema,
  env: Readonly<Record<string, string | undefined>> = {},
): Readonly<z.output<Schema>> {
  const merged: Record<string, string | undefined> = { ...TEST_ENV, ...env };
  if (merged['SERVICE_NAME'] === undefined) {
    const probe = schema.safeParse(merged);
    const lacksName =
      !probe.success &&
      probe.error.issues.some((issue) => issue.path[0] === 'SERVICE_NAME');
    if (lacksName) merged['SERVICE_NAME'] = TEST_SERVICE_NAME;
  }
  return loadConfig(schema, { env: merged });
}
