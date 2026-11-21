import {
  AckPolicy,
  type ConsumerConfig,
  type ConsumerUpdateConfig,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type JetStreamManager,
  type OrderedConsumerOptions,
  type PriorityPolicy,
  ReplayPolicy,
} from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';

/** NATS priority policies used here (`PriorityPolicy` is exported as a type only). */
const PINNED_CLIENT: PriorityPolicy = 'pinned_client';
const NO_PRIORITY: PriorityPolicy = 'none';

import type {
  DurableHandlerSettings,
  OrderedDeliverPolicy,
} from './event-handler.decorator.js';

/** Result of ensuring a durable consumer. */
export type ConsumerEnsureOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Server-side `max_deliver` of a durable consumer. One delivery more than
 * the platform's `maxDeliver`: the platform dead-letters at delivery
 * `maxDeliver`; the spare delivery covers a crash during that last attempt,
 * so the message still reaches the DLQ instead of being dropped silently.
 */
export function serverMaxDeliver(maxDeliver: number): number {
  return maxDeliver + 1;
}

/** NATS configuration of a durable pull consumer (explicit acks, all messages). */
export function durableConsumerConfig(
  settings: DurableHandlerSettings,
): Partial<ConsumerConfig> {
  const { definition } = settings;
  return {
    durable_name: definition.durableName,
    description: definition.description,
    filter_subjects: [...definition.filterSubjects],
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    replay_policy: ReplayPolicy.Instant,
    ack_wait: nanos(settings.ackWaitMs),
    max_deliver: serverMaxDeliver(settings.maxDeliver),
    max_ack_pending: settings.maxAckPending,
    ...(settings.exclusive === undefined
      ? {}
      : {
          priority_groups: [settings.exclusive.group],
          priority_policy: PINNED_CLIENT,
          priority_timeout: nanos(settings.exclusive.pinnedTtlMs),
        }),
  };
}

function filterSubjectsOf(config: Partial<ConsumerConfig>): string[] {
  if (
    config.filter_subjects !== undefined &&
    config.filter_subjects.length > 0
  ) {
    return [...config.filter_subjects].sort();
  }
  return config.filter_subject === undefined || config.filter_subject === ''
    ? []
    : [config.filter_subject];
}

/** Updatable settings of `actual` that differ from `expected`. */
export function consumerDrift(
  expected: Partial<ConsumerConfig>,
  actual: Partial<ConsumerConfig>,
): string[] {
  const drift: string[] = [];
  if (
    filterSubjectsOf(expected).join('\n') !==
    filterSubjectsOf(actual).join('\n')
  )
    drift.push('filter_subjects');
  if ((expected.description ?? '') !== (actual.description ?? ''))
    drift.push('description');
  if (expected.ack_wait !== actual.ack_wait) drift.push('ack_wait');
  if (expected.max_deliver !== actual.max_deliver) drift.push('max_deliver');
  if (expected.max_ack_pending !== actual.max_ack_pending)
    drift.push('max_ack_pending');
  const priority = (config: Partial<ConsumerConfig>): string =>
    config.priority_policy === undefined ||
    config.priority_policy === NO_PRIORITY
      ? ''
      : `${config.priority_policy}:${(config.priority_groups ?? []).join(',')}:${config.priority_timeout ?? 0}`;
  if (priority(expected) !== priority(actual)) drift.push('priority');
  return drift;
}

/** Thrown when an existing consumer cannot be brought to its definition in place. */
export class ConsumerUpdateError extends Error {
  override readonly name = 'ConsumerUpdateError';
}

function isConsumerNotFound(error: unknown): boolean {
  return (
    error instanceof JetStreamApiError &&
    error.code === JetStreamApiCodes.ConsumerNotFound
  );
}

/**
 * Creates the durable consumer, or updates its updatable settings (filter,
 * description, ack wait, max deliver) when they drifted. Idempotent.
 */
export async function ensureDurableConsumer(
  manager: JetStreamManager,
  settings: DurableHandlerSettings,
): Promise<{
  readonly outcome: ConsumerEnsureOutcome;
  readonly drift: readonly string[];
}> {
  const { stream, durableName } = settings.definition;
  const expected = durableConsumerConfig(settings);
  let actual: Partial<ConsumerConfig>;
  try {
    actual = (await manager.consumers.info(stream, durableName)).config;
  } catch (error) {
    if (!isConsumerNotFound(error)) throw error;
    await manager.consumers.add(stream, expected);
    return { outcome: 'created', drift: [] };
  }
  const drift = consumerDrift(expected, actual);
  if (drift.length === 0) return { outcome: 'unchanged', drift };
  const update: Partial<ConsumerUpdateConfig> = {
    ...(expected.description === undefined
      ? {}
      : { description: expected.description }),
    ...(expected.filter_subjects === undefined
      ? {}
      : { filter_subjects: expected.filter_subjects }),
    ...(expected.ack_wait === undefined ? {} : { ack_wait: expected.ack_wait }),
    ...(expected.max_deliver === undefined
      ? {}
      : { max_deliver: expected.max_deliver }),
    ...(expected.max_ack_pending === undefined
      ? {}
      : { max_ack_pending: expected.max_ack_pending }),
    ...(drift.includes('priority')
      ? {
          priority_groups: expected.priority_groups ?? [],
          priority_policy: expected.priority_policy ?? NO_PRIORITY,
          ...(expected.priority_timeout === undefined
            ? {}
            : { priority_timeout: expected.priority_timeout }),
        }
      : {}),
  };
  try {
    await manager.consumers.update(stream, durableName, update);
  } catch (error) {
    throw new ConsumerUpdateError(
      `Consumer ${durableName} on ${stream} cannot be updated (${drift.join(', ')}): ` +
        `${error instanceof Error ? error.message : String(error)}; delete it to recreate it`,
      { cause: error },
    );
  }
  return { outcome: 'updated', drift };
}

/** Options of an ordered consumer starting at `deliver`. */
export function orderedConsumerOptions(
  filterSubjects: readonly string[],
  deliver: OrderedDeliverPolicy,
): Partial<OrderedConsumerOptions> {
  const filter = { filter_subjects: [...filterSubjects] };
  if (deliver === 'new')
    return { ...filter, deliver_policy: DeliverPolicy.New };
  if (deliver === 'all')
    return { ...filter, deliver_policy: DeliverPolicy.All };
  if (deliver === 'last_per_subject') {
    return { ...filter, deliver_policy: DeliverPolicy.LastPerSubject };
  }
  if ('startTime' in deliver) {
    return {
      ...filter,
      deliver_policy: DeliverPolicy.StartTime,
      opt_start_time: deliver.startTime.toISOString(),
    };
  }
  return {
    ...filter,
    deliver_policy: DeliverPolicy.StartSequence,
    opt_start_seq: deliver.startSequence,
  };
}
