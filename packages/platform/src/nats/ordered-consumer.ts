import { setTimeout as sleep } from 'node:timers/promises';

import type { EventType, OrderedConsumerDefinition, StreamName } from '@darmawanweb/seemp-contracts/events';
import { Logger } from '@nestjs/common';
import type { ConsumerMessages, JsMsg } from '@nats-io/jetstream';

import { errorMessage } from '../common/retry.js';
import { orderedConsumerOptions } from './consumer-config.js';
import type { ConsumerRuntime } from './durable-consumer-runner.js';
import type { OrderedDeliverPolicy } from './event-handler.decorator.js';
import { type BoundEventHandler, eventContextOf, invokeHandler, readDelivery } from './message-processing.js';
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
export function orderedSpecOf(definition: OrderedConsumerDefinition, deliver: OrderedDeliverPolicy): OrderedConsumerSpec {
  return {
    name: definition.name,
    stream: definition.stream,
    filterSubjects: definition.filterSubjects,
    eventTypes: definition.eventTypes,
    deliver,
  };
}

/**
 * Runs one ordered (ephemeral, per instance) consumer: messages arrive in
 * stream order and are handled one at a time; there is no acknowledgement
 * and no redelivery (the client recreates the server-side consumer at the
 * right sequence after gaps). Handler errors are logged and counted.
 */
export class OrderedConsumerRunner {
  private readonly logger: Logger;
  private readonly abort = new AbortController();
  private messages: ConsumerMessages | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly runtime: ConsumerRuntime,
    readonly spec: OrderedConsumerSpec,
    private readonly handler: BoundEventHandler,
    readonly handlerName: string,
  ) {
    this.logger = new Logger(`OrderedConsumer:${spec.name}`);
  }

  /** Consumer name. */
  get name(): string {
    return this.spec.name;
  }

  /** Ensures the stream and starts consuming. */
  async start(): Promise<void> {
    await this.runtime.streams.ensure([this.spec.stream]);
    const { jetstream } = await this.runtime.client.ready();
    const consumer = await jetstream.consumers.get(
      this.spec.stream,
      orderedConsumerOptions(this.spec.filterSubjects, this.spec.deliver),
    );
    this.messages = await consumer.consume();
    this.loop = this.consume(this.messages);
    this.logger.log(`Consuming ${this.spec.stream} ${this.spec.filterSubjects.join(',')} with ${this.handlerName}`);
  }

  /** Stops consuming; waits up to `timeoutMs` for the current handler. */
  async stop(timeoutMs: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await this.messages?.close().catch(() => undefined);
    const finished = (this.loop ?? Promise.resolve()).then(() => 'done' as const);
    if ((await Promise.race([finished, sleep(timeoutMs, 'timeout' as const, { ref: false })])) === 'timeout') {
      this.abort.abort();
    }
  }

  private async consume(messages: ConsumerMessages): Promise<void> {
    try {
      for await (const message of messages) {
        if (this.stopping) break;
        await this.handle(message);
      }
    } catch (error) {
      if (!this.stopping) this.logger.error(`Consume loop failed: ${errorMessage(error)}`);
    }
  }

  private async handle(message: JsMsg): Promise<void> {
    const labels = { stream: this.spec.stream, consumer: this.spec.name };
    const startedAt = performance.now();
    let outcome: ConsumeOutcome = 'handled';
    const delivery = readDelivery(message, this.spec.eventTypes);
    if (delivery.kind === 'invalid') {
      outcome = 'invalid';
      this.runtime.metrics.invalid.inc({ ...labels, reason: delivery.failure.reason });
      this.logger.warn(`Ignoring invalid message ${message.seq}: ${delivery.failure.message}`);
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
        this.logger.error(`Handler failed for ${delivery.envelope.type} ${delivery.envelope.id}: ${errorMessage(error)}`);
      }
    }
    this.runtime.metrics.consumed.inc({ ...labels, outcome });
    this.runtime.metrics.handlerDuration.observe({ ...labels, outcome }, (performance.now() - startedAt) / 1000);
  }
}
