import 'reflect-metadata';

import { Controller, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  ApiCookieAuth,
  ApiSecurity,
  type OpenAPIObject,
} from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { createFastifyAdapter } from './fastify-adapter.js';
import {
  addPlatformAdminDescriptions,
  buildOpenApiDocument,
  OpenApiSecurityError,
  REFRESH_COOKIE_SECURITY_SCHEME,
} from './openapi.js';
import {
  PLATFORM_ADMIN_DESCRIPTION,
  PLATFORM_ADMIN_WITHOUT_API_KEYS_DESCRIPTION,
} from './openapi-security.js';

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

describe('addPlatformAdminDescriptions (K4)', () => {
  const documentWith = (
    operations: Record<string, Record<string, unknown>>,
  ): OpenAPIObject =>
    ({
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: Object.fromEntries(
        Object.entries(operations).map(([path, operation]) => [
          path,
          { post: { responses: {}, ...operation } },
        ]),
      ),
    }) as unknown as OpenAPIObject;

  it('says what the guards answer: 403 for keys only where @AllowApiKey accepts them', () => {
    const document = addPlatformAdminDescriptions(
      documentWith({
        '/keys': {
          description: 'Rotates.',
          'x-required-roles': ['super_admin'],
        },
        '/ingest': {
          'x-required-roles': ['super_admin'],
          'x-api-key-scopes': ['ais:ingest'],
        },
        '/own': {
          description: 'Admins only (403 PLATFORM_ADMIN_REQUIRED otherwise).',
          'x-required-roles': ['super_admin'],
        },
        '/plain': { description: 'Anyone with the permission.' },
      }),
    );
    const description = (path: string) =>
      (document.paths[path]?.post as { description?: string } | undefined)
        ?.description;
    expect(description('/keys')).toBe(
      `Rotates.\n\n${PLATFORM_ADMIN_WITHOUT_API_KEYS_DESCRIPTION}`,
    );
    expect(PLATFORM_ADMIN_WITHOUT_API_KEYS_DESCRIPTION).toContain(
      '401 INVALID_API_KEY',
    );
    expect(description('/ingest')).toBe(PLATFORM_ADMIN_DESCRIPTION);
    expect(description('/own')).toBe(
      'Admins only (403 PLATFORM_ADMIN_REQUIRED otherwise).',
    );
    expect(description('/plain')).toBe('Anyone with the permission.');
    // Idempotent.
    addPlatformAdminDescriptions(document);
    expect(description('/keys')).toBe(
      `Rotates.\n\n${PLATFORM_ADMIN_WITHOUT_API_KEYS_DESCRIPTION}`,
    );
  });
});
