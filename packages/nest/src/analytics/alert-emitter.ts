import {
  type AlertDomain,
  type AlertSeverity,
  type AlertType,
  compareAlertSeverity,
  getAlertType,
  type GeoPoint,
  newId,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  type AlertRaisedV1,
  AlertRaisedV1Schema,
} from '@darmawanweb/ais-its-contracts/events';

import { KeyedSerialQueue } from '../common/semaphore.js';

/** What a detector reports to the {@link AlertEmitter}. */
export interface AlertSignal {
  /** Alert type of the registry (contracts `ALERT_TYPES`) or a future type. */
  readonly type: AlertType;
  /**
   * Identity of the condition: open alerts with the same key are one
   * occurrence (e.g. `ews:<mmsi>:<zoneId>`, `collision:<minMmsi>:<maxMmsi>`).
   */
  readonly dedupKey: string;
  readonly severity: AlertSeverity;
  readonly mmsi: number;
  readonly relatedMmsi?: number | null | undefined;
  readonly title: string;
  readonly message: string;
  /** Where it happened. */
  readonly position?: GeoPoint | null | undefined;
  /** When it happened. Default: the emitter clock. */
  readonly occurredAt?: Date | undefined;
  readonly zoneId?: string | null | undefined;
  /** Methodology catalog id of the rule (spec §17). */
  readonly methodId: string;
  /** Detector specific details. */
  readonly data?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Id of the detector raising it (set by `DetectorContext.alerts`): the
   * occurrence belongs to that detector, which alone sees and resolves it.
   */
  readonly detector?: string | undefined;
}

/** How {@link AlertEmitter.raise} treated a signal. */
export type AlertOutcome =
  /** New occurrence: persisted and published. */
  | 'raised'
  /** Higher severity than the open occurrence: a new alert was persisted and published. */
  | 'escalated'
  /** Same severity as the open occurrence: nothing to do. */
  | 'unchanged'
  /** Lower severity than the open occurrence: recorded (`onUpdated`), not published. */
  | 'de-escalated'
  /**
   * Would have been published, but the key was published with at least this
   * severity less than `cooldownMs` ago: the previous alert is reopened or
   * updated (`onUpdated`) instead of publishing again.
   */
  | 'suppressed';

/** An occurrence that is currently open. */
export interface OpenAlert {
  /** Id of the last published alert of the occurrence. */
  readonly alertId: string;
  readonly dedupKey: string;
  readonly type: AlertType;
  readonly mmsi: number;
  readonly relatedMmsi: number | null;
  readonly zoneId: string | null;
  /** Current severity (may be below the published one after a de-escalation). */
  readonly severity: AlertSeverity;
  /** Highest severity published for the key. */
  readonly publishedSeverity: AlertSeverity;
  /** When the occurrence was opened. */
  readonly openedAt: Date;
  /** When an alert of the key was last published. */
  readonly publishedAt: Date;
  /** When the last signal arrived. */
  readonly lastSeenAt: Date;
  /**
   * Detector that owns the occurrence. Restored occurrences without one
   * (`AlertPersistence.loadOpen` rows that do not store it) are visible to
   * every detector of their domain.
   */
  readonly detector?: string | undefined;
}

/** A change of an open occurrence that publishes nothing. */
export interface AlertUpdate {
  readonly reason: 'de-escalated' | 'suppressed';
  readonly alert: OpenAlert;
  readonly previousSeverity: AlertSeverity;
  /** `true` when the occurrence had been resolved and is open again. */
  readonly reopened: boolean;
  readonly at: Date;
}

