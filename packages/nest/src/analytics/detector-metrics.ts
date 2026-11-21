import type { Counter, Histogram } from 'prom-client';

import { MetricsService } from '../metrics/metrics.service.js';

/** Hooks of a detector, the `hook` label of `aisits_detector_errors_total`. */
export type DetectorHook =
  'onPosition' | 'onTick' | 'onZoneChanged' | 'onVesselChanged';

/** Outcomes of an incoming position (`aisits_detector_positions_total{outcome}`). */
export type PositionOutcome = 'processed' | 'stale';

/**
 * Detector metrics of spec §10: `aisits_detector_evaluations_total{detector}`,
 * `aisits_detector_alerts_total{detector,severity}` and
 * `aisits_detector_duration_seconds{detector}` (evaluations are `onPosition`
 * and `onTick` calls), plus `aisits_detector_errors_total{detector,hook}`
 * (thrown or timed out), `aisits_detector_skipped_total{detector,hook}` and
 * `aisits_detector_positions_total{outcome}`.
 */
export class DetectorMetrics {
  readonly evaluations: Counter<'detector'>;
  readonly alerts: Counter<'detector' | 'severity'>;
  readonly duration: Histogram<'detector'>;
  readonly errors: Counter<'detector' | 'hook'>;
  /** Calls skipped because the detector's previous call for the vessel timed out and still runs. */
  readonly skipped: Counter<'detector' | 'hook'>;
  readonly positions: Counter<'outcome'>;

  constructor(metrics: MetricsService = new MetricsService()) {
    this.evaluations = metrics.counter({
      name: 'detector_evaluations_total',
      help: 'Detector evaluations (onPosition and onTick calls) by detector.',
      labelNames: ['detector'],
    });
    this.alerts = metrics.counter({
      name: 'detector_alerts_total',
      help: 'Alerts published by detector and severity (raised or escalated).',
      labelNames: ['detector', 'severity'],
    });
    this.duration = metrics.histogram({
      name: 'detector_duration_seconds',
      help: 'Duration of detector evaluations in seconds by detector.',
      labelNames: ['detector'],
    });
    this.errors = metrics.counter({
      name: 'detector_errors_total',
      help: 'Detector calls that threw or timed out, by detector and hook.',
      labelNames: ['detector', 'hook'],
    });
    this.skipped = metrics.counter({
      name: 'detector_skipped_total',
      help: 'Detector calls skipped while a timed-out call for the same vessel was still running, by detector and hook.',
      labelNames: ['detector', 'hook'],
    });
    this.positions = metrics.counter({
      name: 'detector_positions_total',
      help: 'Positions received by the detector runner by outcome (processed, stale).',
      labelNames: ['outcome'],
    });
  }
}
