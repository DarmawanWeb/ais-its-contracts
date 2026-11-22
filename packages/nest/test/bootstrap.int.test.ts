import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Controller,
  Get,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
  Post,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { DetectorRunnerModule } from '../src/analytics/index.js';
import { AuthModule, Public, RequirePermissions } from '../src/auth/index.js';
import { DatabaseModule } from '../src/db/index.js';
import {
  OpenApiSecurityError,
  REFRESH_COOKIE_SECURITY_SCHEME,
} from '../src/http/index.js';
import {
  baseConfigSchema,
  bootstrapService,
  ConfigValidationError,
  defineConfig,
  exportOpenApi,
  loadConfig,
  OpenApiDriftError,
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

  it('derives the config from the schema (placeholders for runtime-only variables), runs no lifecycle hook and checks drift', async () => {
    const hooks: string[] = [];
    @Injectable()
    class Hooked implements OnModuleInit, OnApplicationShutdown {
      onModuleInit(): void {
        hooks.push('onModuleInit');
      }
      onApplicationShutdown(): void {
        hooks.push('onApplicationShutdown');
      }
    }
    @Module({ controllers: [PingController], providers: [Hooked] })
    class AppModule {}
    const fleetLike = defineConfig({
      SERVICE_NAME: z.string().default('fleet'),
      S3_ENDPOINT: z.url(),
      S3_BUCKET_PHOTOS: z.string().min(3),
      KEY_ENCRYPTION_SECRET: z.string().min(32),
      PHOTO_MAX_BYTES: z.coerce.number().int().positive(),
    });
    const outFile = join(dir, 'derived.json');
    const options = {
      appModule: AppModule,
      configSchema: fleetLike,
      env: { PATH: '/usr/bin' },
      openapi: { title: 'Fleet', version: '0.1.0' },
      outFile,
    };
    await exportOpenApi(options);
    expect(hooks).toEqual([]);
    await expect(
      exportOpenApi({ ...options, check: true }),
    ).resolves.toMatchObject({
      info: { title: 'Fleet' },
    });
    await writeFile(outFile, '{}\n');
    await expect(
      exportOpenApi({ ...options, check: true }),
    ).rejects.toBeInstanceOf(OpenApiDriftError);
    // Present values are still validated.
    await expect(
      exportOpenApi({ ...options, env: { S3_ENDPOINT: 'not a url' } }),
    ).rejects.toBeInstanceOf(ConfigValidationError);
    expect(hooks).toEqual([]);
  });

  it('declares extra security schemes and refuses undeclared ones (CORE-7)', async () => {
    @ApiTags('auth')
    @Controller('auth')
    class RefreshController {
      @Public()
      @ApiCookieAuth('refreshCookie')
      @Post('refresh')
      refresh(): void {
        // documented only
      }
    }
    @Controller('broken')
    class BrokenController {
      @ApiSecurity('nowhere')
      @Get()
      broken(): void {
        // documented only
      }
    }
    const config = loadConfig(baseConfigSchema, {
      env: { SERVICE_NAME: 'auth', NODE_ENV: 'test' },
      output: null,
    });
    @Module({ controllers: [RefreshController] })
    class AuthAppModule {}
    const outFile = join(dir, 'auth.json');
    const options = {
      appModule: AuthAppModule,
      config,
      openapi: {
        title: 'Auth',
        version: '0.1.0',
        securitySchemes: { refreshCookie: REFRESH_COOKIE_SECURITY_SCHEME },
      },
      outFile,
    };
    const document = await exportOpenApi(options);
    expect(document.components?.securitySchemes?.refreshCookie).toEqual({
      type: 'apiKey',
      in: 'cookie',
      name: 'aisits_rt',
      description: expect.stringContaining('aisits_rt') as string,
    });
    expect(
      document.paths['/api/v2/auth/refresh']?.post?.security,
    ).toContainEqual({ refreshCookie: [] });
    await expect(
      exportOpenApi({ ...options, check: true }),
    ).resolves.toBeDefined();

    @Module({ controllers: [BrokenController] })
    class BrokenAppModule {}
    await expect(
      exportOpenApi({
        appModule: BrokenAppModule,
        config,
        openapi: { title: 'Broken', version: '0.1.0' },
        outFile: join(dir, 'broken.json'),
      }),
    ).rejects.toBeInstanceOf(OpenApiSecurityError);
  });
});
