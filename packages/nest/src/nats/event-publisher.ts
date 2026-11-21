import {
  encodeEnvelope,
  type EventPayload,
  type EventType,
  makeEnvelope,
  subjectForEvent,
  type TypedEventEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import { Injectable } from '@nestjs/common';
import type {
  JetStreamPublishOptions,
  PubAck,
  StreamExpectations,
} from '@nats-io/jetstream';
import { headers as natsHeaders } from '@nats-io/transport-node';

import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import {
  currentTraceparent,
  injectTraceContext,
  SpanKind,
  withSpan,
} from '../telemetry/trace-context.js';
import { EventSubjectMismatchError } from './errors.js';
import { EVENT_TYPE_HEADER } from './headers.js';
import { NatsClient } from './nats-client.js';
import { NatsMetrics } from './nats.metrics.js';

/** Options of one publish. */
export interface PublishOptions {
  /**
   * `Nats-Msg-Id` for JetStream deduplication (2 min window). Default: the
   * envelope id. Use a natural key to deduplicate retries of the same fact,
   * e.g. the ingestor's `<mmsi>:<positionTime>:<source>`.
   */
  readonly msgId?: string | undefined;
  /** Envelope `id` (default: a new UUID v7). */
  readonly id?: string | undefined;
  /** Envelope `time` (default: now). */
  readonly time?: Date | undefined;
  /** Envelope `subject` (entity key; default derived from the payload). */
  readonly entityKey?: string | undefined;
  /** Optimistic concurrency expectations (`expect` of the JetStream publish). */
  readonly expect?: Partial<StreamExpectations> | undefined;
  /** Publish ack timeout, ms. */
  readonly timeoutMs?: number | undefined;
}

/** One message of {@link EventPublisher.publishMany}. */
export interface PublishItem<Type extends EventType = EventType> {
  readonly type: Type;
  readonly data: EventPayload<Type>;
  /**
   * NATS subject; derived with the contracts `subjectForEvent` when omitted.
   * When given it must equal the derived one ({@link EventSubjectMismatchError}).
   */
  readonly subject?: string | undefined;
  readonly options?: PublishOptions | undefined;
}

/** Result of a publish: the stored envelope and the JetStream ack. */
export interface PublishResult<Type extends EventType = EventType> {
  readonly envelope: TypedEventEnvelope<Type>;
  readonly ack: PubAck;
}

/** In-flight publishes of `publishMany`. */
const PUBLISH_MANY_CONCURRENCY = 64;

/**
 * Publishes contracts events to JetStream (spec §7.1): builds the envelope
 * (`source` = `SERVICE_NAME`, UUID v7 id, ISO time, W3C `traceparent`),
 * validates the payload against the contracts registry (throws
 * `InvalidEventError` on a contract violation), and publishes with
 * `Nats-Msg-Id`, `traceparent`, `content-type` and `Ais-Its-Event-Type` headers.
 * The subject is always the contracts subject of the event
 * (`subjectForEvent`): an explicit subject that differs is refused with
 * {@link EventSubjectMismatchError}.
 *
 * @example
 * const { envelope, ack } = await this.events.publishEvent(
 *   EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot,
 * );
 */
@Injectable()
export class EventPublisher {
  constructor(
    private readonly client: NatsClient,
    @InjectConfig() private readonly config: BaseConfig,
    private readonly metrics: NatsMetrics,
  ) {}

  /**
   * Publishes `data` of `type` and resolves with the PubAck. `subject` must
   * be the contracts subject of the event.
   *
   * @deprecated Use {@link publishEvent}, which derives the subject and also
   *   returns the envelope.
   * @throws {EventSubjectMismatchError} when `subject` is not the event's subject.
   */
  async publish<Type extends EventType>(
    subject: string,
    type: Type,
    data: EventPayload<Type>,
    options: PublishOptions = {},
  ): Promise<PubAck> {
    return (await this.send(subject, type, data, options)).ack;
  }

  /**
   * Publishes to the subject derived from the event (contracts
   * `subjectForEvent`) and returns the envelope too.
   */
  async publishEvent<Type extends EventType>(
    type: Type,
    data: EventPayload<Type>,
    options: PublishOptions = {},
  ): Promise<PublishResult<Type>> {
    return this.send(undefined, type, data, options);
  }

  /**
   * Publishes several events, at most 64 in flight. Resolves with the acks
   * in input order; rejects with the first failure (others may be stored).
   */
  async publishMany(items: readonly PublishItem[]): Promise<PubAck[]> {
    const acks: PubAck[] = new Array<PubAck>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const index = next;
        next += 1;
        const item = items[index];
        if (item === undefined) continue;
        acks[index] = (
          await this.send(
            item.subject,
            item.type,
            item.data,
            item.options ?? {},
          )
        ).ack;
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(PUBLISH_MANY_CONCURRENCY, items.length) },
        () => worker(),
      ),
    );
    return acks;
  }

  private async send<Type extends EventType>(
    subject: string | undefined,
    type: Type,
    data: EventPayload<Type>,
    options: PublishOptions,
  ): Promise<PublishResult<Type>> {
    return withSpan(
      `${type} publish`,
      { kind: SpanKind.PRODUCER, attributes: { 'messaging.system': 'nats' } },
      async () => {
        const envelope = makeEnvelope({
          type,
          source: this.config.SERVICE_NAME,
          data,
          subject: options.entityKey,
          traceparent: currentTraceparent(),
          id: options.id,
          time: options.time,
        });
        // `subjectForEvent` takes the union of envelopes; a typed one is a member.
        const target = subjectForEvent(
          envelope as Parameters<typeof subjectForEvent>[0],
        );
        if (subject !== undefined && subject !== target) {
          this.metrics.published.inc({ type, outcome: 'failed' });
          throw new EventSubjectMismatchError(
            `${type} belongs on subject ${target}, not ${subject}`,
          );
        }
        const headers = natsHeaders();
        headers.set('content-type', 'application/json');
        headers.set(EVENT_TYPE_HEADER, type);
        injectTraceContext(headers);
        const publishOptions: Partial<JetStreamPublishOptions> = {
          msgID: options.msgId ?? envelope.id,
          headers,
          ...(options.timeoutMs === undefined
            ? {}
            : { timeout: options.timeoutMs }),
          ...(options.expect === undefined ? {} : { expect: options.expect }),
        };
        const { jetstream } = await this.client.ready();
        try {
          const ack = await jetstream.publish(
            target,
            encodeEnvelope(envelope as Parameters<typeof encodeEnvelope>[0]),
            publishOptions,
          );
          this.metrics.published.inc({
            type,
            outcome: ack.duplicate ? 'duplicate' : 'stored',
          });
          return { envelope, ack };
        } catch (error) {
          this.metrics.published.inc({ type, outcome: 'failed' });
          throw error;
        }
      },
    );
  }
}
