import type { AnyEventEnvelope, EventType, StreamName } from '@darmawanweb/seemp-contracts/events';
import { Injectable } from '@nestjs/common';
import { DeliverPolicy } from '@nats-io/jetstream';

import { NatsConsumerRuntime } from './consumer-runtime.js';
import type { EventContext } from './event-handler.decorator.js';
import { eventContextOf, invokeHandler, readDelivery } from './message-processing.js';

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
  readonly handler: (event: AnyEventEnvelope, context: EventContext) => void | Promise<void>;
  /** Cancels the replay. */
  readonly signal?: AbortSignal | undefined;
}

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
}

/**
 * Replays a stream from a start time with an ephemeral ordered consumer,
 * up to the last message present when the replay starts (or `to`). Used for
 * recomputations, e.g. emission's `POST /cii/vessels/:mmsi/recompute`.
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

  /** Runs the replay to completion. */
  async replay(options: ReplayOptions): Promise<ReplayReport> {
    const { jetstream, manager } = await this.runtime.client.ready();
    const lastSequence = (await manager.streams.info(options.stream)).state.last_seq;
    const consumer = await jetstream.consumers.get(options.stream, {
      filter_subjects: [...options.filterSubjects],
      deliver_policy: DeliverPolicy.StartTime,
      opt_start_time: options.from.toISOString(),
    });
    let handled = 0;
    let invalid = 0;
    let skipped = 0;
    let last: number | undefined;
    if ((await consumer.info()).num_pending === 0) return { handled, invalid, skipped, lastSequence: last };

    const abort = new AbortController();
    const signal = options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]);
    const messages = await consumer.consume();
    try {
      for await (const message of messages) {
        if (signal.aborted) break;
        if (options.to !== undefined && message.time > options.to) break;
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
        if (message.seq >= lastSequence || message.info.pending === 0) break;
      }
    } finally {
      abort.abort();
      await messages.close().catch(() => undefined);
    }
    return { handled, invalid, skipped, lastSequence: last };
  }
}
