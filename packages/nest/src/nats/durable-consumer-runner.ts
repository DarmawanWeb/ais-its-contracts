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
import type { DurableHandlerSettings } from './event-handler.decorator.js';
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
import type { StreamManager } from './stream-manager.js';

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

/** Delay before re-establishing a consume loop that ended unexpectedly, ms. */
const RESUBSCRIBE_DELAY_MS = 2000;

/** How long a pull request stays open on the server, ms (heartbeats every half). */
const PULL_EXPIRES_MS = 30_000;

/**
 * A consumer that has neither received a message nor a server heartbeat for
 * this long, or whose recovery keeps failing for this long, reports itself
 * unhealthy (readiness `nats`), ms.
 */
export const CONSUMER_STALL_THRESHOLD_MS = 2 * PULL_EXPIRES_MS;

/** Liveness of a running durable consumer (readiness and diagnostics). */
export interface ConsumerHealth {
  readonly name: string;
  readonly stream: string;
  /** `false` when the consumer stalled or cannot be recovered. */
  readonly healthy: boolean;
  /** `true` while an exclusive consumer is a standby of another instance. */
  readonly standby: boolean;
  /** Last message, server heartbeat or pull. */
  readonly lastActivityAt: Date | undefined;
  /** Start of the current failure streak (missing consumer, failed recovery). */
  readonly failingSince: Date | undefined;
  readonly lastError: string | undefined;
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
 * deleted or missing consumer is recreated, and {@link health} reports a
 * stall to the readiness check.
 */
export class DurableConsumerRunner {
  private readonly logger: Logger;
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly slots: Semaphore;
  private readonly queue = new KeyedSerialQueue();
  private messages: ConsumerMessages | undefined;
  private supervisor: Promise<void> | undefined;
  private recovering: Promise<void> | undefined;
  private stopping = false;
  private standby = false;
  private lastActivityAt: number | undefined;
  private failingSince: number | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly runtime: ConsumerRuntime,
    readonly settings: DurableHandlerSettings,
    private readonly handler: BoundEventHandler,
    /** `Class.method` of the handler, for logs. */
    readonly handlerName: string,
  ) {
    this.logger = new Logger(`Consumer:${settings.definition.durableName}`);
    this.slots = new Semaphore(settings.concurrency);
  }

  /** Durable consumer name. */
  get name(): string {
    return this.settings.definition.durableName;
  }

  /** Ensures the streams and the consumer and starts consuming. */
  async start(): Promise<void> {
    const { definition } = this.settings;
    await this.runtime.streams.ensure([definition.stream, 'DLQ'], 'consumer');
    await this.ensureConsumer();
    this.messages = await this.subscribe();
    this.supervisor = this.supervise(this.messages);
    this.runtime.running?.add(this);
    this.logger.log(
      `Consuming ${definition.stream} ${definition.filterSubjects.join(',')} with ${this.handlerName} ` +
        `(concurrency ${this.settings.concurrency}, maxDeliver ${this.settings.maxDeliver}` +
        `${this.settings.exclusive === undefined ? '' : ', exclusive'})`,
    );
  }

  /**
   * Stops pulling, waits up to `timeoutMs` for in-flight handlers (then
   * aborts their `signal`), and naks messages received but not started.
   */
  async stop(timeoutMs: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
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
      standby: this.standby,
      lastActivityAt:
        this.lastActivityAt === undefined
          ? undefined
          : new Date(this.lastActivityAt),
      failingSince:
        this.failingSince === undefined ? undefined : new Date(this.failingSince),
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
      expires: PULL_EXPIRES_MS,
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
        switch (status.type) {
          case 'heartbeat':
          case 'next':
            this.touch();
            break;
          case 'consumer_deleted':
          case 'consumer_not_found':
          case 'stream_not_found':
            this.fail(`${status.type.replaceAll('_', ' ')}`);
            this.recover(status.type);
            break;
          case 'heartbeats_missed':
            this.logger.warn(
              `Missed ${status.count} heartbeat(s) from the server`,
            );
            break;
          case 'consumer_pinned':
            if (this.standby)
              this.logger.log('Became the active instance of the consumer');
            this.standby = false;
            this.touch();
            break;
          case 'consumer_unpinned':
            if (!this.standby)
              this.logger.log('Another instance is active: standing by');
            this.standby = true;
            this.touch();
            break;
          default:
            break;
        }
      }
    } catch {
      // The status iterator ends with the consume loop.
    }
  }

  /** Recreates a missing stream or consumer (single flight); the consume loop resumes by itself. */
  private recover(reason: string): void {
    if (this.recovering !== undefined || this.isStopping()) return;
    this.recovering = (async () => {
      try {
        await this.runtime.streams.ensure(
          [this.settings.definition.stream, 'DLQ'],
          'consumer',
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
      try {
        await this.ensureConsumer();
        messages = await this.subscribe();
        this.messages = messages;
        this.recovered();
        this.logger.warn('Consume loop re-established');
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
   * subject's turn and a handler slot.
   */
  private async consume(messages: ConsumerMessages): Promise<void> {
    const ordered =
      this.settings.orderBySubject && this.settings.concurrency > 1;
    for await (const message of messages) {
      this.touch();
      if (this.isStopping()) {
        message.nak();
        continue;
      }
      const heartbeat = this.startHeartbeat(message);
      const work = async (): Promise<void> => {
        await this.slots.acquire();
        try {
          if (this.isStopping()) message.nak();
          else await this.handle(message);
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
  private async handle(message: JsMsg): Promise<void> {
    const { definition } = this.settings;
    const labels = {
      stream: definition.stream,
      consumer: definition.durableName,
    };
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
    await jetstream.publish(
      subjects.dlq(definition.stream, definition.durableName),
      message.data,
      {
        msgID: `dlq:${definition.stream}:${definition.durableName}:${message.seq}`,
        headers,
      },
    );
  }
}
