import {
  STREAMS,
  type StreamDefinition,
  type StreamName,
} from '@darmawanweb/ais-its-contracts/events';
import { Injectable, Logger } from '@nestjs/common';
import {
  JetStreamApiCodes,
  JetStreamApiError,
  type StreamConfig,
  type StreamInfo,
  type StreamUpdateConfig,
} from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';

import { NatsClient } from './nats-client.js';

/**
 * Why a stream is ensured (spec §7.2):
 *
 * - `'producer'` — the service publishes to it (`NatsModule.forRoot({ streams })`,
 *   the audit stream): the stream is created when missing and **widened**
 *   to the contracts definition (new subjects, longer retention, larger
 *   per-subject limit or dedup window, description);
 * - `'consumer'` — the service only reads it (durable and ordered consumers,
 *   the `DLQ` they copy failures to): the stream is created when missing so
 *   services can boot in any order, but an existing stream is never changed.
 *
 * Changes that would narrow a stream (removed subjects, shorter retention,
 * smaller limits) are never applied automatically, by any role: services
 * pin different contracts versions and are released independently, and a
 * narrowing update purges stored messages at once. They are logged as
 * warnings for an operator (`nats stream edit`).
 */
export type StreamEnsureRole = 'producer' | 'consumer';

/** Result of ensuring one stream. */
export type StreamEnsureOutcome =
  /** The stream did not exist and was created from the contracts definition. */
  | 'created'
  /** Widening changes were applied (producers only). */
  | 'updated'
  /** The stream matches the contracts definition. */
  | 'unchanged'
  /** The stream differs, but nothing was applied (consumer role or narrowing changes). */
  | 'drifted';

/** The updatable part of a contracts stream definition in NATS terms. */
export function streamUpdateConfig(
  definition: StreamDefinition,
): Partial<StreamUpdateConfig> {
  return {
    subjects: [...definition.subjects],
    description: definition.description,
    max_age: nanos(definition.maxAgeMs),
    max_msgs_per_subject: definition.maxMsgsPerSubject,
    duplicate_window: nanos(definition.duplicateWindowMs),
  };
}

/** Full NATS stream configuration of a contracts stream definition. */
export function streamConfig(
  definition: StreamDefinition,
): Partial<StreamConfig> & { name: string } {
  return {
    ...streamUpdateConfig(definition),
    name: definition.name,
    retention: definition.retention,
    storage: definition.storage,
  };
}

/** A limit where `0` or a negative value means unlimited. */
function limitOf(value: number | undefined): number {
  return value === undefined || value <= 0 ? Number.POSITIVE_INFINITY : value;
}

/**
 * Differences between a live stream and its contracts definition, split
 * into the widening changes a producer may apply and the narrowing ones
 * that are only reported.
 */
export interface StreamDriftPlan {
  /** Fields to send to `streams.update` (only the widening changes); `undefined` when none. */
  readonly update: Partial<StreamUpdateConfig> | undefined;
  /** Names of the widening changes in {@link update}. */
  readonly widening: readonly string[];
  /** Human-readable narrowing differences that are never applied automatically. */
  readonly narrowing: readonly string[];
}

/**
 * Plans the update of `actual` towards `expected` without ever narrowing
 * it: missing subjects are added (extra ones kept), retention, per-subject
 * limit and dedup window only grow, the description follows the contracts.
 */
export function planStreamUpdate(
  expected: StreamDefinition,
  actual: StreamConfig,
): StreamDriftPlan {
  const wanted = streamUpdateConfig(expected);
  const update: Partial<StreamUpdateConfig> = {};
  const widening: string[] = [];
  const narrowing: string[] = [];

  const current = actual.subjects;
  const missing = (wanted.subjects ?? []).filter((s) => !current.includes(s));
  const extra = current.filter((s) => !(wanted.subjects ?? []).includes(s));
  if (missing.length > 0) {
    update.subjects = [...current, ...missing];
    widening.push('subjects');
  }
  if (extra.length > 0) {
    narrowing.push(`extra subjects ${extra.join(', ')} kept`);
  }
  if ((wanted.description ?? '') !== (actual.description ?? '')) {
    if (wanted.description !== undefined)
      update.description = wanted.description;
    widening.push('description');
  }

  const wantedAge = limitOf(wanted.max_age);
  const actualAge = limitOf(actual.max_age);
  if (wantedAge > actualAge) {
    update.max_age = wanted.max_age ?? 0;
    widening.push('max_age');
  } else if (wantedAge < actualAge) {
    narrowing.push('max_age is longer than the contracts definition');
  }

  const wantedPer = limitOf(wanted.max_msgs_per_subject);
  const actualPer = limitOf(actual.max_msgs_per_subject);
  if (wantedPer > actualPer) {
    update.max_msgs_per_subject = wanted.max_msgs_per_subject ?? -1;
    widening.push('max_msgs_per_subject');
  } else if (wantedPer < actualPer) {
    narrowing.push(
      'max_msgs_per_subject is larger than the contracts definition',
    );
  }

  const wantedWindow = wanted.duplicate_window ?? 0;
  if (wantedWindow > actual.duplicate_window) {
    update.duplicate_window = wantedWindow;
    widening.push('duplicate_window');
  } else if (wantedWindow < actual.duplicate_window) {
    narrowing.push('duplicate_window is longer than the contracts definition');
  }

  return {
    update: widening.length > 0 ? update : undefined,
    widening,
    narrowing,
  };
}

