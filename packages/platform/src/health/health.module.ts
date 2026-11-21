import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller.js';
import { ReadinessRegistry } from './readiness.js';

/**
 * Health endpoints (spec §10): `GET /health/live` and `GET /health/ready`
 * with @nestjs/terminus. Readiness checks are discovered from the
 * `@ReadinessCheck()` providers of the modules that are present (database,
 * NATS, Redis, or the service's own). Imported by `bootstrapService()` /
 * `buildTestApp()`.
 */
@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'json' }), DiscoveryModule],
  controllers: [HealthController],
  providers: [ReadinessRegistry],
})
export class HealthModule {}
