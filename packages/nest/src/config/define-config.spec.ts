import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  baseConfigSchema,
  ConfigValidationError,
  defineConfig,
  formatConfigIssues,
  loadConfig,
} from './define-config.js';
import {
  DEV_INTERNAL_TOKEN,
  envBoolean,
  envInteger,
  envList,
} from './env-schema.js';

const silent = { output: null } as const;

describe('base configuration (spec §4)', () => {
  it('applies the development defaults', () => {
    const config = loadConfig(baseConfigSchema, {
      ...silent,
      env: { SERVICE_NAME: 'fleet' },
    });
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      LOG_LEVEL: 'info',
      LOG_PRETTY: true,
      DATABASE_POOL_MAX: 10,
      DB_MIGRATE_ON_BOOT: true,
      NATS_URL: ['nats://localhost:4222'],
      REDIS_URL: 'redis://localhost:6379',
      AUTH_JWKS_URL: 'http://localhost:3001/.well-known/jwks.json',
      AUTH_ISSUER: 'ais-its-auth',
      AUTH_AUDIENCE: 'ais-its-api',
      AUTH_INTERNAL_URL: 'http://localhost:3001',
      INTERNAL_TOKEN: DEV_INTERNAL_TOKEN,
      CORS_ORIGINS: ['http://localhost:5173', 'http://localhost:8000'],
      PUBLIC_BASE_URL: 'http://localhost:8000',
    });
    expect(config.DATABASE_URL).toBeUndefined();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.NATS_URL)).toBe(true);
  });

  it('derives DATABASE_URL from DATABASE_SCHEMA outside production (database aisits)', () => {
    const config = loadConfig(baseConfigSchema, {
      ...silent,
      env: {
        SERVICE_NAME: 'fleet',
        DATABASE_SCHEMA: 'fleet',
        NODE_ENV: 'test',
      },
    });
    expect(config.DATABASE_URL).toBe(
      'postgres://fleet_svc:fleet_svc@localhost:5432/aisits',
    );
    expect(config.LOG_PRETTY).toBe(false);
  });

  it('parses lists, booleans and integers from strings and treats blanks as unset', () => {
    const config = loadConfig(baseConfigSchema, {
      ...silent,
      env: {
        SERVICE_NAME: 'geo',
        NATS_URL: 'nats://a:4222, nats://b:4222,,',
        LOG_PRETTY: 'off',
        DB_MIGRATE_ON_BOOT: 'FALSE',
        PORT: '3009',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
      },
    });
    expect(config.NATS_URL).toEqual(['nats://a:4222', 'nats://b:4222']);
    expect(config.LOG_PRETTY).toBe(false);
    expect(config.DB_MIGRATE_ON_BOOT).toBe(false);
    expect(config.PORT).toBe(3009);
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
    expect(envBoolean().parse('yes')).toBe(true);
    expect(envInteger(1, 5).safeParse('9').success).toBe(false);
    expect(envList().parse('a, b')).toEqual(['a', 'b']);
  });

  it('reports every problem at once and prints them without values', () => {
    let printed = '';
    const output = {
      write: (chunk: string) => {
        printed += chunk;
        return true;
      },
    };
    const attempt = () =>
      loadConfig(baseConfigSchema, {
        output,
        env: {
          SERVICE_NAME: 'Bad Name',
          PORT: '99999',
          REDIS_URL: 'http://secret-host',
          LOG_LEVEL: 'loud',
        },
      });
    expect(attempt).toThrow(ConfigValidationError);
    expect(printed).toContain('Invalid configuration (4 problems)');
    for (const variable of ['SERVICE_NAME', 'PORT', 'REDIS_URL', 'LOG_LEVEL'])
      expect(printed).toContain(`- ${variable}:`);
    expect(printed).not.toContain('secret-host');
    expect(formatConfigIssues([{ variable: 'A', message: 'bad' }])).toBe(
      'Invalid configuration (1 problem):\n  - A: bad',
    );
  });

  it('enforces the production rules', () => {
    const attempt = () =>
      loadConfig(baseConfigSchema, {
        ...silent,
        env: {
          SERVICE_NAME: 'fleet',
          NODE_ENV: 'production',
          DATABASE_SCHEMA: 'fleet',
        },
      });
    try {
      attempt();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const variables = (error as ConfigValidationError).issues.map(
        (issue) => issue.variable,
      );
      expect(variables).toEqual(
        expect.arrayContaining(['INTERNAL_TOKEN', 'DATABASE_URL']),
      );
    }
    const production = loadConfig(baseConfigSchema, {
      ...silent,
      env: {
        SERVICE_NAME: 'fleet',
        NODE_ENV: 'production',
        INTERNAL_TOKEN: 'a-long-production-secret',
        DATABASE_URL: 'postgres://fleet_svc:x@db:5432/aisits',
        DATABASE_SCHEMA: 'fleet',
      },
    });
    expect(production.LOG_PRETTY).toBe(false);
  });

  it('extends the base schema with service variables and typed overrides', () => {
    const schema = defineConfig({
      SERVICE_NAME: z.string().default('emission'),
      PORT: envInteger(0, 65_535).default(3006),
      CII_PUBLISH_INTERVAL_S: envInteger(1).default(60),
    });
    const config = loadConfig(schema, { ...silent, env: {} });
    expect(config).toMatchObject({
      SERVICE_NAME: 'emission',
      PORT: 3006,
      CII_PUBLISH_INTERVAL_S: 60,
    });
  });
});

describe('.env loading', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    delete process.env.AISITS_SPEC_FROM_FILE;
  });

  it('loads the .env file into process.env when present (set variables win)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'aisits-env-'));
    const file = join(dir, '.env');
    await writeFile(file, 'SERVICE_NAME=from-file\nAISITS_SPEC_FROM_FILE=1\n');
    const schema = defineConfig({
      AISITS_SPEC_FROM_FILE: z.string().optional(),
    });
    const previous = process.env.SERVICE_NAME;
    process.env.SERVICE_NAME = 'from-env';
    try {
      const config = loadConfig(schema, { ...silent, envFile: file });
      expect(config.SERVICE_NAME).toBe('from-env');
      expect(config.AISITS_SPEC_FROM_FILE).toBe('1');
    } finally {
      if (previous === undefined) delete process.env.SERVICE_NAME;
      else process.env.SERVICE_NAME = previous;
    }
  });
});
