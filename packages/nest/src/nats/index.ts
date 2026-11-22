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
  type ConsumerState,
} from './durable-consumer-runner.js';
export {
  DeadLetterError,
  EventSubjectMismatchError,
  EventTooLargeError,
  NonRetryableError,
  RetryableError,
} from './errors.js';
export {
  type CoreMessageHandler,
  type CoreMessageOutcome,
  type CorePayloadSchema,
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
  type ExclusiveConsumerEvent,
  type ExclusiveConsumerListener,
  type ExclusiveConsumerOptions,
  type ExclusiveConsumerTransition,
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
  DEFAULT_HEADER_ALLOWANCE_BYTES,
  eventMessageSize,
  type EventMessageSizeOptions,
} from './message-size.js';
export {
  type NatsHandles,
  NatsClient,
  NatsNotConnectedError,
} from './nats-client.js';
export { NatsHealthIndicator } from './nats.health.js';
export { type ConsumeOutcome, NatsMetrics } from './nats.metrics.js';
export { NatsModule } from './nats.module.js';
export {
  DEFAULT_MIN_MAX_PAYLOAD_BYTES,
  NATS_OPTIONS,
  type NatsModuleOptions,
} from './nats.options.js';
export { CatchUpTimeoutError } from './ordered-consumer.js';
export {
  OrderedConsumers,
  type OrderedSubscription,
  type OrderedSubscriptionOptions,
} from './ordered-consumers.service.js';
export {
  type StreamEnsureOptions,
  type StreamEnsureOutcome,
  type StreamEnsureRole,
  StreamManager,
} from './stream-manager.js';
export {
  type ReplayEnd,
  type ReplayOptions,
  type ReplayReport,
  StreamReplayer,
} from './stream-replayer.js';
export {
  enqueueEvent,
  type EnqueueEventOptions,
  OUTBOX_OPTIONS,
  OUTBOX_TABLE,
  OutboxConfigError,
  OutboxModule,
  type OutboxModuleAsyncOptions,
  type OutboxModuleOptions,
  type OutboxQueryable,
  OutboxRelay,
  type OutboxRelayMode,
  type OutboxRelayResult,
  outboxTableSql,
  outboxUpgradeSql,
} from './outbox.js';
export {
  DEFAULT_OUTBOX_RETRY_BASE_MS,
  DEFAULT_OUTBOX_RETRY_MAX_MS,
  type OutboxRetryOptions,
} from './outbox-plan.js';
