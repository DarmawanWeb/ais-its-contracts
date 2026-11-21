import {
  type ApiKeyScope,
  HTTP_HEADERS,
  parseBearerToken,
  type Permission,
} from '@darmawanweb/seemp-contracts/auth';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';

import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { ForbiddenError, UnauthorizedError } from '../errors/domain-error.js';
import { AccessTokenVerifier } from './access-token-verifier.service.js';
import { ApiKeyVerifier } from './api-key-verifier.js';
import {
  API_KEY_SCOPES_KEY,
  IS_INTERNAL_KEY,
  IS_PUBLIC_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from './decorators.js';
import { internalTokenMatches } from './internal-token.js';
import type { Principal } from './principal.js';
import { setRequestPrincipal } from './request-principal.js';

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : value?.[0];
}

/**
 * The global default-deny guard (spec §8.6), registered by `AuthModule`:
 *
 * 1. `@Internal()` routes require a matching `X-Internal-Token` (no user).
 * 2. `@Public()` routes are open.
 * 3. Otherwise a principal is required: `Authorization: Bearer <jwt>`, or
 *    `X-API-Key` on `@AllowApiKey(...)` routes. Missing/invalid credentials
 *    → `401` (with `WWW-Authenticate`).
 * 4. Users need every `@RequirePermissions(...)` permission, API keys every
 *    `@AllowApiKey(...)` scope → `403 FORBIDDEN` / `403 INSUFFICIENT_SCOPE`.
 *
 * Only HTTP is guarded: WebSocket gateways authenticate their handshake with
 * `AccessTokenVerifier`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenVerifier,
    @InjectConfig() private readonly config: BaseConfig,
    @Optional() @Inject(ApiKeyVerifier) private readonly apiKeys: ApiKeyVerifier | null = null,
    @Optional() @Inject(PinoLogger) private readonly logger: PinoLogger | null = null,
  ) {}

  /** Authenticates and authorizes the request; throws problem-mapped errors. */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (this.reflector.getAllAndOverride<boolean | undefined, string>(IS_INTERNAL_KEY, targets) === true) {
      if (!internalTokenMatches(header(request, HTTP_HEADERS.INTERNAL_TOKEN), this.config.INTERNAL_TOKEN)) {
        throw new UnauthorizedError('A valid X-Internal-Token is required', {
          challenge: 'InternalToken',
        });
      }
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean | undefined, string>(IS_PUBLIC_KEY, targets) === true) {
      return true;
    }

    const scopes = this.reflector.getAllAndOverride<readonly ApiKeyScope[] | undefined, string>(
      API_KEY_SCOPES_KEY,
      targets,
    );
    const permissions = this.reflector.getAllAndMerge<Permission[], string>(
      REQUIRED_PERMISSIONS_KEY,
      targets,
    );

    const principal = await this.authenticate(request, scopes);
    this.authorize(principal, permissions, scopes ?? []);
    setRequestPrincipal(request, principal);
    this.assignLogPrincipal(principal);
    return true;
  }

  private async authenticate(
    request: FastifyRequest,
    scopes: readonly ApiKeyScope[] | undefined,
  ): Promise<Principal> {
    const authorization = header(request, HTTP_HEADERS.AUTHORIZATION);
    if (authorization !== undefined) {
      const token = parseBearerToken(authorization);
      if (token === null) {
        throw new UnauthorizedError('The Authorization header must be "Bearer <access token>"', {
          challenge: 'Bearer error="invalid_request"',
        });
      }
      return this.accessTokens.verify(token);
    }

    const apiKey = header(request, HTTP_HEADERS.API_KEY);
    if (apiKey !== undefined) {
      if (scopes === undefined || this.apiKeys === null) {
        throw new UnauthorizedError('API keys are not accepted on this route', {
          code: 'INVALID_API_KEY',
          challenge: 'Bearer',
        });
      }
      return this.apiKeys.verify(apiKey);
    }

    throw new UnauthorizedError('Authentication required', {
      challenge: scopes === undefined ? 'Bearer' : 'Bearer, ApiKey',
    });
  }

  private authorize(
    principal: Principal,
    permissions: readonly Permission[],
    scopes: readonly ApiKeyScope[],
  ): void {
    if (principal.kind === 'api_key') {
      const missingScopes = scopes.filter((scope) => !principal.hasScope(scope));
      if (missingScopes.length > 0) {
        throw new ForbiddenError(`The API key lacks the scope ${missingScopes.join(', ')}`, {
          code: 'INSUFFICIENT_SCOPE',
          extra: { missingScopes },
        });
      }
      return;
    }
    const missingPermissions = [...new Set(permissions)].filter((permission) => !principal.can(permission));
    if (missingPermissions.length > 0) {
      throw new ForbiddenError(`Missing permission ${missingPermissions.join(', ')}`, {
        extra: { missingPermissions },
      });
    }
  }

  /** Adds `principal` (the id only, spec §10) to the request's log lines. */
  private assignLogPrincipal(principal: Principal): void {
    try {
      this.logger?.assign({ principal: principal.id });
    } catch {
      // Outside a request logging context (e.g. without the logging module).
    }
  }
}
