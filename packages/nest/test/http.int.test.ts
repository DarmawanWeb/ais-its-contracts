import { ProblemDetailsSchema } from '@darmawanweb/ais-its-contracts/api';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthModule } from '../src/auth/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import {
  buildTestApp,
  type BuildTestAppOptions,
  createTestConfig,
  createTestJwtIssuer,
  type TestJwtIssuer,
} from '../src/testing/index.js';
import { FixtureModule } from './support/fixture-app.js';

async function fixtureApp(
  jwt: TestJwtIssuer,
  env: Record<string, string> = {},
  options: Pick<BuildTestAppOptions, 'cors'> = {},
): Promise<NestFastifyApplication> {
  @Module({
    imports: [
      AuthModule.forRoot({
        apiKeys: false,
        keyResolver: { useValue: jwt.keyResolver },
      }),
      FixtureModule,
    ],
  })
  class AppModule {}
  return buildTestApp(AppModule, {
    config: createTestConfig(baseConfigSchema, env),
    ...options,
  });
}

describe('HTTP conventions', () => {
  let jwt: TestJwtIssuer;
  let app: NestFastifyApplication;
  let writer: string;

  beforeAll(async () => {
    jwt = await createTestJwtIssuer();
    app = await fixtureApp(
      jwt,
      { CORS_ORIGINS: 'http://localhost:5173' },
      { cors: { exposedHeaders: ['X-Total-Count'] } },
    );
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
    expect(
      (await app.inject({ method: 'GET', url: '/api/v2/fixtures/public' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/fixtures/public' })).statusCode,
    ).toBe(404);
  });

  it('transforms valid bodies into DTO instances', async () => {
    const response = await createVessel({
      mmsi: 525005223,
      name: 'KM Test',
      positions: [{ lat: -6.1, lon: 106.8 }],
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      mmsi: 525005223,
      positions: 1,
      dto: true,
    });
  });

  it('answers 400 VALIDATION_FAILED with field errors (nested paths)', async () => {
    const response = await createVessel({
      mmsi: 12,
      name: 'K',
      positions: [
        { lat: 10, lon: 20 },
        { lat: 95, lon: 20 },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    const body = ProblemDetailsSchema.parse(response.json());
    expect(body).toMatchObject({
      type: 'urn:ais-its:problem:validation-failed',
      code: 'VALIDATION_FAILED',
      status: 400,
    });
    expect(body.errors?.map((error) => error.field).sort()).toEqual([
      'mmsi',
      'name',
      'positions.1.lat',
    ]);
    expect(body.errors).toContainEqual(
      expect.objectContaining({ field: 'positions.1.lat', code: 'isLatitude' }),
    );
  });

  it('rejects unknown properties (forbidNonWhitelisted)', async () => {
    const response = await createVessel({
      mmsi: 525005223,
      name: 'KM Test',
      positions: [],
      admin: true,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [
        expect.objectContaining({
          field: 'admin',
          code: 'whitelistValidation',
        }),
      ],
    });
  });

  it('maps domain errors to their code, status and extensions', async () => {
    const notFound = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/vessels/525005223',
    });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({
      type: 'urn:ais-its:problem:vessel-not-found',
      title: 'Vessel not found',
      status: 404,
      code: 'VESSEL_NOT_FOUND',
      detail: 'No vessel with MMSI 525005223',
      instance: '/api/v2/fixtures/vessels/525005223',
      mmsi: 525005223,
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/conflict',
    });
    expect(conflict.json()).toMatchObject({
      status: 409,
      code: 'MMSI_ALREADY_EXISTS',
    });
  });

  it('maps Nest exceptions (pipes, unknown routes, malformed JSON)', async () => {
    const pipe = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/vessels/abc',
    });
    expect(pipe.statusCode).toBe(400);
    expect(pipe.json()).toMatchObject({ code: 'BAD_REQUEST' });

    const missing = await app.inject({ method: 'GET', url: '/api/v2/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(missing.json()).toMatchObject({
      code: 'NOT_FOUND',
      instance: '/api/v2/nope',
    });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/vessels',
      headers: {
        authorization: `Bearer ${writer}`,
        'content-type': 'application/json',
      },
      payload: '{"mmsi":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
    });
  });

  it('answers 500 INTERNAL_ERROR without a stack trace', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/crash',
    });
    expect(response.statusCode).toBe(500);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('reuses a well-formed X-Request-Id, generates one otherwise, and reports it in problems', async () => {
    const reused = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/public',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(reused.headers['x-request-id']).toBe('req-123');

    const generated = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/public',
      headers: { 'x-request-id': 'bad\nid' },
    });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const problem = await app.inject({
      method: 'GET',
      url: '/api/v2/nope',
      headers: { 'x-request-id': 'req-456' },
    });
    expect(problem.json()).toMatchObject({
      requestId: 'req-456',
      traceId: 'req-456',
    });
  });

  it('sends CORS headers for configured origins (with credentials) and security headers', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v2/fixtures/public',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(preflight.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');

    const foreign = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/public',
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/public',
    });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
  });

  it('exposes the default and the configured headers to CORS origins (CORE-6)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/public',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(
      response.headers['access-control-expose-headers']
        ?.toString()
        .split(',')
        .map((header) => header.trim()),
    ).toEqual([
      'X-Request-Id',
      'Retry-After',
      'WWW-Authenticate',
      'ETag',
      'Location',
      'X-Total-Count',
    ]);
  });

  it('bounds page at MAX_PAGE: 400 instead of an OFFSET overflow (CORE-3)', async () => {
    const last = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/pages?page=1000000&pageSize=100',
    });
    expect(last.json()).toEqual({ offset: 99_999_900 });
    for (const page of ['1000001', '99999999999999999999']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v2/fixtures/pages?page=${page}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [expect.objectContaining({ field: 'page', code: 'max' })],
      });
    }
  });

  it('validates path parameters with field errors (CORE-4)', async () => {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v2/fixtures/by-mmsi/525005223',
        })
      ).json(),
    ).toEqual({ mmsi: 525005223 });
    for (const value of ['0525005223', '0x1F4A1D67', '%20525005223', '1e5']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v2/fixtures/by-mmsi/${value}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'mmsi', code: 'isMmsi' }],
      });
    }
    const id = '0193a3c0-0000-7000-8000-0000000000e1';
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v2/fixtures/zones/${id}/years/2026`,
        })
      ).json(),
    ).toEqual({ id, year: 2026 });
    const badId = await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/zones/not-a-uuid/years/2026',
    });
    expect(badId.json()).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'id', code: 'isUuid' }],
    });
    const badYear = await app.inject({
      method: 'GET',
      url: `/api/v2/fixtures/zones/${id}/years/1999`,
    });
    expect(badYear.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'year', code: 'min' }],
    });
  });

  it('answers 400 for null in an "optional but not null" PATCH field (CORE-5)', async () => {
    const url = '/api/v2/fixtures/zones/0193a3c0-0000-7000-8000-0000000000e1';
    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: 'PATCH', url, payload });
    expect((await patch({})).json()).toMatchObject({ fields: [] });
    expect((await patch({ name: 'Batam' })).json()).toMatchObject({
      fields: ['name'],
    });
    const cleared = await patch({ name: null });
    expect(cleared.statusCode).toBe(400);
    const clearedBody = cleared.json<{
      code: string;
      errors: { field: string; code: string }[];
    }>();
    expect(clearedBody.code).toBe('VALIDATION_FAILED');
    expect(
      clearedBody.errors.map((error) => `${error.field}:${error.code}`),
    ).toContain('name:isString');
  });

  it('accepts bodiless JSON POSTs and still rejects bad JSON (CORE-8)', async () => {
    const ack = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/alerts/0193a3c0-0000-7000-8000-0000000000e1/ack',
      headers: { 'content-type': 'application/json' },
    });
    expect(ack.statusCode).toBe(204);
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/vessels',
      headers: {
        authorization: `Bearer ${writer}`,
        'content-type': 'application/json',
      },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    for (const payload of [
      '{"mmsi":',
      '{"__proto__":{"admin":true}}',
      '{"constructor":{"prototype":{"admin":true}}}',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v2/fixtures/vessels',
        headers: {
          authorization: `Bearer ${writer}`,
          'content-type': 'application/json',
        },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'BAD_REQUEST' });
    }
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/v2/fixtures/vessels',
      headers: {
        authorization: `Bearer ${writer}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'x'.repeat(1024 * 1024 + 1) }),
    });
    expect(tooLarge.statusCode).toBe(413);
  });

  it('serves Swagger UI and the OpenAPI document outside the prefix', async () => {
    const docs = await app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    expect(docs.headers['content-type']).toContain('text/html');
    const document = (
      await app.inject({ method: 'GET', url: '/openapi.json' })
    ).json<{
      paths: Record<
        string,
        Record<
          string,
          { security?: unknown; responses: Record<string, unknown> }
        >
      >;
      components: {
        securitySchemes: Record<string, unknown>;
        schemas: Record<string, unknown>;
      };
      security: unknown;
    }>();
    expect(Object.keys(document.paths)).toContain('/api/v2/fixtures/vessels');
    expect(Object.keys(document.paths)).toContain('/internal/fixtures/ping');
    expect(
      Object.keys(document.paths).some(
        (path) => path.startsWith('/health') || path === '/metrics',
      ),
    ).toBe(false);
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
      'apiKey',
      'bearer',
      'internalToken',
    ]);
    expect(document.security).toEqual([{ bearer: [] }]);
    expect(document.paths['/api/v2/fixtures/public']?.get?.security).toEqual([
      {},
    ]);
    expect(document.paths['/api/v2/fixtures/ingest']?.post?.security).toEqual([
      { bearer: [] },
      { apiKey: [] },
    ]);
    expect(
      document.paths['/api/v2/fixtures/vessels']?.post?.responses.default,
    ).toBeDefined();
    expect(document.components.schemas.ProblemDetails).toBeDefined();
    const parameters = (path: string, method = 'get') =>
      (
        document.paths[path]?.[method] as
          { parameters?: Record<string, unknown>[] } | undefined
      )?.parameters;
    expect(parameters('/api/v2/fixtures/by-mmsi/{mmsi}')).toEqual([
      expect.objectContaining({
        name: 'mmsi',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^[0-9]{9}$', example: '525005223' },
      }),
    ]);
    expect(parameters('/api/v2/fixtures/zones/{id}/years/{year}')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          schema: { type: 'string', format: 'uuid' },
        }),
        expect.objectContaining({
          name: 'year',
          schema: { type: 'integer', minimum: 2000, maximum: 2100 },
        }),
      ]),
    );
    const page = parameters('/api/v2/fixtures/pages')?.find(
      (parameter) => parameter.name === 'page',
    );
    expect(page?.schema).toMatchObject({ maximum: 1_000_000 });
  });
});

describe('HTTP conventions in production', () => {
  it('hides the message of unexpected errors', async () => {
    const jwt = await createTestJwtIssuer();
    const app = await fixtureApp(jwt, {
      NODE_ENV: 'production',
      INTERNAL_TOKEN: 'a-production-secret-token',
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v2/fixtures/crash',
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: 'INTERNAL_ERROR',
        detail: 'An unexpected error occurred',
      });
      expect(response.body).not.toContain('hunter2');
    } finally {
      await app.close();
    }
  });
});
