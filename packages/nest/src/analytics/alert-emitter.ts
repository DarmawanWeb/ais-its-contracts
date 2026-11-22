import { AsyncLocalStorage } from 'node:async_hooks';

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
  ALERT_RESOLUTION_REASON_MAX_LENGTH,
  type AlertRaisedV1,
  AlertRaisedV1Schema,
  type AlertResolvedV1,
  AlertResolvedV1Schema,
} from '@darmawanweb/ais-its-contracts/events';
import { Logger } from '@nestjs/common';

import { KeyedSerialQueue } from '../common/semaphore.js';

/** Default {@link AlertEmitterOptions.cooldownMs}: 10 min. */
export const DEFAULT_ALERT_COOLDOWN_MS = 10 * 60_000;

/** Default {@link AlertEmitterOptions.repeatedIntervalMs}: 60 s. */
export const DEFAULT_ALERT_REPEATED_INTERVAL_MS = 60_000;

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
  /**
   * When it happened (event time, e.g. the position's time). Default: the
   * emitter clock. It becomes the alert's `occurredAt` and the occurrence's
   * {@link OpenAlert.firstOccurredAt} / {@link OpenAlert.lastOccurredAt}.
   */
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
  /**
   * Same severity as the open occurrence: nothing is published; the
   * persistence hook's `onRepeated` hears of it at most every
   * `repeatedIntervalMs` of event time.
   */
  | 'unchanged'
  /** Lower severity than the open occurrence: recorded (`onUpdated`), not published. */
  | 'de-escalated'
  /**
   * Would have been published, but the key was published with at least this
   * severity less than `cooldownMs` ago: the previous alert is reopened or
   * updated (`onUpdated`) instead of publishing again.
   */
  | 'suppressed';

/**
 * An occurrence that is currently open.
 *
 * Times come from two clocks: `openedAt`, `publishedAt` and `lastSeenAt`
 * are emitter-clock (wall clock) times, while `firstOccurredAt` and
 * `lastOccurredAt` are event times (`AlertSignal.occurredAt`). Store and
 * compare event times with event times (e.g. a `last_seen_at` column with
 * `lastOccurredAt`, or the age of a condition against a position's time).
 */
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
  /**
   * When the occurrence was opened: the emitter clock at its first raise.
   * `loadOpen` rows usually restore the stored opening time; for the event
   * time of the condition's start, use {@link firstOccurredAt}.
   */
  readonly openedAt: Date;
  /** When an alert of the key was last published (emitter clock; it starts the cooldown). */
  readonly publishedAt: Date;
  /** When the last signal arrived (emitter clock); for its event time, use {@link lastOccurredAt}. */
  readonly lastSeenAt: Date;
  /**
   * Event time of the occurrence's first signal (`AlertSignal.occurredAt`,
   * default the emitter clock). Set on every occurrence the emitter holds;
   * `loadOpen` rows without it default to `openedAt`.
   */
  readonly firstOccurredAt?: Date | undefined;
  /**
   * Event time of the occurrence's latest signal: the latest
   * `AlertSignal.occurredAt` seen, never moving backwards. Set on every
   * occurrence the emitter holds; `loadOpen` rows without it default to
   * `lastSeenAt`.
   */
  readonly lastOccurredAt?: Date | undefined;
  /**
   * Domain of the occurrence's alerts. Set on occurrences raised by the
   * emitter; `loadOpen` rows should return it (without it, the
   * `alert.resolved.v1` of the occurrence takes the registry domain of
   * `type`, or the resolving detector's domain).
   */
  readonly domain?: AlertDomain | undefined;
  /**
   * Methodology catalog id of the occurrence's last published alert. Set on
   * occurrences raised by the emitter; `loadOpen` rows should return it
   * (without it, the `alert.resolved.v1` of the occurrence takes the
   * resolving detector's first method id).
   */
  readonly methodId?: string | undefined;
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
  /** When the update was made (emitter clock). */
  readonly at: Date;
  /**
   * Event time of the signal that caused it (`AlertSignal.occurredAt`,
   * default the emitter clock). Always set by the emitter.
   */
  readonly occurredAt?: Date | undefined;
}

