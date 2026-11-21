import { describe, expect, it } from 'vitest';

import {
  isPermission,
  type Permission,
  PERMISSIONS,
  permissionsForRoles,
  ROLE_PERMISSIONS,
  rolesHavePermission,
} from './permissions.js';
import {
  isRole,
  ORG_ROLES,
  parseRoles,
  PLATFORM_ROLES,
  type Role,
  ROLES,
} from './roles.js';

/**
 * Transcription of the permission table of spec 8.4, column order:
 * super_admin | org_admin | fleet_manager | authority | viewer.
 */
const SPEC_MATRIX = `
vessel:read       ✓ ✓ ✓ ✓ ✓
vessel:write      ✓ ✓ ✓ · ·
reference:write   ✓ · · · ·
ais:read          ✓ ✓ ✓ ✓ ✓
telemetry:read    ✓ ✓ ✓ · ·
telemetry:write   ✓ ✓ ✓ · ·
device:manage     ✓ ✓ · · ·
cii:read          ✓ ✓ ✓ · ✓
seemp:read        ✓ ✓ ✓ · ✓
seemp:simulate    ✓ ✓ ✓ · ·
safety:read           ✓ ✓ ✓ ✓ ✓
surveillance:read     ✓ ✓ ✓ ✓ ✓
surveillance:review   ✓ · · ✓ ·
zone:read         ✓ ✓ ✓ ✓ ✓
zone:write        ✓ ✓ · ✓ ·
alert:read        ✓ ✓ ✓ ✓ ✓
alert:ack         ✓ ✓ ✓ ✓ ·
alert_rule:write  ✓ ✓ ✓ ✓ ·
user:manage       ✓ ✓ · · ·
org:manage        ✓ · · · ·
api_key:manage    ✓ ✓ · · ·
audit:read        ✓ ✓ · · ·
report:read       ✓ ✓ ✓ · ·
`;

const COLUMNS: readonly Role[] = [
  'super_admin',
  'org_admin',
  'fleet_manager',
  'authority',
  'viewer',
];

const specRows = SPEC_MATRIX.trim()
  .split('\n')
  .map((line) => {
    const [permission = '', ...marks] = line.trim().split(/\s+/);
    return { permission, marks };
  });

describe('ROLE_PERMISSIONS', () => {
  it('lists the permissions of the spec table in order', () => {
    expect(specRows.map((row) => row.permission)).toEqual([...PERMISSIONS]);
  });

  it('matches the spec 8.4 matrix exactly', () => {
    for (const [column, role] of COLUMNS.entries()) {
      const expected = specRows
        .filter((row) => row.marks[column] === '✓')
        .map((row) => row.permission);
      expect([...ROLE_PERMISSIONS[role]].sort(), role).toEqual(expected.sort());
    }
  });

  it('grants super_admin every permission', () => {
    expect(new Set(ROLE_PERMISSIONS.super_admin)).toEqual(new Set(PERMISSIONS));
    expect(permissionsForRoles(['super_admin']).size).toBe(PERMISSIONS.length);
  });

  it('grants viewer no write permission', () => {
    const viewer = permissionsForRoles(['viewer']);
    expect(viewer.size).toBeGreaterThan(0);
    for (const permission of viewer) {
      expect(permission.endsWith(':read'), permission).toBe(true);
    }
  });

  it('keeps tenant-administration permissions to admins', () => {
    for (const role of ['fleet_manager', 'authority', 'viewer'] as const) {
      for (const permission of [
        'user:manage',
        'org:manage',
        'api_key:manage',
        'audit:read',
        'reference:write',
      ] as const) {
        expect(
          rolesHavePermission([role], permission),
          `${role} ${permission}`,
        ).toBe(false);
      }
    }
    expect(rolesHavePermission(['org_admin'], 'org:manage')).toBe(false);
  });

  it('has no duplicates and only known permissions', () => {
    for (const role of ROLES) {
      const permissions = ROLE_PERMISSIONS[role];
      expect(new Set(permissions).size).toBe(permissions.length);
      expect(permissions.every(isPermission)).toBe(true);
    }
  });
});

describe('permissionsForRoles', () => {
  it('returns the union of the roles', () => {
    const granted = permissionsForRoles(['authority', 'viewer']);
    const expected = new Set<Permission>([
      ...ROLE_PERMISSIONS.authority,
      ...ROLE_PERMISSIONS.viewer,
    ]);
    expect(granted).toEqual(expected);
    expect(granted.has('surveillance:review')).toBe(true);
    expect(granted.has('safety:read')).toBe(true);
    expect(granted.has('cii:read')).toBe(true);
    expect(granted.has('vessel:write')).toBe(false);
  });

  it('returns nothing for no roles', () => {
    expect(permissionsForRoles([]).size).toBe(0);
    expect(rolesHavePermission([], 'vessel:read')).toBe(false);
  });
});

describe('roles', () => {
  it('splits platform and organization roles', () => {
    expect([...PLATFORM_ROLES, ...ORG_ROLES].sort()).toEqual([...ROLES].sort());
    expect(isRole('org_admin')).toBe(true);
    expect(isRole('admin')).toBe(false);
  });

  it('parses untrusted role lists', () => {
    expect(parseRoles(['viewer', 'hacker', 'viewer', 42, 'authority'])).toEqual(
      ['viewer', 'authority'],
    );
  });
});
