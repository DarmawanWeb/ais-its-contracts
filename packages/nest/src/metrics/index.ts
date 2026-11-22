export { registerHttpMetrics, UNMATCHED_ROUTE } from './http-metrics.js';
export { MetricsController } from './metrics.controller.js';
export { MetricsModule } from './metrics.module.js';
export {
  DURATION_BUCKETS_SECONDS,
  type HistogramOptions,
  METRIC_PREFIX,
  metricName,
  MetricsService,
} from './metrics.service.js';
/**
 * The prom-client types `MetricsService` returns (re-exported so that
 * services type their metric fields without a direct `prom-client`
 * dependency under pnpm's strict layout).
 *
 * @example
 * private readonly processed: Counter<'outcome'>;
 */
export type { Counter, Gauge, Histogram, Registry, Summary } from 'prom-client';
