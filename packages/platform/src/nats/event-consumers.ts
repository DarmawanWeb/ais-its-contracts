import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { NatsConsumerRuntime } from './consumer-runtime.js';
import { DurableConsumerRunner } from './durable-consumer-runner.js';
import { getEventHandlerMetadata } from './event-handler.decorator.js';
import type { BoundEventHandler } from './message-processing.js';
import { NATS_OPTIONS, type NatsModuleOptions } from './nats.options.js';
import { OrderedConsumerRunner, orderedSpecOf } from './ordered-consumer.js';

/** A running consumer of the application. */
export type RunningConsumer = DurableConsumerRunner | OrderedConsumerRunner;

/** Thrown when two handlers claim the same consumer. */
export class DuplicateConsumerHandlerError extends Error {
  override readonly name = 'DuplicateConsumerHandlerError';
}

/**
 * Discovers `@EventHandler` / `@OrderedEventHandler` methods of the
 * application's singleton providers when the application bootstraps (after
 * every `onModuleInit`, so migrations are done), starts one runner per
 * handler, and stops them gracefully before the application shuts down.
 */
@Injectable()
export class EventConsumers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('EventConsumers');
  private runners: RunningConsumer[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly runtime: NatsConsumerRuntime,
    @Inject(NATS_OPTIONS) private readonly options: NatsModuleOptions,
  ) {}

  /** The consumers started by this application. */
  get running(): readonly RunningConsumer[] {
    return this.runners;
  }

  /** Discovers the handlers and starts their consumers. */
  async onApplicationBootstrap(): Promise<void> {
    const runners = this.discoverRunners();
    for (const runner of runners) {
      await runner.start();
      this.runners.push(runner);
    }
  }

  /** Stops pulling and waits for in-flight handlers (bounded by `drainTimeoutMs`). */
  async beforeApplicationShutdown(): Promise<void> {
    const timeout = this.options.drainTimeoutMs ?? 25_000;
    await Promise.all(this.runners.map((runner) => runner.stop(timeout)));
    this.runners = [];
  }

  private discoverRunners(): RunningConsumer[] {
    const runners: RunningConsumer[] = [];
    const owners = new Map<string, string>();
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) continue;
      const prototype: unknown = Object.getPrototypeOf(instance);
      if (typeof prototype !== 'object' || prototype === null) continue;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const method: unknown = Reflect.get(instance, methodName);
        const metadata = getEventHandlerMetadata(method);
        if (metadata === undefined || typeof method !== 'function') continue;
        const handlerName = `${instance.constructor.name}.${methodName}`;
        if (!wrapper.isDependencyTreeStatic()) {
          this.logger.error(`${handlerName}: event handlers must be in singleton providers, skipped`);
          continue;
        }
        const handler = method.bind(instance) as BoundEventHandler;
        const runner =
          metadata.kind === 'durable'
            ? new DurableConsumerRunner(this.runtime, metadata.settings, handler, handlerName)
            : new OrderedConsumerRunner(this.runtime, orderedSpecOf(metadata.definition, metadata.deliver), handler, handlerName);
        const key = `${metadata.kind}:${runner.name}`;
        const owner = owners.get(key);
        if (owner !== undefined) {
          throw new DuplicateConsumerHandlerError(`Consumer ${runner.name} is handled by both ${owner} and ${handlerName}`);
        }
        owners.set(key, handlerName);
        runners.push(runner);
      }
    }
    return runners;
  }
}
