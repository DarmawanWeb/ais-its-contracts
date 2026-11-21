import { Controller, Get, Header, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/decorators.js';
import { MetricsService } from './metrics.service.js';

/** `GET /metrics` (outside `/api/v2`, not routed by the gateway). */
@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** Prometheus text exposition. */
  @Get()
  @Header('Cache-Control', 'no-store')
  async scrape(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
