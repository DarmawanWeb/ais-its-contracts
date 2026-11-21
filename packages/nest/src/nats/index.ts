/**
 * NATS JetStream (spec §7): connection, streams, publisher, the
 * `@EventHandler` consumer framework, ordered consumers and replays.
 *
 * @packageDocumentation
 */
export {
  type ConsumerEnsureOutcome,
  consumerDrift,
  ConsumerUpdateError,
  durableConsumerConfig,
  ensureDurableConsumer,
  orderedConsumerOptions,
  serverMaxDeliver,
} from './consumer-config.js';
export {
  type ConsumerEnvelope,
  type ConsumerEventType,
  type DurableConsumerRef,
  type OrderedConsumerRef,
  resolveDurableConsumer,
  resolveOrderedConsumer,
  UnknownConsumerError,
} from './consumer-definitions.js';
export { NatsConsumerRuntime } from './consumer-runtime.js';
export {
  decideFailure,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  type DeliveryPolicy,
  type FailureDecision,
  retryDelayMs,
} from './delivery-policy.js';
export {
  CONSUMER_STALL_THRESHOLD_MS,
  type ConsumerHealth,
  type ConsumerRuntime,
  DurableConsumerRunner,
} from './durable-consumer-runner.js';
export {
  EventSubjectMismatchError,
  NonRetryableError,
  RetryableError,
} from './errors.js';
export {
  DuplicateConsumerHandlerError,
  EventConsumers,
  type RunningConsumer,
} from './event-consumers.js';
export {
  DEFAULT_ACK_WAIT_MS,
  DEFAULT_PINNED_TTL_MS,
  type DurableHandlerSettings,
  durableHandlerSettings,
  EVENT_HANDLER_METADATA,
  EXCLUSIVE_CONSUMER_GROUP,
  type ExclusiveConsumerOptions,
  type ExclusiveConsumerSettings,
  type EventContext,
  EventHandler,
  type EventHandlerMetadata,
  type EventHandlerMethod,
  type EventHandlerOptions,
  getEventHandlerMetadata,
  type OrderedDeliverPolicy,
  OrderedEventHandler,
  type OrderedEventHandlerOptions,
  withDurableName,
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
  headerValue,
  MAX_HEADER_VALUE_LENGTH,
} from './headers.js';
export {
  type BoundEventHandler,
  eventContextOf,
  type LogContextRunner,
  readDelivery,
  type ReadDelivery,
} from './message-processing.js';
export {
  type NatsHandles,
  NatsClient,
  NatsNotConnectedError,
} from './nats-client.js';
export { NatsHealthIndicator } from './nats.health.js';
export { type ConsumeOutcome, NatsMetrics } from './nats.metrics.js';
export { NatsModule } from './nats.module.js';
export { NATS_OPTIONS, type NatsModuleOptions } from './nats.options.js';
export {
  CatchUpTimeoutError,
  OrderedConsumerRunner,
  type OrderedConsumerSpec,
  orderedSpecOf,
} from './ordered-consumer.js';
export {
  OrderedConsumers,
  type OrderedSubscription,
  type OrderedSubscriptionOptions,
} from './ordered-consumers.service.js';
export {
  planStreamUpdate,
  streamConfig,
  streamDrift,
  type StreamDriftPlan,
  type StreamEnsureOutcome,
  type StreamEnsureRole,
  StreamManager,
  streamUpdateConfig,
} from './stream-manager.js';
export {
  type ReplayOptions,
  type ReplayReport,
  StreamReplayer,
} from './stream-replayer.js';
