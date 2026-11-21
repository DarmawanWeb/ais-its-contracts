import type { ApiKeyScope, Permission } from '@darmawanweb/seemp-contracts/auth';
import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { ApiExtension, ApiSecurity } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { UnauthorizedError } from '../errors/domain-error.js';
import { SECURITY_SCHEMES } from '../http/openapi-security.js';
import { getRequestPrincipal } from './request-principal.js';

/** Metadata key of {@link Public}. */
export const IS_PUBLIC_KEY = 'seemp:auth:public';
/** Metadata key of {@link RequirePermissions}. */
export const REQUIRED_PERMISSIONS_KEY = 'seemp:auth:permissions';
/** Metadata key of {@link AllowApiKey}. */
export const API_KEY_SCOPES_KEY = 'seemp:auth:api-key-scopes';
/** Metadata key of {@link Internal}. */
export const IS_INTERNAL_KEY = 'seemp:auth:internal';

/**
 * Opens a route (or every route of a controller) to anonymous callers. The
 * global guard denies everything else by default (spec §8.6).
 */
export function Public(): ClassDecorator & MethodDecorator {
  return applyDecorators(SetMetadata(IS_PUBLIC_KEY, true), ApiSecurity({}));
}

/**
 * Requires a user holding every listed permission (`403 FORBIDDEN`
 * otherwise). API keys are checked against `@AllowApiKey` scopes instead.
 *
 * @example
 * @RequirePermissions('vessel:write')
 */
export function RequirePermissions(
  ...permissions: [Permission, ...Permission[]]
): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions),
    ApiExtension('x-required-permissions', permissions),
  );
}

/**
 * Also accepts `X-API-Key` on this route: the key must hold every listed
 * scope (`403 INSUFFICIENT_SCOPE` otherwise). Routes without it reject API
 * keys. Users are still accepted (checked with `@RequirePermissions`).
 *
 * @example
 * @AllowApiKey('telemetry:ingest')
 * @RequirePermissions('telemetry:write')
 */
export function AllowApiKey(
  ...scopes: [ApiKeyScope, ...ApiKeyScope[]]
): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(API_KEY_SCOPES_KEY, scopes),
    ApiSecurity(SECURITY_SCHEMES.BEARER),
    ApiSecurity(SECURITY_SCHEMES.API_KEY),
    ApiExtension('x-api-key-scopes', scopes),
  );
}

/**
 * Service-to-service route (`/internal/*`): requires `X-Internal-Token`
 * (constant-time compared with `INTERNAL_TOKEN`) instead of a user or key.
 */
export function Internal(): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(IS_INTERNAL_KEY, true),
    ApiSecurity(SECURITY_SCHEMES.INTERNAL_TOKEN),
  );
}

/**
 * Injects the authenticated {@link Principal} of the request. Throws `401`
 * when there is none (e.g. on a `@Public()` route).
 *
 * @example
 * list(@CurrentPrincipal() principal: Principal) {}
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = getRequestPrincipal(request);
    if (principal === undefined) throw new UnauthorizedError('Authentication required');
    return principal;
  },
);
