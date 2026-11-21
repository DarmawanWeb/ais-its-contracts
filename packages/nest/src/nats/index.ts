/**
 * NATS (spec §7): connection, streams, publisher, the `@EventHandler`
 * consumer framework, ordered consumers, replays, core subscriptions and the
 * transactional outbox. Runner plumbing lives in `./internal` (no semver
 * guarantees).
 *
 * @packageDocumentation
 */
export { ConsumerUpdateError } from './consumer-config.js';
export {
  type ConsumerEnvelope,
  type ConsumerEventType,
  type DurableConsumerRef,
  type OrderedConsumerRef,
  resolveDurableConsumer,
  resolveOrderedConsumer,
  UnknownConsumerError,
} from './consumer-definitions.js';
export {
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
} from './delivery-policy.js';
export {
  CONSUMER_STALL_THRESHOLD_MS,
  type ConsumerHealth,
} from './durable-consumer-runner.js';
export {
  EventSubjectMismatchError,
  NonRetryableError,
  RetryableError,
} from './errors.js';
export {
  type CoreMessageHandler,
  type CoreMessageOutcome,
  CoreSubscriptionConfigError,
  CoreSubscriptionHandler,
  type CoreSubscriptionHandlerOptions,
  type CoreSubscriptionName,
  CoreSubscriptions,
  DuplicateCoreSubscriptionHandlerError,
} from './core-subscriptions.js';
export {
  DuplicateConsumerHandlerError,
  EventConsumers,
  type RunningConsumer,
} from './event-consumers.js';
/** The core NATS message handed to `@CoreSubscriptionHandler()` methods. */
export type { Msg } from '@nats-io/transport-node';
export {
  DEFAULT_ACK_WAIT_MS,
  DEFAULT_PINNED_TTL_MS,
  EXCLUSIVE_CONSUMER_GROUP,
  type ExclusiveConsumerOptions,
  type EventContext,
  EventHandler,
  type EventHandlerMethod,
  type EventHandlerOptions,
  type OrderedDeliverPolicy,
  OrderedEventHandler,
  type OrderedEventHandlerOptions,
} from './event-handler.decorator.js';
export {
  EventPublisher,
  type PublishItem,
  type PublishOptions,
  type PublishResult,
} from './event-publisher.js';
export {
  DLQ_HEADERS,
  EVENT_TYPE_HEADER,
  MAX_HEADER_VALUE_LENGTH,
} from './headers.js';
export {
  type NatsHandles,
  NatsClient,
  NatsNotConnectedError,
} from './nats-client.js';
export { NatsHealthIndicator } from './nats.health.js';
export { type ConsumeOutcome, NatsMetrics } from './nats.metrics.js';
export { NatsModule } from './nats.module.js';
export { NATS_OPTIONS, type NatsModuleOptions } from './nats.options.js';
export { CatchUpTimeoutError } from './ordered-consumer.js';
export {
  OrderedConsumers,
  type OrderedSubscription,
  type OrderedSubscriptionOptions,
} from './ordered-consumers.service.js';
export {
  type StreamEnsureOutcome,
  type StreamEnsureRole,
  StreamManager,
} from './stream-manager.js';
export {
  type ReplayOptions,
  type ReplayReport,
  StreamReplayer,
} from './stream-replayer.js';
export {
  enqueueEvent,
  type EnqueueEventOptions,
  OUTBOX_OPTIONS,
  OUTBOX_TABLE,
  OutboxModule,
  type OutboxModuleOptions,
  type OutboxQueryable,
  OutboxRelay,
  type OutboxRelayResult,
  outboxTableSql,
} from './outbox.js';
