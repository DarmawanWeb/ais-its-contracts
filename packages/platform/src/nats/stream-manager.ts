import { STREAMS, type StreamDefinition, type StreamName } from '@darmawanweb/seemp-contracts/events';
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

/** Result of ensuring one stream. */
export type StreamEnsureOutcome = 'created' | 'updated' | 'unchanged';

/** The updatable part of a contracts stream definition in NATS terms. */
export function streamUpdateConfig(definition: StreamDefinition): Partial<StreamUpdateConfig> {
  return {
    subjects: [...definition.subjects],
    description: definition.description,
    max_age: nanos(definition.maxAgeMs),
    max_msgs_per_subject: definition.maxMsgsPerSubject,
    duplicate_window: nanos(definition.duplicateWindowMs),
  };
}

/** Full NATS stream configuration of a contracts stream definition. */
export function streamConfig(definition: StreamDefinition): Partial<StreamConfig> & { name: string } {
  return {
    ...streamUpdateConfig(definition),
    name: definition.name,
    retention: definition.retention,
    storage: definition.storage,
  };
}

function sameSubjects(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/** Updatable fields of `actual` that differ from `expected`. */
export function streamDrift(expected: StreamDefinition, actual: StreamConfig): string[] {
  const wanted = streamUpdateConfig(expected);
  const drift: string[] = [];
  if (!sameSubjects(wanted.subjects ?? [], actual.subjects)) drift.push('subjects');
  if ((wanted.description ?? '') !== (actual.description ?? '')) drift.push('description');
  if (wanted.max_age !== actual.max_age) drift.push('max_age');
  if (wanted.max_msgs_per_subject !== actual.max_msgs_per_subject) drift.push('max_msgs_per_subject');
  if (wanted.duplicate_window !== actual.duplicate_window) drift.push('duplicate_window');
  return drift;
}

function isNotFound(error: unknown): boolean {
  return error instanceof JetStreamApiError && error.code === JetStreamApiCodes.StreamNotFound;
}

/**
 * Ensures contracts streams (spec §7.2): creates missing streams, updates
 * the updatable settings (subjects, max age, per-subject limit, dedup window,
 * description) of drifted ones, and never deletes. Retention and storage
 * cannot change on a live stream: a mismatch is logged for an operator.
 * Each stream is ensured once per process.
 */
@Injectable()
export class StreamManager {
  private readonly logger = new Logger('NatsStreams');
  private readonly ensured = new Map<StreamName, Promise<StreamEnsureOutcome>>();

  constructor(private readonly client: NatsClient) {}

  /** Ensures every named stream (concurrently, once each). */
  async ensure(names: readonly StreamName[]): Promise<Map<StreamName, StreamEnsureOutcome>> {
    const unique = [...new Set(names)];
    const outcomes = await Promise.all(unique.map((name) => this.ensureOne(name)));
    return new Map(unique.map((name, index) => [name, outcomes[index] ?? 'unchanged']));
  }

  private ensureOne(name: StreamName): Promise<StreamEnsureOutcome> {
    let pending = this.ensured.get(name);
    if (pending === undefined) {
      pending = this.apply(STREAMS[name]);
      // A failed attempt may be retried by the next caller.
      pending.catch(() => this.ensured.delete(name));
      this.ensured.set(name, pending);
    }
    return pending;
  }

  private async apply(definition: StreamDefinition): Promise<StreamEnsureOutcome> {
    const { manager } = await this.client.ready();
    let info: StreamInfo;
    try {
      info = await manager.streams.info(definition.name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await manager.streams.add(streamConfig(definition));
      this.logger.log(`Created stream ${definition.name}`);
      return 'created';
    }

    if (info.config.retention !== definition.retention || info.config.storage !== definition.storage) {
      this.logger.error(
        `Stream ${definition.name} has retention=${info.config.retention}/storage=${info.config.storage}, ` +
          `contracts expect ${definition.retention}/${definition.storage}: these cannot be changed in place, ` +
          'recreate the stream manually',
      );
    }
    const drift = streamDrift(definition, info.config);
    if (drift.length === 0) return 'unchanged';
    await manager.streams.update(definition.name, streamUpdateConfig(definition));
    this.logger.log(`Updated stream ${definition.name} (${drift.join(', ')})`);
    return 'updated';
  }
}
