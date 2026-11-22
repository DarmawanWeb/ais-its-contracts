import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuditRecordedV1Schema,
  parseEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditModule, AuditService } from '../src/audit/index.js';
import { UserPrincipal } from '../src/auth/index.js';
import { baseConfigSchema } from '../src/config/index.js';
import { DatabaseModule, PG_POOL, withTransaction } from '../src/db/index.js';
import {
  NatsClient,
  NatsModule,
  OutboxModule,
  OutboxRelay,
  outboxTableSql,
} from '../src/nats/index.js';
import {
  buildTestApp,
  createTestConfig,
  provisionServiceSchema,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';

const SCHEMA = uniqueName('auditbox');
/** A service of its own: its audit subject holds only this file's records. */
const SERVICE = `audit-${randomBytes(4).toString('hex')}`;
const USER = '0192f2a0-0000-7000-8000-0000000000a1';

describe('AuditService.enqueue through the transactional outbox (CORE-10)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let migrations: string;
  const principal = new UserPrincipal({
    id: USER,
    sessionId: '0192f2a0-0000-7000-8000-0000000000a2',
    orgId: '0192f2a0-0000-7000-8000-0000000000a3',
    roles: ['org_admin'],
    email: 'admin@example.org',
    name: 'Admin',
  });

  beforeAll(async () => {
    const url = await provisionServiceSchema(
      testInfra().postgresAdminUrl,
      SCHEMA,
    );
    migrations = await mkdtemp(join(tmpdir(), 'kit-audit-outbox-'));
    await writeFile(join(migrations, '0001_outbox.sql'), outboxTableSql());
    @Module({
      imports: [
        DatabaseModule.forRoot({ migrationsDir: migrations }),
        NatsModule.forRoot(),
        OutboxModule.forRoot({ autoStart: false }),
        AuditModule,
      ],
    })
    class AppModule {}
    app = await buildTestApp(AppModule, {
      config: createTestConfig(baseConfigSchema, {
        SERVICE_NAME: SERVICE,
        DATABASE_URL: url,
        DATABASE_SCHEMA: SCHEMA,
        DB_MIGRATE_ON_BOOT: 'true',
        NATS_URL: testInfra().natsUrl,
      }),
    });
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app.close();
    await rm(migrations, { recursive: true, force: true });
  });

  it('publishes committed records on audit.v1.<service> and never rolled-back ones', async () => {
    const audit = app.get(AuditService);
    const committed = await withTransaction(pool, (client) =>
      audit.enqueue(
        client,
        { action: 'user.mfa_disable', targetType: 'user', targetId: USER },
        principal,
        { ip: '[2001:db8::1]:443', headers: { 'user-agent': 'vitest' } },
      ),
    );
    await expect(
      withTransaction(pool, async (client) => {
        await audit.enqueue(
          client,
          { action: 'user.delete', targetType: 'user', targetId: USER },
          principal,
        );
        throw new Error('deleting the user failed');
      }),
    ).rejects.toThrow('deleting the user failed');

    const result = await app.get(OutboxRelay).relayOnce();
    expect(result).toMatchObject({ published: 1, rejected: 0 });

    const subject = `audit.v1.${SERVICE}`;
    const manager = await (
      await app.get(NatsClient).ready()
    ).jetstream.jetstreamManager();
    const info = await manager.streams.info('AUDIT', {
      subjects_filter: subject,
    });
    expect(info.state.subjects?.[subject]).toBe(1);
    const stored = await manager.streams.getMessage('AUDIT', {
      last_by_subj: subject,
    });
    const parsed = parseEnvelope(stored?.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.envelope).toMatchObject({
      id: committed,
      type: 'audit.recorded.v1',
      source: SERVICE,
    });
    expect(AuditRecordedV1Schema.parse(parsed.envelope.data)).toMatchObject({
      action: 'user.mfa_disable',
      actorType: 'user',
      actorId: USER,
      ip: '2001:db8::1',
      userAgent: 'vitest',
    });
  });
});
