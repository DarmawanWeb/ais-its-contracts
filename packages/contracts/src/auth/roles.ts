import * as z from 'zod';

import type { LocalizedText } from '../domain/locale.js';

/**
 * Every role (spec 8.4). `super_admin` is a platform role (users with
 * `is_platform_admin`); the others are granted per organization membership.
 */
export const ROLES = [
  'super_admin',
  'org_admin',
  'fleet_manager',
  'authority',
  'viewer',
] as const;

/** A role. */
export type Role = (typeof ROLES)[number];

/** Zod schema of {@link Role}. */
export const RoleSchema = z.enum(ROLES).describe('Role');

/** Platform-wide roles (not tied to an organization). */
export const PLATFORM_ROLES = [
  'super_admin',
] as const satisfies readonly Role[];

/** Roles that can be granted through an organization membership. */
export const ORG_ROLES = [
  'org_admin',
  'fleet_manager',
  'authority',
  'viewer',
] as const satisfies readonly Role[];

/** A role granted through an organization membership. */
export type OrgRole = (typeof ORG_ROLES)[number];

/** Zod schema of {@link OrgRole}. */
export const OrgRoleSchema = z.enum(ORG_ROLES).describe('Organization role');

/** Labels of every role. */
export const ROLE_LABELS: Readonly<Record<Role, LocalizedText>> = {
  super_admin: { en: 'Super admin', id: 'Super admin' },
  org_admin: { en: 'Organization admin', id: 'Admin organisasi' },
  fleet_manager: { en: 'Fleet manager', id: 'Manajer armada' },
  authority: { en: 'Authority', id: 'Otoritas' },
  viewer: { en: 'Viewer', id: 'Pengamat' },
};

/** Returns `true` when `value` is a known role. */
export function isRole(value: unknown): value is Role {
  return ROLES.some((role) => role === value);
}

/** Keeps the known roles of an untrusted list (e.g. token claims), in order, without duplicates. */
export function parseRoles(values: Iterable<unknown>): Role[] {
  const roles = new Set<Role>();
  for (const value of values) {
    if (isRole(value)) roles.add(value);
  }
  return [...roles];
}