/** The end of an occurrence. */
export interface AlertResolution {
  readonly alert: OpenAlert;
  /** End of the condition: `AlertResolveOptions.at` (event time) or the emitter clock. */
  readonly resolvedAt: Date;
  /** Why it ended, e.g. `"left the danger zone"`. */
  readonly reason: string | undefined;
  readonly data: Readonly<Record<string, unknown>>;
  /**
   * Id of the `alert.resolved.v1` event announcing the resolution (its
   * envelope id and `Nats-Msg-Id`). `undefined` when no event is built: the
   * emitter has no `publishResolution`, the resolution was made with
   * `publish: false`, or no domain / method id is known for the occurrence.
   * The event may go out later (after the key's cooldown) or never (a
   * re-raise within the cooldown reopens the occurrence).
   */
  readonly eventId?: string | undefined;
}

/**
 * The service's event repository hook (spec §18): the emitter calls it
 * BEFORE publishing, so the service's `events` table is the record of every
 * occurrence. Every method is optional; failures propagate to the caller.
 * Implementations must be idempotent (a resolution may be reported for an
 * alert that was already resolved after a suppressed reopen). Hooks run in
 * turn with the key's operations: calling the emitter for the same key from
 * a hook waits for the hook itself (deadlock).
 */
export interface AlertPersistence {
  /** A new alert (status open): insert the event row. */
  onRaised?(
    alert: AlertRaisedV1,
    outcome: 'raised' | 'escalated',
  ): Promise<void>;
  /** Severity changed or the occurrence reopened without publishing. */
  onUpdated?(update: AlertUpdate): Promise<void>;
  /**
   * A signal repeated the open occurrence with the same severity
   * (`'unchanged'`), e.g. to move `last_seen_at` to `occurredAt` (event
   * time). Called at most once per `repeatedIntervalMs` of event time per
   * key, counted from the latest signal any hook of the key reported; a
   * failure propagates to the caller and the next signal retries.
   */
  onRepeated?(alert: OpenAlert, occurredAt: Date): Promise<void>;
  /** The occurrence ended: mark the event row resolved. */
  onResolved?(resolution: AlertResolution): Promise<void>;
  /**
   * Occurrences still open in the store. Restored at startup and, by the
   * detector runner, again whenever this instance becomes the active one
   * (with replace semantics, {@link AlertEmitter.replaceOpen}), so neither a
   * restart nor a failover re-raises them or misses their resolutions.
   * Return `domain`, `methodId`, `firstOccurredAt` and `lastOccurredAt`
   * when the store has them.
   */
  loadOpen?(): Promise<readonly OpenAlert[]>;
}

