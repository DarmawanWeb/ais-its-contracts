import type { Counter, Histogram } from 'prom-client';

import { MetricsService } from '../metrics/metrics.service.js';

/** Hooks of a detector, the `hook` label of `aisits_detector_errors_total`. */
export type DetectorHook =
  | 'onPosition'
  | 'onTick'
  | 'onZoneChanged'
  | 'onVesselChanged'
  | 'onActivated'
  | 'onDeactivated';

/** Outcomes of an incoming position (`aisits_detector_positions_total{outcome}`). */
export type PositionOutcome = 'processed' | 'stale';

/** Outcomes of an activation (`aisits_detector_activations_total{outcome}`). */
export type ActivationOutcome = 'completed' | 'failed';

/**
 * Detector metrics of spec §10: `aisits_detector_evaluations_total{detector}`,
 * `aisits_detector_alerts_total{detector,severity}` and
 * `aisits_detector_duration_seconds{detector}` (evaluations are `onPosition`
 * and `onTick` calls), plus `aisits_detector_errors_total{detector,hook}`
 * (thrown or timed out), `aisits_detector_skipped_total{detector,hook}`,
 * `aisits_detector_positions_total{outcome}`,
 * `aisits_detector_alert_resolutions_total{detector}` and
 * `aisits_detector_activations_total{outcome}`.
 */
export class DetectorMetrics {
  readonly evaluations: Counter<'detector'>;
  readonly alerts: Counter<'detector' | 'severity'>;
  readonly duration: Histogram<'detector'>;
  readonly errors: Counter<'detector' | 'hook'>;
  /** Calls skipped because the detector's previous call for the vessel timed out and still runs. */
  readonly skipped: Counter<'detector' | 'hook'>;
  readonly positions: Counter<'outcome'>;
  /** Occurrences resolved through `DetectorContext.alerts.resolve`, by detector. */
  readonly resolutions: Counter<'detector'>;
  /** Activations of this instance (its exclusive position consumer was pinned), by outcome. */
  readonly activations: Counter<'outcome'>;

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
    this.resolutions = metrics.counter({
      name: 'detector_alert_resolutions_total',
      help: 'Alert occurrences resolved by detector (announced with alert.resolved.v1 unless re-raised within the cooldown).',
      labelNames: ['detector'],
    });
    this.activations = metrics.counter({
      name: 'detector_activations_total',
      help: 'Activations of this detector instance (exclusive position consumer pinned: alerts reloaded, onActivated called) by outcome (completed, failed).',
      labelNames: ['outcome'],
    });
  }
}
