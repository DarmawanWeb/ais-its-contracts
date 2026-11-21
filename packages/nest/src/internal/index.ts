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
  type CoreSubscriptionSettings,
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
  DurableConsumerRunner,
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
  OrderedConsumerRunner,
  type OrderedConsumerSpec,
  orderedSpecOf,
} from '../nats/ordered-consumer.js';
export {
  planStreamUpdate,
  streamConfig,
  streamDrift,
  type StreamDriftPlan,
  streamUpdateConfig,
} from '../nats/stream-manager.js';
