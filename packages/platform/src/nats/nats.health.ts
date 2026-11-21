import { Injectable } from '@nestjs/common';
import type { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

import { ReadinessCheck, type ReadinessIndicator } from '../health/readiness.js';
import { NatsClient } from './nats-client.js';

/** Readiness of NATS: connected and a round trip within 2 s. */
@ReadinessCheck()
@Injectable()
export class NatsHealthIndicator implements ReadinessIndicator {
  readonly healthKey = 'nats';

  constructor(private readonly client: NatsClient) {}

  /** @inheritdoc */
  check(health: HealthIndicatorService): PromiseLike<HealthIndicatorResult> {
    return health
      .check(this.healthKey)
      .attempt(async () => {
        if (!this.client.isConnected()) throw new Error('Not connected to NATS');
        await this.client.connection.rtt();
      })
      .withTimeout(2000);
  }
}
