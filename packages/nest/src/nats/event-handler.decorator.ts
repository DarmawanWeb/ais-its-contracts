import type {
  AnyEventEnvelope,
  DurableConsumerDefinition,
  OrderedConsumerDefinition,
} from '@darmawanweb/ais-its-contracts/events';
import type { MsgHdrs } from '@nats-io/transport-node';

import {
  type ConsumerEnvelope,
  type DurableConsumerRef,
  type OrderedConsumerRef,
  resolveDurableConsumer,
  resolveOrderedConsumer,
} from './consumer-definitions.js';

/** Metadata key of {@link EventHandler} / {@link OrderedEventHandler}. */
export const EVENT_HANDLER_METADATA = 'aisits:nats:event-handler';

/** Delivery facts passed to a handler next to the envelope. */
export interface EventContext {
  /** NATS subject of the message. */
  readonly subject: string;
  readonly stream: string;
  /** Durable name, or the ordered consumer's name. */
  readonly consumer: string;
  readonly streamSequence: number;
  /** 1-based; `> 1` means a redelivery (handlers MUST be idempotent). */
  readonly deliveryCount: number;
  /** Message headers (`Nats-Msg-Id`, `traceparent`, …). */
  readonly headers: MsgHdrs | undefined;
  /** When the message was stored in the stream. */
  readonly storedAt: Date;
  /** Aborted when the shutdown deadline is reached. */
  readonly signal: AbortSignal;
  /** Extends the ack deadline (the platform already does it periodically). */
  working(): void;
}

/** A handler method of consumer `Ref`. */
export type EventHandlerMethod<Envelope> = (
  event: Envelope,
  context: EventContext,
) => void | Promise<void>;

/** Options of {@link EventHandler}. */
export interface EventHandlerOptions<Ref extends DurableConsumerRef> {
  /** A contracts `CONSUMERS` key (e.g. `'emission-positions'`) or an explicit definition. */
  readonly consumer: Ref;
  /** Messages handled in parallel. Default 1. */
  readonly concurrency?: number | undefined;
  /**
   * With `concurrency > 1`, messages of the same NATS subject (same vessel)
   * are still handled one after the other, in stream order. Default `true`.
   */
  readonly orderBySubject?: boolean | undefined;
  /** Deliveries before dead-lettering. Default: the definition's `maxDeliver` (10). */
  readonly maxDeliver?: number | undefined;
  /** Redelivery timeout of an unacknowledged message, ms. Default 30 s (heartbeats keep long handlers alive). */
  readonly ackWaitMs?: number | undefined;
  /** Retry delays, ms, by failed delivery; the last repeats. Default exponential 1 s … 60 s. */
  readonly backoffMs?: readonly number[] | undefined;
  /**
   * Most messages delivered to this consumer but not yet acknowledged
   * (server-side `max_ack_pending`): bounds the messages buffered by the
   * process, which are all kept alive with heartbeats while they wait.
   * Messages waiting for a `nak` redelivery count too. Default
   * `max(16, 4 × concurrency)`.
   */
  readonly maxAckPending?: number | undefined;
  /**
   * Single active instance: with several replicas only one receives
   * messages; the others stand by and take over when it stops pulling for
   * `pinnedTtlMs` (NATS ≥ 2.11 priority group, policy `pinned_client`).
   * Use it for handlers that keep per-entity state in memory. Default `false`.
   */
  readonly exclusive?: boolean | ExclusiveConsumerOptions | undefined;
}

/** Options of an exclusive (single active instance) consumer. */
export interface ExclusiveConsumerOptions {
  /** Time without pulls after which the server hands the consumer to a standby, ms. Default 30 s. */
  readonly pinnedTtlMs?: number | undefined;
}

/** Normalized {@link ExclusiveConsumerOptions}. */
export interface ExclusiveConsumerSettings {
  /** NATS priority group name. */
  readonly group: string;
  readonly pinnedTtlMs: number;
}

/** Priority group of exclusive consumers. */
export const EXCLUSIVE_CONSUMER_GROUP = 'active';

/** Default {@link ExclusiveConsumerOptions.pinnedTtlMs}, ms. */
export const DEFAULT_PINNED_TTL_MS = 30_000;

/**
 * Where an ordered consumer starts:
 *
 * - `'new'` — only messages stored after the consumer was created;
 * - `'all'` — the whole stream;
 * - `'last_per_subject'` — the latest message of every subject, then new
 *   ones: the snapshot of a compacted stream (`FLEET`, `GEO`, `SAFETY`, whose
 *   `max_msgs_per_subject` is 1) followed by its live changes;
 * - `{ startTime }` / `{ startSequence }` — from a point in the stream.
 */
export type OrderedDeliverPolicy =
  | 'new'
  | 'all'
  | 'last_per_subject'
  | { readonly startTime: Date }
  | { readonly startSequence: number };

/** Options of {@link OrderedEventHandler}. */
export interface OrderedEventHandlerOptions {
  /** A contracts `ORDERED_CONSUMERS` name (e.g. `'notification-positions'`) or an explicit definition. */
  readonly consumer: OrderedConsumerRef;
  /** Default `'new'`. */
  readonly deliver?: OrderedDeliverPolicy | undefined;
}

/** Normalized options of a durable handler. */
export interface DurableHandlerSettings {
  readonly definition: DurableConsumerDefinition;
  readonly concurrency: number;
  readonly orderBySubject: boolean;
  readonly maxDeliver: number;
  readonly ackWaitMs: number;
  readonly backoffMs: readonly number[] | undefined;
  readonly maxAckPending: number;
  /** Set for single-active-instance consumers. */
  readonly exclusive: ExclusiveConsumerSettings | undefined;
}

