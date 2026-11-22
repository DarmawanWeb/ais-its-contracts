import {
  encodeEnvelope,
  type EventPayload,
  type EventType,
  makeEnvelope,
  type StreamName,
  streamForSubject,
  subjectForEvent,
  type TypedEventEnvelope,
} from '@darmawanweb/ais-its-contracts/events';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type {
  JetStreamClient,
  JetStreamPublishOptions,
  PubAck,
  StreamExpectations,
} from '@nats-io/jetstream';
import { headers as natsHeaders } from '@nats-io/transport-node';

import { errorMessage } from '../common/retry.js';

import { InjectConfig } from '../config/config.module.js';
import type { BaseConfig } from '../config/env-schema.js';
import {
  currentTraceparent,
  injectTraceContext,
  SpanKind,
  withSpan,
} from '../telemetry/trace-context.js';
import { EventSubjectMismatchError, EventTooLargeError } from './errors.js';
import { EVENT_TYPE_HEADER } from './headers.js';
import {
  headerBlockBytes,
  isMaxPayloadError,
  jetStreamPublishHeaders,
} from './message-size.js';
import { NatsClient, type NatsHandles } from './nats-client.js';
import { NatsMetrics } from './nats.metrics.js';
import { isNoStreamError, StreamManager } from './stream-manager.js';

/**
 * `max_payload` of the connection behind `handles` (read from the handles,
 * not `NatsClient.maxPayloadBytes()`, so publishers over test doubles that
 * only implement `ready()` keep working; no check without a connection).
 */
function maxPayloadOf(
  handles: Partial<Pick<NatsHandles, 'connection'>>,
): number | undefined {
  return handles.connection?.info?.max_payload;
}

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
 * An event whose message (envelope and headers) exceeds the server's
 * `max_payload` is refused with {@link EventTooLargeError} before anything
 * is sent (`aisits_events_published_total{outcome="rejected"}`). When a
 * stream this process produces to (`NatsModule.forRoot({ streams })`) was
 * deleted at runtime, the publish that finds no stream re-creates it
 * (`StreamManager.ensure(…, { refresh: true })`) and is retried once.
 *
 * @example
 * const { envelope, ack } = await this.events.publishEvent(
 *   EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot,
 * );
 */
@Injectable()
export class EventPublisher {
  private readonly logger = new Logger('EventPublisher');

  constructor(
    private readonly client: NatsClient,
    @InjectConfig() private readonly config: BaseConfig,
    private readonly metrics: NatsMetrics,
    // Explicit token: a union type has no usable design-time metadata.
    @Optional()
    @Inject(StreamManager)
    private readonly streams: StreamManager | null = null,
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
   *
   * @throws {InvalidEventError} when `data` violates the contract.
   * @throws {EventTooLargeError} when the message exceeds the server's
   *   `max_payload` (nothing is sent).
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
   * in input order; rejects with the first failure (others may be stored),
   * e.g. {@link EventTooLargeError} for an item over `max_payload`.
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
        const msgId = options.msgId ?? envelope.id;
        const publishOptions: Partial<JetStreamPublishOptions> = {
          msgID: msgId,
          headers,
          ...(options.timeoutMs === undefined
            ? {}
            : { timeout: options.timeoutMs }),
          ...(options.expect === undefined ? {} : { expect: options.expect }),
        };
        const bytes = encodeEnvelope(
          envelope as Parameters<typeof encodeEnvelope>[0],
        );
        const handles = await this.client.ready();
        const { jetstream } = handles;
        const maxBytes = maxPayloadOf(handles);
        const sizeBytes =
          bytes.length +
          headerBlockBytes(
            headers,
            jetStreamPublishHeaders(msgId, options.expect),
          );
        if (maxBytes !== undefined && sizeBytes > maxBytes) {
          this.metrics.published.inc({ type, outcome: 'rejected' });
          throw new EventTooLargeError(type, sizeBytes, maxBytes);
        }
        try {
          const ack = await this.publishToStream(
            jetstream,
            target,
            bytes,
            publishOptions,
          );
          this.metrics.published.inc({
            type,
            outcome: ack.duplicate ? 'duplicate' : 'stored',
          });
          return { envelope, ack };
        } catch (error) {
          if (isMaxPayloadError(error)) {
            // The client's own check (a server limit lowered since connecting).
            this.metrics.published.inc({ type, outcome: 'rejected' });
            throw new EventTooLargeError(
              type,
              sizeBytes,
              maxPayloadOf(handles) ?? maxBytes ?? 0,
              { cause: error },
            );
          }
          this.metrics.published.inc({ type, outcome: 'failed' });
          throw error;
        }
      },
    );
  }

  /**
   * Publishes; when no stream binds the subject although this process
   * produces to its stream (deleted at runtime), re-creates the stream and
   * retries once.
   */
  private async publishToStream(
    jetstream: JetStreamClient,
    subject: string,
    data: Uint8Array,
    options: Partial<JetStreamPublishOptions>,
  ): Promise<PubAck> {
    try {
      return await jetstream.publish(subject, data, options);
    } catch (error) {
      const stream = this.recoverableStream(subject, error);
      if (stream === undefined || this.streams === null) throw error;
      try {
        await this.streams.ensure([stream], 'producer', { refresh: true });
      } catch (ensureError) {
        this.logger.warn(
          `Stream ${stream} is missing and could not be re-created: ${errorMessage(ensureError)}`,
        );
        throw error;
      }
      this.logger.warn(
        `Stream ${stream} was missing: re-created, retrying the publish`,
      );
      return jetstream.publish(subject, data, options);
    }
  }

  /** The produced stream of `subject` when `error` says it is missing. */
  private recoverableStream(
    subject: string,
    error: unknown,
  ): StreamName | undefined {
    if (this.streams === null || !isNoStreamError(error)) return undefined;
    const definition = streamForSubject(subject);
    if (definition === undefined) return undefined;
    return this.streams.roleOf(definition.name) === 'producer'
      ? definition.name
      : undefined;
  }
}
