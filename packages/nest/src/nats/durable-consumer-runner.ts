import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AnyEventEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { Logger } from '@nestjs/common';
import type { ConsumerMessages, JsMsg } from '@nats-io/jetstream';
import { headers as natsHeaders } from '@nats-io/transport-node';

import { errorMessage } from '../common/retry.js';
import { KeyedSerialQueue, Semaphore } from '../common/semaphore.js';
import {
  type ConsumerEnsureOutcome,
  ensureDurableConsumer,
} from './consumer-config.js';
import { decideFailure, retryDelayMs } from './delivery-policy.js';
import type {
  DurableHandlerSettings,
  ExclusiveConsumerEvent,
  ExclusiveConsumerTransition,
} from './event-handler.decorator.js';
import { DLQ_HEADERS, headerValue } from './headers.js';
import {
  type BoundEventHandler,
  eventContextOf,
  invokeHandler,
  type LogContextRunner,
  readDelivery,
} from './message-processing.js';
import type { NatsClient } from './nats-client.js';
import type { ConsumeOutcome, NatsMetrics } from './nats.metrics.js';
import { isNoStreamError, type StreamManager } from './stream-manager.js';

/** What a consumer runner needs from the NATS module. */
export interface ConsumerRuntime {
  readonly client: NatsClient;
  readonly streams: StreamManager;
  readonly metrics: NatsMetrics;
  /** `SERVICE_NAME` (dead-letter headers). */
  readonly serviceName: string;
  readonly runInLogContext: LogContextRunner;
  /** Running durable consumers, for the readiness check (optional in tests). */
  readonly running?: Set<DurableConsumerRunner> | undefined;
}

/** Delay before re-establishing a consume loop that ended (or was closed on unpin), ms. */
const RESUBSCRIBE_DELAY_MS = 2000;

/** How long a pull request stays open on the server, ms (heartbeats every half). */
const PULL_EXPIRES_MS = 30_000;

/** Shortest pull expiry `@nats-io/jetstream` accepts, ms. */
const MIN_PULL_EXPIRES_MS = 1000;

/**
 * Exclusive consumers with a shorter `pinnedTtlMs` log a warning: their pull
 * expiry is clamped to 1 s, so fewer than three pulls renew the pin per TTL.
 */
const MIN_SAFE_PINNED_TTL_MS = 3000;

/** Header with the pin id on the messages of an exclusive consumer. */
const PIN_ID_HEADER = 'Nats-Pin-Id';

/** Longest interval of the pin watchdog of an exclusive consumer, ms. */
const MAX_WATCHDOG_INTERVAL_MS = 1000;

/**
 * Redelivery delay of a message an exclusive consumer returns unhandled
 * because, when its turn came, this instance was not (or no longer) the
 * confirmed active one, ms.
 */
export const RETURNED_MESSAGE_DELAY_MS = 1000;

/**
 * A consumer that has neither received a message nor a server heartbeat for
 * this long, or whose recovery keeps failing for this long, reports itself
 * unhealthy (readiness `nats`), ms.
 */
export const CONSUMER_STALL_THRESHOLD_MS = 2 * PULL_EXPIRES_MS;

/**
 * Expiry of the pull requests of a durable consumer, ms: 30 s, and for an
 * exclusive consumer a third of its pinned TTL (between 1 s and 30 s), so
 * an idle active instance renews its pin at least three times per TTL and
 * never loses it while idle. Idle heartbeats come every half expiry.
 */
export function pullExpiresMsFor(
  settings: Pick<DurableHandlerSettings, 'exclusive'>,
): number {
  if (settings.exclusive === undefined) return PULL_EXPIRES_MS;
  return Math.min(
    PULL_EXPIRES_MS,
    Math.max(
      MIN_PULL_EXPIRES_MS,
      Math.floor(settings.exclusive.pinnedTtlMs / 3),
    ),
  );
}

/** Idle heartbeat interval of the pull requests of a durable consumer, ms (half the pull expiry, at least 500 ms). */
export function idleHeartbeatMsFor(
  settings: Pick<DurableHandlerSettings, 'exclusive'>,
): number {
  return Math.max(500, Math.floor(pullExpiresMsFor(settings) / 2));
}

/**
 * How long an exclusive consumer instance may go without confirmed contact
 * with the server before the server may have pinned another instance, ms
 * (`undefined` for shared consumers): `max(2 × heartbeat, pinnedTtlMs −
 * expires − heartbeat)` with `expires` = {@link pullExpiresMsFor} and
 * `heartbeat` = {@link idleHeartbeatMsFor} — half the pinned TTL for TTLs of
 * 3 to 90 s (15 s at the default 30 s).
 *
 * The server unpins an instance `pinnedTtlMs` after the last pull carrying
 * its pin reached it. Every server message the instance receives (a
 * message, an idle heartbeat, the expiry notice of a pull) belongs to a
 * pull that is at most `expires` old, so the server cannot unpin the
 * instance before `pinnedTtlMs − expires − d` after that contact, `d` being
 * the transit time of the contact: deactivating after this bound is early
 * enough while `d` stays below one heartbeat interval (the safety margin,
 * 5 s at the default TTL). A healthy active instance hears from the server
 * at least every heartbeat interval, so it gives its pin up only after
 * missing about three heartbeats in a row. The same bound detects pauses of
 * the process (SIGSTOP, a blocked event loop). Below a TTL of 3 000 ms the
 * bound cannot be kept (the kit warns at start).
 */
export function pinContactTimeoutMsFor(
  settings: Pick<DurableHandlerSettings, 'exclusive'>,
): number | undefined {
  if (settings.exclusive === undefined) return undefined;
  const expires = pullExpiresMsFor(settings);
  const heartbeat = idleHeartbeatMsFor(settings);
  return Math.max(
    2 * heartbeat,
    settings.exclusive.pinnedTtlMs - expires - heartbeat,
  );
}

