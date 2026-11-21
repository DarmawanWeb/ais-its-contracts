import { setTimeout as sleep } from 'node:timers/promises';

import {
  CORE_SUBSCRIPTIONS,
  type CoreSubscriptionDefinition,
} from '@darmawanweb/ais-its-contracts/events';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { Msg, Subscription } from '@nats-io/transport-node';
import type { Counter, Histogram } from 'prom-client';

import { errorMessage } from '../common/retry.js';
import { Semaphore } from '../common/semaphore.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { NatsConsumerRuntime } from './consumer-runtime.js';

/** Metadata key of {@link CoreSubscriptionHandler}. */
export const CORE_SUBSCRIPTION_HANDLER_METADATA =
  'aisits:nats:core-subscription-handler';

/** Name of a contracts core subscription (`CORE_SUBSCRIPTIONS`). */
export type CoreSubscriptionName = (typeof CORE_SUBSCRIPTIONS)[number]['name'];

/** Options of {@link CoreSubscriptionHandler}. */
export interface CoreSubscriptionHandlerOptions {
  /** A contracts core subscription (by name) or a definition. */
  readonly subscription: CoreSubscriptionName | CoreSubscriptionDefinition;
  /**
   * Queue group: replicas of the service share the messages. Default
   * `SERVICE_NAME`; `false` delivers every message to every instance.
   */
  readonly queue?: string | false | undefined;
  /** Handlers running at once. Default 16. */
  readonly concurrency?: number | undefined;
  /**
   * Messages waiting for a handler before new ones are dropped (core NATS
   * has no flow control; dropped messages are counted). Default 1 000.
   */
  readonly maxPending?: number | undefined;
}

/** Resolved settings of a core subscription handler. */
export interface CoreSubscriptionSettings {
  readonly definition: CoreSubscriptionDefinition;
  readonly queue: string | false | undefined;
  readonly concurrency: number;
  readonly maxPending: number;
}

/** Thrown for a handler whose subscription is unknown or whose options are invalid. */
export class CoreSubscriptionConfigError extends Error {
  override readonly name = 'CoreSubscriptionConfigError';
}

/** A core NATS message handler (the message gives `subject`, `data`, `json()`, `string()`, `headers`). */
export type CoreMessageHandler = (message: Msg) => unknown;

function resolveDefinition(
  subscription: CoreSubscriptionHandlerOptions['subscription'],
): CoreSubscriptionDefinition {
  if (typeof subscription !== 'string') return subscription;
  const definition = CORE_SUBSCRIPTIONS.find((s) => s.name === subscription);
  if (definition === undefined) {
    throw new CoreSubscriptionConfigError(
      `Unknown core subscription "${subscription}" (contracts CORE_SUBSCRIPTIONS)`,
    );
  }
  return definition;
}

function positive(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new CoreSubscriptionConfigError(`${name} must be a positive integer`);
  }
  return resolved;
}

/** Resolves {@link CoreSubscriptionHandlerOptions} (validated at decoration time). */
export function coreSubscriptionSettings(
  options: CoreSubscriptionHandlerOptions,
): CoreSubscriptionSettings {
  return {
    definition: resolveDefinition(options.subscription),
    queue: options.queue,
    concurrency: positive(options.concurrency, 16, 'concurrency'),
    maxPending: positive(options.maxPending, 1_000, 'maxPending'),
  };
}

/**
 * Marks a provider method as the handler of a core NATS subscription
 * (contracts `CORE_SUBSCRIPTIONS`, e.g. telemetry's MQTT gateway subject
 * `aisits.telemetry.*`). The kit subscribes when the application bootstraps
 * (queue group `SERVICE_NAME` by default), runs the handler with bounded
 * concurrency inside the log context, isolates and counts failures
 * (`aisits_core_messages_total{subscription,outcome}`), and drains the
 * subscription on shutdown. Core NATS has no redelivery: a handler that
 * throws loses the message (it is logged and counted).
 *
 * @example
 * @CoreSubscriptionHandler({ subscription: 'telemetry-mqtt' })
 * async onDeviceMessage(message: Msg): Promise<void> {
 *   const deviceId = message.subject.split('.').at(-1);
 *   await this.readings.ingestDeviceJson(deviceId, message.json<unknown>());
 * }
 */
