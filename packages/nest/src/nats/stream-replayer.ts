import type {
  AnyEventEnvelope,
  EventType,
  StreamName,
} from '@darmawanweb/ais-its-contracts/events';
import { Injectable } from '@nestjs/common';
import { DeliverPolicy, type JsMsg } from '@nats-io/jetstream';

import { NatsConsumerRuntime } from './consumer-runtime.js';
import type { EventContext } from './event-handler.decorator.js';
import {
  eventContextOf,
  invokeHandler,
  readDelivery,
} from './message-processing.js';

/**
 * `true` for the client errors of a connection that closed or drains (the
 * consume iterator throws them when it pulls again): the replay ends as
 * `closed` instead of failing.
 */
function isConnectionEnded(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'ClosedConnectionError' ||
      error.name === 'DrainingConnectionError')
  );
}

/** Options of {@link StreamReplayer.replay}. */
export interface ReplayOptions {
  readonly stream: StreamName;
  readonly filterSubjects: readonly string[];
  /** First message time (inclusive). */
  readonly from: Date;
  /** Last message time (inclusive); default: the end of the stream when the replay starts. */
  readonly to?: Date | undefined;
  /** Event types handled; others are skipped. */
  readonly eventTypes: readonly EventType[];
  /** Called sequentially, in stream order; a rejection aborts the replay. */
  readonly handler: (
    event: AnyEventEnvelope,
    context: EventContext,
  ) => void | Promise<void>;
  /** Cancels the replay. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Why a replay ended:
 *
 * - `'empty'` — nothing to replay in the range;
 * - `'end_of_stream'` — the last message present when the replay started was read;
 * - `'to'` — the first message after `to` was reached;
 * - `'aborted'` — the `signal` aborted (partial replay);
 * - `'closed'` — the message iterator ended early or failed because the
 *   connection closed or drains, e.g. at shutdown (partial replay; errors
 *   of the handler still reject the replay).
 */
export type ReplayEnd = 'empty' | 'end_of_stream' | 'to' | 'aborted' | 'closed';

/** Outcome of a replay. */
export interface ReplayReport {
  /** Events passed to the handler. */
  readonly handled: number;
  /** Invalid messages ignored. */
  readonly invalid: number;
  /** Messages of other types. */
  readonly skipped: number;
  /** Stream sequence of the last message read, if any. */
  readonly lastSequence: number | undefined;
  /**
   * `true` when the whole range was replayed (`endedBy` is `empty`,
   * `end_of_stream` or `to`); `false` for a partial replay (`aborted`,
   * `closed`) whose results must not replace complete ones.
   */
  readonly completed: boolean;
  /** Why the replay ended (see {@link ReplayEnd}). */
  readonly endedBy: ReplayEnd;
}

/**
 * Replays a stream from a start time with an ephemeral ordered consumer,
 * up to the last message present when the replay starts (or `to`). Used for
 * recomputations, e.g. emission's `POST /cii/vessels/:mmsi/recompute`. The
 * report tells a complete replay from a partial one (`completed`,
 * `endedBy`): an aborted signal ends the replay at once, even while it
 * waits for a message.
 *
 * @example
 * await this.replayer.replay({
 *   stream: 'AIS_POSITION', filterSubjects: [subjects.aisPosition(mmsi)],
 *   from, to, eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
 *   handler: (event) => this.segments.rebuild(event),
 * });
 */
@Injectable()
export class StreamReplayer {
  constructor(private readonly runtime: NatsConsumerRuntime) {}

  /** Runs the replay to completion (or until aborted or closed: see {@link ReplayReport.completed}). */
  async replay(options: ReplayOptions): Promise<ReplayReport> {
    const { jetstream, manager } = await this.runtime.client.ready();
    const lastSequence = (await manager.streams.info(options.stream)).state
      .last_seq;
    const consumer = await jetstream.consumers.get(options.stream, {
      filter_subjects: [...options.filterSubjects],
      deliver_policy: DeliverPolicy.StartTime,
      opt_start_time: options.from.toISOString(),
    });
    let handled = 0;
    let invalid = 0;
    let skipped = 0;
    let last: number | undefined;
    const report = (endedBy: ReplayEnd): ReplayReport => ({
      handled,
      invalid,
      skipped,
      lastSequence: last,
      completed:
        endedBy === 'empty' || endedBy === 'end_of_stream' || endedBy === 'to',
      endedBy,
    });
    // Read through a function: the signal changes while the replay awaits.
    const cancelled = (): boolean => options.signal?.aborted === true;
    if (cancelled()) return report('aborted');
    if ((await consumer.info()).num_pending === 0) return report('empty');

    const abort = new AbortController();
    const signal =
      options.signal === undefined
        ? abort.signal
        : AbortSignal.any([abort.signal, options.signal]);
    const messages = await consumer.consume();
    // An abort ends the replay even while it waits for the next message.
    const onAbort = (): void => {
      void messages.close().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let endedBy: ReplayEnd = 'closed';
    const iterator = messages[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Only the iterator's own errors are mapped; handler errors propagate.
        let next: IteratorResult<JsMsg>;
        try {
          next = await iterator.next();
        } catch (error) {
          if (!isConnectionEnded(error)) throw error;
          break;
        }
        if (next.done === true) break;
        const message = next.value;
        if (signal.aborted) {
          endedBy = 'aborted';
          break;
        }
        if (options.to !== undefined && message.time > options.to) {
          endedBy = 'to';
          break;
        }
        last = message.seq;
        const delivery = readDelivery(message, options.eventTypes);
        if (delivery.kind === 'invalid') invalid += 1;
        else if (delivery.kind === 'skipped') skipped += 1;
        else {
          await invokeHandler(
            options.handler,
            delivery.envelope,
            eventContextOf(message, `replay:${options.stream}`, signal),
            this.runtime.runInLogContext,
          );
          handled += 1;
        }
        if (message.seq >= lastSequence || message.info.pending === 0) {
          endedBy = 'end_of_stream';
          break;
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      abort.abort();
      // As `for await` would on break: the client's close() waits for it.
      await iterator.return?.().catch(() => undefined);
      await messages.close().catch(() => undefined);
    }
    // The iterator also ends when the abort closed it.
    if (endedBy === 'closed' && cancelled()) endedBy = 'aborted';
    return report(endedBy);
  }
}
