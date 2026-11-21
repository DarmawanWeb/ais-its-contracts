import { Injectable } from '@nestjs/common';
import type {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';

import {
  ReadinessCheck,
  type ReadinessIndicator,
} from '../health/readiness.js';
import { NatsConsumerRuntime } from './consumer-runtime.js';
import { NatsClient } from './nats-client.js';

/**
 * Readiness of NATS: connected, a round trip within 2 s, and no durable
 * consumer stalled (no message or server heartbeat for 60 s, or a missing
 * consumer that cannot be recreated).
 */
@ReadinessCheck()
@Injectable()
export class NatsHealthIndicator implements ReadinessIndicator {
  readonly healthKey = 'nats';

  constructor(
    private readonly client: NatsClient,
    private readonly consumers: NatsConsumerRuntime,
  ) {}

  /** @inheritdoc */
  check(health: HealthIndicatorService): PromiseLike<HealthIndicatorResult> {
    return health
      .check(this.healthKey)
      .attempt(async () => {
        if (!this.client.isConnected())
          throw new Error('Not connected to NATS');
        await this.client.connection.rtt();
        const stalled = [...this.consumers.running]
          .map((runner) => runner.health())
          .filter((health) => !health.healthy);
        if (stalled.length > 0) {
          throw new Error(
            `Stalled consumer(s): ${stalled
              .map(
                (h) =>
                  `${h.name}${h.lastError === undefined ? '' : ` (${h.lastError})`}`,
              )
              .join(', ')}`,
          );
        }
      })
      .withTimeout(2000);
  }
}
