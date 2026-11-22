import 'reflect-metadata';

import { Controller, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiCookieAuth, ApiSecurity } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { createFastifyAdapter } from './fastify-adapter.js';
import {
  buildOpenApiDocument,
  OpenApiSecurityError,
  REFRESH_COOKIE_SECURITY_SCHEME,
} from './openapi.js';

@Controller('auth')
class AuthController {
  @ApiCookieAuth('refreshCookie')
  @Post('refresh')
  refresh(): void {
    // documented only
  }
}

@Controller('broken')
class BrokenController {
  @ApiSecurity('undeclared')
  @Post()
  broken(): void {
    // documented only
  }
}

async function appWith(
  controller: new () => unknown,
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [controller],
  }).compile();
  return moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter(),
  );
}

describe('OpenAPI security schemes (CORE-7)', () => {
  it('declares extra schemes such as the refresh cookie', async () => {
    const app = await appWith(AuthController);
    try {
      const document = buildOpenApiDocument(app, {
        title: 'Auth',
        version: '1.0.0',
        securitySchemes: { refreshCookie: REFRESH_COOKIE_SECURITY_SCHEME },
      });
      expect(document.components?.securitySchemes).toMatchObject({
        bearer: { type: 'http' },
        refreshCookie: { type: 'apiKey', in: 'cookie', name: 'aisits_rt' },
      });
      expect(document.paths['/auth/refresh']?.post?.security).toEqual([
        { refreshCookie: [] },
      ]);
    } finally {
      await app.close();
    }
  });

  it('refuses undeclared references and redefined platform schemes', async () => {
    const app = await appWith(BrokenController);
    try {
      expect(() =>
        buildOpenApiDocument(app, { title: 'Broken', version: '1.0.0' }),
      ).toThrow(OpenApiSecurityError);
      expect(() =>
        buildOpenApiDocument(app, { title: 'Broken', version: '1.0.0' }),
      ).toThrow('POST /broken references undeclared scheme "undeclared"');
      expect(() =>
        buildOpenApiDocument(app, {
          title: 'Broken',
          version: '1.0.0',
          securitySchemes: {
            undeclared: { type: 'http', scheme: 'basic' },
            bearer: { type: 'http', scheme: 'basic' },
          },
        }),
      ).toThrow(/securitySchemes.bearer redefines a platform scheme/);
      expect(
        buildOpenApiDocument(app, {
          title: 'Fixed',
          version: '1.0.0',
          securitySchemes: { undeclared: { type: 'http', scheme: 'basic' } },
        }).components?.securitySchemes,
      ).toHaveProperty('undeclared');
    } finally {
      await app.close();
    }
  });
});
