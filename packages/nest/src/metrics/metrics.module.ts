import { Global, Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

/**
 * Prometheus metrics (spec §10): the application registry
 * ({@link MetricsService}, default metrics prefixed `aisits_`) and
 * `GET /metrics`. HTTP RED metrics are registered on the Fastify instance by
 * the platform bootstrap; event metrics by the NATS module. Imported by
 * `bootstrapService()` / `buildTestApp()`.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
