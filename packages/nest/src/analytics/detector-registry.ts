import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AlertType,
  getAlertType,
  isAlertDomain,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  getMethod,
  isCatalogId,
  METHODS,
} from '@darmawanweb/ais-its-contracts/references';
import { Logger } from '@nestjs/common';

import { errorMessage } from '../common/retry.js';
import {
  type ConfigIssue,
  ConfigValidationError,
} from '../config/define-config.js';
import {
  type AlertEmitter,
  type AlertOutcome,
  AlertSignalError,
  type OpenAlert,
} from './alert-emitter.js';
import {
  type AnyDetector,
  DETECTOR_ID_PATTERN,
  type DetectorAlerts,
  type DetectorAlertSignal,
  type DetectorCall,
  type DetectorContext,
  type DetectorDescriptor,
  type DetectorLogger,
  type DetectorVesselChange,
  type DetectorZoneChange,
} from './detector.js';
import {
  DETECTORS_ENV,
  detectorEnvPrefix,
  parseDetectorConfig,
  parseDetectorList,
} from './detector-config.js';
import { type DetectorHook, DetectorMetrics } from './detector-metrics.js';
import type { FleetDirectory } from './fleet-directory.js';
import type { PairSearch } from './pair-search.js';
import type { VesselPosition } from './vessel-position.js';
import type { VesselState, VesselStateStore } from './vessel-state-store.js';
import type { ZoneIndex } from './zone-index.js';

/** The shared SDK state handed to every detector. */
export interface DetectorServices {
  readonly vessels: VesselStateStore;
  readonly pairs: PairSearch<VesselState>;
  readonly zones: ZoneIndex;
  readonly fleet: FleetDirectory;
  readonly alerts: AlertEmitter;
  readonly clock: () => Date;
}

/** Options of {@link DetectorRegistry}. */
export interface DetectorRegistryOptions {
  readonly services: DetectorServices;
  /** Source of `DETECTORS` and the `<ID>_*` variables. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Enabled detector ids; overrides `DETECTORS`. Default: every registered detector. */
  readonly enabled?: readonly string[] | undefined;
  readonly metrics?: DetectorMetrics | undefined;
  /** Upper bound of one detector call, ms; a slower call counts as an error. Default 10 s. */
  readonly callTimeoutMs?: number | undefined;
  /** Logger factory. Default: Nest `Logger` with context `Detector:<id>`. */
  readonly logger?: ((detectorId: string) => DetectorLogger) | undefined;
}

/** A registered, enabled detector. */
export interface RegisteredDetector {
  readonly detector: AnyDetector;
  readonly descriptor: DetectorDescriptor;
  readonly context: DetectorContext;
}

/** What `GET …/detectors` shows about a detector (spec §13.7, §13.8). */
export interface DetectorDescription extends DetectorDescriptor {
  /** Alert types the detector declares (`Detector.alertTypes`), `null` when undeclared. */
  readonly alertTypes: readonly string[] | null;
  readonly enabled: boolean;
  /** Active configuration (thresholds) of an enabled detector, `null` when disabled. */
  readonly config: unknown;
  readonly tickIntervalMs: number | null;
}

/** Thrown for invalid detector definitions (ids, domains, duplicates, unknown `DETECTORS` entries). */
export class DetectorRegistrationError extends Error {
  override readonly name = 'DetectorRegistrationError';
}

/** Reason of the abort signal of a detector call that exceeded `callTimeoutMs`. */
export class DetectorTimeoutError extends Error {
  override readonly name = 'DetectorTimeoutError';
}

/**
 * Holds the detectors of a service (spec §18): validates their definitions,
 * enables those selected by `DETECTORS` (comma list, default all), parses
 * each one's `<ID>_*` configuration with its zod schema (every problem is
 * reported at once), builds their contexts, and dispatches events with
 * failure isolation, per-call timeouts and metrics.
 */
