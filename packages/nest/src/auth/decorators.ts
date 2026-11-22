import type {
  ApiKeyScope,
  Permission,
} from '@darmawanweb/ais-its-contracts/auth';
import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import { ApiExtension, ApiSecurity } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { UnauthorizedError } from '../errors/domain-error.js';
import {
  PLATFORM_ADMIN_ROLES_EXTENSION,
  SECURITY_SCHEMES,
} from '../http/openapi-security.js';
import { getRequestPrincipal } from './request-principal.js';

/** Metadata key of {@link Public}. */
export const IS_PUBLIC_KEY = 'aisits:auth:public';
/** Metadata key of {@link RequirePermissions}. */
export const REQUIRED_PERMISSIONS_KEY = 'aisits:auth:permissions';
/** Metadata key of {@link AllowApiKey}. */
export const API_KEY_SCOPES_KEY = 'aisits:auth:api-key-scopes';
/** Metadata key of {@link Internal}. */
export const IS_INTERNAL_KEY = 'aisits:auth:internal';
/** Metadata key of {@link RequirePlatformAdmin}. */
export const PLATFORM_ADMIN_KEY = 'aisits:auth:platform-admin';

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
 * Restricts a route (or every route of a controller) to platform
 * administrators: the global guard requires a signed-in user with the
 * `super_admin` role (`UserPrincipal.isPlatformAdmin`); other users and API
 * keys get `403 PLATFORM_ADMIN_REQUIRED`. Combines with
 * `@RequirePermissions` (both must hold). A handler-level `@Public()` wins
 * over a controller-level `@RequirePlatformAdmin()`, as for the other
 * decorators. OpenAPI shows `x-required-roles: ["super_admin"]`, and
 * `buildOpenApiDocument` adds `PLATFORM_ADMIN_DESCRIPTION` (`./http`) to
 * the operation description.
 *
 * @example
 * @RequirePlatformAdmin()
 * @Post('vessels/:id/republish')
 * republish(@UuidParam() id: string) {}
 */
export function RequirePlatformAdmin(): ClassDecorator & MethodDecorator {
  return applyDecorators(
    SetMetadata(PLATFORM_ADMIN_KEY, true),
    ApiExtension(PLATFORM_ADMIN_ROLES_EXTENSION, ['super_admin']),
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
    if (principal === undefined)
      throw new UnauthorizedError('Authentication required');
    return principal;
  },
);