/** Updatable fields of `actual` that differ from `expected` (both directions). */
export function streamDrift(
  expected: StreamDefinition,
  actual: StreamConfig,
): string[] {
  const wanted = streamUpdateConfig(expected);
  const drift: string[] = [];
  const subjects = [...(wanted.subjects ?? [])].sort().join('\n');
  if (subjects !== [...actual.subjects].sort().join('\n'))
    drift.push('subjects');
  if ((wanted.description ?? '') !== (actual.description ?? ''))
    drift.push('description');
  if (limitOf(wanted.max_age) !== limitOf(actual.max_age))
    drift.push('max_age');
  if (
    limitOf(wanted.max_msgs_per_subject) !==
    limitOf(actual.max_msgs_per_subject)
  )
    drift.push('max_msgs_per_subject');
  if ((wanted.duplicate_window ?? 0) !== actual.duplicate_window)
    drift.push('duplicate_window');
  return drift;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof JetStreamApiError &&
    error.code === JetStreamApiCodes.StreamNotFound
  );
}

/** JetStream API error `stream name already in use with a different configuration`. */
const STREAM_NAME_EXISTS = 10_058;

function isNameInUse(error: unknown): boolean {
  return error instanceof JetStreamApiError && error.code === STREAM_NAME_EXISTS;
}

/** Rank of a role: a producer ensure supersedes a consumer one. */
const ROLE_RANK: Record<StreamEnsureRole, number> = { consumer: 0, producer: 1 };

/**
 * Ensures contracts streams (spec §7.2) according to the caller's
 * {@link StreamEnsureRole}: creates missing streams, lets producers widen
 * drifted ones, never narrows and never deletes. Retention and storage
 * cannot change on a live stream: a mismatch is logged for an operator.
 * Each stream is ensured once per process and role.
 */
@Injectable()
export class StreamManager {
  private readonly logger = new Logger('NatsStreams');
  private readonly ensured = new Map<
    StreamName,
    { readonly role: StreamEnsureRole; readonly outcome: Promise<StreamEnsureOutcome> }
  >();

  constructor(private readonly client: NatsClient) {}

  /**
   * Ensures every named stream (concurrently, once each).
   *
   * @param role `'producer'` (default) for streams the service publishes to,
   *   `'consumer'` for streams it only reads.
   */
  async ensure(
    names: readonly StreamName[],
    role: StreamEnsureRole = 'producer',
  ): Promise<Map<StreamName, StreamEnsureOutcome>> {
    const unique = [...new Set(names)];
    const outcomes = await Promise.all(
      unique.map((name) => this.ensureOne(name, role)),
    );
    return new Map(
      unique.map((name, index) => [name, outcomes[index] ?? 'unchanged']),
    );
  }

  private ensureOne(
    name: StreamName,
    role: StreamEnsureRole,
  ): Promise<StreamEnsureOutcome> {
    const previous = this.ensured.get(name);
    if (previous !== undefined && ROLE_RANK[previous.role] >= ROLE_RANK[role])
      return previous.outcome;
    const outcome = (previous?.outcome.catch(() => undefined) ?? Promise.resolve()).then(
      () => this.apply(STREAMS[name], role),
    );
    const entry = { role, outcome };
    // A failed attempt may be retried by the next caller.
    outcome.catch(() => {
      if (this.ensured.get(name) === entry) this.ensured.delete(name);
    });
    this.ensured.set(name, entry);
    return outcome;
  }

  private async apply(
    definition: StreamDefinition,
    role: StreamEnsureRole,
  ): Promise<StreamEnsureOutcome> {
    const { manager } = await this.client.ready();
    let info: StreamInfo;
    try {
      info = await manager.streams.info(definition.name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      try {
        await manager.streams.add(streamConfig(definition));
      } catch (addError) {
        // Another service created it in the meantime: treat it as existing.
        if (!isNameInUse(addError)) throw addError;
        info = await manager.streams.info(definition.name);
        return this.reconcile(definition, info, role);
      }
      this.logger.log(`Created stream ${definition.name} (${role})`);
      return 'created';
    }
    return this.reconcile(definition, info, role);
  }

  private async reconcile(
    definition: StreamDefinition,
    info: StreamInfo,
    role: StreamEnsureRole,
  ): Promise<StreamEnsureOutcome> {
    const { manager } = await this.client.ready();
    if (
      info.config.retention !== definition.retention ||
      info.config.storage !== definition.storage
    ) {
      this.logger.error(
        `Stream ${definition.name} has retention=${info.config.retention}/storage=${info.config.storage}, ` +
          `contracts expect ${definition.retention}/${definition.storage}: these cannot be changed in place, ` +
          'recreate the stream manually',
      );
    }
    const plan = planStreamUpdate(definition, info.config);
    if (plan.narrowing.length > 0) {
      this.logger.warn(
        `Stream ${definition.name} differs from the contracts definition and is left as is: ` +
          `${plan.narrowing.join('; ')} (narrowing changes are never applied automatically)`,
      );
    }
    if (plan.update === undefined)
      return plan.narrowing.length > 0 ? 'drifted' : 'unchanged';
    if (role === 'consumer') {
      this.logger.warn(
        `Stream ${definition.name} differs from this service's contracts definition ` +
          `(${plan.widening.join(', ')}); only its producers update it`,
      );
      return 'drifted';
    }
    await manager.streams.update(definition.name, plan.update);
    this.logger.log(
      `Updated stream ${definition.name} (${plan.widening.join(', ')})`,
    );
    return 'updated';
  }
}
