import { setTimeout as sleep } from 'node:timers/promises';

import type {
  EventType,
  OrderedConsumerDefinition,
  StreamName,
} from '@darmawanweb/ais-its-contracts/events';
import { Logger } from '@nestjs/common';
import type { ConsumerMessages, JsMsg } from '@nats-io/jetstream';

import { errorMessage } from '../common/retry.js';
import { orderedConsumerOptions } from './consumer-config.js';
import type { ConsumerRuntime } from './durable-consumer-runner.js';
import type { OrderedDeliverPolicy } from './event-handler.decorator.js';
import {
  type BoundEventHandler,
  eventContextOf,
  invokeHandler,
  readDelivery,
} from './message-processing.js';
import type { ConsumeOutcome } from './nats.metrics.js';

/** What an ordered consumer reads. */
export interface OrderedConsumerSpec {
  /** Name used in logs and metrics (the `consumer` label). */
  readonly name: string;
  readonly stream: StreamName;
  readonly filterSubjects: readonly string[];
  /** Event types handled; others are skipped. */
  readonly eventTypes: readonly EventType[];
  readonly deliver: OrderedDeliverPolicy;
}

/** The spec of a contracts ordered consumer definition. */
export function orderedSpecOf(
  definition: OrderedConsumerDefinition,
  deliver: OrderedDeliverPolicy,
): OrderedConsumerSpec {
  return {
    name: definition.name,
    stream: definition.stream,
    filterSubjects: definition.filterSubjects,
    eventTypes: definition.eventTypes,
    deliver,
  };
}

/** Thrown by {@link OrderedConsumerRunner.caughtUp} when the backlog is not delivered in time. */
export class CatchUpTimeoutError extends Error {
  override readonly name = 'CatchUpTimeoutError';
}

/**
 * Runs one ordered (ephemeral, per instance) consumer: messages arrive in
 * stream order and are handled one at a time; there is no acknowledgement
 * and no redelivery (the client recreates the server-side consumer at the
 * right sequence after gaps). Handler errors are logged and counted.
 *
 * {@link caughtUp} resolves once the messages that were pending when the
 * consumer was created have been handled — with `'last_per_subject'` that is
 * the full snapshot of a compacted stream, which projections wait for before
 * they serve queries.
 */
export class OrderedConsumerRunner {
  private readonly logger: Logger;
  private readonly abort = new AbortController();
  private readonly backlog: { promise: Promise<void>; resolve: () => void };
  private messages: ConsumerMessages | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private handled = 0;

  constructor(
    private readonly runtime: ConsumerRuntime,
    readonly spec: OrderedConsumerSpec,
    private readonly handler: BoundEventHandler,
    readonly handlerName: string,
  ) {
    this.logger = new Logger(`OrderedConsumer:${spec.name}`);
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.backlog = { promise, resolve };
  }

  /** Consumer name. */
  get name(): string {
    return this.spec.name;
  }

  /** Messages handled so far (all outcomes). */
  get handledCount(): number {
    return this.handled;
  }

  /** Ensures the stream exists (never changes it) and starts consuming. */
  async start(): Promise<void> {
    await this.runtime.streams.ensure([this.spec.stream], 'consumer');
    const { jetstream } = await this.runtime.client.ready();
    const consumer = await jetstream.consumers.get(
      this.spec.stream,
      orderedConsumerOptions(this.spec.filterSubjects, this.spec.deliver),
    );
    // The server-side consumer exists now: its cached info tells how many
    // messages the initial delivery holds.
    if ((await consumer.info(true)).num_pending === 0) this.backlog.resolve();
    this.messages = await consumer.consume();
    this.loop = this.consume(this.messages);
    this.logger.log(
      `Consuming ${this.spec.stream} ${this.spec.filterSubjects.join(',')} with ${this.handlerName}`,
    );
  }

  /**
   * Resolves once the backlog present at {@link start} has been handled.
   *
   * @throws {CatchUpTimeoutError} after `timeoutMs` (default 60 s).
   */
  async caughtUp(timeoutMs = 60_000): Promise<void> {
    const timeout = sleep(timeoutMs, 'timeout' as const, {
      ref: false,
      signal: this.abort.signal,
    }).catch(() => 'aborted' as const);
    const outcome = await Promise.race([
      this.backlog.promise.then(() => 'done' as const),
      timeout,
    ]);
    if (outcome !== 'done') {
      throw new CatchUpTimeoutError(
        `Ordered consumer ${this.spec.name} did not deliver its backlog of ${this.spec.stream} within ${timeoutMs} ms`,
      );
    }
  }

  /** Stops consuming; waits up to `timeoutMs` for the current handler. */
  async stop(timeoutMs: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.messages?.close().catch(() => undefined);
    const finished = (this.loop ?? Promise.resolve()).then(
      () => 'done' as const,
    );
    if (
      (await Promise.race([
        finished,
        sleep(timeoutMs, 'timeout' as const, { ref: false }),
      ])) === 'timeout'
    ) {
      this.abort.abort();
    }
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        if (this.stopping) break;
        await this.handle(message);
        this.handled += 1;
        if (message.info.pending === 0) this.backlog.resolve();
      }
    } catch (error) {
      if (!this.stopping)
        this.logger.error(`Consume loop failed: ${errorMessage(error)}`);
    }
  }

  private async handle(message: JsMsg): Promise<void> {
    const labels = { stream: this.spec.stream, consumer: this.spec.name };
    const startedAt = performance.now();
    let outcome: ConsumeOutcome = 'handled';
    const delivery = readDelivery(message, this.spec.eventTypes);
    if (delivery.kind === 'invalid') {
      outcome = 'invalid';
      this.runtime.metrics.invalid.inc({
        ...labels,
        reason: delivery.failure.reason,
      });
      this.logger.warn(
        `Ignoring invalid message ${message.seq}: ${delivery.failure.message}`,
      );
    } else if (delivery.kind === 'skipped') {
      outcome = 'skipped';
    } else {
      try {
        await invokeHandler(
          this.handler,
          delivery.envelope,
          eventContextOf(message, this.spec.name, this.abort.signal),
          this.runtime.runInLogContext,
        );
      } catch (error) {
        outcome = 'error';
        this.logger.error(
          `Handler failed for ${delivery.envelope.type} ${delivery.envelope.id}: ${errorMessage(error)}`,
        );
      }
    }
    this.runtime.metrics.consumed.inc({ ...labels, outcome });
    this.runtime.metrics.handlerDuration.observe(
      { ...labels, outcome },
      (performance.now() - startedAt) / 1000,
    );
  }
}
