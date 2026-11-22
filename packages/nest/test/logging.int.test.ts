import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthModule } from '../src/auth/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import { buildLoggerOptions, resolvePinoPretty } from '../src/logging/index.js';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type TestJwtIssuer,
  waitFor,
} from '../src/testing/index.js';
import { FixtureModule } from './support/fixture-app.js';

/** Collects the JSON log lines of the application. */
class LogSink extends Writable {
  readonly lines: Record<string, unknown>[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim() !== '')
        this.lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    done();
  }
}

// nestjs-pino keeps ONE root logger per process: the first application of a
// test file fixes the logging configuration, so this file uses a single app.
describe('structured logging', () => {
  const sink = new LogSink();
  let jwt: TestJwtIssuer;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    jwt = await createTestJwtIssuer();
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
    app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        NODE_ENV: 'production',
        INTERNAL_TOKEN: 'a-production-secret-token',
        LOG_LEVEL: 'info',
      }),
      logging: { destination: sink },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes JSON lines with service, version, requestId and the principal id', async () => {
    const { token, principal } = await jwt.issue({ roles: ['viewer'] });
    await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/me',
      headers: { authorization: `Bearer ${token}`, 'x-request-id': 'log-1' },
    });
    const line = await waitFor(() =>
      sink.lines.find(
        (entry) =>
          entry.requestId === 'log-1' && entry.msg === 'request completed',
      ),
    );
    expect(line).toMatchObject({
      level: 'info',
      service: 'test-service',
      version: '0.0.0-test',
      principal: principal.id,
      req: { method: 'GET', url: '/api/v2/fixtures/me' },
      res: { statusCode: 200 },
    });
    expect(typeof line.time).toBe('string');
    expect(JSON.stringify(sink.lines)).not.toContain(token);
  });

  it('logs unexpected errors with their stack under the request id', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/v2/fixtures/crash',
      headers: { 'x-request-id': 'log-2' },
    });
    const errorLine = await waitFor(() =>
      sink.lines.find(
        (line) =>
          line.context === 'ProblemDetailsFilter' && line.requestId === 'log-2',
      ),
    );
    expect(errorLine).toMatchObject({
      level: 'error',
      err: { message: 'database password is hunter2' },
    });
    const completed = await waitFor(() =>
      sink.lines.find(
        (line) => line.requestId === 'log-2' && line.msg === 'request errored',
      ),
    );
    expect(completed).toMatchObject({
      level: 'error',
      res: { statusCode: 500 },
    });
  });

  it('logs client errors as warnings and keeps health probes quiet', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/v2/nope',
      headers: { 'x-request-id': 'log-3' },
    });
    await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'log-4' },
    });
    const notFound = await waitFor(() =>
      sink.lines.find(
        (line) =>
          line.requestId === 'log-3' && line.msg === 'request completed',
      ),
    );
    expect(notFound).toMatchObject({ level: 'warn', res: { statusCode: 404 } });
    expect(
      sink.lines.some(
        (line) =>
          line.requestId === 'log-4' && line.msg === 'request completed',
      ),
    ).toBe(false);
  });
});

describe('pretty development logging (CORE-14)', () => {
  it('writes human-readable lines through the resolved pino-pretty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kit-pretty-log-'));
    const file = join(dir, 'pretty.log');
    try {
      const { options, prettyUnavailable } = buildLoggerOptions({
        service: 'pretty-test',
        level: 'info',
        pretty: true,
      });
      expect(prettyUnavailable).toBe(false);
      const transport = options.transport as {
        target: string;
        options: Record<string, unknown>;
      };
      expect(transport.target).toBe(resolvePinoPretty());
      const logger = pino({
        ...options,
        transport: {
          ...transport,
          options: {
            ...transport.options,
            colorize: false,
            destination: file,
            mkdir: true,
          },
        },
      });
      logger.info({ vessels: 3 }, 'pretty line written');
      const content = await waitFor(async () => {
        const text = await readFile(file, 'utf8').catch(() => '');
        return text.includes('pretty line written') ? text : undefined;
      });
      expect(content).toMatch(/INFO.*pretty line written/);
      expect(content.trimStart().startsWith('{')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
