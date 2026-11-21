import {
  type DynamicModule,
  type ForwardReference,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type Type,
} from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { ConfigModule } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { HealthModule } from '../health/health.module.js';
import { ProblemDetailsFilter } from '../http/problem-details.filter.js';
import { createValidationPipe } from '../http/validation.js';
import { LoggingModule, type LoggingModuleOptions } from '../logging/logging.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { shutdownTelemetry } from '../telemetry/start-telemetry.js';

/** Anything Nest accepts in `imports`. */
export type ImportableModule =
  | Type<unknown>
  | DynamicModule
  | Promise<DynamicModule>
  | ForwardReference;

/** Options of {@link PlatformRootModule.wrap}. */
export interface PlatformRootOptions {
  readonly logging?: LoggingModuleOptions | undefined;
}

/** Flushes the OpenTelemetry SDK (if started) once the application stopped. */
@Injectable()
class TelemetryShutdown implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}

/**
 * Root module built around a service's `AppModule`: configuration, logging,
 * metrics, health, the global validation pipe and problem-details filter.
 * Used by `bootstrapService()`, `exportOpenApi()` and `buildTestApp()` so that
 * production, documentation and tests run the same composition.
 */
@Module({})
export class PlatformRootModule {
  /** Wraps `appModule` with the platform modules. */
  static wrap(
    appModule: ImportableModule,
    config: BaseConfig,
    options: PlatformRootOptions = {},
  ): DynamicModule {
    return {
      module: PlatformRootModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggingModule.forRoot(options.logging),
        MetricsModule,
        HealthModule,
        appModule,
      ],
      providers: [
        { provide: APP_PIPE, useFactory: createValidationPipe },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        TelemetryShutdown,
      ],
    };
  }
}
