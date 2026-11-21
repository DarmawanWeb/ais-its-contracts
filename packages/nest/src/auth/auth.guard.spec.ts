import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { baseConfigSchema, loadConfig } from '../config/define-config.js';
import { DomainError } from '../errors/domain-error.js';
import {
  FakeApiKeyIntrospector,
  generateTestApiKey,
} from '../testing/api-key-introspection.js';
import {
  createTestJwtIssuer,
  type TestJwtIssuer,
} from '../testing/jwt-issuer.js';
import { AccessTokenVerifier } from './access-token-verifier.service.js';
import { ApiKeyVerifier } from './api-key-verifier.js';
import { AuthGuard } from './auth.guard.js';
import {
  AllowApiKey,
  Internal,
  Public,
  RequirePermissions,
} from './decorators.js';
import { assertOrgAccess, type Principal, UserPrincipal } from './principal.js';
import { getRequestPrincipal } from './request-principal.js';

const ORG = '018f2b5e-0000-7000-8000-000000000001';

/** Routes carrying the guard metadata. */
class Routes {
  @Public()
  open(): string {
    return 'open';
  }

  @Internal()
  internal(): string {
    return 'internal';
  }

  anyUser(): string {
    return 'any user';
  }

  @RequirePermissions('vessel:write')
  write(): string {
    return 'write';
  }

  @AllowApiKey('ais:ingest')
  ingest(): string {
    return 'ingest';
  }
}

/** A controller opened as a whole, with handlers that protect themselves. */
@Public()
class OpenController {
  page(): string {
    return 'page';
  }

  @RequirePermissions('org:manage')
  rotate(): string {
    return 'rotate';
  }
}

/** A controller accepting API keys, with an admin-only handler. */
@AllowApiKey('ais:ingest')
class IngestController {
  ingest(): string {
    return 'ingest';
  }

  @RequirePermissions('org:manage')
  status(): string {
    return 'status';
  }
}

/** A WebSocket gateway: one handler opened after the handshake check, one not. */
class Gateway {
  @Public()
  subscribe(): string {
    return 'subscribe';
  }

  unmarked(): string {
    return 'unmarked';
  }
}

interface FakeRequest {
  readonly headers: Record<string, string>;
}

type Controller = typeof Routes | typeof OpenController | typeof IngestController | typeof Gateway;

