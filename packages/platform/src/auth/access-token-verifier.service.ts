import { Inject, Injectable } from '@nestjs/common';

import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import {
  type AccessTokenKeyResolver,
  type AccessTokenVerification,
  createAccessTokenVerifier,
} from './access-token-verifier.js';
import type { UserPrincipal } from './principal.js';

/** Injection token of the {@link AccessTokenKeyResolver} used by the verifier. */
export const ACCESS_TOKEN_KEY_RESOLVER = 'SEEMP_ACCESS_TOKEN_KEY_RESOLVER';

/**
 * Injectable access token verifier configured from `AUTH_ISSUER`,
 * `AUTH_AUDIENCE` and the module's key resolver (remote JWKS by default).
 * Inject it where tokens arrive outside HTTP routes (socket.io handshakes).
 */
@Injectable()
export class AccessTokenVerifier implements AccessTokenVerification {
  private readonly verification: AccessTokenVerification;

  constructor(
    @InjectConfig() config: BaseConfig,
    @Inject(ACCESS_TOKEN_KEY_RESOLVER) keyResolver: AccessTokenKeyResolver,
  ) {
    this.verification = createAccessTokenVerifier({
      issuer: config.AUTH_ISSUER,
      audience: config.AUTH_AUDIENCE,
      keyResolver,
    });
  }

  /** @inheritdoc */
  verify(token: string): Promise<UserPrincipal> {
    return this.verification.verify(token);
  }
}
