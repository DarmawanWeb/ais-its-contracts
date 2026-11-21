import { PROBLEM_CONTENT_TYPE } from '@darmawanweb/seemp-contracts/api';
import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import { toProblemResponse } from '../errors/problem-mapper.js';
import { currentTraceId } from '../telemetry/trace-context.js';

/** Emitted to socket.io clients when a gateway handler fails. */
export const WS_EXCEPTION_EVENT = 'exception';

interface EmittingClient {
  emit(event: string, payload: unknown): unknown;
}

function isEmittingClient(value: unknown): value is EmittingClient {
  return typeof value === 'object' && value !== null && 'emit' in value && typeof value.emit === 'function';
}

/**
 * The global exception filter (spec §5): every error becomes RFC 9457
 * problem details with `Content-Type: application/problem+json`, the stable
 * `code`, `traceId`, `requestId` and `instance`. Unexpected errors are logged
 * with their stack and answered `500 INTERNAL_ERROR` (generic detail in
 * production).
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetailsFilter');

  constructor(@InjectConfig() private readonly config: BaseConfig) {}

  /** Maps and sends the problem. */
  catch(exception: unknown, host: ArgumentsHost): void {
    const exposeInternalErrors = this.config.NODE_ENV !== 'production';
    if (host.getType() === 'ws') {
      const problem = toProblemResponse(exception, { exposeInternalErrors });
      if (problem.unexpected) this.logger.error(exception);
      const client: unknown = host.switchToWs().getClient();
      if (isEmittingClient(client)) client.emit(WS_EXCEPTION_EVENT, problem.body);
      return;
    }
    if (host.getType() !== 'http') throw exception;

    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblemResponse(exception, {
      instance: request.url.split('?', 1)[0],
      requestId: request.id,
      traceId: currentTraceId(),
      exposeInternalErrors,
    });

    if (problem.unexpected) {
      this.logger.error(exception);
    } else {
      this.logger.debug(`${problem.status} ${problem.body.code}: ${problem.body.detail ?? problem.body.title}`);
    }
    if (reply.sent) return;
    void reply
      .status(problem.status)
      .headers({ ...problem.headers, 'content-type': PROBLEM_CONTENT_TYPE })
      .send(problem.body);
  }
}