export function CoreSubscriptionHandler(
  options: CoreSubscriptionHandlerOptions,
): MethodDecorator {
  const settings = coreSubscriptionSettings(options);
  return (_target, _propertyKey, descriptor) => {
    const method: unknown = descriptor.value;
    if (typeof method !== 'function') {
      throw new CoreSubscriptionConfigError(
        '@CoreSubscriptionHandler() decorates methods only',
      );
    }
    Reflect.defineMetadata(
      CORE_SUBSCRIPTION_HANDLER_METADATA,
      settings,
      method,
    );
  };
}

/** The settings of a method decorated with {@link CoreSubscriptionHandler}. */
export function getCoreSubscriptionSettings(
  method: unknown,
): CoreSubscriptionSettings | undefined {
  if (typeof method !== 'function') return undefined;
  const settings: unknown = Reflect.getMetadata(
    CORE_SUBSCRIPTION_HANDLER_METADATA,
    method,
  );
  return settings === undefined
    ? undefined
    : (settings as CoreSubscriptionSettings);
}

/** Outcome of one core message. */
export type CoreMessageOutcome = 'handled' | 'failed' | 'dropped';

/** Metrics of core subscriptions (`aisits_core_*`). */
@Injectable()
export class CoreSubscriptionMetrics {
  readonly messages: Counter<'subscription' | 'outcome'>;
  readonly duration: Histogram<'subscription'>;

  constructor(
    @Optional() @Inject(MetricsService) metrics: MetricsService | null = null,
  ) {
    const registry = metrics ?? new MetricsService();
    this.messages = registry.counter({
      name: 'core_messages_total',
      help: 'Core NATS messages by subscription and outcome (handled, failed, dropped).',
      labelNames: ['subscription', 'outcome'],
    });
    this.duration = registry.histogram({
      name: 'core_handler_duration_seconds',
      help: 'Core NATS message handler duration in seconds by subscription.',
      labelNames: ['subscription'],
    });
  }
}

/** One running core subscription. */
class CoreSubscriptionRunner {
  private readonly logger: Logger;
  private readonly slots: Semaphore;
  private readonly inFlight = new Set<Promise<void>>();
  private subscription: Subscription | undefined;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly runtime: NatsConsumerRuntime,
    private readonly metrics: CoreSubscriptionMetrics,
    readonly settings: CoreSubscriptionSettings,
    private readonly handler: CoreMessageHandler,
    readonly handlerName: string,
  ) {
    this.logger = new Logger(`CoreSubscription:${settings.definition.name}`);
    this.slots = new Semaphore(settings.concurrency);
  }

  get name(): string {
    return this.settings.definition.name;
  }

  async start(): Promise<void> {
    const { connection } = await this.runtime.client.ready();
    const queue =
      this.settings.queue === false
        ? undefined
        : (this.settings.queue ?? this.runtime.serviceName);
    this.subscription = connection.subscribe(this.settings.definition.subject, {
      ...(queue === undefined ? {} : { queue }),
    });
    this.loop = this.consume(this.subscription);
    this.logger.log(
      `Subscribed to ${this.settings.definition.subject} with ${this.handlerName}` +
        `${queue === undefined ? '' : ` (queue ${queue})`}, concurrency ${this.settings.concurrency}`,
    );
  }

  /** Drains the subscription and waits up to `timeoutMs` for running handlers. */
  async stop(timeoutMs: number): Promise<void> {
    await this.subscription?.drain().catch(() => undefined);
    await this.loop?.catch(() => undefined);
    const settled = Promise.allSettled([...this.inFlight]).then(() => true);
    const finished = await Promise.race([
      settled,
      sleep(timeoutMs, false, { ref: false }),
    ]);
    if (!finished)
      this.logger.warn(
        `${this.inFlight.size} handler(s) still running after ${timeoutMs} ms`,
      );
  }

  private async consume(subscription: Subscription): Promise<void> {
    const labels = { subscription: this.name };
    for await (const message of subscription) {
      if (
        this.inFlight.size >=
        this.settings.concurrency + this.settings.maxPending
      ) {
        this.metrics.messages.inc({ ...labels, outcome: 'dropped' });
        continue;
      }
      const task = this.run(message);
      this.inFlight.add(task);
      void task.finally(() => this.inFlight.delete(task));
    }
  }

  /** Runs the handler for one message; never throws. */
  private async run(message: Msg): Promise<void> {
    const labels = { subscription: this.name };
    await this.slots.acquire();
    const startedAt = performance.now();
    let outcome: CoreMessageOutcome = 'handled';
    try {
      await this.runtime.runInLogContext(
        async () => {
          await this.handler(message);
        },
        { subscription: this.name, subject: message.subject },
      );
    } catch (error) {
      outcome = 'failed';
      this.logger.warn(
        `Handler failed for a message on ${message.subject}: ${errorMessage(error)}`,
      );
    } finally {
      this.slots.release();
      this.metrics.messages.inc({ ...labels, outcome });
      this.metrics.duration.observe(
        labels,
        (performance.now() - startedAt) / 1000,
      );
    }
  }
}

