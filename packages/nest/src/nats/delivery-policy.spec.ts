import { STREAMS } from '@darmawanweb/ais-its-contracts/events';
import { DeliverPolicy, type StreamConfig } from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import { describe, expect, it } from 'vitest';

import {
  consumerDrift,
  durableConsumerConfig,
  orderedConsumerOptions,
  serverMaxDeliver,
} from './consumer-config.js';
import { decideFailure, retryDelayMs } from './delivery-policy.js';
import {
  DeadLetterError,
  NonRetryableError,
  RetryableError,
} from './errors.js';
import { durableHandlerSettings } from './event-handler.decorator.js';
import { headerValue, MAX_HEADER_VALUE_LENGTH } from './headers.js';
import { streamConfig, streamDrift } from './stream-manager.js';

describe('delivery policy (spec §7.1)', () => {
  it('backs off exponentially by delivery count, capped at 60 s', () => {
    expect([1, 2, 3, 4, 7, 8, 20].map((count) => retryDelayMs(count))).toEqual([
      1000, 2000, 4000, 8000, 60_000, 60_000, 60_000,
    ]);
    expect(retryDelayMs(1, [500, 5000])).toBe(500);
    expect(retryDelayMs(9, [500, 5000])).toBe(5000);
  });

  it('terms non-retryable errors, naks others and dead-letters at maxDeliver', () => {
    const policy = { maxDeliver: 3 };
    expect(decideFailure(new NonRetryableError('never'), 1, policy)).toEqual({
      action: 'term',
    });
    expect(decideFailure(new Error('db down'), 1, policy)).toEqual({
      action: 'nak',
      delayMs: 1000,
    });
    expect(
      decideFailure(
        new RetryableError('busy', { retryAfterMs: 250 }),
        2,
        policy,
      ),
    ).toEqual({ action: 'nak', delayMs: 250 });
    expect(decideFailure(new Error('db down'), 3, policy)).toEqual({
      action: 'dead_letter',
    });
    expect(decideFailure(new NonRetryableError('never'), 3, policy)).toEqual({
      action: 'term',
    });
  });

  it('dead-letters a DeadLetterError on any delivery, the first included', () => {
    const policy = { maxDeliver: 10 };
    const error = new DeadLetterError('value rejected by the store');
    expect(error.name).toBe('DeadLetterError');
    for (const deliveryCount of [1, 2, 10])
      expect(decideFailure(error, deliveryCount, policy)).toEqual({
        action: 'dead_letter',
      });
    // A subclass keeps the behaviour.
    class ColumnTooLong extends DeadLetterError {}
    expect(decideFailure(new ColumnTooLong('name'), 1, policy)).toEqual({
      action: 'dead_letter',
    });
  });
});

describe('consumer and stream configuration', () => {
  const settings = durableHandlerSettings({
    consumer: 'safety-positions',
    concurrency: 4,
    ackWaitMs: 10_000,
  });

  it('builds explicit-ack durable pull consumers with one spare server delivery', () => {
    const config = durableConsumerConfig(settings);
    expect(config).toMatchObject({
      durable_name: 'safety-positions',
      filter_subjects: ['ais.position.v1.>'],
      ack_policy: 'explicit',
      deliver_policy: 'all',
      ack_wait: nanos(10_000),
      max_deliver: serverMaxDeliver(10),
    });
    expect(consumerDrift(config, config)).toEqual([]);
    expect(
      consumerDrift(config, {
        ...config,
        ack_wait: nanos(1000),
        filter_subjects: ['x.>'],
      }),
    ).toEqual(['filter_subjects', 'ack_wait']);
    expect(() =>
      durableHandlerSettings({ consumer: 'safety-positions', concurrency: 0 }),
    ).toThrow(RangeError);
  });

  it('maps ordered start policies, including last-per-subject for compacted streams', () => {
    expect(
      orderedConsumerOptions(['geo.zone.v1.>'], 'last_per_subject'),
    ).toEqual({
      filter_subjects: ['geo.zone.v1.>'],
      deliver_policy: DeliverPolicy.LastPerSubject,
    });
    expect(orderedConsumerOptions(['a.>'], 'new').deliver_policy).toBe(
      DeliverPolicy.New,
    );
    expect(
      orderedConsumerOptions(['a.>'], {
        startTime: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toMatchObject({
      deliver_policy: DeliverPolicy.StartTime,
      opt_start_time: '2026-01-01T00:00:00.000Z',
    });
    expect(
      orderedConsumerOptions(['a.>'], { startSequence: 42 }),
    ).toMatchObject({ opt_start_seq: 42 });
  });

  it('detects stream drift on updatable settings only', () => {
    const geo = STREAMS.GEO;
    const config = streamConfig(geo) as StreamConfig;
    expect(config).toMatchObject({
      name: 'GEO',
      subjects: ['geo.zone.v1.>'],
      max_msgs_per_subject: 1,
    });
    expect(streamDrift(geo, config)).toEqual([]);
    expect(
      streamDrift(geo, {
        ...config,
        max_msgs_per_subject: 5,
        subjects: ['geo.>'],
      }),
    ).toEqual(['subjects', 'max_msgs_per_subject']);
  });

  it('makes header values single-line and bounded', () => {
    expect(headerValue('line 1\nline 2\r\n')).toBe('line 1 line 2');
    expect(headerValue('x'.repeat(5000))).toHaveLength(MAX_HEADER_VALUE_LENGTH);
  });
});
