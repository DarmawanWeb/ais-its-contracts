import type { IncomingHttpHeaders } from 'node:http';

import { FastifyAdapter } from '@nestjs/platform-fastify';

import { DEFAULT_TRUSTED_PROXIES } from '../config/env-schema.js';
import { REQUEST_ID_HEADER, resolveRequestId } from '../logging/request-id.js';

/** Default JSON body limit: 1 MiB (an AIS batch of 1000 reports fits). */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

/** Options of {@link createFastifyAdapter}. */
export interface FastifyAdapterOptions {
  /** Largest accepted request body in bytes. Default 1 MiB. */
  readonly bodyLimitBytes?: number | undefined;
  /**
   * Proxies whose `X-Forwarded-*` headers are trusted for the client IP
   * (`request.ip` in throttles, logs and audit): IPs, CIDRs or the names
   * `loopback`, `linklocal`, `uniquelocal`; an empty list or `false` trusts
   * none. Default {@link DEFAULT_TRUSTED_PROXIES} (`TRUSTED_PROXIES`).
   * Never `true`: trusting every hop lets any direct caller choose its IP.
   */
  readonly trustProxy?: false | string | readonly string[] | undefined;
}

function trustProxyOf(
  option: FastifyAdapterOptions['trustProxy'],
): false | string | string[] {
  if (option === false) return false;
  if (typeof option === 'string') return option === '' ? false : option;
  const list = [...(option ?? DEFAULT_TRUSTED_PROXIES)];
  return list.length === 0 ? false : list;
}

/**
 * The Fastify adapter of every service: no Fastify logger (pino runs through
 * nestjs-pino), request ids from `X-Request-Id` (validated) or a new UUID,
 * proxy trust and the body limit.
 */
export function createFastifyAdapter(
  options: FastifyAdapterOptions = {},
): FastifyAdapter {
  return new FastifyAdapter({
    logger: false,
    trustProxy: trustProxyOf(options.trustProxy),
    bodyLimit: options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
    requestIdHeader: false,
    genReqId: (request: { readonly headers: IncomingHttpHeaders }) =>
      resolveRequestId(request.headers[REQUEST_ID_HEADER]),
  });
}
