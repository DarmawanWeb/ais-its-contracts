import { setTimeout as sleep } from 'node:timers/promises';

import {
  type AnyEventEnvelope,
  type DurableConsumerDefinition,
  EVENT_TYPES,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { Module } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { baseConfigSchema } from '../src/config/index.js';
import {
  DurableConsumerRunner,
  durableHandlerSettings,
  NatsConsumerRuntime,
} from '../src/internal/index.js';
import {
  type EventContext,
  EventPublisher,
  NatsClient,
  NatsModule,
} from '../src/nats/index.js';
import {
  buildTestApp,
  createTestConfig,
  waitFor,
} from '../src/testing/index.js';
import { testInfra, uniqueName } from './support/infra.js';
import {
  type InstanceEvent,
  type InstanceProcess,
  startInstanceProcess,
} from './support/kit-process.js';

/**
 * K2: an active instance of an exclusive consumer, run in its own process,
 * is paused for real (`SIGSTOP`) longer than the pinned TTL while messages
 * wait in it, then resumed (`SIGCONT`).
 */
const base = 300_000_000 + Math.floor(Math.random() * 600_000_000);

@Module({ imports: [NatsModule.forRoot({ streams: ['FUEL'] })] })
class ProducerModule {}

const fuelConsumer = (mmsi: number): DurableConsumerDefinition => ({
  durableName: uniqueName('paused'),
  stream: 'FUEL',
  filterSubjects: [subjects.fuelReading(mmsi)],
  service: 'emission',
  eventTypes: [EVENT_TYPES.FUEL_READING_RECORDED],
  maxDeliver: 10,
  description: 'exclusive pause integration test',
});

const handledMinutes = (events: readonly InstanceEvent[]): number[] =>
  events.flatMap((event) => (event.kind === 'handled' ? [event.minute] : []));

describe('exclusive consumers paused past the pinned TTL (SIGSTOP)', () => {
  let app: NestFastifyApplication;
  const instances: InstanceProcess[] = [];
  const runners: DurableConsumerRunner[] = [];

  beforeAll(async () => {
    app = await buildTestApp(ProducerModule, {
      config: createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'exclusive-pause-test',
        NATS_URL: testInfra().natsUrl,
      }),
    });
  });

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((instance) => instance.stop()));
    await Promise.all(runners.splice(0).map((runner) => runner.stop(2000)));
  });

  afterAll(async () => {
    await app.close();
  });

  const publish = (mmsi: number, minute: number) =>
    app.get(EventPublisher).publishEvent(EVENT_TYPES.FUEL_READING_RECORDED, {
      mmsi,
      time: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
      periodStart: null,
      fuelMeTon: minute,
      fuelAeTon: 0,
      deviceId: null,
      source: 'api',
    });

  /** Messages delivered to the consumer but not acknowledged yet. */
  const ackPending = async (definition: DurableConsumerDefinition) =>
    (
      await app
        .get(NatsClient)
        .manager.consumers.info('FUEL', definition.durableName)
    ).num_ack_pending;

  /**
   * An active instance with minute 1 in its (slow) handler and minutes 2
   * and 3 waiting behind it in the process, then paused.
   */
  async function pausedWithBufferedMessages(
    mmsi: number,
    definition: DurableConsumerDefinition,
    beforePause?: () => Promise<void>,
  ): Promise<InstanceProcess> {
    const instance = await startInstanceProcess({
      natsUrl: testInfra().natsUrl,
      definition,
      pinnedTtlMs: 3000,
      slowMinutes: { '1': 3000 },
    });
    instances.push(instance);
    await publish(mmsi, 1);
    await instance.waitFor((event) => event.kind === 'activated');
    await beforePause?.();
    await publish(mmsi, 2);
    await publish(mmsi, 3);
    await waitFor(async () => (await ackPending(definition)) === 3, {
      timeoutMs: 5000,
    });
    instance.child.kill('SIGSTOP');
    await sleep(200);
    return instance;
  }

  it('returns what it buffered, never handles it nor ticks, and stays a standby when another instance took over', async () => {
    const mmsi = base + 1;
    const definition = fuelConsumer(mmsi);
    const deliveries: { minute: number; deliveryCount: number }[] = [];
    const b = new DurableConsumerRunner(
      app.get(NatsConsumerRuntime),
      durableHandlerSettings({
        consumer: definition,
        exclusive: { pinnedTtlMs: 3000 },
      }),
      (event: AnyEventEnvelope, context: EventContext) => {
        if (event.type === EVENT_TYPES.FUEL_READING_RECORDED)
          deliveries.push({
            minute: event.data.fuelMeTon,
            deliveryCount: context.deliveryCount,
          });
        return Promise.resolve();
      },
      'b.handler',
    );
    const a = await pausedWithBufferedMessages(mmsi, definition, async () => {
      await b.start();
      runners.push(b);
      await sleep(300);
      expect(b.state).toBe('starting');
    });
    // The TTL passes: the server pins b with the next message.
    await sleep(4500);
    await publish(mmsi, 4);
    await waitFor(() => deliveries.some((d) => d.minute === 4), {
      timeoutMs: 10_000,
    });
    expect(b.state).toBe('active');

    const before = a.events.length;
    a.child.kill('SIGCONT');
    // a returns 2 and 3 at once (not after ack_wait): b handles them.
    await waitFor(
      () => [2, 3].every((m) => deliveries.some((d) => d.minute === m)),
      { timeoutMs: 15_000 },
    );
    await a.waitFor((event) => event.kind === 'deactivated');
    await sleep(500);
    const resumed = a.events.slice(before);
    expect(
      resumed.filter((event) => event.kind === 'deactivated'),
    ).toMatchObject([{ kind: 'deactivated', reason: 'paused' }]);
    // Only the handler that was running when the process stopped finishes.
    expect(handledMinutes(a.events)).toEqual([1]);
    expect(
      resumed.filter(
        (event) => event.kind === 'consumed' && event.outcome === 'returned',
      ),
    ).toHaveLength(2);
    expect(resumed.some((event) => event.kind === 'tick')).toBe(false);
    expect(resumed.some((event) => event.kind === 'activating')).toBe(false);
    expect(
      deliveries
        .filter((d) => d.minute === 2 || d.minute === 3)
        .map((d) => d.deliveryCount),
    ).toEqual([2, 2]);
    expect(b.state).toBe('active');
  }, 60_000);

  it('runs the activation reload before handling what it buffered when it is pinned again', async () => {
    const mmsi = base + 2;
    const definition = fuelConsumer(mmsi);
    const a = await pausedWithBufferedMessages(mmsi, definition);
    await sleep(5000);
    const before = a.events.length;
    a.child.kill('SIGCONT');
    await a.waitFor(
      (event) => event.kind === 'handled' && event.minute === 3,
      20_000,
    );
    const resumed = a.events.slice(before);
    const kinds = resumed
      .filter((event) => event.kind !== 'consumed' && event.kind !== 'state')
      .map((event) =>
        event.kind === 'handled'
          ? `handled:${event.minute}`
          : event.kind === 'deactivated'
            ? `deactivated:${event.reason}`
            : event.kind,
      );
    const reloaded = kinds.indexOf('activated');
    // Paused: deactivated; then a pin (the same one or a new one) and the reload…
    expect(kinds.slice(0, kinds.indexOf('activating'))).toContain(
      'deactivated:paused',
    );
    expect(reloaded).toBeGreaterThan(kinds.indexOf('activating'));
    // …before 2 and 3 are handled (redelivered), and no tick before it.
    expect(kinds.indexOf('handled:2')).toBeGreaterThan(reloaded);
    expect(kinds.indexOf('handled:3')).toBeGreaterThan(reloaded);
    expect(kinds.slice(0, reloaded)).not.toContain('tick');
    const redelivered = resumed.filter(
      (event) =>
        event.kind === 'handled' && (event.minute === 2 || event.minute === 3),
    );
    expect(
      redelivered.every(
        (event) => event.kind === 'handled' && event.deliveryCount >= 2,
      ),
    ).toBe(true);
    expect(
      resumed.filter(
        (event) => event.kind === 'consumed' && event.outcome === 'returned',
      ),
    ).toHaveLength(2);
  }, 60_000);
});
