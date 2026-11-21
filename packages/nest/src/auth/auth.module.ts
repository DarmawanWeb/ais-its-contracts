import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import {
  provideAs,
  type ProviderDefinition,
} from '../common/provider-definition.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { InternalHttpClient } from '../internal-http/internal-http-client.js';
import {
  type AccessTokenKeyResolver,
  createRemoteKeyResolver,
} from './access-token-verifier.js';
import {
  ACCESS_TOKEN_KEY_RESOLVER,
  AccessTokenVerifier,
} from './access-token-verifier.service.js';
import {
  type ApiKeyIntrospector,
  ApiKeyVerifier,
  type ApiKeyVerifierOptions,
  HttpApiKeyIntrospector,
} from './api-key-verifier.js';
import { AuthGuard } from './auth.guard.js';

/** Injection token of the {@link ApiKeyIntrospector}. */
export const API_KEY_INTROSPECTOR = 'AISITS_API_KEY_INTROSPECTOR';

export type { ProviderDefinition };

/** Options of {@link AuthModule.forRoot}. */
export interface AuthModuleOptions {
  /**
   * Accept `X-API-Key` on `@AllowApiKey(...)` routes (introspection against
   * the auth service). Default `true`.
   */
  readonly apiKeys?: boolean | undefined;
  /**
   * Verification keys of access tokens. Default: the remote JWKS of
   * `AUTH_JWKS_URL` (cached, 30 s refetch cooldown). The auth service plugs in
   * its local signing keys; tests plug in `createTestJwtIssuer().keyResolver`.
   */
  readonly keyResolver?: ProviderDefinition<AccessTokenKeyResolver> | undefined;
  /** API key lookup. Default: `POST {AUTH_INTERNAL_URL}/internal/api-keys/introspect`. */
  readonly apiKeyIntrospector?:
    ProviderDefinition<ApiKeyIntrospector> | undefined;
  /** Cache TTLs of the API key verifier (default 60 s / 10 s). */
  readonly apiKeyCache?: ApiKeyVerifierOptions | undefined;
  /** Modules the custom providers depend on. */
  readonly imports?: ModuleMetadata['imports'];
}

/**
 * Authentication and authorization (spec §8): registers the GLOBAL
 * default-deny {@link AuthGuard} and exports {@link AccessTokenVerifier} and
 * {@link ApiKeyVerifier}. Every route needs a principal unless `@Public()`.
 *
 * @example
 * @Module({ imports: [AuthModule.forRoot()] })
 * export class AppModule {}
 */
@Module({})
export class AuthModule {
  /** Registers the guard and the verifiers. */
  static forRoot(options: AuthModuleOptions = {}): DynamicModule {
    const acceptApiKeys = options.apiKeys ?? true;
    const providers: Provider[] = [
      provideAs(
        ACCESS_TOKEN_KEY_RESOLVER,
        options.keyResolver ?? {
          useFactory: (config: BaseConfig) =>
            createRemoteKeyResolver(config.AUTH_JWKS_URL),
          inject: [APP_CONFIG],
        },
      ),
      AccessTokenVerifier,
      { provide: APP_GUARD, useClass: AuthGuard },
    ];
    const exported: InjectionToken[] = [
      AccessTokenVerifier,
      ACCESS_TOKEN_KEY_RESOLVER,
    ];
    if (acceptApiKeys) {
      providers.push(
        provideAs(
          API_KEY_INTROSPECTOR,
          options.apiKeyIntrospector ?? {
            useFactory: (config: BaseConfig) =>
              new HttpApiKeyIntrospector(
                InternalHttpClient.forService(config, config.AUTH_INTERNAL_URL),
              ),
            inject: [APP_CONFIG],
          },
        ),
        {
          provide: ApiKeyVerifier,
          useFactory: (introspector: ApiKeyIntrospector) =>
            new ApiKeyVerifier(introspector, options.apiKeyCache),
          inject: [API_KEY_INTROSPECTOR],
        },
      );
      exported.push(ApiKeyVerifier, API_KEY_INTROSPECTOR);
    }
    return {
      module: AuthModule,
      global: true,
      imports: options.imports ?? [],
      providers,
      exports: exported,
    };
  }
}
