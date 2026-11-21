import { describe, expect, it } from 'vitest';

import {
  AccessTokenClaimsSchema,
  type AccessTokenClaimsInput,
} from './claims.js';
import {
  DEFAULT_AUTH_AUDIENCE,
  DEFAULT_AUTH_ISSUER,
  HTTP_HEADERS,
  parseBearerToken,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_PATH,
} from './constants.js';
import {
  type ApiKeyPrincipal,
  apiKeyPrincipalFromIntrospection,
  canAccessOrg,
  hasAuthorityAccess,
  isPlatformAdmin,
  principalCan,
  principalHasScope,
  principalPermissions,
  type UserPrincipal,
  userPrincipalFromClaims,
} from './tenancy.js';

const ORG_A = '01a1f8c2-54d8-71c4-95cf-ab5eb8908e00';
const ORG_B = '01a1f8c2-54d9-7223-9107-543e8d90de1c';

const CLAIMS: AccessTokenClaimsInput = {
  iss: 'ais-its-auth',
  aud: 'ais-its-api',
  sub: '01a1f8c2-54db-7a10-8b21-1d2e3f4a5b6c',
  sid: '01a1f8c2-54db-7a10-8b21-0c9d8e7f6a5b',
  org: ORG_A,
  roles: ['fleet_manager'],
  email: 'manager@example.com',
  name: 'Fleet Manager',
  typ: 'access',
  iat: 1_795_000_000,
  exp: 1_795_000_900,
};

describe('AccessTokenClaimsSchema', () => {
  it('accepts the claims of spec 8.2', () => {
    expect(AccessTokenClaimsSchema.parse(CLAIMS)).toEqual(CLAIMS);
    expect(
      AccessTokenClaimsSchema.parse({
        ...CLAIMS,
        org: null,
        aud: ['ais-its-api', 'other'],
      }),
    ).toMatchObject({ org: null, aud: ['ais-its-api', 'other'] });
  });

  it('drops unknown roles instead of rejecting the token', () => {
    expect(
      AccessTokenClaimsSchema.parse({
        ...CLAIMS,
        roles: ['viewer', 'root', 'viewer'],
      }).roles,
    ).toEqual(['viewer']);
  });

  it.each([
    ['refresh token type', { typ: 'refresh' }, 'typ'],
    ['non-uuid subject', { sub: 'user-1' }, 'sub'],
    ['missing session', { sid: undefined }, 'sid'],
    ['expiry before issue', { exp: CLAIMS.iat - 1 }, 'exp'],
    ['fractional iat', { iat: 1.5 }, 'iat'],
    ['empty audience list', { aud: [] }, 'aud'],
  ])('rejects %s', (_, patch, path) => {
    const result = AccessTokenClaimsSchema.safeParse({ ...CLAIMS, ...patch });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      path,
    );
  });

  it('exposes the default issuer, audience and cookie', () => {
    expect(DEFAULT_AUTH_ISSUER).toBe('ais-its-auth');
    expect(DEFAULT_AUTH_AUDIENCE).toBe('ais-its-api');
    expect(REFRESH_TOKEN_COOKIE).toBe('aisits_rt');
    expect(REFRESH_TOKEN_COOKIE_PATH).toBe('/api/v2/auth');
    expect(HTTP_HEADERS).toMatchObject({
      API_KEY: 'X-API-Key',
      INTERNAL_TOKEN: 'X-Internal-Token',
      REQUEST_ID: 'X-Request-Id',
      WEBHOOK_SIGNATURE: 'X-AIS-ITS-Signature',
      WEBHOOK_TIMESTAMP: 'X-AIS-ITS-Timestamp',
    });
  });
});

describe('parseBearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer   abc', 'abc'],
    ['Bearer', null],
    ['Basic dXNlcjpwYXNz', null],
    ['Bearer a b', null],
    [undefined, null],
    [null, null],
  ])('%s → %s', (header, expected) => {
    expect(parseBearerToken(header)).toBe(expected);
  });
});

describe('tenancy helpers', () => {
  const manager: UserPrincipal = userPrincipalFromClaims(
    AccessTokenClaimsSchema.parse(CLAIMS),
  );
  const superAdmin: UserPrincipal = {
    ...manager,
    orgId: null,
    roles: ['super_admin'],
  };
  const authority: UserPrincipal = { ...manager, roles: ['authority'] };
  const pusher: ApiKeyPrincipal = apiKeyPrincipalFromIntrospection({
    active: true,
    keyId: '01a1f8c2-54da-749e-ac81-2cf58c581789',
    orgId: ORG_A,
    scopes: ['ais:ingest'],
    name: 'AIS pusher',
  });

  it('maps claims and introspection results to principals', () => {
    expect(manager).toEqual({
      kind: 'user',
      id: CLAIMS.sub,
      sessionId: CLAIMS.sid,
      orgId: ORG_A,
      roles: ['fleet_manager'],
      email: CLAIMS.email,
      name: CLAIMS.name,
    });
    expect(pusher).toEqual({
      kind: 'api_key',
      id: '01a1f8c2-54da-749e-ac81-2cf58c581789',
      orgId: ORG_A,
      scopes: ['ais:ingest'],
      name: 'AIS pusher',
    });
  });

  it('restricts tenant-private data to the active organization', () => {
    expect(canAccessOrg(manager, ORG_A)).toBe(true);
    expect(canAccessOrg(manager, ORG_B)).toBe(false);
    expect(canAccessOrg(manager, null)).toBe(false);
    expect(canAccessOrg(pusher, ORG_A)).toBe(true);
    expect(canAccessOrg(pusher, ORG_B)).toBe(false);
    expect(canAccessOrg(superAdmin, ORG_B)).toBe(true);
    expect(canAccessOrg(superAdmin, null)).toBe(true);
  });

  it('identifies platform admins and cross-tenant surveillance roles', () => {
    expect(isPlatformAdmin(superAdmin)).toBe(true);
    expect(isPlatformAdmin(manager)).toBe(false);
    expect(isPlatformAdmin(pusher)).toBe(false);
    expect(hasAuthorityAccess(authority)).toBe(true);
    expect(hasAuthorityAccess(superAdmin)).toBe(true);
    expect(hasAuthorityAccess(manager)).toBe(false);
  });

  it('checks permissions for users and scopes for API keys', () => {
    expect(principalCan(manager, 'vessel:write')).toBe(true);
    expect(principalCan(manager, 'user:manage')).toBe(false);
    expect(principalCan(pusher, 'ais:read')).toBe(false);
    expect(principalPermissions(pusher).size).toBe(0);
    expect(principalHasScope(pusher, 'ais:ingest')).toBe(true);
    expect(principalHasScope(pusher, 'telemetry:ingest')).toBe(false);
    expect(principalHasScope(manager, 'ais:ingest')).toBe(false);
  });
});