/** The end of an occurrence. */
export interface AlertResolution {
  readonly alert: OpenAlert;
  readonly resolvedAt: Date;
  /** Why it ended, e.g. `"left the danger zone"`. */
  readonly reason: string | undefined;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * The service's event repository hook (spec §18): the emitter calls it
 * BEFORE publishing, so the service's `events` table is the record of every
 * occurrence. Every method is optional; failures propagate to the caller.
 * Implementations must be idempotent (a resolution may be reported for an
 * alert that was already resolved after a suppressed reopen).
 */
export interface AlertPersistence {
  /** A new alert (status open): insert the event row. */
  onRaised?(
    alert: AlertRaisedV1,
    outcome: 'raised' | 'escalated',
  ): Promise<void>;
  /** Severity changed or the occurrence reopened without publishing. */
  onUpdated?(update: AlertUpdate): Promise<void>;
  /** The occurrence ended: mark the event row resolved. */
  onResolved?(resolution: AlertResolution): Promise<void>;
  /** Occurrences still open in the store, restored at startup so a restart does not re-raise them. */
  loadOpen?(): Promise<readonly OpenAlert[]>;
}

/** Publishes an alert (`alert.raised.v1` on `alert.v1.<type>.<mmsi>`). */
export type AlertPublisher = (alert: AlertRaisedV1) => Promise<void>;

/** Options of {@link AlertEmitter}. */
export interface AlertEmitterOptions {
  readonly publish: AlertPublisher;
  readonly persistence?: AlertPersistence | undefined;
  /** Minimum time between two publications of a key (unless escalating past them), ms. Default 10 min. */
  readonly cooldownMs?: number | undefined;
  /** Default `() => new Date()`. */
  readonly clock?: (() => Date) | undefined;
  /** Called after each publication (metrics). */
  readonly onPublished?:
    | ((alert: AlertRaisedV1, outcome: 'raised' | 'escalated') => void)
    | undefined;
}

/** Recently resolved occurrences, kept for the cooldown. */
interface ClosedAlert {
  readonly alert: OpenAlert;
  readonly closedAt: Date;
}

/** Thrown for signals that contradict the alert type registry. */
export class AlertSignalError extends Error {
  override readonly name = 'AlertSignalError';
}

/**
 * Builds `alert.raised.v1` payloads from detector signals (spec §18) and
 * keeps one state machine per `dedupKey`: new occurrences and escalations
 * are persisted and published, unchanged signals are ignored, de-escalations
 * and flapping within `cooldownMs` are recorded without publishing, and
 * {@link resolve} closes an occurrence. Detectors use it through
 * `DetectorContext.alerts`, which fixes the domain and the owning detector.
 *
 * Every operation on one `dedupKey` (raise, resolve, publication retries)
 * runs to completion before the next one starts, so concurrent signals of
 * one condition — the two vessels of a pair, a tick and a position — never
 * open two occurrences or lose a resolution.
 */
export class AlertEmitter {
  /** Cooldown between publications of a key, ms. */
  readonly cooldownMs: number;
  private readonly open = new Map<string, OpenAlert>();
  private readonly closed = new Map<string, ClosedAlert>();
  /** Persisted alerts whose publication failed, retried with the same id. */
  private readonly unpublished = new Map<
    string,
    { readonly alert: AlertRaisedV1; readonly outcome: 'raised' | 'escalated' }
  >();
  private readonly clock: () => Date;
  private readonly keys = new KeyedSerialQueue();

  constructor(private readonly options: AlertEmitterOptions) {
    this.cooldownMs = options.cooldownMs ?? 10 * 60_000;
    this.clock = options.clock ?? (() => new Date());
  }

  /** Restores open occurrences (from `AlertPersistence.loadOpen`). */
  restore(alerts: readonly OpenAlert[]): void {
    for (const alert of alerts) this.open.set(alert.dedupKey, alert);
  }

  /** Restores the open occurrences of the persistence hook, if it has `loadOpen`; returns how many. */
  async restoreFromPersistence(): Promise<number> {
    const alerts = (await this.options.persistence?.loadOpen?.()) ?? [];
    this.restore(alerts);
    return alerts.length;
  }

  /**
   * Reports a condition of `domain` (validated against the registry).
   *
   * @throws {AlertSignalError} when a registry type is raised from another
   *   domain, or the key is open for another detector.
   */
  raise(domain: AlertDomain, signal: AlertSignal): Promise<AlertOutcome> {
    const definition = getAlertType(signal.type);
    if (definition !== undefined && definition.domain !== domain) {
      return Promise.reject(
        new AlertSignalError(
          `Alert type "${signal.type}" belongs to domain "${definition.domain}", not "${domain}"`,
        ),
      );
    }
    return this.keys.run(signal.dedupKey, () => this.raiseNow(domain, signal));
  }

