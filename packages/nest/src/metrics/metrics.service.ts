import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  collectDefaultMetrics,
  Counter,
  type CounterConfiguration,
  Gauge,
  type GaugeConfiguration,
  Histogram,
  type HistogramConfiguration,
  type Metric,
  Registry,
} from 'prom-client';

/** Prefix of every platform metric (spec §10). */
export const METRIC_PREFIX = 'aisits_';

/** Default buckets of duration histograms, in seconds. */
export const DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Common options of the metric helpers (`registers` is managed for you). */
interface MetricOptions<Label extends string> {
  /** Name with or without the `aisits_` prefix (added when missing). */
  readonly name: string;
  readonly help: string;
  readonly labelNames?: readonly Label[] | undefined;
}

/** Options of {@link MetricsService.histogram}. */
export interface HistogramOptions<
  Label extends string,
> extends MetricOptions<Label> {
  /** Bucket upper bounds; default {@link DURATION_BUCKETS_SECONDS}. */
  readonly buckets?: readonly number[] | undefined;
}

/** Ensures the `aisits_` prefix. */
export function metricName(name: string): string {
  return name.startsWith(METRIC_PREFIX) ? name : `${METRIC_PREFIX}${name}`;
}

/**
 * The application's prom-client registry (one per Nest application, so that
 * tests can run several apps in one process) with the default Node.js metrics
 * prefixed `aisits_`, and get-or-create helpers that keep names and labels
 * consistent: asking twice for the same metric returns the same instance.
 *
 * @example
 * private readonly processed = this.metrics.counter({
 *   name: 'ais_messages_total', help: 'AIS messages by outcome', labelNames: ['source', 'outcome'],
 * });
 * this.processed.inc({ source: 'primary', outcome: 'accepted' });
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  /** The registry served at `GET /metrics`. */
  readonly registry = new Registry();
  private defaultMetricsCollected = false;

  /** Starts collecting the default Node.js metrics (`aisits_process_*`, `aisits_nodejs_*`). */
  onModuleInit(): void {
    if (this.defaultMetricsCollected) return;
    collectDefaultMetrics({ register: this.registry, prefix: METRIC_PREFIX });
    this.defaultMetricsCollected = true;
  }

  /** Get-or-create a counter. */
  counter<Label extends string = string>(
    options: MetricOptions<Label>,
  ): Counter<Label> {
    return this.getOrCreate(options.name, Counter, (name) => {
      const configuration: CounterConfiguration<Label> = {
        name,
        help: options.help,
        labelNames: options.labelNames ?? [],
        registers: [this.registry],
      };
      return new Counter(configuration);
    });
  }

  /** Get-or-create a gauge. */
  gauge<Label extends string = string>(
    options: MetricOptions<Label>,
  ): Gauge<Label> {
    return this.getOrCreate(options.name, Gauge, (name) => {
      const configuration: GaugeConfiguration<Label> = {
        name,
        help: options.help,
        labelNames: options.labelNames ?? [],
        registers: [this.registry],
      };
      return new Gauge(configuration);
    });
  }

  /** Get-or-create a histogram (default buckets: durations in seconds). */
  histogram<Label extends string = string>(
    options: HistogramOptions<Label>,
  ): Histogram<Label> {
    return this.getOrCreate(options.name, Histogram, (name) => {
      const configuration: HistogramConfiguration<Label> = {
        name,
        help: options.help,
        labelNames: options.labelNames ?? [],
        buckets: [...(options.buckets ?? DURATION_BUCKETS_SECONDS)],
        registers: [this.registry],
      };
      return new Histogram(configuration);
    });
  }

  /** Prometheus text exposition of every metric. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  /** `Content-Type` of {@link render}. */
  get contentType(): string {
    return this.registry.contentType;
  }

  private getOrCreate<T extends Metric>(
    requestedName: string,
    type: abstract new (...args: never[]) => T,
    create: (name: string) => T,
  ): T {
    const name = metricName(requestedName);
    const existing = this.registry.getSingleMetric(name);
    if (existing === undefined) return create(name);
    if (!(existing instanceof type)) {
      throw new TypeError(
        `Metric ${name} is already registered with another type`,
      );
    }
    return existing;
  }
}
