/**
 * Plumbing of the kit's runners, exported for the kit's own packages, tests
 * and diagnostics. NOT part of the public API: anything here may change in
 * any release (no semver guarantees). Services use the public subpaths.
 *
 * @packageDocumentation
 */
export {
  type ConsumerEnsureOutcome,
  consumerDrift,
  durableConsumerConfig,
  ensureDurableConsumer,
  orderedConsumerOptions,
  serverMaxDeliver,
} from '../nats/consumer-config.js';
export { NatsConsumerRuntime } from '../nats/consumer-runtime.js';
export {
  checkCorePayload,
  contractsCorePayloadSchema,
  type CorePayloadCheck,
  type CoreSubscriptionSettings,
  coreSubscriptionQueue,
  coreSubscriptionSettings,
  getCoreSubscriptionSettings,
} from '../nats/core-subscriptions.js';
export {
  decideFailure,
  type DeliveryPolicy,
  type FailureDecision,
  retryDelayMs,
} from '../nats/delivery-policy.js';
export {
  type ConsumerRuntime,
  type ConsumerState,
  DurableConsumerRunner,
  type DurableConsumerRunnerOptions,
  idleHeartbeatMsFor,
  orderingWarning,
  pinContactTimeoutMsFor,
  pullExpiresMsFor,
} from '../nats/durable-consumer-runner.js';
export {
  type DurableHandlerSettings,
  durableHandlerSettings,
  EVENT_HANDLER_METADATA,
  type EventHandlerMetadata,
  type ExclusiveConsumerSettings,
  getEventHandlerMetadata,
  withDurableName,
} from '../nats/event-handler.decorator.js';
export { headerValue } from '../nats/headers.js';
export {
  type BoundEventHandler,
  eventContextOf,
  type LogContextRunner,
  readDelivery,
  type ReadDelivery,
} from '../nats/message-processing.js';
export {
  envelopeMessageSize,
  headerBlockBytes,
  isMaxPayloadError,
  jetStreamPublishHeaders,
} from '../nats/message-size.js';
export {
  OrderedConsumerRunner,
  type OrderedConsumerSpec,
  orderedSpecOf,
} from '../nats/ordered-consumer.js';
export {
  OUTBOX_LAST_ERROR_MAX_LENGTH,
  type OutboxClaimedRow,
  type OutboxKeyRun,
  type OutboxPlan,
  outboxRetryDelayMs,
  planOutboxRuns,
  sanitizeOutboxError,
} from '../nats/outbox-plan.js';
export {
  isNoStreamError,
  planStreamUpdate,
  streamConfig,
  streamDrift,
  type StreamDriftPlan,
  type StreamEnsureOptions,
  streamUpdateConfig,
} from '../nats/stream-manager.js';