  private async raiseNow(
    domain: AlertDomain,
    signal: AlertSignal,
  ): Promise<AlertOutcome> {
    // A persisted alert of this key that could not be published goes out first.
    await this.publishPending(signal.dedupKey);
    const now = this.clock();
    const current = this.open.get(signal.dedupKey);
    if (current !== undefined) {
      if (
        signal.detector !== undefined &&
        current.detector !== undefined &&
        current.detector !== signal.detector
      ) {
        throw new AlertSignalError(
          `dedupKey "${signal.dedupKey}" is open for detector ${current.detector}, not ${signal.detector}`,
        );
      }
      return this.update(domain, signal, current, now);
    }

    const closed = this.recentlyClosed(signal.dedupKey, now);
    if (
      closed !== undefined &&
      compareAlertSeverity(signal.severity, closed.alert.publishedSeverity) <= 0
    ) {
      const reopened: OpenAlert = {
        ...closed.alert,
        severity: signal.severity,
        lastSeenAt: now,
      };
      this.closed.delete(signal.dedupKey);
      this.open.set(signal.dedupKey, reopened);
      await this.options.persistence?.onUpdated?.({
        reason: 'suppressed',
        alert: reopened,
        previousSeverity: closed.alert.severity,
        reopened: true,
        at: now,
      });
      return 'suppressed';
    }
    this.closed.delete(signal.dedupKey);
    await this.publishNew(domain, signal, now, 'raised', undefined);
    return 'raised';
  }

  /**
   * Ends the open occurrence of `dedupKey`.
   *
   * @returns `false` when no occurrence was open.
   */
  async resolve(
    dedupKey: string,
    options: {
      readonly at?: Date;
      readonly reason?: string;
      readonly data?: Readonly<Record<string, unknown>>;
    } = {},
  ): Promise<boolean> {
    const alert = this.open.get(dedupKey);
    if (alert === undefined) return false;
    const resolvedAt = options.at ?? this.clock();
    this.open.delete(dedupKey);
    this.closed.set(dedupKey, { alert, closedAt: resolvedAt });
    await this.options.persistence?.onResolved?.({
      alert,
      resolvedAt,
      reason: options.reason,
      data: options.data ?? {},
    });
    return true;
  }

  /** The open occurrence of a key. */
  get(dedupKey: string): OpenAlert | undefined {
    return this.open.get(dedupKey);
  }

  /** `true` when the key has an open occurrence. */
  isOpen(dedupKey: string): boolean {
    return this.open.has(dedupKey);
  }

  /** Open occurrences, optionally of one vessel (as `mmsi` or `relatedMmsi`) or type. */
  openAlerts(
    filter: { readonly mmsi?: number; readonly type?: AlertType } = {},
  ): OpenAlert[] {
    return [...this.open.values()].filter(
      (alert) =>
        (filter.type === undefined || alert.type === filter.type) &&
        (filter.mmsi === undefined ||
          alert.mmsi === filter.mmsi ||
          alert.relatedMmsi === filter.mmsi),
    );
  }

  /** Alerts persisted but not yet published (their publication failed). */
  get pendingCount(): number {
    return this.unpublished.size;
  }

  /**
   * Retries the publication of persisted alerts whose publication failed
   * (same alert id, so JetStream deduplicates). The runner calls it
   * periodically; signals of the same key retry it too.
   */
  async retryPending(): Promise<{
    readonly published: number;
    readonly failed: number;
  }> {
    let published = 0;
    let failed = 0;
    for (const dedupKey of [...this.unpublished.keys()]) {
      try {
        await this.keys.run(dedupKey, () => this.publishPending(dedupKey));
        published += 1;
      } catch {
        failed += 1;
      }
    }
    return { published, failed };
  }

