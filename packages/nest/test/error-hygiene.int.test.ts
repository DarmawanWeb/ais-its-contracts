import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Body, Controller, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { IsString } from 'class-validator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Public } from '../src/auth/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import { type Database, DatabaseModule, InjectDb } from '../src/db/index.js';
import {
  buildTestApp,
  createTestConfig,
  provisionServiceSchema,
  waitFor,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

const SCHEMA = uniqueName('hygiene');
const users = pgSchema(SCHEMA).table('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique('users_email_key'),
});
const schema = { users };

/** Values that must never appear in a response or a log line. */
const SECRET_EMAIL = 'alice.secret+bound@example.com';
const PRODUCTION_EMAIL = 'bob.secret+bound@example.com';

class CreateUserDto {
  @IsString()
  email!: string;
}

@Controller('users')
class UsersController {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** A drizzle insert whose second call violates the unique constraint. */
  @Public()
  @Post()
  async create(@Body() body: CreateUserDto): Promise<{ readonly ok: true }> {
    await this.db.insert(users).values({ email: body.email });
    return { ok: true };
  }
}

/** Collects the JSON log lines (raw text, to search for leaked values). */
class LogSink extends Writable {
  readonly lines: string[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString('utf8').split('\n'))
      if (line.trim() !== '') this.lines.push(line);
    done();
  }
}

// nestjs-pino keeps one root logger per process: both applications of this
// file log to the same sink.
describe('database errors never leak bound values (CORE-1)', () => {
  const sink = new LogSink();
  let url: string;
  let migrations: string;
  const apps: NestFastifyApplication[] = [];

  async function appFor(
    env: Record<string, string>,
  ): Promise<NestFastifyApplication> {
    @Module({
      imports: [DatabaseModule.forRoot({ schema, migrationsDir: migrations })],
      controllers: [UsersController],
    })
    class AppModule {}
    const app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        DATABASE_URL: url,
        DATABASE_SCHEMA: SCHEMA,
        DB_MIGRATE_ON_BOOT: 'true',
        LOG_LEVEL: 'info',
        ...env,
      }),
      logging: { destination: sink },
    });
    apps.push(app);
    return app;
  }

  beforeAll(async () => {
    url = await provisionServiceSchema(testInfra().postgresAdminUrl, SCHEMA);
    migrations = await mkdtemp(join(tmpdir(), 'kit-hygiene-'));
    await writeFile(
      join(migrations, '0001_users.sql'),
      'CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL CONSTRAINT users_email_key UNIQUE);\n',
    );
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
    await rm(migrations, { recursive: true, force: true });
  });

  const insertTwice = async (app: NestFastifyApplication, email: string) => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v2/users',
      payload: { email },
    });
    expect(first.statusCode).toBe(201);
    return app.inject({
      method: 'POST',
      url: '/api/v2/users',
      payload: { email },
    });
  };

  it('shows only the driver message outside production and logs no parameters', async () => {
    const app = await appFor({ NODE_ENV: 'development' });
    const failed = await insertTwice(app, SECRET_EMAIL);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      detail:
        'duplicate key value violates unique constraint "users_email_key"',
    });
    expect(failed.body).not.toContain(SECRET_EMAIL);
    const errorLine = await waitFor(() =>
      sink.lines.find(
        (line) =>
          line.includes('"ProblemDetailsFilter"') &&
          line.includes('SanitizedDatabaseError'),
      ),
    );
    expect(JSON.parse(errorLine)).toMatchObject({
      level: 'error',
      err: {
        type: 'SanitizedDatabaseError',
        message:
          'duplicate key value violates unique constraint "users_email_key"',
        code: '23505',
        constraint: 'users_email_key',
        table: 'users',
      },
    });
    expect(errorLine).toContain('insert into');
    expect(sink.lines.join('\n')).not.toContain(SECRET_EMAIL);
  });

  it('answers a generic detail in production and logs no parameters', async () => {
    const before = sink.lines.length;
    const app = await appFor({
      NODE_ENV: 'production',
      INTERNAL_TOKEN: 'a-production-secret-token',
    });
    const failed = await insertTwice(app, PRODUCTION_EMAIL);
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred',
    });
    expect(failed.body).not.toContain(PRODUCTION_EMAIL);
    await waitFor(() =>
      sink.lines
        .slice(before)
        .some((line) => line.includes('SanitizedDatabaseError')),
    );
    const logs = sink.lines.join('\n');
    expect(logs).not.toContain(SECRET_EMAIL);
    expect(logs).not.toContain(PRODUCTION_EMAIL);
  });
});
