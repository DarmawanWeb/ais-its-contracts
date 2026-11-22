import { Controller, Get, Logger, Module } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { baseConfigSchema, loadConfig } from '../config/define-config.js';
import {
  bootstrapService,
  trustedProxiesWarning,
} from './bootstrap-service.js';

describe('trustedProxiesWarning (CORE-9)', () => {
  const defaults = ['loopback', 'linklocal', 'uniquelocal'];

  it('warns in production with the default TRUSTED_PROXIES only', () => {
    expect(
      trustedProxiesWarning({
        NODE_ENV: 'production',
        TRUSTED_PROXIES: defaults,
      }),
    ).toMatch(/TRUSTED_PROXIES is the default/);
    expect(
      trustedProxiesWarning({
        NODE_ENV: 'production',
        TRUSTED_PROXIES: [...defaults].reverse(),
      }),
    ).toBeDefined();
    expect(
      trustedProxiesWarning({
        NODE_ENV: 'development',
        TRUSTED_PROXIES: defaults,
      }),
    ).toBeUndefined();
    expect(
      trustedProxiesWarning({
        NODE_ENV: 'production',
        TRUSTED_PROXIES: ['10.0.0.0/8'],
      }),
    ).toBeUndefined();
    expect(
      trustedProxiesWarning({ NODE_ENV: 'production', TRUSTED_PROXIES: [] }),
    ).toBeUndefined();
  });

  it('follows the adapter trustProxy option, which wins', () => {
    const production = {
      NODE_ENV: 'production' as const,
      TRUSTED_PROXIES: defaults,
    };
    expect(trustedProxiesWarning(production, false)).toBeUndefined();
    expect(trustedProxiesWarning(production, ['10.1.2.3'])).toBeUndefined();
    expect(
      trustedProxiesWarning(
        { NODE_ENV: 'production', TRUSTED_PROXIES: ['10.1.2.3'] },
        'loopback, linklocal,uniquelocal',
      ),
    ).toBeDefined();
  });
});

@Controller('ping')
class PingController {
  @Get()
  ping(): { readonly pong: true } {
    return { pong: true };
  }
}

@Module({ controllers: [PingController] })
class PingModule {}

describe('bootstrapService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the trusted proxies warning in production', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const config = loadConfig(baseConfigSchema, {
      env: {
        SERVICE_NAME: 'proxy-warning',
        NODE_ENV: 'production',
        INTERNAL_TOKEN: 'a-production-secret-token',
        HOST: '127.0.0.1',
        PORT: '0',
        LOG_LEVEL: 'silent',
        SHUTDOWN_TIMEOUT_MS: '0',
      },
      output: null,
    });
    const app = await bootstrapService({
      appModule: PingModule,
      config,
      openapi: false,
    });
    try {
      expect(
        warn.mock.calls.some((call) =>
          String(call[0]).includes('TRUSTED_PROXIES is the default'),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
