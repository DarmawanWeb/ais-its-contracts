import type { ApiKeyIntrospectionResult, ApiKeyScope } from './api-key.js';
import type { AccessTokenClaims } from './claims.js';
import { type Permission, permissionsForRoles } from './permissions.js';
import type { Role } from './roles.js';

/** Kinds of authenticated principals. */
export const PRINCIPAL_KINDS = ['user', 'api_key'] as const;

/** A principal kind. */
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** A user authenticated with an access token. */
export interface UserPrincipal {
  readonly kind: 'user';
  /** User id (`sub`). */
  readonly id: string;
  /** Session id (`sid`). */
  readonly sessionId: string;
  /** Active organization, `null` for platform admins without one. */
  readonly orgId: string | null;
  readonly roles: readonly Role[];
  readonly email: string;
  readonly name: string;
}

/** A machine client authenticated with an API key (`X-API-Key`). */
export interface ApiKeyPrincipal {
  readonly kind: 'api_key';
  /** API key id. */
  readonly id: string;
  /** Organization owning the key. */
  readonly orgId: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly name: string;
}

/** Any authenticated principal. */
export type Principal = UserPrincipal | ApiKeyPrincipal;

/** A record that belongs to a tenant (`null` = no owning organization). */
export type TenantScoped<T> = T & { readonly orgId: string | null };

/** An active API key introspection result. */
export type ActiveApiKey = Extract<ApiKeyIntrospectionResult, { active: true }>;

/** Builds the principal of validated access token claims. */
export function userPrincipalFromClaims(
  claims: AccessTokenClaims,
): UserPrincipal {
  return {
    kind: 'user',
    id: claims.sub,
    sessionId: claims.sid,
    orgId: claims.org,
    roles: claims.roles,
    email: claims.email,
    name: claims.name,
  };
}

/** Builds the principal of an active API key introspection result. */
export function apiKeyPrincipalFromIntrospection(
  key: ActiveApiKey,
): ApiKeyPrincipal {
  return {
    kind: 'api_key',
    id: key.keyId,
    orgId: key.orgId,
    scopes: key.scopes,
    name: key.name,
  };
}

/** `true` for users holding the platform role `super_admin`. */
export function isPlatformAdmin(principal: Principal): boolean {
  return principal.kind === 'user' && principal.roles.includes('super_admin');
}

/**
 * `true` for users with cross-tenant safety and surveillance access
 * (`authority` or `super_admin`): they see every safety and surveillance
 * event and alert and join the realtime `authority` room (spec 8.5, 9).
 */
export function hasAuthorityAccess(principal: Principal): boolean {
  return (
    principal.kind === 'user' &&
    principal.roles.some(
      (role) => role === 'authority' || role === 'super_admin',
    )
  );
}

/** Permissions of a principal; API keys carry scopes, not permissions. */
export function principalPermissions(
  principal: Principal,
): ReadonlySet<Permission> {
  return principal.kind === 'user'
    ? permissionsForRoles(principal.roles)
    : new Set<Permission>();
}

/** `true` when the principal holds `permission`. */
export function principalCan(
  principal: Principal,
  permission: Permission,
): boolean {
  return principalPermissions(principal).has(permission);
}

/** `true` when the principal is an API key granted `scope`. */
export function principalHasScope(
  principal: Principal,
  scope: ApiKeyScope,
): boolean {
  return principal.kind === 'api_key' && principal.scopes.includes(scope);
}

/**
 * Tenant-private access rule (spec 8.5): platform admins access every
 * organization; other principals only their active organization. Records
 * without an owner (`orgId === null`) are reserved to platform admins.
 */
export function canAccessOrg(
  principal: Principal,
  orgId: string | null,
): boolean {
  if (isPlatformAdmin(principal)) return true;
  return orgId !== null && principal.orgId === orgId;
}
