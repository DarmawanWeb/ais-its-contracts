/**
 * Event contracts (spec 7): envelope, event types, payload schemas, the schema
 * registry, NATS JetStream streams, consumers and subject builders.
 *
 * @packageDocumentation
 */
export * from './catalog.js';
export * from './codec.js';
export * from './consumers.js';
export * from './envelope.js';
export {
  EVENT_FAILURE_REASONS,
  type EventFailure,
  type EventFailureReason,
  InvalidEventError,
} from './failure.js';
export * from './payloads/index.js';
export * from './registry.js';
export * from './services.js';
export * from './streams.js';
export { subjectMatchesFilter } from './subject-match.js';
export * from './subjects.js';
export * from './types.js';
