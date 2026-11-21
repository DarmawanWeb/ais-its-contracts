import * as z from 'zod';

import type { Role } from './roles.js';

/** Every permission (spec 8.4), `<resource>:<action>`. */
export const PERMISSIONS = [
  'vessel:read',
  'vessel:write',
  'reference:write',
  'ais:read',
  'telemetry:read',
  'telemetry:write',
  'device:manage',
  'cii:read',
  'seemp:read',
  'seemp:simulate',
  'safety:read',
  'surveillance:read',
  'surveillance:review',
  'zone:read',
  'zone:write',
  'alert:read',
  'alert:ack',
  'alert_rule:write',
  'user:manage',
  'org:manage',
  'api_key:manage',
  'audit:read',
  'report:read',
] as const;

/** A permission. */
export type Permission = (typeof PERMISSIONS)[number];

/** Zod schema of {@link Permission}. */
export const PermissionSchema = z.enum(PERMISSIONS).describe('Permission');

/**
 * Permissions granted by each role, exactly as the matrix of spec 8.4.
 * `super_admin` holds every permission.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  super_admin: PERMISSIONS,
  org_admin: [
    'vessel:read',
    'vessel:write',
    'ais:read',
    'telemetry:read',
    'telemetry:write',
    'device:manage',
    'cii:read',
    'seemp:read',
    'seemp:simulate',
    'safety:read',
    'surveillance:read',
    'zone:read',
    'zone:write',
    'alert:read',
    'alert:ack',
    'alert_rule:write',
    'user:manage',
    'api_key:manage',
    'audit:read',
    'report:read',
  ],
  fleet_manager: [
    'vessel:read',
    'vessel:write',
    'ais:read',
    'telemetry:read',
    'telemetry:write',
    'cii:read',
    'seemp:read',
    'seemp:simulate',
    'safety:read',
    'surveillance:read',
    'zone:read',
    'alert:read',
    'alert:ack',
    'alert_rule:write',
    'report:read',
  ],
  authority: [
    'vessel:read',
    'ais:read',
    'safety:read',
    'surveillance:read',
    'surveillance:review',
    'zone:read',
    'zone:write',
    'alert:read',
    'alert:ack',
    'alert_rule:write',
  ],
  viewer: [
    'vessel:read',
    'ais:read',
    'cii:read',
    'seemp:read',
    'safety:read',
    'surveillance:read',
    'zone:read',
    'alert:read',
  ],
};

/** Returns `true` when `value` is a known permission. */
export function isPermission(value: unknown): value is Permission {
  return PERMISSIONS.some((permission) => permission === value);
}

/**
 * Union of the permissions of `roles`.
 *
 * @example permissionsForRoles(['viewer']).has('vessel:write') // false
 */
export function permissionsForRoles(
  roles: Iterable<Role>,
): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) granted.add(permission);
  }
  return granted;
}

/** Returns `true` when at least one of `roles` grants `permission`. */
export function rolesHavePermission(
  roles: Iterable<Role>,
  permission: Permission,
): boolean {
  for (const role of roles) {
    if (ROLE_PERMISSIONS[role].includes(permission)) return true;
  }
  return false;
}
