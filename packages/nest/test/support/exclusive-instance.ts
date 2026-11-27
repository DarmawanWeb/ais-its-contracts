/**
 * One instance of an exclusive durable consumer in its own process, so that
 * a test can pause it for real (`SIGSTOP` / `SIGCONT`). Started by
 * `startInstanceProcess()` (`kit-process.ts`), configured by `KIT_INSTANCE`;
 * reports what happens as `INSTANCE_EVENT_MARKER` + JSON lines on stdout.
 * It "ticks" every 100 ms while it is the active instance and its
 * activation completed, as the Detector SDK's ticks do.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';

import { MetricsService } from '../../src/metrics/metrics.service.js';
import {
  type ConsumerRuntime,
  DurableConsumerRunner,
} from '../../src/nats/durable-consumer-runner.js';
import { durableHandlerSettings } from '../../src/nats/event-handler.decorator.js';
import type { NatsClient } from '../../src/nats/nats-client.js';
import { NatsMetrics } from '../../src/nats/nats.metrics.js';
import type { StreamManager } from '../../src/nats/stream-manager.js';
import type { InstanceConfig, InstanceEvent } from './kit-process.js';

/** Same value as `INSTANCE_EVENT_MARKER` (not imported: that module compiles `src/`). */
const MARKER = '@@instance ';

function emit(event: InstanceEvent): void {
  process.stdout.write(`${MARKER}${JSON.stringify(event)}\n`);
}

const config = JSON.parse(process.env.KIT_INSTANCE ?? '{}') as InstanceConfig;
const connection = await connect({
  servers: config.natsUrl,
  name: `kit-instance@${process.pid}`,
});
const handles = {
  connection,
  jetstream: jetstream(connection, { timeout: 5000 }),
  manager: await jetstreamManager(connection, { timeout: 5000 }),
};
const metrics = new NatsMetrics(new MetricsService());
const count = metrics.consumed.inc.bind(metrics.consumed);
metrics.consumed.inc = ((labels: Record<string, string>) => {
  emit({ kind: 'consumed', outcome: labels.outcome ?? '' });
  count(labels);
}) as typeof metrics.consumed.inc;
const runtime: ConsumerRuntime = {
  client: { ready: () => Promise.resolve(handles) } as unknown as NatsClient,
  // The test process creates the streams.
  streams: {
    ensure: () => Promise.resolve(new Map()),
  } as unknown as StreamManager,
  metrics,
  serviceName: 'kit-instance',
  runInLogContext: (fn) => fn(),
};

let activated = false;
const runner = new DurableConsumerRunner(
  runtime,
  durableHandlerSettings({
    consumer: config.definition,
    exclusive: { pinnedTtlMs: config.pinnedTtlMs },
    backoffMs: [500],
  }),
  async (event, context) => {
    if (event.type !== EVENT_TYPES.FUEL_READING_RECORDED) return;
    const minute = event.data.fuelMeTon;
    const slowMs = config.slowMinutes?.[String(minute)];
    if (slowMs !== undefined) await sleep(slowMs);
    emit({ kind: 'handled', minute, deliveryCount: context.deliveryCount });
  },
  'ExclusiveInstance.handle',
  {
    onActivated: async (event) => {
      emit({
        kind: 'activating',
        pinId: event.pinId ?? null,
        previous: event.previous ?? null,
      });
      await sleep(300); // e.g. reload the open alerts
      activated = true;
      emit({
        kind: 'activated',
        pinId: event.pinId ?? null,
        previous: event.previous ?? null,
      });
    },
    onDeactivated: (event) => {
      emit({
        kind: 'deactivated',
        reason: event.reason,
        pinId: event.pinId ?? null,
      });
    },
    onStateChange: (state) => {
      if (state !== 'active') activated = false;
      emit({ kind: 'state', state });
    },
  },
);
await runner.start();

const ticks = setInterval(() => {
  // Reading the role first notices a pause (as DetectorRunner's ticks do).
  if (runner.state === 'active' && activated) emit({ kind: 'tick' });
}, 100);

process.once('SIGTERM', () => {
  clearInterval(ticks);
  void runner
    .stop(2000)
    .then(() => connection.drain())
    .catch(() => undefined)
    .finally(() => process.exit(0));
});
emit({ kind: 'ready' });
