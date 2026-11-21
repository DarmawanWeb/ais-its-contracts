import {
  type BeforeApplicationShutdown,
  Controller,
  Get,
  Header,
  Logger,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  HealthCheckService,
  type HealthCheckResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { FastifyReply } from 'fastify';

import { Public } from '../auth/decorators.js';
import { ReadinessRegistry } from './readiness.js';

/**
 * `GET /health/live` (the process is up) and `GET /health/ready` (every
 * discovered dependency answers; `503` otherwise and while shutting down),
 * outside `/api/v2` (spec §5, §10).
 */
@ApiExcludeController()
@Public()
@Controller('health')
export class HealthController implements BeforeApplicationShutdown {
  private readonly logger = new Logger('Health');
  private shuttingDown = false;

  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly registry: ReadinessRegistry,
  ) {}

  /** Stops reporting ready so that load balancers drain the instance. */
  beforeApplicationShutdown(signal?: string): void {
    this.shuttingDown = true;
    this.logger.log(
      `Shutting down${signal === undefined ? '' : ` (${signal})`}: /health/ready answers 503, draining`,
    );
  }

  /** Liveness: no dependency is checked. */
  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): HealthCheckResult {
    return { status: 'ok', info: {}, error: {}, details: {} };
  }

  /** Readiness: database, NATS, Redis (those the service uses). */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<HealthCheckResult> {
    if (this.shuttingDown) {
      reply.status(503);
      return { status: 'shutting_down', info: {}, error: {}, details: {} };
    }
    try {
      return await this.health.check(
        this.registry
          .all()
          .map((indicator) => () => indicator.check(this.indicators)),
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        reply.status(503);
        return error.getResponse() as HealthCheckResult;
      }
      throw error;
    }
  }
}