/** `true` for a subject with a `*` or `>` token. */
function hasWildcard(subject: string): boolean {
  return subject.split('.').some((token) => token === '*' || token === '>');
}

/**
 * The warning a consumer logs at start when `orderBySubject` (default
 * `true`) defeats its `concurrency`: every filter subject is literal, so
 * messages share at most that many subjects and run one subject at a time.
 * `undefined` when the settings are fine.
 */
export function orderingWarning(
  settings: Pick<
    DurableHandlerSettings,
    'concurrency' | 'orderBySubject' | 'definition'
  >,
): string | undefined {
  const { concurrency, orderBySubject, definition } = settings;
  if (!orderBySubject || concurrency <= 1) return undefined;
  const filters = [...new Set(definition.filterSubjects)];
  if (filters.length === 0 || filters.some(hasWildcard)) return undefined;
  if (filters.length === 1)
    return `concurrency ${concurrency} has no effect: all messages share a subject; set orderBySubject: false`;
  if (filters.length >= concurrency) return undefined;
  return (
    `concurrency ${concurrency} is limited to ${filters.length}: all messages share ${filters.length} subjects; ` +
    'set orderBySubject: false'
  );
}

/**
 * Role of a durable consumer instance:
 *
 * - `shared` — not exclusive: every instance receives messages;
 * - `starting` — exclusive, not pinned yet (a hot standby that was never
 *   active stays here);
 * - `active` — exclusive and pinned: this instance receives the messages;
 * - `standby` — exclusive and unpinned: another instance took over.
 */
export type ConsumerState = 'starting' | 'active' | 'standby' | 'shared';

/** Liveness of a running durable consumer (readiness and diagnostics). */
export interface ConsumerHealth {
  readonly name: string;
  readonly stream: string;
  /** `false` when the consumer stalled or cannot be recovered. */
  readonly healthy: boolean;
  /** `true` while an exclusive consumer is a standby of another instance (`state === 'standby'`). */
  readonly standby: boolean;
  /** Role of this instance (see {@link ConsumerState}). */
  readonly state: ConsumerState;
  /** Last message, server heartbeat or pull. */
  readonly lastActivityAt: Date | undefined;
  /** Start of the current failure streak (missing consumer, failed recovery). */
  readonly failingSince: Date | undefined;
  readonly lastError: string | undefined;
}

/** Hooks of an exclusive {@link DurableConsumerRunner} (see `ExclusiveConsumerListener`). */
export interface DurableConsumerRunnerOptions {
  /**
   * Runs when this instance becomes the active one — also again, for the
   * same pin, when the server confirms the pin after a pause of the process
   * (`previous === pinId`); dispatch of the message that revealed the pin
   * and of every later one waits until it settles. A rejection naks those
   * messages with backoff and the hook runs again on the next message.
   */
  readonly onActivated?:
    ((event: ExclusiveConsumerEvent) => void | Promise<void>) | undefined;
  /**
   * Runs when another instance took over, when this instance gave its pin up
   * (`contact_lost`, `paused`) — after the handlers of the ended period
   * settled — and on a graceful stop (before the pin is released). Errors
   * are logged and ignored.
   */
  readonly onDeactivated?:
    ((event: ExclusiveConsumerEvent) => void | Promise<void>) | undefined;
  /**
   * Called synchronously whenever {@link DurableConsumerRunner.state}
   * changes, before any hook runs: e.g. to stop the timers of the active
   * instance at once (`onDeactivated` waits for the handlers of the ended
   * period). Errors are logged and ignored.
   */
  readonly onStateChange?: ((state: ConsumerState) => void) | undefined;
  /** Monotonic clock, ms (tests). Default `performance.now()`. */
  readonly clock?: (() => number) | undefined;
}

/** What a received message of an exclusive consumer may be dispatched under. */
interface DispatchTicket {
  /** Its `Nats-Pin-Id`. */
  readonly pinId: string;
  /** The runner's epoch when it arrived. */
  readonly epoch: number;
}

/** The `pinned_client_id` of `group` in a consumer info (NATS ≥ 2.11). */
function pinnedClientId(info: unknown, group: string): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  const groups: unknown = Reflect.get(info, 'priority_groups');
  if (!Array.isArray(groups)) return undefined;
  for (const entry of groups as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    if (Reflect.get(entry, 'group') !== group) continue;
    const id: unknown = Reflect.get(entry, 'pinned_client_id');
    return typeof id === 'string' && id !== '' ? id : undefined;
  }
  return undefined;
}

/**
 * Runs one durable pull consumer (spec §7.1): ensures its stream (created
 * when missing, never changed: only producers update streams), the DLQ
 * stream and the consumer, then pulls and dispatches messages with bounded
 * concurrency (per-subject order kept), applies the ack / nak-with-backoff /
 * term / dead-letter policy, and stops gracefully.
 *
 * Every received message is heartbeated (`working()` every `ackWaitMs / 3`)
 * from its arrival until it is settled; the server's `max_ack_pending`
 * bounds how many wait in the process. The consumer's status is watched: a
 * deleted or missing consumer (or stream) is recreated, and {@link health}
 * reports a stall to the readiness check.
 *
 * Exclusive consumers (pinned client) track their {@link ConsumerState}
 * from the messages' `Nats-Pin-Id`: a new pin activates the instance
 * (`onActivated` gates dispatch), losing it re-subscribes at once as a
 * standby (`onDeactivated`), and a graceful stop releases the pin so a
 * standby takes over without waiting for the pinned TTL. A message is
 * dispatched only while this instance is the confirmed active one for its
 * pin, in the period it arrived in; otherwise it is returned for
 * redelivery (`nak`, outcome `returned`). Two situations make an active
 * instance give its pin up although no unpin notice arrived (bound:
 * {@link pinContactTimeoutMsFor}): no confirmed contact with the server for
 * that long (cut off from NATS: `contact_lost`, it subscribes afresh and is
 * activated again only by a new pin), and a pause of the process that long
 * (`paused`: what it buffered is returned, and the server is asked whether
 * it still pins this instance before it activates again).
 */
