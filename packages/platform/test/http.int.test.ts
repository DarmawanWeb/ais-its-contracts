import { ProblemDetailsSchema } from '@darmawanweb/seemp-contracts/api';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthModule } from '../src/auth/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type TestJwtIssuer,
} from '../src/testing/index.js';
import { FixtureModule } from './support/fixture-app.js';

async function fixtureApp(jwt: TestJwtIssuer, env: Record<string, string> = {}): Promise<NestFastifyApplication> {
  @Module({ imports: [AuthModule.forRoot({ apiKeys: false, keyResolver: { useValue: jwt.keyResolver } }), FixtureModule] })
  class AppModule {}
  return buildTestApp(AppModule, { config: createTestConfig(baseConfigSchema, env) });
}

describe('HTTP conventions', () => {
  let jwt: TestJwtIssuer;
  let app: NestFastifyApplication;
  let writer: string;

  beforeAll(async () => {
    jwt = await createTestJwtIssuer();
    app = await fixtureApp(jwt, { CORS_ORIGINS: 'http://localhost:5173' });
    writer = await jwt.sign({ roles: ['fleet_manager'] });
  });

  afterAll(async () => {
    await app.close();
  });

  const createVessel = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/vessels',
      headers: { authorization: `Bearer ${writer}` },
      payload: payload as Record<string, unknown>,
    });

  it('serves routes under /api/v2 only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v2/fixtures/public' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/fixtures/public' })).statusCode).toBe(404);
  });

  it('transforms valid bodies into DTO instances', async () => {
    const response = await createVessel({ mmsi: 525005223, name: 'KM Test', positions: [{ lat: -6.1, lon: 106.8 }] });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ mmsi: 525005223, positions: 1, dto: true });
  });

  it('answers 400 VALIDATION_FAILED with field errors (nested paths)', async () => {
    const response = await createVessel({ mmsi: 12, name: 'K', positions: [{ lat: 10, lon: 20 }, { lat: 95, lon: 20 }] });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = ProblemDetailsSchema.parse(response.json());
    expect(body).toMatchObject({ type: 'https://seemp.dev/problems/validation-failed', code: 'VALIDATION_FAILED', status: 400 });
    expect(body.errors?.map((error) => error.field).sort()).toEqual(['mmsi', 'name', 'positions.1.lat']);
    expect(body.errors).toContainEqual(expect.objectContaining({ field: 'positions.1.lat', code: 'isLatitude' }));
  });

  it('rejects unknown properties (forbidNonWhitelisted)', async () => {
    const response = await createVessel({ mmsi: 525005223, name: 'KM Test', positions: [], admin: true });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ field: 'admin', code: 'whitelistValidation' })],
    });
  });

  it('maps domain errors to their code, status and extensions', async () => {
    const notFound = await app.inject({ method: 'GET', url: '/api/v2/fixtures/vessels/525005223' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({
      type: 'https://seemp.dev/problems/vessel-not-found',
      title: 'Vessel not found',
      status: 404,
      code: 'VESSEL_NOT_FOUND',
      detail: 'No vessel with MMSI 525005223',
      instance: '/api/v2/fixtures/vessels/525005223',
      mmsi: 525005223,
    });
    const conflict = await app.inject({ method: 'POST', url: '/api/v2/fixtures/conflict' });
    expect(conflict.json()).toMatchObject({ status: 409, code: 'MMSI_ALREADY_EXISTS' });
  });

  it('maps Nest exceptions (pipes, unknown routes, malformed JSON)', async () => {
    const pipe = await app.inject({ method: 'GET', url: '/api/v2/fixtures/vessels/abc' });
    expect(pipe.statusCode).toBe(400);
    expect(pipe.json()).toMatchObject({ code: 'BAD_REQUEST' });

    const missing = await app.inject({ method: 'GET', url: '/api/v2/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND', instance: '/api/v2/nope' });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/vessels',
      headers: { authorization: `Bearer ${writer}`, 'content-type': 'application/json' },
      payload: '{"mmsi":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
  });

  it('answers 500 INTERNAL_ERROR without a stack trace', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v2/fixtures/crash' });
    expect(response.statusCode).toBe(500);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('reuses a well-formed X-Request-Id, generates one otherwise, and reports it in problems', async () => {
    const reused = await app.inject({ method: 'GET', url: '/api/v2/fixtures/public', headers: { 'x-request-id': 'req-123' } });
    expect(reused.headers['x-request-id']).toBe('req-123');

    const generated = await app.inject({ method: 'GET', url: '/api/v2/fixtures/public', headers: { 'x-request-id': 'bad\nid' } });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const problem = await app.inject({ method: 'GET', url: '/api/v2/nope', headers: { 'x-request-id': 'req-456' } });
    expect(problem.json()).toMatchObject({ requestId: 'req-456', traceId: 'req-456' });
  });

  it('sends CORS headers for configured origins (with credentials) and security headers', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v2/fixtures/public',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');

    const foreign = await app.inject({ method: 'GET', url: '/api/v2/fixtures/public', headers: { origin: 'https://evil.example' } });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    const response = await app.inject({ method: 'GET', url: '/api/v2/fixtures/public' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('serves Swagger UI and the OpenAPI document outside the prefix', async () => {
    const docs = await app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    const document = (await app.inject({ method: 'GET', url: '/openapi.json' })).json<{
      paths: Record<string, Record<string, { security?: unknown; responses: Record<string, unknown> }>>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
      security: unknown;
    }>();
    expect(Object.keys(document.paths)).toContain('/api/v2/fixtures/vessels');
    expect(Object.keys(document.paths)).toContain('/internal/fixtures/ping');
    expect(Object.keys(document.paths).some((path) => path.startsWith('/health') || path === '/metrics')).toBe(false);
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual(['apiKey', 'bearer', 'internalToken']);
    expect(document.security).toEqual([{ bearer: [] }]);
    expect(document.paths['/api/v2/fixtures/public']?.get?.security).toEqual([{}]);
    expect(document.paths['/api/v2/fixtures/ingest']?.post?.security).toEqual([{ bearer: [] }, { apiKey: [] }]);
    expect(document.paths['/api/v2/fixtures/vessels']?.post?.responses.default).toBeDefined();
    expect(document.components.schemas.ProblemDetails).toBeDefined();
  });
});

describe('HTTP conventions in production', () => {
  it('hides the message of unexpected errors', async () => {
    const jwt = await createTestJwtIssuer();
    const app = await fixtureApp(jwt, { NODE_ENV: 'production', INTERNAL_TOKEN: 'a-production-secret-token' });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v2/fixtures/crash' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: 'INTERNAL_ERROR', detail: 'An unexpected error occurred' });
      expect(response.body).not.toContain('hunter2');
    } finally {
      await app.close();
    }
  });
});
