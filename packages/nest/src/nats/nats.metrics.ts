import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Counter, Histogram } from 'prom-client';

import { MetricsService } from '../metrics/metrics.service.js';

/** Outcomes of a consumed message (`aisits_events_consumed_total{outcome}`). */
export type ConsumeOutcome =
  /** Handled and acknowledged. */
  | 'ack'
  /** Failed, redelivery scheduled. */
  | 'nak'
  /** `NonRetryableError`: terminated. */
  | 'term'
  /** Deliveries exhausted: copied to the DLQ and acknowledged. */
  | 'dead_letter'
  /** Invalid JSON, envelope or payload: terminated. */
  | 'invalid'
  /** Event type not handled by this consumer: acknowledged. */
  | 'skipped'
  /** Ordered consumer handler failure (no redelivery possible). */
  | 'error'
  /** Handled (ordered consumers do not acknowledge). */
  | 'handled';

/**
 * Event metrics of spec §10: `aisits_events_published_total{type,outcome}`,
 * `aisits_events_consumed_total{stream,consumer,outcome}`,
 * `aisits_events_invalid_total{stream,consumer,reason}` and
 * `aisits_event_handler_duration_seconds{stream,consumer,outcome}`, plus
 * `aisits_events_consumer_recoveries_total{stream,consumer,outcome}` and
 * `aisits_events_consumer_activations_total{consumer}`.
 */
@Injectable()
export class NatsMetrics {
  readonly published: Counter<'type' | 'outcome'>;
  readonly consumed: Counter<'stream' | 'consumer' | 'outcome'>;
  readonly invalid: Counter<'stream' | 'consumer' | 'reason'>;
  readonly handlerDuration: Histogram<'stream' | 'consumer' | 'outcome'>;
  /** Recoveries of missing streams/consumers by outcome (`recreated`, `checked`, `failed`). */
  readonly consumerRecoveries: Counter<'stream' | 'consumer' | 'outcome'>;
  /** Times this instance became the active one of an exclusive consumer. */
  readonly consumerActivations: Counter<'consumer'>;

  constructor(
    @Optional() @Inject(MetricsService) metrics: MetricsService | null = null,
  ) {
    const registry = metrics ?? new MetricsService();
    this.published = registry.counter({
      name: 'events_published_total',
      help: 'Events published to JetStream by type and outcome (stored, duplicate, failed, rejected = larger than max_payload).',
      labelNames: ['type', 'outcome'],
    });
    this.consumed = registry.counter({
      name: 'events_consumed_total',
      help: 'Events consumed by stream, consumer and outcome.',
      labelNames: ['stream', 'consumer', 'outcome'],
    });
    this.invalid = registry.counter({
      name: 'events_invalid_total',
      help: 'Consumed events rejected as invalid (JSON, envelope or payload) and terminated.',
      labelNames: ['stream', 'consumer', 'reason'],
    });
    this.handlerDuration = registry.histogram({
      name: 'event_handler_duration_seconds',
      help: 'Event handler duration in seconds by stream, consumer and outcome.',
      labelNames: ['stream', 'consumer', 'outcome'],
    });
    this.consumerRecoveries = registry.counter({
      name: 'events_consumer_recoveries_total',
      help: 'Recoveries of durable consumers whose consumer or stream went missing, by outcome (recreated, checked, failed).',
      labelNames: ['stream', 'consumer', 'outcome'],
    });
    this.consumerActivations = registry.counter({
      name: 'events_consumer_activations_total',
      help: 'Times this instance became the active (pinned) instance of an exclusive durable consumer.',
      labelNames: ['consumer'],
    });
  }
}
