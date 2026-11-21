import { Injectable } from '@nestjs/common';
import type {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Pool } from 'pg';

import {
  ReadinessCheck,
  type ReadinessIndicator,
} from '../health/readiness.js';
import { InjectPool } from './tokens.js';

/** Readiness of the database: `SELECT 1` within 3 s. */
@ReadinessCheck()
@Injectable()
export class DatabaseHealthIndicator implements ReadinessIndicator {
  readonly healthKey = 'database';

  constructor(@InjectPool() private readonly pool: Pool) {}

  /** @inheritdoc */
  check(health: HealthIndicatorService): PromiseLike<HealthIndicatorResult> {
    return health
      .check(this.healthKey)
      .attempt(async () => {
        await this.pool.query('SELECT 1');
      })
      .withTimeout(3000);
  }
}