  /** Forgets resolved occurrences whose cooldown is over; returns how many. */
  prune(now: Date = this.clock()): number {
    let removed = 0;
    for (const [key, closed] of [...this.closed]) {
      if (
        now.getTime() - closed.alert.publishedAt.getTime() >=
        this.cooldownMs
      ) {
        this.closed.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  private recentlyClosed(dedupKey: string, now: Date): ClosedAlert | undefined {
    const closed = this.closed.get(dedupKey);
    if (closed === undefined) return undefined;
    if (now.getTime() - closed.alert.publishedAt.getTime() >= this.cooldownMs) {
      this.closed.delete(dedupKey);
      return undefined;
    }
    return closed;
  }

  private async update(
    domain: AlertDomain,
    signal: AlertSignal,
    current: OpenAlert,
    now: Date,
  ): Promise<AlertOutcome> {
    const order = compareAlertSeverity(signal.severity, current.severity);
    if (order === 0) {
      this.open.set(signal.dedupKey, { ...current, lastSeenAt: now });
      return 'unchanged';
    }
    if (order < 0) {
      const lowered: OpenAlert = {
        ...current,
        severity: signal.severity,
        lastSeenAt: now,
      };
      this.open.set(signal.dedupKey, lowered);
      await this.options.persistence?.onUpdated?.({
        reason: 'de-escalated',
        alert: lowered,
        previousSeverity: current.severity,
        reopened: false,
        at: now,
      });
      return 'de-escalated';
    }
    // Escalation: back to a severity already published within the cooldown is flapping.
    const withinCooldown =
      now.getTime() - current.publishedAt.getTime() < this.cooldownMs;
    if (
      withinCooldown &&
      compareAlertSeverity(signal.severity, current.publishedSeverity) <= 0
    ) {
      const raised: OpenAlert = {
        ...current,
        severity: signal.severity,
        lastSeenAt: now,
      };
      this.open.set(signal.dedupKey, raised);
      await this.options.persistence?.onUpdated?.({
        reason: 'suppressed',
        alert: raised,
        previousSeverity: current.severity,
        reopened: false,
        at: now,
      });
      return 'suppressed';
    }
    await this.publishNew(domain, signal, now, 'escalated', current);
    return 'escalated';
  }

  private async publishNew(
    domain: AlertDomain,
    signal: AlertSignal,
    now: Date,
    outcome: 'raised' | 'escalated',
    previous: OpenAlert | undefined,
  ): Promise<void> {
    const alert = AlertRaisedV1Schema.parse({
      id: newId(),
      type: signal.type,
      domain,
      severity: signal.severity,
      mmsi: signal.mmsi,
      relatedMmsi: signal.relatedMmsi ?? null,
      title: signal.title,
      message: signal.message,
      lat: signal.position?.lat ?? null,
      lon: signal.position?.lon ?? null,
      occurredAt: (signal.occurredAt ?? now).toISOString(),
      dedupKey: signal.dedupKey,
      zoneId: signal.zoneId ?? null,
      methodId: signal.methodId,
      data: { ...(signal.data ?? {}) },
    });
    const state: OpenAlert = {
      alertId: alert.id,
      dedupKey: signal.dedupKey,
      type: signal.type,
      mmsi: signal.mmsi,
      relatedMmsi: alert.relatedMmsi,
      zoneId: alert.zoneId,
      severity: signal.severity,
      publishedSeverity:
        previous === undefined ||
        compareAlertSeverity(signal.severity, previous.publishedSeverity) > 0
          ? signal.severity
          : previous.publishedSeverity,
      openedAt: previous?.openedAt ?? now,
      publishedAt: now,
      lastSeenAt: now,
      ...(signal.detector === undefined && previous?.detector === undefined
        ? {}
        : { detector: signal.detector ?? previous?.detector }),
    };
    await this.options.persistence?.onRaised?.(alert, outcome);
    this.open.set(signal.dedupKey, state);
    this.unpublished.set(signal.dedupKey, { alert, outcome });
    await this.publishPending(signal.dedupKey);
  }

  /** Publishes the pending alert of a key; it stays pending (and the error propagates) on failure. */
  private async publishPending(dedupKey: string): Promise<void> {
    const pending = this.unpublished.get(dedupKey);
    if (pending === undefined) return;
    await this.options.publish(pending.alert);
    this.unpublished.delete(dedupKey);
    this.options.onPublished?.(pending.alert, pending.outcome);
  }
}
