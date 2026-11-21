import type { FastifyInstance } from 'fastify';

import type { MetricsService } from './metrics.service.js';

/** Route label of requests that matched no route (404s, rejected URLs). */
export const UNMATCHED_ROUTE = '<unmatched>';

/**
 * Registers the HTTP RED metrics of spec §10 on a Fastify instance:
 * `aisits_http_requests_total{method,route,status_code}` and
 * `aisits_http_request_duration_seconds{method,route,status_code}`. The `route`
 * label is the route template (`/api/v2/vessels/:id`), never the raw URL, so
 * the label cardinality stays bounded.
 *
 * Must run before the instance is ready (the platform does it while
 * configuring the application).
 */
export function registerHttpMetrics(
  instance: FastifyInstance,
  metrics: MetricsService,
): void {
  const labelNames = ['method', 'route', 'status_code'] as const;
  const requests = metrics.counter({
    name: 'http_requests_total',
    help: 'HTTP requests by method, route template and status code.',
    labelNames,
  });
  const duration = metrics.histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds by method, route template and status code.',
    labelNames,
  });

  instance.addHook('onResponse', (request, reply, done) => {
    const labels = {
      method: request.method,
      route: request.routeOptions.url ?? UNMATCHED_ROUTE,
      status_code: String(reply.statusCode),
    };
    requests.inc(labels);
    duration.observe(labels, reply.elapsedTime / 1000);
    done();
  });
}
