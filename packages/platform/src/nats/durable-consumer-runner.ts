import { setTimeout as sleep } from 'node:timers/promises';

import { type AnyEventEnvelope, subjects } from '@darmawanweb/seemp-contracts/events';
import { Logger } from '@nestjs/common';
import type { ConsumerMessages, JsMsg } from '@nats-io/jetstream';
import { headers as natsHeaders } from '@nats-io/transport-node';

import { errorMessage } from '../common/retry.js';
import { KeyedSerialQueue, Semaphore } from '../common/semaphore.js';
import { ensureDurableConsumer } from './consumer-config.js';
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
}

/** Delay before re-establishing a consume loop that ended unexpectedly, ms. */
const RESUBSCRIBE_DELAY_MS = 2000;

/**
 * Runs one durable pull consumer (spec §7.1): ensures its stream, the DLQ
 * stream and the consumer, then pulls and dispatches messages with bounded
 * concurrency (per-subject order kept), heartbeats long handlers, applies the
 * ack / nak-with-backoff / term / dead-letter policy, and stops gracefully.
 */
export class DurableConsumerRunner {
  private readonly logger: Logger;
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private messages: ConsumerMessages | undefined;
  private supervisor: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly runtime: ConsumerRuntime,
    readonly settings: DurableHandlerSettings,
    private readonly handler: BoundEventHandler,
    /** `Class.method` of the handler, for logs. */
    readonly handlerName: string,
  ) {
    this.logger = new Logger(`Consumer:${settings.definition.durableName}`);
  }

  /** Durable consumer name. */
  get name(): string {
    return this.settings.definition.durableName;
  }

  /** Ensures the streams and the consumer and starts consuming. */
  async start(): Promise<void> {
    const { definition } = this.settings;
    await this.runtime.streams.ensure([definition.stream, 'DLQ']);
    const { manager } = await this.runtime.client.ready();
    const { outcome, drift } = await ensureDurableConsumer(manager, this.settings);
    if (outcome !== 'unchanged') {
      this.logger.log(`Consumer ${outcome}${drift.length > 0 ? ` (${drift.join(', ')})` : ''}`);
    }
    this.messages = await this.subscribe();
    this.supervisor = this.supervise(this.messages);
    this.logger.log(
      `Consuming ${definition.stream} ${definition.filterSubjects.join(',')} with ${this.handlerName} ` +
        `(concurrency ${this.settings.concurrency}, maxDeliver ${this.settings.maxDeliver})`,
    );
  }

  /**
   * Stops pulling, waits up to `timeoutMs` for in-flight handlers (then
   * aborts their `signal`), and naks messages received but not started.
   */
  async stop(timeoutMs: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.messages?.close().catch(() => undefined);
    const settled = Promise.allSettled([...this.inFlight]).then(() => 'settled' as const);
    const deadline = sleep(timeoutMs, 'timeout' as const, { ref: false });
    if ((await Promise.race([settled, deadline])) === 'timeout') {
      this.logger.warn(`${this.inFlight.size} handler(s) still running after ${timeoutMs} ms: aborting`);
      this.abort.abort();
      await Promise.race([settled, sleep(1000, undefined, { ref: false })]);
    }
    await this.supervisor?.catch(() => undefined);
  }

  private async subscribe(): Promise<ConsumerMessages> {
    const { jetstream } = await this.runtime.client.ready();
    const { stream, durableName } = this.settings.definition;
    const consumer = await jetstream.consumers.get(stream, durableName);
    return consumer.consume({ max_messages: Math.max(16, this.settings.concurrency * 2) });
  }

  /** Runs the consume loop and re-subscribes if it ends while not stopping. */
  private async supervise(initial: ConsumerMessages): Promise<void> {
    let messages: ConsumerMessages | undefined = initial;
    while (!this.stopping) {
      if (messages !== undefined) {
        try {
          await this.consume(messages);
        } catch (error) {
          if (!this.stopping) this.logger.error(`Consume loop failed: ${errorMessage(error)}`);
        }
      }
      if (this.stopping) break;
      await sleep(RESUBSCRIBE_DELAY_MS, undefined, { ref: false });
      if (this.stopping) break;
      try {
        messages = await this.subscribe();
        this.messages = messages;
        this.logger.warn('Consume loop re-established');
      } catch (error) {
        messages = undefined;
        this.logger.error(`Re-subscribing failed: ${errorMessage(error)}`);
      }
    }
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    const slots = new Semaphore(this.settings.concurrency);
    const ordered = this.settings.orderBySubject && this.settings.concurrency > 1;
    const queue = new KeyedSerialQueue();
    for await (const message of messages) {
      if (this.stopping) {
        message.nak();
        continue;
      }
      await slots.acquire();
      if (this.stopping) {
        slots.release();
        message.nak();
        continue;
      }
      const heartbeat = this.startHeartbeat(message);
      const work = (): Promise<void> => this.handle(message).finally(() => clearInterval(heartbeat));
      const task = (ordered ? queue.run(message.subject, work) : work()).finally(() => slots.release());
      this.inFlight.add(task);
      void task.finally(() => this.inFlight.delete(task));
    }
  }

  /** Keeps the message's ack deadline moving while it waits or runs. */
  private startHeartbeat(message: JsMsg): NodeJS.Timeout {
    const interval = Math.max(1000, Math.floor(this.settings.ackWaitMs / 2));
    const timer = setInterval(() => {
      message.working();
    }, interval);
    timer.unref();
    return timer;
  }

  /** Handles one message; never throws. */
  private async handle(message: JsMsg): Promise<void> {
    const { definition } = this.settings;
    const labels = { stream: definition.stream, consumer: definition.durableName };
    const startedAt = performance.now();
    let outcome: ConsumeOutcome;
    try {
      outcome = await this.dispatch(message);
    } catch (error) {
      // Only reached if acknowledging itself failed (connection lost).
      this.logger.error(`Message ${message.seq} could not be settled: ${errorMessage(error)}`);
      outcome = 'nak';
    }
    this.runtime.metrics.consumed.inc({ ...labels, outcome });
    this.runtime.metrics.handlerDuration.observe({ ...labels, outcome }, (performance.now() - startedAt) / 1000);
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
      this.logger.warn(`Terminating invalid message ${message.seq} on ${message.subject}: ${delivery.failure.message}`);
      message.term(headerValue(`${delivery.failure.reason}: ${delivery.failure.message}`));
      return 'invalid';
    }
    if (delivery.kind === 'skipped') {
      this.logger.warn(`Skipping message ${message.seq} on ${message.subject}: ${delivery.reason}`);
      message.ack();
      return 'skipped';
    }

    const context = eventContextOf(message, definition.durableName, this.abort.signal);
    try {
      await invokeHandler(this.handler, delivery.envelope, context, this.runtime.runInLogContext);
    } catch (error) {
      return this.settleFailure(message, delivery.envelope, error);
    }
    message.ack();
    return 'ack';
  }

  private async settleFailure(message: JsMsg, envelope: AnyEventEnvelope, error: unknown): Promise<ConsumeOutcome> {
    const { maxDeliver, backoffMs } = this.settings;
    const deliveryCount = message.info.deliveryCount;
    const decision = decideFailure(error, deliveryCount, { maxDeliver, backoffMs });
    const what = `${envelope.type} ${envelope.id} (delivery ${deliveryCount}/${maxDeliver})`;
    switch (decision.action) {
      case 'term':
        this.logger.warn(`Terminating ${what}: ${errorMessage(error)}`);
        message.term(headerValue(errorMessage(error)));
        return 'term';
      case 'nak':
        this.logger.warn(`Handler failed for ${what}, retrying in ${decision.delayMs} ms: ${errorMessage(error)}`);
        message.nak(decision.delayMs);
        return 'nak';
      case 'dead_letter':
        try {
          await this.deadLetter(message, error);
        } catch (dlqError) {
          this.logger.error(`Dead-lettering ${what} failed, retrying: ${errorMessage(dlqError)}`);
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
    headers.set(DLQ_HEADERS.ERROR, headerValue(errorMessage(error)) || 'unknown error');
    headers.set(DLQ_HEADERS.ERROR_NAME, error instanceof Error ? error.name : typeof error);
    headers.set(DLQ_HEADERS.FAILED_AT, new Date().toISOString());
    headers.set(DLQ_HEADERS.SERVICE, this.runtime.serviceName);
    const { jetstream } = await this.runtime.client.ready();
    await jetstream.publish(subjects.dlq(definition.stream, definition.durableName), message.data, {
      msgID: `dlq:${definition.stream}:${definition.durableName}:${message.seq}`,
      headers,
    });
  }
}