export class DetectorRegistry {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly metrics: DetectorMetrics;
  private readonly callTimeoutMs: number;
  private readonly registered: RegisteredDetector[] = [];
  private readonly disabled: AnyDetector[] = [];
  /** Timed-out calls that are still running, by detector and vessel. */
  private readonly lingering = new Map<string, Promise<unknown>>();
  /** Detector calls in progress (each settles within `callTimeoutMs`). */
  private readonly running = new Set<Promise<boolean>>();
  private readonly logger = new Logger('DetectorRegistry');
  private activeInstance = true;

  constructor(private readonly options: DetectorRegistryOptions) {
    this.env = options.env ?? process.env;
    this.metrics = options.metrics ?? new DetectorMetrics();
    this.callTimeoutMs = options.callTimeoutMs ?? 10_000;
  }

  /** Enabled detectors, in registration order. */
  get enabled(): readonly RegisteredDetector[] {
    return this.registered;
  }

  /** `true` when `DETECTORS` (or `enabled`) disabled some registered detectors. */
  get isSubset(): boolean {
    return this.disabled.length > 0;
  }

  /**
   * `true` while this instance is the active detector instance (default):
   * what `DetectorContext.isActive()` returns. The runner sets it from its
   * exclusive position consumer, the test harness from `activate()` /
   * `deactivate()`; ticks run only while it is `true`.
   */
  get active(): boolean {
    return this.activeInstance;
  }

  /** Sets {@link active} (see `DetectorEngine.activate` / `deactivate`). */
  setActive(active: boolean): void {
    this.activeInstance = active;
  }