/** Thrown when two handlers claim the same core subscription. */
export class DuplicateCoreSubscriptionHandlerError extends Error {
  override readonly name = 'DuplicateCoreSubscriptionHandlerError';
}

/**
 * Discovers {@link CoreSubscriptionHandler} methods of singleton providers,
 * subscribes when the application bootstraps and drains before it shuts down.
 */
@Injectable()
export class CoreSubscriptions
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger('CoreSubscriptions');
  private runners: CoreSubscriptionRunner[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly runtime: NatsConsumerRuntime,
    private readonly metrics: CoreSubscriptionMetrics,
  ) {}

  /** Names of the running subscriptions. */
  get running(): readonly string[] {
    return this.runners.map((runner) => runner.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    const runners = this.discoverRunners();
    for (const runner of runners) {
      await runner.start();
      this.runners.push(runner);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.runners.length === 0) return;
    this.logger.log(`Draining ${this.runners.length} core subscription(s)`);
    await Promise.all(this.runners.map((runner) => runner.stop(10_000)));
    this.runners = [];
  }

  private discoverRunners(): CoreSubscriptionRunner[] {
    const runners: CoreSubscriptionRunner[] = [];
    const owners = new Map<string, string>();
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (typeof instance !== 'object' || instance === null) continue;
      const prototype: unknown = Object.getPrototypeOf(instance);
      if (typeof prototype !== 'object' || prototype === null) continue;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const method: unknown = Reflect.get(instance, methodName);
        const settings = getCoreSubscriptionSettings(method);
        if (settings === undefined || typeof method !== 'function') continue;
        const handlerName = `${instance.constructor.name}.${methodName}`;
        if (!wrapper.isDependencyTreeStatic()) {
          this.logger.error(
            `${handlerName}: core subscription handlers must be in singleton providers, skipped`,
          );
          continue;
        }
        const owner = owners.get(settings.definition.name);
        if (owner !== undefined) {
          throw new DuplicateCoreSubscriptionHandlerError(
            `Core subscription ${settings.definition.name} is handled by both ${owner} and ${handlerName}`,
          );
        }
        owners.set(settings.definition.name, handlerName);
        runners.push(
          new CoreSubscriptionRunner(
            this.runtime,
            this.metrics,
            settings,
            method.bind(instance) as CoreMessageHandler,
            handlerName,
          ),
        );
      }
    }
    return runners;
  }
}
