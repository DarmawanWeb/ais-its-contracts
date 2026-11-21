import type { IncomingHttpHeaders } from 'node:http';

import { FastifyAdapter } from '@nestjs/platform-fastify';

import { REQUEST_ID_HEADER, resolveRequestId } from '../logging/request-id.js';

/** Default JSON body limit: 1 MiB (an AIS batch of 1000 reports fits). */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/** Options of {@link createFastifyAdapter}. */
export interface FastifyAdapterOptions {
  /** Largest accepted request body in bytes. Default 1 MiB. */
  readonly bodyLimitBytes?: number | undefined;
  /**
   * Trust `X-Forwarded-*` from the gateway (client IP in logs and audit).
   * Default `true`: services are only reachable through the gateway.
   */
  readonly trustProxy?: boolean | string | readonly string[] | undefined;
}

/**
 * The Fastify adapter of every service: no Fastify logger (pino runs through
 * nestjs-pino), request ids from `X-Request-Id` (validated) or a new UUID,
 * proxy trust and the body limit.
 */
export function createFastifyAdapter(options: FastifyAdapterOptions = {}): FastifyAdapter {
  return new FastifyAdapter({
    logger: false,
    trustProxy: typeof options.trustProxy === 'object' ? [...options.trustProxy] : (options.trustProxy ?? true),
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    requestIdHeader: false,
    genReqId: (request: { readonly headers: IncomingHttpHeaders }) =>
      resolveRequestId(request.headers[REQUEST_ID_HEADER]),
  });
}