/** Options of {@link AlertEmitter.resolve}. */
export interface AlertResolveOptions {
  /** When the condition ended (event time, e.g. the position's time). Default: the emitter's clock. */
  readonly at?: Date | undefined;
  /**
   * Why it ended, e.g. `"left the danger zone"` (the event carries at most
   * `ALERT_RESOLUTION_REASON_MAX_LENGTH` characters of it).
   */
  readonly reason?: string | undefined;
  readonly data?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Resolves only an occurrence this predicate accepts (checked in turn with
   * the key's other operations, so a raise still persisting is seen);
   * `DetectorContext.alerts` uses it to scope resolutions to the detector.
   */
  readonly accept?: ((alert: OpenAlert) => boolean) | undefined;
  /**
   * Announce the resolution with `alert.resolved.v1` (when the emitter has
   * `publishResolution`). Default `true`; `false` only records it
   * (`onResolved`), e.g. for an occurrence whose end another process
   * already announced.
   */
  readonly publish?: boolean | undefined;
  /**
   * Domain of the event when the occurrence carries none (a `loadOpen` row
   * without it, of a type outside the registry). `DetectorContext.alerts`
   * sets the detector's domain.
   */
  readonly domain?: AlertDomain | undefined;
  /**
   * Method id of the event when the occurrence carries none (a `loadOpen`
   * row without it). `DetectorContext.alerts` sets the detector's first
   * method id.
   */
  readonly methodId?: string | undefined;
}

/** Options of {@link AlertEmitter.forget}. */
export interface AlertForgetOptions {
  /**
   * Forgets the key only when this predicate accepts its open (or recently
   * resolved) occurrence; `DetectorContext.alerts` scopes it to the detector.
   */
  readonly accept?: ((alert: OpenAlert) => boolean) | undefined;
}

/** Options of {@link AlertEmitter.replaceOpen}. */
export interface AlertReplaceOptions {
  /**
   * The occurrences being replaced: only open (and recently resolved)
   * occurrences this predicate accepts are dropped, and only given ones it
   * accepts are installed. Default: every occurrence.
   */
  readonly filter?: ((alert: OpenAlert) => boolean) | undefined;
}

/** What {@link AlertEmitter.replaceOpen} changed. */
export interface AlertReplaceResult {
  /** Occurrences installed from the given ones (new, changed or identical). */
  readonly restored: number;
  /** Open occurrences in scope dropped because the given ones lack their key. */
  readonly forgotten: number;
}

/** What {@link AlertEmitter.retryPending} and {@link AlertEmitter.flush} published. */
export interface AlertPublicationResult {
  /** Persisted alerts (`alert.raised.v1`) published after an earlier failure. */
  readonly published: number;
  /** Persisted alerts whose publication failed again (still pending). */
  readonly failed: number;
  /** Resolutions (`alert.resolved.v1`) published. */
  readonly resolutionsPublished: number;
  /** Resolutions whose publication failed (still pending, retried). */
  readonly resolutionsFailed: number;
  /** Resolutions waiting for the end of their key's cooldown (`retryPending` only: `flush` publishes them). */
  readonly resolutionsWaiting: number;
}

/** Publishes an alert (`alert.raised.v1` on `alert.v1.<type>.<mmsi>`). */
export type AlertPublisher = (alert: AlertRaisedV1) => Promise<void>;

/**
 * Publishes the end of an occurrence (`alert.resolved.v1` on the raise's
 * subject `alert.v1.<type>.<mmsi>`, envelope id = `event.id`).
 */
export type AlertResolutionPublisher = (
  event: AlertResolvedV1,
) => Promise<void>;

/** Options of {@link AlertEmitter}. */
export interface AlertEmitterOptions {
  readonly publish: AlertPublisher;
  /**
   * Announces resolutions with `alert.resolved.v1` (spec §18); without it
   * resolutions are only persisted. A resolution goes out once its key's
   * cooldown since the last published raise is over: at once for an older
   * occurrence, otherwise when the window ends (`retryPending()`), before
   * the key's next raise, or on `flush()`. A re-raise within the window
   * reopens the occurrence without publishing and cancels the event, so
   * subscribers never see resolved an occurrence the emitter holds open,
   * and flapping publishes nothing. A publication that fails is retried
   * with the same event id. Pending events live in memory: a crash within
   * the cooldown window loses that event (the resolution itself was
   * persisted); a graceful stop or deactivation publishes them first.
   */
  readonly publishResolution?: AlertResolutionPublisher | undefined;
  readonly persistence?: AlertPersistence | undefined;
  /** Minimum time between two publications of a key (unless escalating past them), ms. Default 10 min. */
  readonly cooldownMs?: number | undefined;
  /** Minimum event-time interval between two `onRepeated` calls of a key, ms. Default 60 s. */
  readonly repeatedIntervalMs?: number | undefined;
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

/** A resolution event not published yet. */
interface PendingResolution {
  readonly event: AlertResolvedV1;
  /** Emitter-clock time (ms) from which it may go out: the end of the key's cooldown. */
  readonly dueAt: number;
}

/** A key held by {@link AlertEmitter.withKey} in the current async context. */
interface KeyLease {
  readonly emitter: AlertEmitter;
  readonly key: string;
  /** Cleared when the `withKey` callback settled: later continuations no longer hold the key. */
  active: boolean;
  readonly parent: KeyLease | undefined;
}

const leases = new AsyncLocalStorage<KeyLease>();

/** Thrown for signals that contradict the alert type registry. */
export class AlertSignalError extends Error {
  override readonly name = 'AlertSignalError';
}

/**
 * Builds `alert.raised.v1` payloads from detector signals (spec §18) and
 * keeps one state machine per `dedupKey`: new occurrences and escalations
 * are persisted and published, unchanged signals are ignored (throttled
 * `onRepeated`), de-escalations and flapping within `cooldownMs` are
 * recorded without publishing, and {@link resolve} closes an occurrence and,
 * with `publishResolution`, announces it with `alert.resolved.v1`.
 * Detectors use it through `DetectorContext.alerts`, which fixes the domain
 * and the owning detector.
 *
 * Every operation on one `dedupKey` (raise, resolve, forget, replace,
 * publication retries, {@link withKey}) runs to completion before the next
 * one starts, so concurrent signals of one condition — the two vessels of a
 * pair, a tick and a position — never open two occurrences or lose a
 * resolution, and the events of a key are published in order.
 */
export class AlertEmitter {
  /** Cooldown between publications of a key, ms. */
  readonly cooldownMs: number;
  /** Event-time throttle of `AlertPersistence.onRepeated`, ms. */
  readonly repeatedIntervalMs: number;
  private readonly open = new Map<string, OpenAlert>();
  private readonly closed = new Map<string, ClosedAlert>();
  /** Persisted alerts whose publication failed, retried with the same id. */
  private readonly unpublished = new Map<
    string,
    { readonly alert: AlertRaisedV1; readonly outcome: 'raised' | 'escalated' }
  >();
  /** Resolutions not published yet (waiting for the cooldown, or failed). */
  private readonly pendingResolutions = new Map<string, PendingResolution>();
  /** Latest event time (ms) of each open key that a persistence hook heard of. */
  private readonly reported = new Map<string, number>();
  private readonly clock: () => Date;
  private readonly keys = new KeyedSerialQueue();
  private readonly logger = new Logger('AlertEmitter');

