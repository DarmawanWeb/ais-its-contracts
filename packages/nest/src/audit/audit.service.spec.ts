import {
  AuditRecordedV1Schema,
  type EventEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import type { JetStreamPublishOptions, PubAck } from '@nats-io/jetstream';
import { describe, expect, it } from 'vitest';

import { ApiKeyPrincipal, UserPrincipal } from '../auth/principal.js';
import { baseConfigSchema } from '../config/define-config.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { EventPublisher } from '../nats/event-publisher.js';
import type { NatsClient } from '../nats/nats-client.js';
import { NatsMetrics } from '../nats/nats.metrics.js';
import type { StreamManager } from '../nats/stream-manager.js';
import { createTestConfig } from '../testing/test-app.js';
import { AuditService } from './audit.service.js';

const ORG = '0192f2a0-0000-7000-8000-000000000001';
const USER = '0192f2a0-0000-7000-8000-000000000002';
const KEY = '0192f2a0-0000-7000-8000-000000000003';

interface Published {
  readonly subject: string;
  readonly envelope: EventEnvelope;
  readonly options: Partial<JetStreamPublishOptions> | undefined;
}

/** An AuditService over a real EventPublisher whose JetStream is a recorder. */
function auditService(failWith?: Error) {
  const published: Published[] = [];
  const ensured: string[][] = [];
  const jetstream = {
    publish(
      subject: string,
      payload: Uint8Array,
      options?: Partial<JetStreamPublishOptions>,
    ): Promise<PubAck> {
      if (failWith !== undefined) return Promise.reject(failWith);
      published.push({
        subject,
        envelope: JSON.parse(
          new TextDecoder().decode(payload),
        ) as EventEnvelope,
        options,
      });
      return Promise.resolve({
        stream: 'AUDIT',
        seq: published.length,
        duplicate: false,
        domain: '',
      });
    },
  };
  // Only `ready()` is used by the publisher.
  const client = {
    ready: () => Promise.resolve({ jetstream }),
  } as unknown as NatsClient;
  // Only `ensure()` is used by the audit service.
  const streams = {
    ensure: (names: string[]) => {
      ensured.push(names);
      return Promise.resolve([]);
    },
  } as unknown as StreamManager;
  const metrics = new MetricsService();
  const config = createTestConfig(baseConfigSchema, {
    SERVICE_NAME: 'fleet',
  });
  const publisher = new EventPublisher(
    client,
    config,
    new NatsMetrics(metrics),
  );
  const service = new AuditService(publisher, streams, metrics);
  return { service, published, ensured, metrics };
}

const user = new UserPrincipal({
  id: USER,
  sessionId: '0192f2a0-0000-7000-8000-000000000004',
  orgId: ORG,
  roles: ['fleet_manager'],
  email: 'manager@example.org',
  name: 'Manager',
});

describe('AuditService', () => {
  it('ensures the AUDIT stream it produces to', async () => {
    const { service, ensured } = auditService();
    await service.onModuleInit();
    expect(ensured).toEqual([['AUDIT']]);
  });

  it('maps the principal, its organization and the request into the record', () => {
    const { service } = auditService();
    const record = service.buildRecord(
      {
        action: 'vessel.update',
        targetType: 'vessel',
        targetId: 'v-1',
        meta: { fields: ['name'] },
      },
      user,
      { ip: '198.51.100.7', headers: { 'user-agent': 'vitest' } },
    );
    expect(AuditRecordedV1Schema.parse(record)).toMatchObject({
      actorType: 'user',
      actorId: USER,
      orgId: ORG,
      action: 'vessel.update',
      targetType: 'vessel',
      targetId: 'v-1',
      ip: '198.51.100.7',
      userAgent: 'vitest',
      meta: { fields: ['name'] },
    });
    expect(Date.parse(record.at)).not.toBeNaN();
  });

  it('records API keys and the system, and lets the entry name the organization', () => {
    const { service } = auditService();
    const key = new ApiKeyPrincipal({
      id: KEY,
      orgId: ORG,
      scopes: ['ais:ingest'],
      name: 'pusher',
    });
    expect(service.buildRecord({ action: 'ais.ingest' }, key)).toMatchObject({
      actorType: 'api_key',
      actorId: KEY,
      orgId: ORG,
      ip: null,
      userAgent: null,
    });
    expect(
      service.buildRecord({ action: 'zone.republish', orgId: null }, user),
    ).toMatchObject({ actorType: 'user', orgId: null });
    expect(service.buildRecord({ action: 'signing_key.rotate' })).toMatchObject(
      { actorType: 'system', actorId: null, orgId: null },
    );
  });

  it('publishes audit.recorded.v1 to audit.v1.<SERVICE_NAME> with the envelope id as Nats-Msg-Id', async () => {
    const { service, published } = auditService();
    await expect(
      service.record({ action: 'vessel.delete', targetId: 'v-2' }, user),
    ).resolves.toBe(true);
    expect(published).toHaveLength(1);
    const [message] = published;
    expect(message?.subject).toBe('audit.v1.fleet');
    expect(message?.envelope).toMatchObject({
      type: 'audit.recorded.v1',
      source: 'fleet',
      data: { action: 'vessel.delete', targetId: 'v-2', actorId: USER },
    });
    expect(message?.options?.msgID).toBe(message?.envelope.id);
  });

  it('never throws: an invalid action resolves false and is counted', async () => {
    const { service, published, metrics } = auditService();
    await expect(
      service.record({ action: 'Not An Action' }, user),
    ).resolves.toBe(false);
    expect(published).toHaveLength(0);
    expect(await metrics.render()).toMatch(
      /aisits_audit_failures_total\{action="Not An Action"\} 1/,
    );
  });

  it('normalizes the request ip for inet columns (CORE-9)', () => {
    const { service } = auditService();
    const ipOf = (ip: string | undefined) =>
      service.buildRecord({ action: 'vessel.update' }, user, { ip }).ip;
    expect(ipOf('1.2.3.4:5678')).toBe('1.2.3.4');
    expect(ipOf('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(ipOf('fe80::1%eth0')).toBe('fe80::1');
    expect(ipOf('foo')).toBeNull();
    expect(ipOf('')).toBeNull();
    expect(ipOf(undefined)).toBeNull();
  });

  it('enqueues the record in the caller transaction instead of publishing (CORE-10)', async () => {
    const { service, published } = auditService();
    const queries: { text: string; values: unknown[] }[] = [];
    const client = {
      query: (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return Promise.resolve({ rows: [], rowCount: 1 });
      },
    };
    const id = await service.enqueue(
      client as never,
      { action: 'user.mfa_disable', targetType: 'user', targetId: USER },
      user,
      { ip: '[2001:db8::1]:443' },
      { table: 'audit_outbox' },
    );
    expect(published).toHaveLength(0);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toMatch(/^INSERT INTO "audit_outbox" /);
    const [rowId, type, , data] = queries[0]?.values ?? [];
    expect(rowId).toBe(id);
    expect(type).toBe('audit.recorded.v1');
    expect(AuditRecordedV1Schema.parse(JSON.parse(String(data)))).toMatchObject(
      {
        action: 'user.mfa_disable',
        actorId: USER,
        ip: '2001:db8::1',
      },
    );
    // Unlike record(), an invalid entry throws (the transaction fails with it).
    await expect(
      service.enqueue(client as never, { action: 'Not An Action' }, user),
    ).rejects.toThrow();
  });

  it('never throws: a publish failure resolves false and is counted', async () => {
    const { service, metrics } = auditService(new Error('no responders'));
    await expect(
      service.record({ action: 'vessel.update' }, user),
    ).resolves.toBe(false);
    expect(await metrics.render()).toMatch(
      /aisits_audit_failures_total\{action="vessel.update"\} 1/,
    );
  });
});