  /**
   * Resolves once the detector calls running now have settled (a call that
   * exceeds `callTimeoutMs` counts as settled when it times out).
   */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }

  /**
   * `true` when an enabled detector owns the occurrence: raised by it, or
   * restored without an owner in its domain (what its `DetectorContext.alerts`
   * sees). The runner reloads exactly these occurrences on activation.
   */
  owns(alert: OpenAlert): boolean {
    return this.registered.some((entry) => ownedBy(alert, entry.descriptor));
  }

  /**
   * Registers the detectors of the application (once).
   *
   * @throws {DetectorRegistrationError} for invalid or duplicate definitions and unknown `DETECTORS` ids.
   * @throws {ConfigValidationError} listing every invalid `<ID>_*` variable.
   */
  register(detectors: readonly AnyDetector[]): void {
    const ids = new Set<string>();
    for (const detector of detectors) {
      validateDefinition(detector);
      if (ids.has(detector.id))
        throw new DetectorRegistrationError(
          `Detector id "${detector.id}" is registered twice`,
        );
      ids.add(detector.id);
    }
    const selection =
      this.options.enabled ?? parseDetectorList(this.env[DETECTORS_ENV]);
    const unknown = (selection ?? []).filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      throw new DetectorRegistrationError(
        `${DETECTORS_ENV} lists unknown detector(s) ${unknown.join(', ')}; known: ${[...ids].join(', ') || '(none)'}`,
      );
    }

    this.warnUnknownMethodIds(detectors);
    const issues: ConfigIssue[] = [];
    const accepted: RegisteredDetector[] = [];
    for (const detector of detectors) {
      if (selection !== undefined && !selection.includes(detector.id)) {
        this.disabled.push(detector);
        continue;
      }
      const parsed = parseDetectorConfig(
        detector.id,
        detector.configSchema,
        this.env,
      );
      if (!parsed.success) {
        issues.push(...parsed.issues);
        continue;
      }
      const descriptor: DetectorDescriptor = {
        id: detector.id,
        domain: detector.domain,
        methodIds: Object.freeze([...detector.methodIds]),
      };
      accepted.push({
        detector,
        descriptor,
        context: this.createContext(detector, descriptor, parsed.config),
      });
    }
    if (issues.length > 0) throw new ConfigValidationError(issues);
    this.registered.push(...accepted);
  }

  /** Description of every registered detector (enabled first). */
  describe(): DetectorDescription[] {
    return [
      ...this.registered.map(({ detector, descriptor, context }) => ({
        ...descriptor,
        alertTypes: alertTypesOf(detector),
        enabled: true,
        config: context.config,
        tickIntervalMs: detector.tickIntervalMs ?? null,
      })),
      ...this.disabled.map((detector) => ({
        id: detector.id,
        domain: detector.domain,
        methodIds: [...detector.methodIds],
        alertTypes: alertTypesOf(detector),
        enabled: false,
        config: null,
        tickIntervalMs: detector.tickIntervalMs ?? null,
      })),
    ];
  }

  /** The enabled detector with this id. */
  get(id: string): RegisteredDetector | undefined {
    return this.registered.find((entry) => entry.descriptor.id === id);
  }

  /** Calls `onPosition` of every enabled detector (concurrently, isolated). */
  async dispatchPosition(position: VesselPosition): Promise<void> {
    await Promise.all(
      this.registered.map((entry) =>
        this.invoke(entry, 'onPosition', String(position.mmsi), (call) =>
          entry.detector.onPosition(entry.context, position, call),
        ),
      ),
    );
  }

  /** Calls `onTick` of one detector (isolated). */
  async dispatchTick(id: string, now: Date): Promise<void> {
    const entry = this.get(id);
    if (entry?.detector.onTick === undefined) return;
    await this.invoke(entry, 'onTick', undefined, (call) =>
      entry.detector.onTick?.(entry.context, now, call),
    );
  }

  /** Calls `onZoneChanged` of every enabled detector that has it. */
  async dispatchZoneChange(change: DetectorZoneChange): Promise<void> {
    await Promise.all(
      this.registered
        .filter((entry) => entry.detector.onZoneChanged !== undefined)
        .map((entry) =>
          this.invoke(entry, 'onZoneChanged', undefined, (call) =>
            entry.detector.onZoneChanged?.(entry.context, change, call),
          ),
        ),
    );
  }

  /** Calls `onActivated` of every enabled detector that has it (concurrently, isolated). */
  async dispatchActivated(): Promise<void> {
    await Promise.all(
      this.registered
        .filter((entry) => entry.detector.onActivated !== undefined)
        .map((entry) =>
          this.invoke(entry, 'onActivated', undefined, (call) =>
            entry.detector.onActivated?.(entry.context, call),
          ),
        ),
    );
  }

  /** Calls `onDeactivated` of every enabled detector that has it (concurrently, isolated). */
  async dispatchDeactivated(): Promise<void> {
    await Promise.all(
      this.registered
        .filter((entry) => entry.detector.onDeactivated !== undefined)
        .map((entry) =>
          this.invoke(entry, 'onDeactivated', undefined, (call) =>
            entry.detector.onDeactivated?.(entry.context, call),
          ),
        ),
    );
  }

  /** Calls `onVesselChanged` of every enabled detector that has it. */
  async dispatchVesselChange(change: DetectorVesselChange): Promise<void> {
    await Promise.all(
      this.registered
        .filter((entry) => entry.detector.onVesselChanged !== undefined)
        .map((entry) =>
          this.invoke(entry, 'onVesselChanged', undefined, (call) =>
            entry.detector.onVesselChanged?.(entry.context, change, call),
          ),
        ),
    );
  }

  /**
   * Runs one detector call: never throws; errors and timeouts are logged and
   * counted. A call that exceeds `callTimeoutMs` has its signal aborted and
   * is no longer awaited; while it still runs, later calls of the same
   * detector for the same vessel (`key`) are skipped (and counted), so calls
   * for one vessel never overlap. Tracked for {@link settled}.
   */
  private invoke(
    entry: RegisteredDetector,
    hook: DetectorHook,
    key: string | undefined,
    call: (options: DetectorCall) => void | Promise<void>,
  ): Promise<boolean> {
    const running = this.invokeNow(entry, hook, key, call);
    this.running.add(running);
    void running.finally(() => this.running.delete(running));
    return running;
  }

  private async invokeNow(
    entry: RegisteredDetector,
    hook: DetectorHook,
    key: string | undefined,
    call: (options: DetectorCall) => void | Promise<void>,
  ): Promise<boolean> {
    const labels = { detector: entry.descriptor.id };
    const lingeringKey =
      key === undefined ? undefined : `${entry.descriptor.id}\u0000${key}`;
    if (lingeringKey !== undefined && this.lingering.has(lingeringKey)) {
      this.metrics.skipped.inc({ ...labels, hook });
      entry.context.logger.warn(
        `${hook} skipped for ${key}: its previous call timed out and is still running`,
      );
      return false;
    }
    const evaluation = hook === 'onPosition' || hook === 'onTick';
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = new AbortController();
    const running = Promise.resolve().then(() =>
      call({ signal: controller.signal }),
    );
    try {
      const timeout = sleep(this.callTimeoutMs, undefined, {
        ref: false,
        signal: timer.signal,
      }).then(() => {
        throw new DetectorTimeoutError(
          `${hook} did not settle within ${this.callTimeoutMs} ms`,
        );
      });
      await Promise.race([running, timeout]);
      return true;
    } catch (error) {
      if (error instanceof DetectorTimeoutError) {
        controller.abort(error);
        if (lingeringKey !== undefined) {
          const settled = running.then(
            () => undefined,
            (late: unknown) => {
              entry.context.logger.warn(
                `${hook} for ${key} failed after its timeout: ${errorMessage(late)}`,
              );
            },
          );
          this.lingering.set(lingeringKey, settled);
          void settled.finally(() => this.lingering.delete(lingeringKey));
        } else {
          running.catch(() => undefined);
        }
      }
      this.metrics.errors.inc({ ...labels, hook });
      entry.context.logger.error(`${hook} failed: ${errorMessage(error)}`);
      return false;
    } finally {
      timer.abort();
      if (evaluation) {
        this.metrics.evaluations.inc(labels);
        this.metrics.duration.observe(
          labels,
          (performance.now() - startedAt) / 1000,
        );
      }
    }
  }

  /** Warns about method ids that the contracts methodology catalog does not know (spec §17). */
  private warnUnknownMethodIds(detectors: readonly AnyDetector[]): void {
    if (METHODS.length === 0) return;
    for (const detector of detectors) {
      const unknown = detector.methodIds.filter(
        (id) => getMethod(id) === undefined,
      );
      if (unknown.length > 0) {
        this.logger.warn(
          `Detector ${detector.id} uses method id(s) missing from the methodology catalog: ${unknown.join(', ')} ` +
            '(add them to docs/references/methods.json, spec §17)',
        );
      }
    }
  }

  private createContext(
    detector: AnyDetector,
    descriptor: DetectorDescriptor,
    config: unknown,
  ): DetectorContext {
    const { services } = this.options;
    const logger =
      this.options.logger?.(descriptor.id) ?? nestLogger(descriptor.id);
    const declared = alertTypesOf(detector);
    /** Occurrences of this detector, or unowned ones of its domain (restored rows). */
    const owns = (alert: OpenAlert | undefined): alert is OpenAlert =>
      alert !== undefined && ownedBy(alert, descriptor);
    const alerts: DetectorAlerts = {
      raise: async (signal: DetectorAlertSignal): Promise<AlertOutcome> => {
        const methodId = signal.methodId ?? descriptor.methodIds[0];
        if (methodId === undefined) {
          throw new DetectorRegistrationError(
            `Detector ${descriptor.id} raised an alert without a methodId`,
          );
        }
        if (declared !== null && !declared.includes(signal.type)) {
          throw new AlertSignalError(
            `Detector ${descriptor.id} raised alert type "${signal.type}", which is not in its alertTypes (${declared.join(', ')})`,
          );
        }
        const outcome = await services.alerts.raise(descriptor.domain, {
          ...signal,
          methodId,
          detector: descriptor.id,
        });
        if (outcome === 'raised' || outcome === 'escalated') {
          this.metrics.alerts.inc({
            detector: descriptor.id,
            severity: signal.severity,
          });
        }
        return outcome;
      },
      // Ownership is checked in turn with the key's other operations, so a
      // raise of this detector that is still persisting is resolved too.
      // Restored occurrences without a domain or method id take the
      // detector's for their alert.resolved.v1.
      resolve: async (dedupKey, options = {}) => {
        const resolved = await services.alerts.resolve(dedupKey, {
          ...options,
          accept: owns,
          domain: descriptor.domain,
          methodId: descriptor.methodIds[0],
        });
        if (resolved) this.metrics.resolutions.inc({ detector: descriptor.id });
        return resolved;
      },
      forget: (dedupKey) => services.alerts.forget(dedupKey, { accept: owns }),
      get: (dedupKey) => {
        const alert = services.alerts.get(dedupKey);
        return owns(alert) ? alert : undefined;
      },
      isOpen: (dedupKey) => owns(services.alerts.get(dedupKey)),
      open: (filter = {}) => services.alerts.openAlerts(filter).filter(owns),
    };
    return {
      detector: descriptor,
      config,
      vessels: services.vessels,
      pairs: services.pairs,
      zones: services.zones,
      fleet: services.fleet,
      alerts,
      logger,
      now: services.clock,
      isActive: () => this.activeInstance,
    };
  }
}