  constructor(private readonly options: AlertEmitterOptions) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    this.repeatedIntervalMs =
      options.repeatedIntervalMs ?? DEFAULT_ALERT_REPEATED_INTERVAL_MS;
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Restores open occurrences (from `AlertPersistence.loadOpen`): adds them
   * or overwrites the same keys, keeping the others. Missing
   * `firstOccurredAt` / `lastOccurredAt` default to `openedAt` /
   * `lastSeenAt`. See {@link replaceOpen} for replace semantics.
   */
  restore(alerts: readonly OpenAlert[]): void {
    for (const alert of alerts) this.install(normalizeOpen(alert));
  }

  /** Restores the open occurrences of the persistence hook, if it has `loadOpen`; returns how many. */
  async restoreFromPersistence(): Promise<number> {
    const alerts = (await this.options.persistence?.loadOpen?.()) ?? [];
    this.restore(alerts);
    return alerts.length;
  }

  /**
   * Makes `alerts` the open occurrences within `options.filter` (default:
   * all), e.g. the persistence hook's `loadOpen()` after a failover: open
   * occurrences in scope that `alerts` lacks are dropped, those it contains
   * are installed (the last one of a key wins), and cooldown entries in
   * scope are cleared, so the next signal of a dropped key raises a new
   * occurrence. Calls no persistence hook and publishes nothing; pending
   * publications stay pending. Each key is replaced in turn with its other
   * operations, so a raise of the key already running completes first and
   * a later one sees the new state.
   */
  async replaceOpen(
    alerts: readonly OpenAlert[],
    options: AlertReplaceOptions = {},
  ): Promise<AlertReplaceResult> {
    const inScope = options.filter ?? (() => true);
    const next = new Map<string, OpenAlert>();
    for (const alert of alerts)
      if (inScope(alert)) next.set(alert.dedupKey, normalizeOpen(alert));
    const keys = new Set(next.keys());
    for (const alert of this.open.values())
      if (inScope(alert)) keys.add(alert.dedupKey);
    for (const { alert } of this.closed.values())
      if (inScope(alert)) keys.add(alert.dedupKey);
    let restored = 0;
    let forgotten = 0;
    await Promise.all(
      [...keys].map((key) =>
        this.runKeyed(key, () => {
          const replacement = next.get(key);
          const current = this.open.get(key);
          const closed = this.closed.get(key);
          if (
            replacement !== undefined ||
            (closed !== undefined && inScope(closed.alert))
          )
            this.closed.delete(key);
          if (replacement !== undefined) {
            this.install(replacement);
            restored += 1;
          } else if (current !== undefined && inScope(current)) {
            this.open.delete(key);
            this.reported.delete(key);
            forgotten += 1;
          }
          return Promise.resolve();
        }),
      ),
    );
    return { restored, forgotten };
  }

