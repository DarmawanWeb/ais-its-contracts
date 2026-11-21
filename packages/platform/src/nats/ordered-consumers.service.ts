import type { AnyEventEnvelope, EventType, StreamName } from '@darmawanweb/seemp-contracts/events';
import { type BeforeApplicationShutdown, Inject, Injectable } from '@nestjs/common';

import { NatsConsumerRuntime } from './consumer-runtime.js';
import type { EventContext, OrderedDeliverPolicy } from './event-handler.decorator.js';
import { OrderedConsumerRunner } from './ordered-consumer.js';
import { NATS_OPTIONS, type NatsModuleOptions } from './nats.options.js';

/** Options of {@link OrderedConsumers.start}. */
export interface OrderedSubscriptionOptions {
  /** Name in logs and metrics. */
  readonly name: string;
  readonly stream: StreamName;
  readonly filterSubjects: readonly string[];
  readonly eventTypes: readonly EventType[];
  /** Default `'new'`. */
  readonly deliver?: OrderedDeliverPolicy | undefined;
  readonly handler: (event: AnyEventEnvelope, context: EventContext) => void | Promise<void>;
}

/** A running ordered subscription. */
export interface OrderedSubscription {
  readonly name: string;
  /** Stops it (waits up to `timeoutMs` for the current handler, default 5 s). */
  stop(timeoutMs?: number): Promise<void>;
}

/**
 * Starts ordered consumers at runtime (fan-out to WebSocket clients,
 * per-request tails). Subscriptions still running at shutdown are stopped.
 * For consumers known at build time prefer `@OrderedEventHandler`.
 */
@Injectable()
export class OrderedConsumers implements BeforeApplicationShutdown {
  private readonly running = new Set<OrderedConsumerRunner>();

  constructor(
    private readonly runtime: NatsConsumerRuntime,
    @Inject(NATS_OPTIONS) private readonly options: NatsModuleOptions,
  ) {}

  /** Starts an ordered consumer and resolves once it is subscribed. */
  async start(options: OrderedSubscriptionOptions): Promise<OrderedSubscription> {
    const runner = new OrderedConsumerRunner(
      this.runtime,
      {
        name: options.name,
        stream: options.stream,
        filterSubjects: options.filterSubjects,
        eventTypes: options.eventTypes,
        deliver: options.deliver ?? 'new',
      },
      options.handler,
      options.name,
    );
    await runner.start();
    this.running.add(runner);
    return {
      name: options.name,
      stop: async (timeoutMs = 5000) => {
        this.running.delete(runner);
        await runner.stop(timeoutMs);
      },
    };
  }

  /** Stops every subscription still running. */
  async beforeApplicationShutdown(): Promise<void> {
    const timeout = this.options.drainTimeoutMs ?? 25_000;
    await Promise.all([...this.running].map((runner) => runner.stop(timeout)));
    this.running.clear();
  }
}