/** `true` when `descriptor`'s alerts API sees the occurrence (its own, or unowned of its domain). */
function ownedBy(alert: OpenAlert, descriptor: DetectorDescriptor): boolean {
  if (alert.detector !== undefined) return alert.detector === descriptor.id;
  const domain =
    alert.domain ?? getAlertType(alert.type)?.domain ?? descriptor.domain;
  return domain === descriptor.domain;
}

/** Declared alert types of a detector, `null` when it declares none. */
function alertTypesOf(
  detector: AnyDetector | undefined,
): readonly AlertType[] | null {
  return detector?.alertTypes === undefined ? null : [...detector.alertTypes];
}

function nestLogger(detectorId: string): DetectorLogger {
  const logger = new Logger(`Detector:${detectorId}`);
  return {
    log: (message) => {
      logger.log(message);
    },
    warn: (message) => {
      logger.warn(message);
    },
    error: (message) => {
      logger.error(message);
    },
    debug: (message) => {
      logger.debug(message);
    },
  };
}

function validateDefinition(detector: AnyDetector): void {
  if (!DETECTOR_ID_PATTERN.test(detector.id)) {
    throw new DetectorRegistrationError(
      `Detector id "${detector.id}" must match ${String(DETECTOR_ID_PATTERN)} (env prefix ${detectorEnvPrefix(detector.id)})`,
    );
  }
  const domain: unknown = detector.domain;
  if (!isAlertDomain(domain)) {
    throw new DetectorRegistrationError(
      `Detector ${detector.id} has an unknown domain ${JSON.stringify(domain)}`,
    );
  }
  if (detector.methodIds.length === 0) {
    throw new DetectorRegistrationError(
      `Detector ${detector.id} must declare at least one method id (spec §17)`,
    );
  }
  for (const methodId of detector.methodIds) {
    if (!isCatalogId(methodId)) {
      throw new DetectorRegistrationError(
        `Detector ${detector.id} has an invalid method id ${JSON.stringify(methodId)}`,
      );
    }
  }
  for (const type of detector.alertTypes ?? []) {
    const definition = getAlertType(type);
    if (definition !== undefined && definition.domain !== detector.domain) {
      throw new DetectorRegistrationError(
        `Detector ${detector.id} (${detector.domain}) declares alert type "${type}" of domain ${definition.domain}`,
      );
    }
  }
  if (detector.tickIntervalMs !== undefined && !(detector.tickIntervalMs > 0)) {
    throw new DetectorRegistrationError(
      `Detector ${detector.id} has an invalid tickIntervalMs`,
    );
  }
}