  /**
   * Drops the state of `dedupKey` — its open occurrence and its cooldown
   * entry — without calling a persistence hook or publishing, e.g. when the
   * occurrence was resolved by another process: the next signal of the key
   * raises a new occurrence. Pending publications of the key stay pending.
   *
   * @returns `false` when the key had no state (or `accept` refused it).
   */
  forget(dedupKey: string, options: AlertForgetOptions = {}): Promise<boolean> {
    return this.runKeyed(dedupKey, () => {
      const target =
        this.open.get(dedupKey) ?? this.closed.get(dedupKey)?.alert;
      if (target === undefined) return Promise.resolve(false);
      if (options.accept !== undefined && !options.accept(target))
        return Promise.resolve(false);
      this.open.delete(dedupKey);
      this.closed.delete(dedupKey);
      this.reported.delete(dedupKey);
      return Promise.resolve(true);
    });
  }

  /**
   * Runs `fn` in turn with the other operations of `dedupKey`: raises,
   * resolutions, `forget`, `replaceOpen` and publication retries of the key
   * wait for it, and it waits for those already queued — e.g. to align the
   * key with an external store before acting on it. Calls of this emitter
   * for the same key made inside `fn` run at once (re-entrant) instead of
   * waiting for `fn`. Work that `fn` starts but does not await is not
   * serialized; holding several keys at once can deadlock against another
   * caller holding them in a different order.
   */
  withKey<T>(dedupKey: string, fn: () => Promise<T>): Promise<T> {
    if (this.holds(dedupKey)) return fn();
    return this.keys.run(dedupKey, () => {
      const lease: KeyLease = {
        emitter: this,
        key: dedupKey,
        active: true,
        parent: leases.getStore(),
      };
      return leases.run(lease, async () => {
        try {
          return await fn();
        } finally {
          lease.active = false;
        }
      });
    });
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
    return this.runKeyed(signal.dedupKey, () => this.raiseNow(domain, signal));
  }

  private async raiseNow(
    domain: AlertDomain,
    signal: AlertSignal,
  ): Promise<AlertOutcome> {
    const key = signal.dedupKey;
    // A persisted alert of this key that could not be published goes out first.
    await this.publishPending(key);
    const now = this.clock();
    const occurredAt = signal.occurredAt ?? now;
    const current = this.open.get(key);
    if (
      current !== undefined &&
      signal.detector !== undefined &&
      current.detector !== undefined &&
      current.detector !== signal.detector
    ) {
      throw new AlertSignalError(
        `dedupKey "${key}" is open for detector ${current.detector}, not ${signal.detector}`,
      );
    }
    const closed =
      current === undefined ? this.recentlyClosed(key, now) : undefined;
    // Back within the cooldown, the occurrence never ended for subscribers:
    // its resolution is cancelled. That of an earlier occurrence goes first.
    await this.settlePendingResolution(
      key,
      (current ?? closed?.alert)?.alertId,
    );
    if (current !== undefined)
      return this.update(domain, signal, current, now, occurredAt);

    if (
      closed !== undefined &&
      compareAlertSeverity(signal.severity, closed.alert.publishedSeverity) <= 0
    ) {
      const reopened: OpenAlert = {
        ...closed.alert,
        severity: signal.severity,
        lastSeenAt: now,
        lastOccurredAt: later(closed.alert.lastOccurredAt, occurredAt),
      };
      this.closed.delete(key);
      this.open.set(key, reopened);
      await this.reportUpdate({
        reason: 'suppressed',
        alert: reopened,
        previousSeverity: closed.alert.severity,
        reopened: true,
        at: now,
        occurredAt,
      });
      return 'suppressed';
    }
    this.closed.delete(key);
    await this.publishNew(domain, signal, now, occurredAt, 'raised', undefined);
    return 'raised';
  }

