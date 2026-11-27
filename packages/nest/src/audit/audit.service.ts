import type { IncomingHttpHeaders } from 'node:http';

import {
  AUDIT_LABEL_MAX_LENGTH,
  type AuditLabels,
  type AuditRecordedV1,
  EVENT_TYPES,
} from '@darmawanweb/ais-its-contracts/events';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import type { Counter } from 'prom-client';

import type { Principal } from '../auth/principal.js';
import { errorMessage } from '../common/retry.js';
import { clientIp } from '../http/client-ip.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { EventPublisher } from '../nats/event-publisher.js';
import { enqueueEvent, type OutboxQueryable } from '../nats/outbox.js';
import { StreamManager } from '../nats/stream-manager.js';

/** What happened, on which target. */
export interface AuditEntry {
  /** `<resource>.<verb>`, e.g. `vessel.update` (contracts `AUDIT_ACTION_PATTERN`). */
  readonly action: string;
  readonly targetType?: string | null | undefined;
  readonly targetId?: string | null | undefined;
  /** Details (changed fields, …); never secrets. */
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  /** Organization of the target; defaults to the principal's active organization. */
  readonly orgId?: string | null | undefined;
  /**
   * Names known when the record is written (`audit.recorded.v1` `labels`),
   * e.g. `{ targetLabel: vessel.name }` in the transaction of a vessel
   * change, so the audit log shows the name of the time even after a
   * rename or deletion. Members left out are not sent; longer names are cut
   * to `AUDIT_LABEL_MAX_LENGTH` (200) characters. Default: no labels (the
   * audit log resolves names itself).
   */
  readonly labels?: AuditLabels | undefined;
}

/** `value` cut to the contract's length (UTF-16 units), never inside a surrogate pair. */
function cutLabel(value: string): string {
  if (value.length <= AUDIT_LABEL_MAX_LENGTH) return value;
  const cut = value.slice(0, AUDIT_LABEL_MAX_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** `labels` as sent: only the given members, each cut to the contract's length. */
function labelsOf(labels: AuditLabels | undefined): AuditLabels | undefined {
  if (labels === undefined) return undefined;
  const sent: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(labels)) {
    if (value === undefined) continue;
    sent[name] = value === null ? null : cutLabel(value);
  }
  return Object.keys(sent).length === 0 ? undefined : (sent as AuditLabels);
}

/** The request facts recorded with an entry (a `FastifyRequest` fits). */
export interface AuditRequest {
  /** `request.ip`; normalized with `clientIp()` (`null` when not an address). */
  readonly ip?: string | undefined;
  readonly headers?: IncomingHttpHeaders | undefined;
}

/** Options of {@link AuditService.enqueue}. */
export interface AuditEnqueueOptions {
  /** Outbox table. Default `outbox`. */
  readonly table?: string | undefined;
}

function userAgentOf(request: AuditRequest | undefined): string | null {
  const value = request?.headers?.['user-agent'];
  return typeof value === 'string' && value !== '' ? value.slice(0, 512) : null;
}

/**
 * Publishes `audit.recorded.v1` to `audit.v1.<SERVICE_NAME>` (spec §7.3), the
 * central audit log being written by the auth service.
 *
 * - {@link AuditService.record} is best effort: it never throws into
 *   business code; failures (a NATS outage) are logged and counted
 *   (`aisits_audit_failures_total`) and it resolves `false` — the record is
 *   lost.
 * - {@link AuditService.enqueue} writes the record to the transactional
 *   outbox in the caller's transaction instead: it commits or rolls back with
 *   the change it describes and the `OutboxRelay` publishes it, so security
 *   relevant records survive outages (needs an outbox table and
 *   `OutboxModule`).
 *
 * @example
 * await this.audit.record({ action: 'vessel.update', targetType: 'vessel', targetId: id, meta: { fields } }, principal, request);
 */
@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger('Audit');
  private readonly failures: Counter<'action'>;

  constructor(
    private readonly publisher: EventPublisher,
    private readonly streams: StreamManager,
    @Optional() @Inject(MetricsService) metrics: MetricsService | null = null,
  ) {
    this.failures = (metrics ?? new MetricsService()).counter({
      name: 'audit_failures_total',
      help: 'Audit records that could not be published, by action.',
      labelNames: ['action'],
    });
  }

  /** Ensures the `AUDIT` stream (every service produces audit records). */
  async onModuleInit(): Promise<void> {
    await this.streams.ensure(['AUDIT']);
  }

  /**
   * The `audit.recorded.v1` payload of an entry. The request's `ip` is
   * normalized with `clientIp()` (brackets, ports and zone ids stripped,
   * `null` for anything that is not an IPv4/IPv6 address), so it fits an
   * `inet` column.
   */
  buildRecord(
    entry: AuditEntry,
    principal?: Principal,
    request?: AuditRequest,
  ): AuditRecordedV1 {
    const labels = labelsOf(entry.labels);
    return {
      actorType: principal?.kind ?? 'system',
      actorId: principal?.id ?? null,
      orgId:
        entry.orgId !== undefined ? entry.orgId : (principal?.orgId ?? null),
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      ip: clientIp(request?.ip),
      userAgent: userAgentOf(request),
      meta: { ...(entry.meta ?? {}) },
      at: new Date().toISOString(),
      ...(labels === undefined ? {} : { labels }),
    };
  }

  /**
   * Adds the record of an entry to the transactional outbox through
   * `client`, inside the caller's transaction (`enqueueEvent`): it is
   * published by the `OutboxRelay` on `audit.v1.<SERVICE_NAME>` after the
   * commit, and never when the transaction rolls back. Unlike
   * {@link record} it throws (an invalid entry, a failing insert), so the
   * change it describes fails with it.
   *
   * @returns the envelope id of the queued event.
   * @example
   * await withTransaction(this.pool, async (client) => {
   *   await this.users.disableMfa(client, userId);
   *   await this.audit.enqueue(client, { action: 'user.mfa_disable', targetType: 'user', targetId: userId }, principal, request);
   * });
   */
  async enqueue(
    client: OutboxQueryable,
    entry: AuditEntry,
    principal?: Principal,
    request?: AuditRequest,
    options: AuditEnqueueOptions = {},
  ): Promise<string> {
    return enqueueEvent(
      client,
      EVENT_TYPES.AUDIT_RECORDED,
      this.buildRecord(entry, principal, request),
      { table: options.table },
    );
  }

  /** Records an entry; resolves `true` once stored in JetStream, `false` on failure. */
  async record(
    entry: AuditEntry,
    principal?: Principal,
    request?: AuditRequest,
  ): Promise<boolean> {
    try {
      const record = this.buildRecord(entry, principal, request);
      await this.publisher.publishEvent(EVENT_TYPES.AUDIT_RECORDED, record);
      return true;
    } catch (error) {
      this.failures.inc({ action: entry.action.slice(0, 64) });
      this.logger.warn(
        `Audit record ${entry.action} failed: ${errorMessage(error)}`,
      );
      return false;
    }
  }
}