export class DurableConsumerRunner {
  private readonly logger: Logger;
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly slots: Semaphore;
  private readonly queue = new KeyedSerialQueue();
  private readonly clock: () => number;
  /** {@link pinContactTimeoutMsFor}; `undefined` for shared consumers. */
  private readonly contactTimeoutMs: number | undefined;
  private messages: ConsumerMessages | undefined;
  private supervisor: Promise<void> | undefined;
  private recovering: Promise<void> | undefined;
  private stopping = false;
  private currentState: ConsumerState;
  /** Last time this runner's code ran (monotonic ms); a longer silence is a pause of the process. */
  private lastRunAt: number;
  /** Last confirmed contact with the server (monotonic ms). */
  private lastContactAt: number | undefined;
  /** Changes with every role change: a message is dispatched only in the period it arrived in. */
  private epoch = 0;
  /** After a pause: nothing activates until the server confirmed the pin. */
  private confirming = false;
  /** Identifies the current pin check (a newer pause or an unpin supersedes it). */
  private checkGeneration = 0;
  /** Latest pin id seen on a message while confirming. */
  private seenPinId: string | undefined;
  /** A pin given up after a contact loss: released once the server answers, if it still holds it. */
  private abandonedPinId: string | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  /** Last `Nats-Pin-Id` seen on a message (exclusive consumers). */
  private pinId: string | undefined;
  /** Pin id of the period that ended last: its late messages never re-activate. */
  private lostPinId: string | undefined;
  /** `previous` of the current activation (kept for its retries). */
  private activationPrevious: string | undefined;
  /** The current activation gate; rejected when its hook failed. */
  private activation: Promise<void> | undefined;
  private activationFailed = false;
  /** Hooks run one at a time, in order. */
  private hookTail: Promise<void> = Promise.resolve();
  private pendingHooks = 0;
  /** Set when the consume loop was closed on purpose (unpinned). */
  private closedBecause: string | undefined;
  private lastActivityAt: number | undefined;
  private failingSince: number | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly runtime: ConsumerRuntime,
    readonly settings: DurableHandlerSettings,
    private readonly handler: BoundEventHandler,
    /** `Class.method` of the handler, for logs. */
    readonly handlerName: string,
    private readonly options: DurableConsumerRunnerOptions = {},
  ) {
    this.logger = new Logger(`Consumer:${settings.definition.durableName}`);
    this.slots = new Semaphore(settings.concurrency);
    this.currentState =
      settings.exclusive === undefined ? 'shared' : 'starting';
    this.clock = options.clock ?? (() => performance.now());
    this.contactTimeoutMs = pinContactTimeoutMsFor(settings);
    this.lastRunAt = this.clock();
  }

  /** Durable consumer name. */
  get name(): string {
    return this.settings.definition.durableName;
  }

  /** Role of this instance (see {@link ConsumerState}). */
  get state(): ConsumerState {
    return this.currentState;
  }

  /** Ensures the streams and the consumer and starts consuming. */
  async start(): Promise<void> {
    const { definition, exclusive } = this.settings;
    const warning = orderingWarning(this.settings);
    if (warning !== undefined)
      this.logger.warn(`${this.handlerName}: ${warning}`);
    if (
      exclusive !== undefined &&
      exclusive.pinnedTtlMs < MIN_SAFE_PINNED_TTL_MS
    ) {
      this.logger.warn(
        `pinnedTtlMs ${exclusive.pinnedTtlMs} is below ${MIN_SAFE_PINNED_TTL_MS} ms: ` +
          'the pin may be lost while idle (pulls renew it every 1 s at most)',
      );
    }
    await this.runtime.streams.ensure([definition.stream, 'DLQ'], 'consumer');
    await this.ensureConsumer();
    this.messages = await this.subscribe();
    this.lastRunAt = this.clock();
    this.supervisor = this.supervise(this.messages);
    this.runtime.running?.add(this);
    this.startWatchdog();
    this.logger.log(
      `Consuming ${definition.stream} ${definition.filterSubjects.join(',')} with ${this.handlerName} ` +
        `(concurrency ${this.settings.concurrency}, maxDeliver ${this.settings.maxDeliver}` +
        `${
          exclusive === undefined
            ? ''
            : `, exclusive, pinned TTL ${exclusive.pinnedTtlMs} ms, pin given up after ${this.contactTimeoutMs} ms without server contact`
        })`,
    );
  }

  /**
   * Stops pulling, waits up to `timeoutMs` for in-flight handlers (then
   * aborts their `signal`), and naks messages received but not started.
   * An exclusive consumer then runs `onDeactivated` and, if this instance
   * still holds the pin, releases it so a standby takes over at once.
   */
  async stop(timeoutMs: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.watchdog);
    this.checkGeneration += 1;
    this.runtime.running?.delete(this);
    await this.messages?.close().catch(() => undefined);
    const settled = Promise.allSettled([...this.inFlight]).then(
      () => 'settled' as const,
    );
    const deadline = sleep(timeoutMs, 'timeout' as const, { ref: false });
    if ((await Promise.race([settled, deadline])) === 'timeout') {
      this.logger.warn(
        `${this.inFlight.size} handler(s) still running after ${timeoutMs} ms: aborting`,
      );
      this.abort.abort();
      await Promise.race([settled, sleep(1000, undefined, { ref: false })]);
    }
    await this.supervisor?.catch(() => undefined);
    if (this.settings.exclusive === undefined) return;
    await Promise.race([
      this.deactivate('stopped'),
      sleep(timeoutMs, undefined, { ref: false }),
    ]);
    await this.releasePin();
  }

  /** Liveness of the consumer (see {@link CONSUMER_STALL_THRESHOLD_MS}). */
  health(now: number = Date.now()): ConsumerHealth {
    const stalled =
      this.lastActivityAt === undefined ||
      now - this.lastActivityAt > CONSUMER_STALL_THRESHOLD_MS;
    const failing =
      this.failingSince !== undefined &&
      now - this.failingSince > CONSUMER_STALL_THRESHOLD_MS;
    return {
      name: this.name,
      stream: this.settings.definition.stream,
      healthy: !this.stopping && !stalled && !failing,
      standby: this.currentState === 'standby',
      state: this.currentState,
      lastActivityAt:
        this.lastActivityAt === undefined
          ? undefined
          : new Date(this.lastActivityAt),
      failingSince:
        this.failingSince === undefined
          ? undefined
          : new Date(this.failingSince),
      lastError: this.lastError,
    };
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private fail(error: string): void {
    this.failingSince ??= Date.now();
    this.lastError = error;
  }

  private recovered(): void {
    this.failingSince = undefined;
    this.lastError = undefined;
  }

  /** Creates the consumer, or updates its drifted settings. */
  private async ensureConsumer(): Promise<ConsumerEnsureOutcome> {
    const { manager } = await this.runtime.client.ready();
    const { outcome, drift } = await ensureDurableConsumer(
      manager,
      this.settings,
    );
    if (outcome !== 'unchanged') {
      this.logger.log(
        `Consumer ${outcome}${drift.length > 0 ? ` (${drift.join(', ')})` : ''}`,
      );
    }
    return outcome;
  }

  private async subscribe(): Promise<ConsumerMessages> {
    const { jetstream } = await this.runtime.client.ready();
    const { stream, durableName } = this.settings.definition;
    const consumer = await jetstream.consumers.get(stream, durableName);
    const messages = await consumer.consume({
      max_messages: this.settings.maxAckPending,
      expires: pullExpiresMsFor(this.settings),
      idle_heartbeat: idleHeartbeatMsFor(this.settings),
      ...(this.settings.exclusive === undefined
        ? {}
        : { group: this.settings.exclusive.group }),
    });
    this.touch();
    void this.watchStatus(messages);
    return messages;
  }

  /** Reacts to the consume loop's notifications (missing consumer, heartbeats, pinning). */
  private async watchStatus(messages: ConsumerMessages): Promise<void> {
    try {
      for await (const status of messages.status()) {
        if (status.type === 'heartbeat' || status.type === 'next') {
          this.touch();
          // `next` is this client's own pull: no news from the server.
          if (status.type === 'heartbeat') this.serverContact();
        } else if (
          status.type === 'discard' ||
          status.type === 'debug' ||
          status.type === 'exceeded_limits' ||
          status.type === 'flow_control'
        ) {
          // Status replies of the server to this consumer's pulls (e.g. 408 expiry).
          this.serverContact();
        } else if (
          status.type === 'consumer_deleted' ||
          status.type === 'consumer_not_found' ||
          status.type === 'stream_not_found'
        ) {
          this.fail(status.type.replaceAll('_', ' '));
          this.recover(status.type);
        } else if (status.type === 'heartbeats_missed') {
          this.logger.warn(
            `Missed ${status.count} heartbeat(s) from the server`,
          );
        } else if (status.type === 'consumer_pinned') {
          this.touch();
          this.serverContact();
          if (this.settings.exclusive !== undefined) this.observePin(status.id);
        } else if (status.type === 'consumer_unpinned') {
          this.touch();
          this.noteRun();
          this.onUnpinned(messages);
        }
        // Other notifications (flow control, discards, debug) need no action.
      }
    } catch {
      // The status iterator ends with the consume loop.
    }
  }

  /**
   * The server unpinned this instance: it becomes a standby. `@nats-io/jetstream`
   * clears its pin id without pulling again, so the consume loop is closed
   * and `supervise()` re-subscribes with a fresh pull (no stale pin id).
   */
  private onUnpinned(messages: ConsumerMessages): void {
    if (this.currentState !== 'standby')
      this.logger.log('Another instance is active: standing by');
    // The server said so: a pin check after a pause is moot.
    this.checkGeneration += 1;
    this.confirming = false;
    this.seenPinId = undefined;
    void this.deactivate('unpinned');
    this.setState('standby');
    if (this.isStopping()) return;
    this.closedBecause = 'unpinned';
    void messages.close().catch(() => undefined);
  }

  /** Notes the pin of a message: a new pin activates this instance (after a pause: once confirmed). */
  private observePin(pinId: string): void {
    if (pinId === '' || pinId === this.lostPinId) return;
    if (this.confirming) {
      this.seenPinId = pinId;
      return;
    }
    if (
      pinId === this.pinId &&
      this.currentState === 'active' &&
      !this.activationFailed
    )
      return;
    this.activate(pinId);
  }

  /** Changes the role; `onStateChange` hears of it before any hook runs. */
  private setState(state: ConsumerState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    try {
      this.options.onStateChange?.(state);
    } catch (error) {
      this.logger.warn(`State listener failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Notes that this runner's code runs now. A silence longer than the pin
   * bound means the process did not run (SIGSTOP, a blocked event loop):
   * what arrives now may have waited in buffers since before the pin could
   * have moved, so {@link onPaused} runs before it is looked at.
   */
  private noteRun(): void {
    const bound = this.contactTimeoutMs;
    if (bound === undefined) return;
    const now = this.clock();
    const silence = now - this.lastRunAt;
    this.lastRunAt = now;
    if (silence > bound) this.onPaused(Math.round(silence));
  }

  /** A message, heartbeat or status reply of the server arrived (exclusive consumers). */
  private serverContact(): void {
    if (this.contactTimeoutMs === undefined) return;
    this.noteRun();
    this.lastContactAt = this.clock();
  }

  /**
   * Watches the pin of an exclusive consumer: detects pauses of the process
   * between messages and, on an active instance, the loss of contact with
   * the server (see {@link pinContactTimeoutMsFor}).
   */
  private startWatchdog(): void {
    const bound = this.contactTimeoutMs;
    if (bound === undefined) return;
    const interval = Math.max(
      50,
      Math.min(MAX_WATCHDOG_INTERVAL_MS, Math.floor(bound / 4)),
    );
    this.watchdog = setInterval(() => {
      this.noteRun();
      // I/O that waited while timers lagged (messages, heartbeats) goes first.
      setImmediate(() => {
        this.checkContact();
      });
    }, interval);
    this.watchdog.unref();
  }

  private checkContact(): void {
    const bound = this.contactTimeoutMs;
    if (
      bound === undefined ||
      this.isStopping() ||
      this.confirming ||
      this.currentState !== 'active'
    )
      return;
    const silence = this.clock() - (this.lastContactAt ?? this.lastRunAt);
    if (silence > bound) this.onContactLost(Math.round(silence));
  }

  /**
   * No confirmed contact with the server for longer than the pin bound
   * while active (cut off from NATS): the server may pin another instance
   * from now on. This instance deactivates (`contact_lost`), stops pulling
   * with its pin and subscribes afresh, so it becomes active again only
   * through a new pin; the old pin is released once the server answers, if
   * it still holds it.
   */
  private onContactLost(silenceMs: number): void {
    this.logger.warn(
      `No contact with the NATS server for ${silenceMs} ms (bound ${this.contactTimeoutMs} ms): another instance ` +
        'may be pinned now; deactivating and subscribing afresh as a standby',
    );
    this.abandonedPinId = this.pinId;
    void this.deactivate('contact_lost');
    this.abandonSubscription('contact lost');
  }

  /**
   * The process did not run for longer than the pin bound (SIGSTOP, a
   * blocked event loop): the server may have moved the pin meanwhile, and
   * what was buffered (messages under the old pin, heartbeats) proves
   * nothing. An active instance deactivates (`paused`); messages that
   * arrived before and until the pin is confirmed are returned for
   * redelivery; then the server is asked which instance it pins. If it is
   * this one (its pin, or a new pin seen since), it activates again — its
   * activation hook reloads the state before any message is dispatched —,
   * otherwise it subscribes afresh as a standby.
   */
  private onPaused(silenceMs: number): void {
    if (this.isStopping()) return;
    this.epoch += 1;
    const active = this.currentState === 'active';
    const activePin = active ? this.pinId : undefined;
    this.logger.warn(
      `This process did not run for ${silenceMs} ms (paused or blocked event loop; bound ${this.contactTimeoutMs} ms): ` +
        `messages received so far are returned for redelivery${active ? ', deactivating' : ''} until the server confirms the pin`,
    );
    this.confirming = true;
    this.seenPinId = undefined;
    this.checkGeneration += 1;
    if (active) void this.deactivate('paused');
    void this.checkPin(this.checkGeneration, activePin);
  }

  /** After a pause: activates again if the server still (or newly) pins this instance. */
  private async checkPin(
    generation: number,
    activePin: string | undefined,
  ): Promise<void> {
    const { exclusive, definition } = this.settings;
    if (exclusive === undefined) return;
    let pinned: string | undefined;
    let answered = true;
    try {
      const { manager } = await this.runtime.client.ready();
      const info = await manager.consumers.info(
        definition.stream,
        definition.durableName,
      );
      pinned = pinnedClientId(info, exclusive.group);
    } catch (error) {
      answered = false;
      this.logger.warn(
        `Checking the pin after the pause failed: ${errorMessage(error)}`,
      );
    }
    // The messages that arrived together with the answer are looked at first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.isStopping() || generation !== this.checkGeneration) return;
    this.confirming = false;
    const candidate = this.seenPinId ?? activePin;
    this.seenPinId = undefined;
    if (answered && candidate !== undefined && pinned === candidate) {
      this.logger.log(
        `The server still pins this instance (pin ${candidate}): activating again`,
      );
      if (this.lostPinId === candidate) this.lostPinId = undefined;
      this.activate(candidate);
      return;
    }
    // Nothing was pinned here (a standby that saw no pin): nothing to give up.
    if (candidate === undefined) return;
    this.lostPinId = candidate;
    this.logger.log(
      answered
        ? `The server pins ${pinned === undefined ? 'no instance' : 'another instance'} now: subscribing afresh as a standby`
        : 'The pin could not be confirmed: subscribing afresh as a standby',
    );
    this.abandonSubscription('paused');
  }

  /** Closes the consume loop so that `supervise()` subscribes afresh (no stale pin id in the pulls). */
  private abandonSubscription(reason: string): void {
    if (this.isStopping()) return;
    this.closedBecause = reason;
    void this.messages?.close().catch(() => undefined);
  }

  /**
   * `true` while a message that arrived with `ticket` may be dispatched:
   * this instance is the confirmed active one for its pin, in the period it
   * arrived in.
   */
  private mayDispatch(ticket: DispatchTicket): boolean {
    return (
      !this.confirming &&
      this.currentState === 'active' &&
      ticket.epoch === this.epoch &&
      ticket.pinId === this.pinId
    );
  }

  /**
   * Makes this instance the active one for `pinId` and runs `onActivated`
   * (after any pending hook); messages arriving from now on wait for it.
   * A retry after a failed hook keeps the first attempt's `previous`.
   */
  private activate(pinId: string): void {
    const retry = this.activationFailed && pinId === this.pinId;
    if (!retry) {
      this.activationPrevious = this.pinId;
      this.pinId = pinId;
      this.lostPinId = undefined;
      this.epoch += 1;
      this.lastContactAt = this.clock();
      if (this.currentState !== 'active')
        this.logger.log('Became the active instance of the consumer');
      this.setState('active');
      this.runtime.metrics.consumerActivations.inc({ consumer: this.name });
    }
    this.activationFailed = false;
    const hook = this.options.onActivated;
    if (hook === undefined && this.pendingHooks === 0) {
      this.activation = undefined;
      return;
    }
    const event = this.transition(pinId, this.activationPrevious, 'pinned');
    const activation = this.chainHook(async () => {
      await hook?.(event);
    });
    this.activation = activation;
    activation.then(
      () => {
        if (this.activation === activation) this.activation = undefined;
      },
      (error: unknown) => {
        if (this.activation !== activation) return;
        this.activationFailed = true;
        this.logger.error(
          `Activation hook failed (pin ${pinId}): ${errorMessage(error)}; ` +
            'its messages are redelivered and the hook runs again on the next message',
        );
      },
    );
  }

  /**
   * Ends the active period of this instance: `onDeactivated` runs after the
   * handlers of the period (or of the stop) settled; messages of the period
   * not dispatched yet are returned. No-op when this instance is not active.
   */
  private deactivate(
    reason: Exclude<ExclusiveConsumerTransition, 'pinned'>,
  ): Promise<void> {
    if (this.currentState !== 'active') return Promise.resolve();
    const pinId = this.pinId;
    this.lostPinId = pinId;
    this.epoch += 1;
    this.setState('standby');
    this.activation = undefined;
    this.activationFailed = false;
    const hook = this.options.onDeactivated;
    if (hook === undefined) return Promise.resolve();
    const event = this.transition(pinId, this.activationPrevious, reason);
    const ended = [...this.inFlight];
    return this.chainHook(async () => {
      await Promise.allSettled(ended);
      try {
        await hook(event);
      } catch (error) {
        this.logger.warn(
          `Deactivation hook failed (${reason}): ${errorMessage(error)}`,
        );
      }
    });
  }

  private transition(
    pinId: string | undefined,
    previous: string | undefined,
    reason: ExclusiveConsumerTransition,
  ): ExclusiveConsumerEvent {
    return {
      consumer: this.name,
      stream: this.settings.definition.stream,
      pinId,
      previous,
      reason,
    };
  }

  /** Runs `fn` after every hook queued before it. */
  private chainHook(fn: () => Promise<void>): Promise<void> {
    this.pendingHooks += 1;
    const run = this.hookTail.then(fn);
    this.hookTail = run
      .catch(() => undefined)
      .then(() => {
        this.pendingHooks -= 1;
      });
    return run;
  }

  /**
   * Releases the pin on a graceful stop when this instance still holds it
   * (the server's `pinned_client_id` is the last pin id seen here), so a
   * standby is pinned at once; a stale instance never unpins the active
   * one. Failures (NATS < 2.11, connection lost) are ignored.
   */
  private async releasePin(pinId = this.pinId): Promise<boolean> {
    const { exclusive, definition } = this.settings;
    if (exclusive === undefined || pinId === undefined) return true;
    try {
      const { manager } = await this.runtime.client.ready();
      const info = await manager.consumers.info(
        definition.stream,
        definition.durableName,
      );
      const pinned = pinnedClientId(info, exclusive.group);
      if (pinned !== pinId) {
        this.logger.debug(
          `Not releasing the pin: held by ${pinned ?? 'no instance'}, not this one`,
        );
        return true;
      }
      await manager.consumers.unpin(
        definition.stream,
        definition.durableName,
        exclusive.group,
      );
      this.logger.log('Released the pin: a standby takes over now');
      return true;
    } catch (error) {
      this.logger.debug(
        `Releasing the pin failed (ignored): ${errorMessage(error)}`,
      );
      return false;
    }
  }

  /** Recreates a missing stream or consumer (single flight); the consume loop resumes by itself. */
  private recover(reason: string): void {
    if (this.recovering !== undefined || this.isStopping()) return;
    this.recovering = (async () => {
      try {
        // refresh: a stream deleted at runtime is re-created (never updated).
        await this.runtime.streams.ensure(
          [this.settings.definition.stream, 'DLQ'],
          'consumer',
          { refresh: true },
        );
        const outcome = await this.ensureConsumer();
        this.runtime.metrics.consumerRecoveries.inc({
          stream: this.settings.definition.stream,
          consumer: this.name,
          outcome: outcome === 'created' ? 'recreated' : 'checked',
        });
        this.logger.warn(
          outcome === 'created'
            ? `Consumer was missing (${reason}) and has been recreated`
            : `Consumer reported ${reason}; it exists, consuming resumes`,
        );
        this.recovered();
        // Pull requests of the old consumer are gone: re-subscribe now rather
        // than after two missed heartbeats.
        if (outcome === 'created') await this.messages?.close();
      } catch (error) {
        this.runtime.metrics.consumerRecoveries.inc({
          stream: this.settings.definition.stream,
          consumer: this.name,
          outcome: 'failed',
        });
        this.fail(errorMessage(error));
        this.logger.error(
          `Recovering the consumer (${reason}) failed: ${errorMessage(error)}`,
        );
      } finally {
        this.recovering = undefined;
      }
    })();
  }

  /** Read through a method: the flag changes while loops await. */
  private isStopping(): boolean {
    return this.stopping;
  }

  /** Runs the consume loop and re-subscribes if it ends while not stopping. */
  private async supervise(initial: ConsumerMessages): Promise<void> {
    let messages: ConsumerMessages | undefined = initial;
    while (!this.isStopping()) {
      if (messages !== undefined) {
        try {
          await this.consume(messages);
        } catch (error) {
          if (!this.isStopping()) {
            this.fail(errorMessage(error));
            this.logger.error(`Consume loop failed: ${errorMessage(error)}`);
          }
        }
      }
      if (this.isStopping()) break;
      await sleep(RESUBSCRIBE_DELAY_MS, undefined, { ref: false });
      if (this.isStopping()) break;
      const reason = this.closedBecause;
      this.closedBecause = undefined;
      try {
        // A pin given up after a contact loss: let the server pin anew at once.
        if (
          this.abandonedPinId !== undefined &&
          (await this.releasePin(this.abandonedPinId))
        )
          this.abandonedPinId = undefined;
        await this.ensureConsumer();
        messages = await this.subscribe();
        this.messages = messages;
        this.recovered();
        if (reason === undefined)
          this.logger.warn('Consume loop re-established');
        else this.logger.log(`Re-subscribed (${reason}): waiting as a standby`);
      } catch (error) {
        messages = undefined;
        this.fail(errorMessage(error));
        this.logger.error(`Re-subscribing failed: ${errorMessage(error)}`);
      }
    }
  }

  /**
   * Drains the client buffer eagerly: each message is heartbeated from its
   * arrival and waits in the process (bounded by `max_ack_pending`) for its
   * subject's turn and a handler slot. A message of an exclusive consumer
   * also waits for the activation hook of its pin, and is returned instead
   * of dispatched when this instance is no longer the confirmed active one
   * for it by then.
   */
  private async consume(messages: ConsumerMessages): Promise<void> {
    const ordered =
      this.settings.orderBySubject && this.settings.concurrency > 1;
    const exclusive = this.settings.exclusive !== undefined;
    for await (const message of messages) {
      this.touch();
      if (this.isStopping()) {
        message.nak();
        continue;
      }
      let ticket: DispatchTicket | undefined;
      if (exclusive) {
        this.serverContact();
        const pinId = message.headers?.get(PIN_ID_HEADER) ?? '';
        if (pinId !== '') {
          this.observePin(pinId);
          ticket = { pinId, epoch: this.epoch };
        }
      }
      const gate = this.activation;
      const heartbeat = this.startHeartbeat(message);
      const work = async (): Promise<void> => {
        await this.slots.acquire();
        try {
          if (this.isStopping()) message.nak();
          else await this.handle(message, gate, ticket);
        } finally {
          this.slots.release();
          clearInterval(heartbeat);
        }
      };
      // Concurrency 1 keeps stream order through the FIFO semaphore.
      const task = ordered ? this.queue.run(message.subject, work) : work();
      this.inFlight.add(task);
      void task.finally(() => this.inFlight.delete(task));
    }
  }

  /** Keeps the message's ack deadline moving while it waits or runs. */
  private startHeartbeat(message: JsMsg): NodeJS.Timeout {
    const interval = Math.max(100, Math.floor(this.settings.ackWaitMs / 3));
    const timer = setInterval(() => {
      message.working();
    }, interval);
    timer.unref();
    return timer;
  }

  /** Handles one message; never throws. */
  private async handle(
    message: JsMsg,
    gate: Promise<void> | undefined,
    ticket: DispatchTicket | undefined,
  ): Promise<void> {
    const { definition } = this.settings;
    const labels = {
      stream: definition.stream,
      consumer: definition.durableName,
    };
    if (ticket !== undefined && !this.mayDispatch(ticket)) {
      const outcome = await this.returnMessage(message);
      this.runtime.metrics.consumed.inc({ ...labels, outcome });
      return;
    }
    if (gate !== undefined) {
      try {
        await gate;
      } catch (error) {
        const outcome = await this.settleGateFailure(message, error);
        this.runtime.metrics.consumed.inc({ ...labels, outcome });
        return;
      }
      // The role may have changed while the activation hook ran.
      if (ticket !== undefined && !this.mayDispatch(ticket)) {
        const outcome = await this.returnMessage(message);
        this.runtime.metrics.consumed.inc({ ...labels, outcome });
        return;
      }
    }
    const startedAt = performance.now();
    let outcome: ConsumeOutcome;
    try {
      outcome = await this.dispatch(message);
    } catch (error) {
      // Only reached if acknowledging itself failed (connection lost).
      this.logger.error(
        `Message ${message.seq} could not be settled: ${errorMessage(error)}`,
      );
      outcome = 'nak';
    }
    this.runtime.metrics.consumed.inc({ ...labels, outcome });
    this.runtime.metrics.handlerDuration.observe(
      { ...labels, outcome },
      (performance.now() - startedAt) / 1000,
    );
  }

  private async dispatch(message: JsMsg): Promise<ConsumeOutcome> {
    const { definition } = this.settings;
    const delivery = readDelivery(message, definition.eventTypes);
    if (delivery.kind === 'invalid') {
      this.runtime.metrics.invalid.inc({
        stream: definition.stream,
        consumer: definition.durableName,
        reason: delivery.failure.reason,
      });
      this.logger.warn(
        `Terminating invalid message ${message.seq} on ${message.subject}: ${delivery.failure.message}`,
      );
      message.term(
        headerValue(`${delivery.failure.reason}: ${delivery.failure.message}`),
      );
      return 'invalid';
    }
    if (delivery.kind === 'skipped') {
      this.logger.warn(
        `Skipping message ${message.seq} on ${message.subject}: ${delivery.reason}`,
      );
      message.ack();
      return 'skipped';
    }

    const context = eventContextOf(
      message,
      definition.durableName,
      this.abort.signal,
    );
    try {
      await invokeHandler(
        this.handler,
        delivery.envelope,
        context,
        this.runtime.runInLogContext,
      );
    } catch (error) {
      return this.settleFailure(message, delivery.envelope, error);
    }
    message.ack();
    return 'ack';
  }

  /**
   * Returns a message of an exclusive consumer unhandled: this instance was
   * not the confirmed active one for it when its turn came (another
   * instance took over, the pin was given up, or a pause left it
   * unconfirmed). `nak` after {@link RETURNED_MESSAGE_DELAY_MS}, outcome
   * `returned` (not a handler failure); on its last delivery, where the
   * server would drop a nak'd message, it is dead-lettered instead.
   */
  private async returnMessage(message: JsMsg): Promise<ConsumeOutcome> {
    const deliveryCount = message.info.deliveryCount;
    if (deliveryCount >= this.settings.maxDeliver) {
      const reason =
        'returned unhandled on its last delivery: this instance was not the confirmed active one';
      try {
        await this.deadLetter(message, new Error(reason));
        message.ack();
        this.logger.error(
          `Dead-lettered message ${message.seq} on ${message.subject} (delivery ${deliveryCount}/${this.settings.maxDeliver}): ${reason}`,
        );
        return 'dead_letter';
      } catch (error) {
        this.logger.error(
          `Dead-lettering returned message ${message.seq} failed: ${errorMessage(error)}`,
        );
      }
    }
    this.logger.debug(
      `Returning message ${message.seq} on ${message.subject} for redelivery: not the confirmed active instance`,
    );
    try {
      message.nak(RETURNED_MESSAGE_DELAY_MS);
    } catch {
      // Connection lost: the server redelivers after ack_wait.
    }
    return 'returned';
  }

  /**
   * Settles a message whose activation hook failed: nak with backoff (the
   * hook runs again before the redelivery is handled); on its last
   * delivery, dead-letter it instead of letting the server drop it.
   */
  private async settleGateFailure(
    message: JsMsg,
    error: unknown,
  ): Promise<ConsumeOutcome> {
    const { maxDeliver, backoffMs } = this.settings;
    const deliveryCount = message.info.deliveryCount;
    try {
      if (deliveryCount < maxDeliver) {
        message.nak(retryDelayMs(deliveryCount, backoffMs));
        return 'nak';
      }
      await this.deadLetter(message, error);
      this.logger.error(
        `Dead-lettered message ${message.seq} on ${message.subject} (delivery ${deliveryCount}/${maxDeliver}): ` +
          `the activation hook kept failing: ${errorMessage(error)}`,
      );
      message.ack();
      return 'dead_letter';
    } catch (settleError) {
      this.logger.error(
        `Message ${message.seq} could not be settled: ${errorMessage(settleError)}`,
      );
      try {
        message.nak(retryDelayMs(deliveryCount, backoffMs));
      } catch {
        // Connection lost: the server redelivers after ack_wait.
      }
      return 'nak';
    }
  }

  private async settleFailure(
    message: JsMsg,
    envelope: AnyEventEnvelope,
    error: unknown,
  ): Promise<ConsumeOutcome> {
    const { maxDeliver, backoffMs } = this.settings;
    const deliveryCount = message.info.deliveryCount;
    const decision = decideFailure(error, deliveryCount, {
      maxDeliver,
      backoffMs,
    });
    const what = `${envelope.type} ${envelope.id} (delivery ${deliveryCount}/${maxDeliver})`;
    switch (decision.action) {
      case 'term':
        this.logger.warn(`Terminating ${what}: ${errorMessage(error)}`);
        message.term(headerValue(errorMessage(error)));
        return 'term';
      case 'nak':
        this.logger.warn(
          `Handler failed for ${what}, retrying in ${decision.delayMs} ms: ${errorMessage(error)}`,
        );
        message.nak(decision.delayMs);
        return 'nak';
      case 'dead_letter':
        try {
          await this.deadLetter(message, error);
        } catch (dlqError) {
          this.logger.error(
            `Dead-lettering ${what} failed, retrying: ${errorMessage(dlqError)}`,
          );
          message.nak(retryDelayMs(deliveryCount, backoffMs));
          return 'nak';
        }
        this.logger.error(
          `Dead-lettered ${what} to ${subjects.dlq(this.settings.definition.stream, this.name)}: ${errorMessage(error)}`,
        );
        message.ack();
        return 'dead_letter';
    }
  }

  /** Copies the original message to `dlq.<stream>.<consumer>` with the error in headers. */
  private async deadLetter(message: JsMsg, error: unknown): Promise<void> {
    const { definition } = this.settings;
    const headers = natsHeaders();
    for (const [name, values] of message.headers ?? []) {
      if (name.toLowerCase().startsWith('nats-')) continue;
      for (const value of values) headers.append(name, value);
    }
    headers.set(DLQ_HEADERS.STREAM, definition.stream);
    headers.set(DLQ_HEADERS.CONSUMER, definition.durableName);
    headers.set(DLQ_HEADERS.SUBJECT, message.subject);
    headers.set(DLQ_HEADERS.SEQUENCE, String(message.seq));
    headers.set(DLQ_HEADERS.DELIVERY_COUNT, String(message.info.deliveryCount));
    headers.set(
      DLQ_HEADERS.ERROR,
      headerValue(errorMessage(error)) || 'unknown error',
    );
    headers.set(
      DLQ_HEADERS.ERROR_NAME,
      error instanceof Error ? error.name : typeof error,
    );
    headers.set(DLQ_HEADERS.FAILED_AT, new Date().toISOString());
    headers.set(DLQ_HEADERS.SERVICE, this.runtime.serviceName);
    const { jetstream } = await this.runtime.client.ready();
    const subject = subjects.dlq(definition.stream, definition.durableName);
    const options = {
      msgID: `dlq:${definition.stream}:${definition.durableName}:${message.seq}`,
      headers,
    };
    try {
      await jetstream.publish(subject, message.data, options);
    } catch (error) {
      if (!isNoStreamError(error)) throw error;
      // The DLQ stream was deleted at runtime: re-create it and retry once.
      await this.runtime.streams.ensure(['DLQ'], 'consumer', { refresh: true });
      await jetstream.publish(subject, message.data, options);
    }
  }
}
