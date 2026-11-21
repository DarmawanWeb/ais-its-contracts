import {
  type AccessTokenClaims,
  type ActiveApiKey,
  type ApiKeyPrincipal as ApiKeyPrincipalData,
  type ApiKeyScope,
  canAccessOrg,
  hasAuthorityAccess,
  type Permission,
  permissionsForRoles,
  type Role,
  type UserPrincipal as UserPrincipalData,
} from '@darmawanweb/seemp-contracts/auth';

import { ForbiddenError } from '../errors/domain-error.js';

/**
 * A user authenticated with an access token. Implements the contracts
 * `UserPrincipal` shape (`id` = user id), so it works with every contracts
 * tenancy helper, and adds the derived permissions and checks.
 */
export class UserPrincipal implements UserPrincipalData {
  readonly kind = 'user' as const;
  /** User id (`sub`). */
  readonly id: string;
  /** Session id (`sid`). */
  readonly sessionId: string;
  /** Active organization (`org`), `null` for platform admins without one. */
  readonly orgId: string | null;
  readonly roles: readonly Role[];
  readonly email: string;
  readonly name: string;
  /** Permissions of `roles` (contracts `ROLE_PERMISSIONS`, spec §8.4). */
  readonly permissions: ReadonlySet<Permission>;

  constructor(data: Omit<UserPrincipalData, 'kind'>) {
    this.id = data.id;
    this.sessionId = data.sessionId;
    this.orgId = data.orgId;
    this.roles = Object.freeze([...data.roles]);
    this.email = data.email;
    this.name = data.name;
    this.permissions = permissionsForRoles(this.roles);
    Object.freeze(this);
  }

  /** Builds the principal of validated access token claims. */
  static fromClaims(claims: AccessTokenClaims): UserPrincipal {
    return new UserPrincipal({
      id: claims.sub,
      sessionId: claims.sid,
      orgId: claims.org,
      roles: claims.roles,
      email: claims.email,
      name: claims.name,
    });
  }

  /** Alias of `id`. */
  get userId(): string {
    return this.id;
  }

  /** Holds the platform role `super_admin`. */
  get isPlatformAdmin(): boolean {
    return this.roles.includes('super_admin');
  }

  /** `authority` or `super_admin`: cross-tenant surveillance access (spec §8.5). */
  get hasAuthorityAccess(): boolean {
    return hasAuthorityAccess(this);
  }

  /** `true` when the principal holds `permission`. */
  can(permission: Permission): boolean {
    return this.permissions.has(permission);
  }

  /** `true` when the principal holds every permission. */
  canAll(permissions: Iterable<Permission>): boolean {
    for (const permission of permissions) if (!this.can(permission)) return false;
    return true;
  }

  /** Users carry permissions, not scopes. */
  hasScope(_scope: ApiKeyScope): boolean {
    return false;
  }

  /** Tenant rule of spec §8.5 (`super_admin` accesses every organization). */
  canAccessOrg(orgId: string | null): boolean {
    return canAccessOrg(this, orgId);
  }

  /** Plain JSON (logs, audit). */
  toJSON(): UserPrincipalData {
    return {
      kind: this.kind,
      id: this.id,
      sessionId: this.sessionId,
      orgId: this.orgId,
      roles: this.roles,
      email: this.email,
      name: this.name,
    };
  }
}

/**
 * A machine client authenticated with an API key (`X-API-Key`). Implements
 * the contracts `ApiKeyPrincipal` shape (`id` = key id).
 */
export class ApiKeyPrincipal implements ApiKeyPrincipalData {
  readonly kind = 'api_key' as const;
  /** API key id. */
  readonly id: string;
  /** Organization owning the key. */
  readonly orgId: string;
  readonly scopes: readonly ApiKeyScope[];
  /** Display name of the key. */
  readonly name: string;
  /** API keys are never platform admins. */
  readonly isPlatformAdmin = false;

  constructor(data: Omit<ApiKeyPrincipalData, 'kind'>) {
    this.id = data.id;
    this.orgId = data.orgId;
    this.scopes = Object.freeze([...data.scopes]);
    this.name = data.name;
    Object.freeze(this);
  }

  /** Builds the principal of an active introspection result. */
  static fromIntrospection(key: ActiveApiKey): ApiKeyPrincipal {
    return new ApiKeyPrincipal({ id: key.keyId, orgId: key.orgId, scopes: key.scopes, name: key.name });
  }

  /** Alias of `id`. */
  get keyId(): string {
    return this.id;
  }

  /** API keys carry scopes, not permissions. */
  can(_permission: Permission): boolean {
    return false;
  }

  /** `true` when the key was granted `scope`. */
  hasScope(scope: ApiKeyScope): boolean {
    return this.scopes.includes(scope);
  }

  /** API keys only access their own organization. */
  canAccessOrg(orgId: string | null): boolean {
    return canAccessOrg(this, orgId);
  }

  /** Plain JSON (logs, audit). */
  toJSON(): ApiKeyPrincipalData {
    return { kind: this.kind, id: this.id, orgId: this.orgId, scopes: this.scopes, name: this.name };
  }
}

/** Any authenticated principal. */
export type Principal = UserPrincipal | ApiKeyPrincipal;

/**
 * Throws `403 FORBIDDEN` unless the principal may access records of `orgId`
 * (spec §8.5: own organization, or any for `super_admin`; `null` = platform
 * admins only).
 */
export function assertOrgAccess(principal: Principal, orgId: string | null): void {
  if (!principal.canAccessOrg(orgId)) {
    throw new ForbiddenError('The resource belongs to another organization');
  }
}

/** Throws `403 FORBIDDEN` unless the principal holds `permission`. */
export function assertPermission(principal: Principal, permission: Permission): void {
  if (!principal.can(permission)) {
    throw new ForbiddenError(`Missing permission ${permission}`, {
      extra: { missingPermissions: [permission] },
    });
  }
}
