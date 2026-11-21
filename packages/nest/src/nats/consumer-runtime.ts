import { Inject, Injectable, Optional } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import type {
  ConsumerRuntime,
  DurableConsumerRunner,
} from './durable-consumer-runner.js';
import type { LogContextRunner } from './message-processing.js';
import { NatsClient } from './nats-client.js';
import { NatsMetrics } from './nats.metrics.js';
import { StreamManager } from './stream-manager.js';

/** The shared dependencies of every consumer runner of the application. */
@Injectable()
export class NatsConsumerRuntime implements ConsumerRuntime {
  readonly serviceName: string;
  readonly runInLogContext: LogContextRunner;
  /** Prefix of every durable consumer name (`NATS_DURABLE_PREFIX`, tests). */
  readonly durablePrefix: string;
  /** Durable consumers currently running (readiness). */
  readonly running = new Set<DurableConsumerRunner>();

  constructor(
    readonly client: NatsClient,
    readonly streams: StreamManager,
    readonly metrics: NatsMetrics,
    @InjectConfig() config: BaseConfig,
    @Optional() @Inject(PinoLogger) logger: PinoLogger | null = null,
  ) {
    this.serviceName = config.SERVICE_NAME;
    this.durablePrefix = config.NATS_DURABLE_PREFIX ?? '';
    this.runInLogContext =
      logger === null
        ? (fn) => fn()
        : (fn, bindings) =>
            logger.runInContext(fn, { bindings: { ...bindings } });
  }
}