/** Metadata stored on a decorated method. */
export type EventHandlerMetadata =
  | { readonly kind: 'durable'; readonly settings: DurableHandlerSettings }
  | {
      readonly kind: 'ordered';
      readonly definition: OrderedConsumerDefinition;
      readonly deliver: OrderedDeliverPolicy;
    };

/** Default ack wait, ms. */
export const DEFAULT_ACK_WAIT_MS = 30_000;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

/** Normalizes and validates {@link EventHandlerOptions}. */
export function durableHandlerSettings(
  options: EventHandlerOptions<DurableConsumerRef>,
): DurableHandlerSettings {
  const definition = resolveDurableConsumer(options.consumer);
  return {
    definition,
    concurrency: positiveInteger(options.concurrency ?? 1, 'concurrency'),
    orderBySubject: options.orderBySubject ?? true,
    maxDeliver: positiveInteger(
      options.maxDeliver ?? definition.maxDeliver,
      'maxDeliver',
    ),
    ackWaitMs: positiveInteger(
      options.ackWaitMs ?? DEFAULT_ACK_WAIT_MS,
      'ackWaitMs',
    ),
    backoffMs: options.backoffMs,
    maxAckPending: positiveInteger(
      options.maxAckPending ?? Math.max(16, 4 * (options.concurrency ?? 1)),
      'maxAckPending',
    ),
    exclusive: exclusiveSettings(options.exclusive),
  };
}

function exclusiveSettings(
  option: boolean | ExclusiveConsumerOptions | undefined,
): ExclusiveConsumerSettings | undefined {
  if (option === undefined || option === false) return undefined;
  const pinnedTtlMs = option === true ? undefined : option.pinnedTtlMs;
  return {
    group: EXCLUSIVE_CONSUMER_GROUP,
    pinnedTtlMs: positiveInteger(
      pinnedTtlMs ?? DEFAULT_PINNED_TTL_MS,
      'pinnedTtlMs',
    ),
  };
}

/** Durable consumer names: letters, digits, `-` and `_` (no subject tokens). */
const DURABLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The same handler settings for a consumer of another name (a durable
 * prefix in tests, a detector subset): the definition is copied, the server
 * consumer is created under `durableName`.
 *
 * @throws {RangeError} for names NATS does not accept.
 */
export function withDurableName(
  settings: DurableHandlerSettings,
  durableName: string,
): DurableHandlerSettings {
  if (durableName === settings.definition.durableName) return settings;
  if (!DURABLE_NAME.test(durableName))
    throw new RangeError(`Invalid durable consumer name "${durableName}"`);
  return { ...settings, definition: { ...settings.definition, durableName } };
}

function defineHandlerMetadata(
  target: unknown,
  metadata: EventHandlerMetadata,
): void {
  if (typeof target !== 'function')
    throw new TypeError('@EventHandler decorates methods only');
  Reflect.defineMetadata(EVENT_HANDLER_METADATA, metadata, target);
}

/**
 * Marks a provider method as the handler of a durable pull consumer. Handlers
 * are discovered when the application bootstraps (the provider must be a
 * singleton in a module of the application); one handler per consumer.
 *
 * Semantics: valid message + handler resolves → `ack`; invalid JSON /
 * envelope / payload → `term` + `aisits_events_invalid_total`;
 * `NonRetryableError` → `term`; any other error → `nak` with backoff, and
 * after `maxDeliver` deliveries the message is copied to
 * `dlq.<stream>.<consumer>` (error in headers) and acked.
 *
 * Every message received by the process is kept alive with
 * `working()` heartbeats (every `ackWaitMs / 3`) from the moment it arrives
 * until it is settled, so slow handlers never cause redeliveries of
 * buffered messages. Messages of one subject are handled in stream order;
 * a message that failed and is redelivered after a `nak` may be handled
 * after later messages of its subject — handlers that keep "latest" state
 * compare versions or times (spec §7.1: handlers are idempotent).
 *
 * @example
 * @EventHandler({ consumer: 'emission-positions', concurrency: 8 })
 * async onPosition(event: ConsumerEnvelope<'emission-positions'>, context: EventContext) {
 *   await this.segments.record(event.data);
 * }
 */
export function EventHandler<const Ref extends DurableConsumerRef>(
  options: EventHandlerOptions<Ref>,
) {
  const settings = durableHandlerSettings(options);
  return <Method extends EventHandlerMethod<ConsumerEnvelope<Ref>>>(
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<Method>,
  ): void => {
    defineHandlerMetadata(descriptor.value, { kind: 'durable', settings });
  };
}

/**
 * Marks a provider method as the handler of an ordered (ephemeral, per
 * instance) consumer: every instance receives every message, starting at
 * `deliver` (default new messages). Nothing is acknowledged; handler errors
 * are logged and counted (outcome `error`) and processing continues.
 *
 * @example
 * @OrderedEventHandler({ consumer: 'notification-positions' })
 * onPosition(event: AnyEventEnvelope) { this.gateway.broadcast(event); }
 */
export function OrderedEventHandler(options: OrderedEventHandlerOptions) {
  const definition = resolveOrderedConsumer(options.consumer);
  const deliver = options.deliver ?? 'new';
  return <Method extends EventHandlerMethod<AnyEventEnvelope>>(
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<Method>,
  ): void => {
    defineHandlerMetadata(descriptor.value, {
      kind: 'ordered',
      definition,
      deliver,
    });
  };
}

/** Reads the handler metadata of a method, if any. */
export function getEventHandlerMetadata(
  method: unknown,
): EventHandlerMetadata | undefined {
  if (typeof method !== 'function') return undefined;
  const metadata: unknown = Reflect.getMetadata(EVENT_HANDLER_METADATA, method);
  return metadata === undefined
    ? undefined
    : (metadata as EventHandlerMetadata);
}