  /**
   * Ends the open occurrence of `dedupKey`. Runs after any raise of the key
   * that is still persisting, so a resolution is never lost; the occurrence
   * stays open when the persistence hook fails (the error propagates).
   *
   * With `publishResolution`, the resolution is then announced with
   * `alert.resolved.v1` (event id = `AlertResolution.eventId`): at once
   * when the key's last raise was published at least `cooldownMs` ago,
   * otherwise when that window ends — unless the key is raised again within
   * it, which reopens the occurrence and cancels the event. When the
   * immediate publication fails, the occurrence is still resolved, the
   * event stays pending (retried with the same id) and the error
   * propagates.
   *
   * @returns `false` when no occurrence was open (or `accept` refused it).
   */
  resolve(
    dedupKey: string,
    options: AlertResolveOptions = {},
  ): Promise<boolean> {
    return this.runKeyed(dedupKey, () => this.resolveNow(dedupKey, options));
  }

  private async resolveNow(
    dedupKey: string,
    options: AlertResolveOptions,
  ): Promise<boolean> {
    const alert = this.open.get(dedupKey);
    if (alert === undefined) return false;
    if (options.accept !== undefined && !options.accept(alert)) return false;
    // A pending resolution of this occurrence is superseded; the end of an
    // earlier occurrence (restored since) goes out first.
    await this.settlePendingResolution(dedupKey, alert.alertId);
    const now = this.clock();
    const resolvedAt = options.at ?? now;
    const event =
      (options.publish ?? true) && this.options.publishResolution !== undefined
        ? this.resolutionEvent(alert, resolvedAt, options)
        : undefined;
    await this.options.persistence?.onResolved?.({
      alert,
      resolvedAt,
      reason: options.reason,
      data: options.data ?? {},
      eventId: event?.id,
    });
    this.open.delete(dedupKey);
    this.reported.delete(dedupKey);
    this.closed.set(dedupKey, { alert, closedAt: resolvedAt });
    if (event !== undefined) {
      const dueAt = alert.publishedAt.getTime() + this.cooldownMs;
      this.pendingResolutions.set(dedupKey, { event, dueAt });
      if (now.getTime() >= dueAt)
        await this.publishPendingResolution(dedupKey, false);
    }
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

  /** Resolutions not published yet (waiting for their key's cooldown, or failed). */
  get pendingResolutionCount(): number {
    return this.pendingResolutions.size;
  }

  /**
   * Retries the publication of persisted alerts whose publication failed
   * (same alert id, so JetStream deduplicates) and publishes the pending
   * resolutions whose key's cooldown is over (retried with the same event
   * id). The runner calls it every 30 s; signals of the same key retry it
   * too. Never rejects.
   */
  retryPending(): Promise<AlertPublicationResult> {
    return this.publishAll(false);
  }

  /**
   * Publishes every pending publication now — failed alerts and
   * resolutions, including those still within their key's cooldown — e.g.
   * before this instance stops or stops being the active one. Never
   * rejects; what fails stays pending.
   */
  flush(): Promise<AlertPublicationResult> {
    return this.publishAll(true);
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

  /** Runs `task` in turn with the key's operations (at once inside {@link withKey} of the key). */
  private runKeyed<T>(key: string, task: () => Promise<T>): Promise<T> {
    return this.holds(key) ? task() : this.keys.run(key, task);
  }

  /** `true` inside a {@link withKey} callback of this emitter for `key`. */
  private holds(key: string): boolean {
    for (
      let lease = leases.getStore();
      lease !== undefined;
      lease = lease.parent
    )
      if (lease.active && lease.emitter === this && lease.key === key)
        return true;
    return false;
  }

  /** Sets an open occurrence and its `onRepeated` throttle reference. */
  private install(alert: OpenAlert): void {
    this.open.set(alert.dedupKey, alert);
    this.reported.set(
      alert.dedupKey,
      (alert.lastOccurredAt ?? alert.lastSeenAt).getTime(),
    );
  }

  /** Notes that persistence heard of the key at event time `occurredAt`. */
  private markReported(key: string, occurredAt: Date): void {
    const previous = this.reported.get(key);
    const time = occurredAt.getTime();
    if (previous === undefined || time > previous) this.reported.set(key, time);
  }

  private async publishAll(force: boolean): Promise<AlertPublicationResult> {
    let published = 0;
    let failed = 0;
    let resolutionsPublished = 0;
    let resolutionsFailed = 0;
    let resolutionsWaiting = 0;
    const keys = new Set([
      ...this.unpublished.keys(),
      ...this.pendingResolutions.keys(),
    ]);
    await Promise.all(
      [...keys].map((key) =>
        this.runKeyed(key, async () => {
          let raiseFailed = false;
          if (this.unpublished.has(key)) {
            try {
              await this.publishPending(key);
              published += 1;
            } catch {
              failed += 1;
              raiseFailed = true;
            }
          }
          const pending = this.pendingResolutions.get(key);
          if (pending === undefined) return;
          const due = force || this.clock().getTime() >= pending.dueAt;
          if (!due) {
            resolutionsWaiting += 1;
          } else if (raiseFailed) {
            // Its raise goes out first; that just failed.
            resolutionsFailed += 1;
          } else {
            try {
              await this.publishPendingResolution(key, true);
              resolutionsPublished += 1;
            } catch {
              resolutionsFailed += 1;
            }
          }
        }),
      ),
    );
    return {
      published,
      failed,
      resolutionsPublished,
      resolutionsFailed,
      resolutionsWaiting,
    };
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
    occurredAt: Date,
  ): Promise<AlertOutcome> {
    const key = signal.dedupKey;
    const lastOccurredAt = later(current.lastOccurredAt, occurredAt);
    const order = compareAlertSeverity(signal.severity, current.severity);
    if (order === 0) {
      const seen: OpenAlert = { ...current, lastSeenAt: now, lastOccurredAt };
      this.open.set(key, seen);
      await this.reportRepeated(seen, occurredAt);
      return 'unchanged';
    }
    if (order < 0) {
      const lowered: OpenAlert = {
        ...current,
        severity: signal.severity,
        lastSeenAt: now,
        lastOccurredAt,
      };
      this.open.set(key, lowered);
      await this.reportUpdate({
        reason: 'de-escalated',
        alert: lowered,
        previousSeverity: current.severity,
        reopened: false,
        at: now,
        occurredAt,
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
        lastOccurredAt,
      };
      this.open.set(key, raised);
      await this.reportUpdate({
        reason: 'suppressed',
        alert: raised,
        previousSeverity: current.severity,
        reopened: false,
        at: now,
        occurredAt,
      });
      return 'suppressed';
    }
    await this.publishNew(
      domain,
      signal,
      now,
      occurredAt,
      'escalated',
      current,
    );
    return 'escalated';
  }

  /** `onUpdated`, then the key's `onRepeated` throttle restarts from the signal. */
  private async reportUpdate(
    update: AlertUpdate & { readonly occurredAt: Date },
  ): Promise<void> {
    const persistence = this.options.persistence;
    if (persistence?.onUpdated === undefined) return;
    await persistence.onUpdated(update);
    this.markReported(update.alert.dedupKey, update.occurredAt);
  }

  /** `onRepeated` when the key's last report is `repeatedIntervalMs` (event time) old. */
  private async reportRepeated(
    alert: OpenAlert,
    occurredAt: Date,
  ): Promise<void> {
    const persistence = this.options.persistence;
    if (persistence?.onRepeated === undefined) return;
    const last = this.reported.get(alert.dedupKey);
    if (
      last !== undefined &&
      occurredAt.getTime() - last < this.repeatedIntervalMs
    )
      return;
    await persistence.onRepeated(alert, occurredAt);
    this.markReported(alert.dedupKey, occurredAt);
  }

  private async publishNew(
    domain: AlertDomain,
    signal: AlertSignal,
    now: Date,
    occurredAt: Date,
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
      occurredAt: occurredAt.toISOString(),
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
      firstOccurredAt:
        previous === undefined
          ? occurredAt
          : (previous.firstOccurredAt ?? previous.openedAt),
      lastOccurredAt: later(previous?.lastOccurredAt, occurredAt),
      domain,
      methodId: signal.methodId,
      ...(signal.detector === undefined && previous?.detector === undefined
        ? {}
        : { detector: signal.detector ?? previous?.detector }),
    };
    await this.options.persistence?.onRaised?.(alert, outcome);
    this.open.set(signal.dedupKey, state);
    this.markReported(signal.dedupKey, occurredAt);
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

  /**
   * Settles the pending resolution of `dedupKey` before another operation
   * of the key: dropped when it belongs to the occurrence `alertId` (open
   * again, reopened, or resolved anew), otherwise published first.
   */
  private async settlePendingResolution(
    dedupKey: string,
    alertId: string | undefined,
  ): Promise<void> {
    const pending = this.pendingResolutions.get(dedupKey);
    if (pending === undefined) return;
    if (alertId !== undefined && pending.event.alertId === alertId) {
      this.pendingResolutions.delete(dedupKey);
      return;
    }
    await this.publishPendingResolution(dedupKey, true);
  }

  /**
   * Publishes the pending resolution of a key when it is due (or `force`),
   * after the key's pending raise; it stays pending (and the error
   * propagates) on failure.
   *
   * @returns `true` when it was published.
   */
  private async publishPendingResolution(
    dedupKey: string,
    force: boolean,
  ): Promise<boolean> {
    const pending = this.pendingResolutions.get(dedupKey);
    if (pending === undefined) return false;
    if (!force && this.clock().getTime() < pending.dueAt) return false;
    const publish = this.options.publishResolution;
    if (publish === undefined) {
      this.pendingResolutions.delete(dedupKey);
      return false;
    }
    await this.publishPending(dedupKey);
    await publish(pending.event);
    if (this.pendingResolutions.get(dedupKey) === pending)
      this.pendingResolutions.delete(dedupKey);
    return true;
  }

  /**
   * The `alert.resolved.v1` payload of a resolution, or `undefined` (with a
   * warning) when the occurrence has no known domain or method id or the
   * payload is invalid: the resolution is then only persisted.
   */
  private resolutionEvent(
    alert: OpenAlert,
    resolvedAt: Date,
    options: AlertResolveOptions,
  ): AlertResolvedV1 | undefined {
    const domain =
      alert.domain ?? getAlertType(alert.type)?.domain ?? options.domain;
    const methodId = alert.methodId ?? options.methodId;
    if (domain === undefined || methodId === undefined) {
      this.logger.warn(
        `Resolution of ${alert.dedupKey} is not published: the occurrence has no ` +
          `${domain === undefined ? 'domain' : 'method id'} (return it from AlertPersistence.loadOpen)`,
      );
      return undefined;
    }
    const parsed = AlertResolvedV1Schema.safeParse({
      id: newId(),
      alertId: alert.alertId,
      type: alert.type,
      domain,
      severity: alert.publishedSeverity,
      mmsi: alert.mmsi,
      relatedMmsi: alert.relatedMmsi,
      zoneId: alert.zoneId,
      dedupKey: alert.dedupKey,
      openedAt: (alert.firstOccurredAt ?? alert.openedAt).toISOString(),
      resolvedAt: resolvedAt.toISOString(),
      reason:
        options.reason === undefined
          ? null
          : options.reason.slice(0, ALERT_RESOLUTION_REASON_MAX_LENGTH),
      methodId,
      data: { ...(options.data ?? {}) },
    });
    if (!parsed.success) {
      this.logger.warn(
        `Resolution of ${alert.dedupKey} is not published: invalid alert.resolved.v1 ` +
          `(${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')})`,
      );
      return undefined;
    }
    return parsed.data;
  }
}

/** Fills the event times of a restored occurrence. */
function normalizeOpen(alert: OpenAlert): OpenAlert {
  if (alert.firstOccurredAt !== undefined && alert.lastOccurredAt !== undefined)
    return alert;
  return {
    ...alert,
    firstOccurredAt: alert.firstOccurredAt ?? alert.openedAt,
    lastOccurredAt: alert.lastOccurredAt ?? alert.lastSeenAt,
  };
}

/** The later of two times (`time` when `previous` is unknown). */
function later(previous: Date | undefined, time: Date): Date {
  return previous !== undefined && previous.getTime() > time.getTime()
    ? previous
    : time;
}