function contextFor(
  handler: string,
  headers: Record<string, string>,
  controller: Controller = Routes,
  type = 'http',
): [ExecutionContext, FakeRequest] {
  const request: FakeRequest = { headers };
  const context = {
    getType: () => type,
    getHandler: (): unknown =>
      Object.getOwnPropertyDescriptor(controller.prototype, handler)?.value,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return [context, request];
}

describe('AuthGuard (global default-deny, spec §8.6)', () => {
  let jwt: TestJwtIssuer;
  let guard: AuthGuard;
  const introspector = new FakeApiKeyIntrospector();
  const ingestKey = generateTestApiKey();
  const readKey = generateTestApiKey();
  const config = loadConfig(baseConfigSchema, {
    env: { SERVICE_NAME: 'guard-test', INTERNAL_TOKEN: 'internal-secret' },
    output: null,
  });

  beforeAll(async () => {
    jwt = await createTestJwtIssuer();
    introspector.add(ingestKey, { scopes: ['ais:ingest'], orgId: ORG });
    introspector.add(readKey, { scopes: ['ais:read'], orgId: ORG });
    guard = new AuthGuard(
      new Reflector(),
      new AccessTokenVerifier(config, jwt.keyResolver),
      config,
      new ApiKeyVerifier(introspector),
    );
  });

  const status = async (
    handler: string,
    headers: Record<string, string> = {},
    controller: Controller = Routes,
  ): Promise<number> => {
    const [context] = contextFor(handler, headers, controller);
    try {
      return (await guard.canActivate(context)) ? 200 : 403;
    } catch (error) {
      if (error instanceof DomainError) return error.status;
      throw error;
    }
  };

  it('lets handler-level requirements win over a controller-level @Public()', async () => {
    const admin = await jwt.sign({ roles: ['super_admin'] });
    const viewer = await jwt.sign({ roles: ['viewer'], orgId: ORG });
    expect(await status('page', {}, OpenController)).toBe(200);
    expect(await status('rotate', {}, OpenController)).toBe(401);
    expect(
      await status('rotate', { authorization: `Bearer ${viewer}` }, OpenController),
    ).toBe(403);
    expect(
      await status('rotate', { authorization: `Bearer ${admin}` }, OpenController),
    ).toBe(200);
  });

  it('does not extend a controller-level @AllowApiKey to handlers with their own permissions', async () => {
    const admin = await jwt.sign({ roles: ['super_admin'] });
    expect(await status('ingest', { 'x-api-key': ingestKey }, IngestController)).toBe(200);
    expect(await status('status', { 'x-api-key': ingestKey }, IngestController)).toBe(401);
    expect(
      await status('status', { authorization: `Bearer ${admin}` }, IngestController),
    ).toBe(200);
  });

  it('denies non-HTTP handlers unless they are marked @Public()', async () => {
    const [open] = contextFor('subscribe', {}, Gateway, 'ws');
    const [closed] = contextFor('unmarked', {}, Gateway, 'ws');
    const [rpc] = contextFor('unmarked', {}, Gateway, 'rpc');
    expect(await guard.canActivate(open)).toBe(true);
    expect(await guard.canActivate(closed)).toBe(false);
    expect(await guard.canActivate(rpc)).toBe(false);
  });

  it('opens @Public() routes and denies everything else without credentials (401)', async () => {
    expect(await status('open')).toBe(200);
    expect(await status('anyUser')).toBe(401);
    expect(await status('write')).toBe(401);
  });

  it('distinguishes 401 (bad credentials) from 403 (missing permission)', async () => {
    const viewer = await jwt.sign({ roles: ['viewer'], orgId: ORG });
    const manager = await jwt.sign({ roles: ['fleet_manager'], orgId: ORG });
    expect(await status('anyUser', { authorization: `Bearer ${viewer}` })).toBe(
      200,
    );
    expect(await status('write', { authorization: `Bearer ${viewer}` })).toBe(
      403,
    );
    expect(await status('write', { authorization: `Bearer ${manager}` })).toBe(
      200,
    );
    expect(await status('anyUser', { authorization: 'Bearer not-a-jwt' })).toBe(
      401,
    );
    expect(await status('anyUser', { authorization: 'Basic abc' })).toBe(401);
    const expired = await jwt.sign({ expiresInSeconds: -120 });
    expect(
      await status('anyUser', { authorization: `Bearer ${expired}` }),
    ).toBe(401);
  });

  it('accepts API keys only on @AllowApiKey routes with the scope', async () => {
    expect(await status('ingest', { 'x-api-key': ingestKey })).toBe(200);
    expect(await status('ingest', { 'x-api-key': readKey })).toBe(403);
    expect(await status('anyUser', { 'x-api-key': ingestKey })).toBe(401);
    expect(await status('ingest', { 'x-api-key': generateTestApiKey() })).toBe(
      401,
    );
    expect(await status('ingest', { 'x-api-key': 'garbage' })).toBe(401);
  });

  it('requires a matching X-Internal-Token on @Internal() routes, even with a user', async () => {
    const admin = await jwt.sign({ roles: ['super_admin'] });
    expect(
      await status('internal', { 'x-internal-token': 'internal-secret' }),
    ).toBe(200);
    expect(await status('internal', { 'x-internal-token': 'wrong' })).toBe(401);
    expect(await status('internal', { authorization: `Bearer ${admin}` })).toBe(
      401,
    );
  });

  it('attaches the principal to the request', async () => {
    const issued = await jwt.issue({ roles: ['authority'], orgId: ORG });
    const [context, request] = contextFor('anyUser', {
      authorization: `Bearer ${issued.token}`,
    });
    await guard.canActivate(context);
    const principal = getRequestPrincipal(request);
    expect(principal?.id).toBe(issued.principal.id);
    expect(principal?.can('surveillance:review')).toBe(true);
  });

  it('denies API keys when the auth service is down (503, never allowed)', async () => {
    const down = new AuthGuard(
      new Reflector(),
      new AccessTokenVerifier(config, jwt.keyResolver),
      config,
      new ApiKeyVerifier({
        introspect: () => Promise.reject(new Error('ECONNREFUSED')),
      }),
    );
    const [context] = contextFor('ingest', { 'x-api-key': ingestKey });
    await expect(down.canActivate(context)).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe('principals (spec §8.4, §8.5)', () => {
  it('derives permissions from roles and enforces tenancy', () => {
    const manager = new UserPrincipal({
      id: 'u1',
      sessionId: 's1',
      orgId: ORG,
      roles: ['fleet_manager'],
      email: 'a@b.c',
      name: 'A',
    });
    const admin = new UserPrincipal({
      id: 'u2',
      sessionId: 's2',
      orgId: null,
      roles: ['super_admin'],
      email: 'a@b.c',
      name: 'B',
    });
    expect(manager.can('vessel:write')).toBe(true);
    expect(manager.can('org:manage')).toBe(false);
    expect(manager.isPlatformAdmin).toBe(false);
    expect(admin.isPlatformAdmin).toBe(true);
    expect(manager.canAccessOrg(ORG)).toBe(true);
    expect(manager.canAccessOrg('018f2b5e-0000-7000-8000-000000000002')).toBe(
      false,
    );
    expect(admin.canAccessOrg('018f2b5e-0000-7000-8000-000000000002')).toBe(
      true,
    );
    const principal: Principal = manager;
    expect(() => {
      assertOrgAccess(principal, '018f2b5e-0000-7000-8000-000000000002');
    }).toThrow(/another organization/);
  });
});
