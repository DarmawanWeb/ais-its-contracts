import {
  type DynamicModule,
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { NatsConsumerRuntime } from './consumer-runtime.js';
import {
  CoreSubscriptionMetrics,
  CoreSubscriptions,
} from './core-subscriptions.js';
import { EventConsumers } from './event-consumers.js';
import { EventPublisher } from './event-publisher.js';
import { NatsClient } from './nats-client.js';
import { NatsHealthIndicator } from './nats.health.js';
import { NatsMetrics } from './nats.metrics.js';
import { NATS_OPTIONS, type NatsModuleOptions } from './nats.options.js';
import { OrderedConsumers } from './ordered-consumers.service.js';
import { StreamManager } from './stream-manager.js';
import { StreamReplayer } from './stream-replayer.js';

/** Ensures the streams the service produces to, once connected. */
@Injectable()
class ProducerStreams implements OnModuleInit {
  constructor(
    private readonly streams: StreamManager,
    @Inject(NATS_OPTIONS) private readonly options: NatsModuleOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.streams.ensure(this.options.streams ?? []);
  }
}

/**
 * NATS JetStream (spec §7): the connection ({@link NatsClient}), stream
 * management, the {@link EventPublisher}, the `@EventHandler` /
 * `@OrderedEventHandler` consumer framework, {@link OrderedConsumers},
 * {@link StreamReplayer}, event metrics and a readiness check. Global.
 *
 * @example
 * NatsModule.forRoot({ streams: ['FLEET', 'AUDIT'] })
 */
@Module({})
export class NatsModule {
  /** Registers the NATS providers. */
  static forRoot(options: NatsModuleOptions = {}): DynamicModule {
    return {
      module: NatsModule,
      global: true,
      imports: [DiscoveryModule],
      providers: [
        { provide: NATS_OPTIONS, useValue: options },
        NatsClient,
        StreamManager,
        NatsMetrics,
        NatsConsumerRuntime,
        EventPublisher,
        OrderedConsumers,
        StreamReplayer,
        EventConsumers,
        CoreSubscriptionMetrics,
        CoreSubscriptions,
        ProducerStreams,
        NatsHealthIndicator,
      ],
      exports: [
        NatsClient,
        StreamManager,
        NatsMetrics,
        NatsConsumerRuntime,
        EventPublisher,
        OrderedConsumers,
        StreamReplayer,
        EventConsumers,
        CoreSubscriptions,
      ],
    };
  }
}
