import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Controller, Get, Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DetectorRunnerModule } from '../src/analytics/index.js';
import { AuthModule, Public, RequirePermissions } from '../src/auth/index.js';
import { DatabaseModule } from '../src/db/index.js';
import {
  baseConfigSchema,
  bootstrapService,
  exportOpenApi,
  loadConfig,
} from '../src/index.js';
import { NatsModule } from '../src/nats/index.js';
import { RedisModule } from '../src/redis/index.js';
import { createTestJwtIssuer } from '../src/testing/index.js';

@ApiTags('ping')
@Controller('ping')
class PingController {
  @Public()
  @Get()
  @ApiOkResponse({ description: 'Pong' })
  ping(): { readonly pong: true } {
    return { pong: true };
  }

  @RequirePermissions('vessel:read')
  @Get('secure')
  secure(): { readonly ok: true } {
    return { ok: true };
  }
}

describe('bootstrapService', () => {
  let app: NestFastifyApplication;
  let url: string;

  beforeAll(async () => {
    const jwt = await createTestJwtIssuer();
    @Module({
      imports: [
        AuthModule.forRoot({ keyResolver: { useValue: jwt.keyResolver } }),
      ],
      controllers: [PingController],
    })
    class AppModule {}
    const config = loadConfig(baseConfigSchema, {
      env: {
        SERVICE_NAME: 'smoke',
        SERVICE_VERSION: '9.9.9',
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        LOG_LEVEL: 'silent',
      },
      output: null,
    });
    app = await bootstrapService({
      appModule: AppModule,
      config,
      openapi: { title: 'Smoke service', version: '9.9.9', tags: ['ping'] },
      cookies: true,
    });
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('listens with the platform conventions (prefix, request id, health, metrics, docs)', async () => {
    const pong = await fetch(`${url}/api/v2/ping`, {
      headers: { 'x-request-id': 'smoke-1' },
    });
    expect(pong.status).toBe(200);
    expect(pong.headers.get('x-request-id')).toBe('smoke-1');
    expect(await pong.json()).toEqual({ pong: true });

    const denied = await fetch(`${url}/api/v2/ping/secure`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('content-type')).toContain(
      'application/problem+json',
    );

    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toContain('aisits_process_cpu_user_seconds_total');
    expect(metrics).toContain(
      'aisits_http_requests_total{method="GET",route="/api/v2/ping",status_code="200"} 1',
    );
    const document = (await (await fetch(`${url}/openapi.json`)).json()) as {
      info: { title: string };
    };
    expect(document.info.title).toBe('Smoke service');
    expect((await fetch(`${url}/docs`)).status).toBe(200);
    expect((await fetch(`${url}/api/v2/health/live`)).status).toBe(404);
  });
});

describe('exportOpenApi', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aisits-openapi-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('builds the document without opening any connection', async () => {
    @Module({
      imports: [
        // Unreachable infrastructure: nothing may connect during the export.
        DatabaseModule.forRoot(),
        NatsModule.forRoot({ streams: ['ALERTS'] }),
        RedisModule.forRoot(),
        AuthModule.forRoot(),
        DetectorRunnerModule.forRoot({
          positions: 'safety-positions',
          env: {},
        }),
      ],
      controllers: [PingController],
    })
    class AppModule {}
    const config = loadConfig(baseConfigSchema, {
      env: {
        SERVICE_NAME: 'export',
        NODE_ENV: 'test',
        DATABASE_SCHEMA: 'export',
        DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/aisits',
        NATS_URL: 'nats://127.0.0.1:1',
        REDIS_URL: 'redis://127.0.0.1:1',
        AUTH_JWKS_URL: 'http://127.0.0.1:1/.well-known/jwks.json',
      },
      output: null,
    });
    const outFile = join(dir, 'openapi.json');
    const startedAt = Date.now();
    const document = await exportOpenApi({
      appModule: AppModule,
      config,
      openapi: { title: 'Export', version: '0.1.0' },
      outFile,
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(Object.keys(document.paths)).toEqual([
      '/api/v2/ping',
      '/api/v2/ping/secure',
    ]);
    expect(document.components?.securitySchemes).toMatchObject({
      bearer: { type: 'http', scheme: 'bearer' },
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      internalToken: { type: 'apiKey', name: 'X-Internal-Token' },
    });
    expect(document.paths['/api/v2/ping']?.get?.security).toEqual([{}]);
    expect(
      document.paths['/api/v2/ping/secure']?.get?.responses,
    ).toHaveProperty('default');
    const written = JSON.parse(await readFile(outFile, 'utf8')) as {
      openapi: string;
    };
    expect(written.openapi).toMatch(/^3\./);
  });
});
