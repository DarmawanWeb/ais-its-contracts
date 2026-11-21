import { type DynamicModule, Inject, Module } from '@nestjs/common';

import type { BaseConfig } from './env-schema.js';

/** Injection token of the validated configuration object. */
export const APP_CONFIG = 'SEEMP_APP_CONFIG';

/**
 * Global module exposing the validated configuration under {@link APP_CONFIG}.
 * `bootstrapService()` and the test helpers import it for you.
 *
 * @example
 * constructor(@InjectConfig() private readonly config: Config) {}
 */
@Module({})
export class ConfigModule {
  /** Registers `config` (the result of `loadConfig()`) globally. */
  static forRoot(config: BaseConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

/**
 * Parameter decorator injecting the configuration object. Type the parameter
 * with the service's own `AppConfig<typeof configSchema>` (import it with
 * `import type`, it is erased at runtime).
 */
export function InjectConfig(): PropertyDecorator & ParameterDecorator {
  return Inject(APP_CONFIG);
}
