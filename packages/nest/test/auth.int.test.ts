import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthModule } from '../src/auth/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type FakeIntrospectionServer,
  generateTestApiKey,
  startFakeApiKeyIntrospection,
  type TestJwtIssuer,
} from '../src/testing/index.js';
import { FixtureModule } from './support/fixture-app.js';

const INTERNAL_TOKEN = 'integration-internal-token';
const ORG_ID = '0196a1f8-54d9-7223-9107-543e8d90de1c';

describe('auth guard (global default-deny)', () => {
  let jwt: TestJwtIssuer;
  let introspection: FakeIntrospectionServer;
  let app: NestFastifyApplication;
  const ingestKey = generateTestApiKey();
  const readKey = generateTestApiKey();

  beforeAll(async () => {
    jwt = await createTestJwtIssuer();
    introspection = await startFakeApiKeyIntrospection({
      internalToken: INTERNAL_TOKEN,
    });
    introspection.introspector.add(ingestKey, {
      scopes: ['ais:ingest'],
      orgId: ORG_ID,
      name: 'pusher',
    });
    introspection.introspector.add(readKey, { scopes: ['ais:read'] });

    @Module({
      imports: [
        AuthModule.forRoot({ keyResolver: { useValue: jwt.keyResolver } }),
        FixtureModule,
      ],
    })
    class AppModule {}

    const config = createTestConfig(baseConfigSchema, {
      INTERNAL_TOKEN,
      AUTH_INTERNAL_URL: introspection.url,
    });
    app = await buildTestApp(AppModule, { config });
  });

  afterAll(async () => {
    await app.close();
    await introspection.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  it('lets anonymous callers reach @Public() routes', async () => {
    const response = await get('/api/v2/fixtures/public');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it('answers 401 problem details with a Bearer challenge when the token is missing', async () => {
    const response = await get('/api/v2/fixtures/me');
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.json()).toMatchObject({
      type: 'urn:ais-its:problem:unauthorized',
      status: 401,
      code: 'UNAUTHORIZED',
      instance: '/api/v2/fixtures/me',
    });
  });

  it('authenticates a valid access token and exposes the principal', async () => {
    const { token, principal } = await jwt.issue({
      roles: ['viewer'],
      orgId: ORG_ID,
    });
    const response = await get('/api/v2/fixtures/me', {
      authorization: `Bearer ${token}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ kind: 'user', id: principal.id });
  });

  it('rejects expired tokens with 401 invalid_token', async () => {
    const token = await jwt.sign({
      issuedAt: new Date(Date.now() - 3_600_000),
      expiresInSeconds: 60,
    });
    const response = await get('/api/v2/fixtures/me', {
      authorization: `Bearer ${token}`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toContain(
      'error="invalid_token"',
    );
    expect(response.json()).toMatchObject({
      code: 'UNAUTHORIZED',
      detail: 'The access token expired',
    });
  });

  it('tolerates 30 s of clock skew on exp', async () => {
    const token = await jwt.sign({
      issuedAt: new Date(Date.now() - 70_000),
      expiresInSeconds: 50,
    });
    const response = await get('/api/v2/fixtures/me', {
      authorization: `Bearer ${token}`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a wrong audience and a wrong issuer', async () => {
    for (const claims of [{ audience: 'other-api' }, { issuer: 'evil-auth' }]) {
      const token = await jwt.sign(claims);
      const response = await get('/api/v2/fixtures/me', {
        authorization: `Bearer ${token}`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('rejects tokens signed by another key and malformed headers', async () => {
    const other = await createTestJwtIssuer();
    const forged = await other.sign({ roles: ['super_admin'] });
    expect(
      (await get('/api/v2/fixtures/me', { authorization: `Bearer ${forged}` }))
        .statusCode,
    ).toBe(401);
    const malformed = await get('/api/v2/fixtures/me', {
      authorization: 'Basic dXNlcjpwYXNz',
    });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.headers['www-authenticate']).toContain('invalid_request');
  });

  it('rejects tokens whose claims violate the contract (typ must be "access")', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await jwt.signRaw({
      iss: jwt.issuer,
      aud: jwt.audience,
      sub: ORG_ID,
      sid: ORG_ID,
      org: null,
      roles: [],
      email: 'x@ais-its.test',
      name: 'X',
      typ: 'refresh',
      iat: now,
      exp: now + 60,
    });
    const response = await get('/api/v2/fixtures/me', {
      authorization: `Bearer ${token}`,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      detail: 'The access token claims are invalid',
    });
  });

  it('answers 403 when a permission is missing, listing it', async () => {
    const token = await jwt.sign({ roles: ['viewer'] });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/vessels',
      headers: { authorization: `Bearer ${token}` },
      payload: { mmsi: 525005223, name: 'KM Test', positions: [] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      missingPermissions: ['vessel:write'],
    });
  });

  it('accepts API keys only on @AllowApiKey routes, with their scopes', async () => {
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/ingest',
      headers: { 'x-api-key': ingestKey },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ kind: 'api_key', orgId: ORG_ID });

    const wrongScope = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/ingest',
      headers: { 'x-api-key': readKey },
    });
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
      missingScopes: ['ais:ingest'],
    });

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/ingest',
      headers: { 'x-api-key': generateTestApiKey() },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toMatchObject({ code: 'INVALID_API_KEY' });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/ingest',
      headers: { 'x-api-key': 'not-a-key' },
    });
    expect(malformed.statusCode).toBe(401);

    const notAllowed = await get('/api/v2/fixtures/me', {
      'x-api-key': ingestKey,
    });
    expect(notAllowed.statusCode).toBe(401);
    expect(notAllowed.json()).toMatchObject({
      detail: 'API keys are not accepted on this route',
    });
  });

  it('still lets users with the permission call @AllowApiKey routes', async () => {
    const token = await jwt.sign({ roles: ['fleet_manager'], orgId: ORG_ID });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/ingest',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ kind: 'user', orgId: ORG_ID });
  });

  it('caches introspection results (one lookup per key within the TTL)', async () => {
    const key = generateTestApiKey();
    introspection.introspector.add(key, { scopes: ['ais:ingest'] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/fixtures/ingest',
        headers: { 'x-api-key': key },
      });
      expect(response.statusCode).toBe(202);
    }
    expect(
      introspection.introspector.lookups.filter((lookup) => lookup === key),
    ).toHaveLength(1);
  });

  it('protects @Internal() routes with X-Internal-Token (outside the prefix)', async () => {
    expect(
      (
        await get('/internal/fixtures/ping', {
          'x-internal-token': INTERNAL_TOKEN,
        })
      ).json(),
    ).toEqual({ pong: true });
    const wrong = await get('/internal/fixtures/ping', {
      'x-internal-token': 'nope',
    });
    expect(wrong.statusCode).toBe(401);
    const userToken = await jwt.sign({ roles: ['super_admin'] });
    expect(
      (
        await get('/internal/fixtures/ping', {
          authorization: `Bearer ${userToken}`,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('remote JWKS key resolver', () => {
  it('verifies tokens against AUTH_JWKS_URL', async () => {
    const jwt = await createTestJwtIssuer();
    const jwks = await jwt.serveJwks();
    @Module({
      imports: [AuthModule.forRoot({ apiKeys: false }), FixtureModule],
    })
    class AppModule {}
    const app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, { AUTH_JWKS_URL: jwks.url }),
    });
    try {
      const token = await jwt.sign({ roles: ['viewer'] });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v2/fixtures/me',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
      }
      expect(jwks.requests()).toBe(1);
    } finally {
      await app.close();
      await jwks.close();
    }
  });

  it('answers 503 when the JWKS cannot be fetched', async () => {
    const jwt = await createTestJwtIssuer();
    @Module({
      imports: [AuthModule.forRoot({ apiKeys: false }), FixtureModule],
    })
    class AppModule {}
    const app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        AUTH_JWKS_URL: 'http://127.0.0.1:9/.well-known/jwks.json',
      }),
    });
    try {
      const token = await jwt.sign();
      const response = await app.inject({
        method: 'GET',
        url: '/api/v2/fixtures/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    } finally {
      await app.close();
    }
  });
});
