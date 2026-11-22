import {
  JetStreamApiCodes,
  JetStreamApiError,
  type StreamConfig,
} from '@nats-io/jetstream';
import { describe, expect, it } from 'vitest';

import type { NatsClient } from './nats-client.js';
import { isNoStreamError, StreamManager } from './stream-manager.js';

/** A JetStream manager keeping stream configurations in memory. */
class FakeStreams {
  readonly existing = new Map<string, Partial<StreamConfig>>();
  infos = 0;
  adds = 0;
  /** Resolves a pending `info()` (to observe concurrent ensures). */
  gate: Promise<void> = Promise.resolve();

  async info(name: string): Promise<{ config: Partial<StreamConfig> }> {
    this.infos += 1;
    await this.gate;
    const config = this.existing.get(name);
    if (config === undefined)
      throw new JetStreamApiError({
        code: 404,
        err_code: JetStreamApiCodes.StreamNotFound,
        description: 'stream not found',
      });
    return { config };
  }

  add(
    config: Partial<StreamConfig>,
  ): Promise<{ config: Partial<StreamConfig> }> {
    this.adds += 1;
    this.existing.set(config.name ?? '', config);
    return Promise.resolve({ config });
  }
}

function manager(): { streams: StreamManager; fake: FakeStreams } {
  const fake = new FakeStreams();
  const client = {
    ready: () => Promise.resolve({ manager: { streams: fake } }),
  } as unknown as NatsClient;
  return { streams: new StreamManager(client), fake };
}

describe('StreamManager refresh and invalidate (NATS-3)', () => {
  it('remembers an ensure: a stream deleted later is not re-created without refresh', async () => {
    const { streams, fake } = manager();
    expect((await streams.ensure(['FUEL'])).get('FUEL')).toBe('created');
    fake.existing.delete('FUEL');
    expect((await streams.ensure(['FUEL'])).get('FUEL')).toBe('created');
    expect((await streams.ensure(['FUEL'], 'consumer')).get('FUEL')).toBe(
      'created',
    );
    expect({ infos: fake.infos, adds: fake.adds }).toEqual({
      infos: 1,
      adds: 1,
    });
  });

  it('re-creates a deleted stream with refresh and replaces the remembered result', async () => {
    const { streams, fake } = manager();
    await streams.ensure(['FUEL']);
    fake.existing.delete('FUEL');
    const refreshed = await streams.ensure(['FUEL'], 'consumer', {
      refresh: true,
    });
    expect(refreshed.get('FUEL')).toBe('created');
    expect(fake.existing.has('FUEL')).toBe(true);
    // The refreshed result is remembered: no further server call.
    expect((await streams.ensure(['FUEL'])).get('FUEL')).toBe('created');
    expect({ infos: fake.infos, adds: fake.adds }).toEqual({
      infos: 2,
      adds: 2,
    });
    // The producer role ensured first is kept.
    expect(streams.roleOf('FUEL')).toBe('producer');
  });

  it('checks the server again after invalidate, keeping the known role', async () => {
    const { streams, fake } = manager();
    await streams.ensure(['FUEL'], 'consumer');
    expect(streams.roleOf('FUEL')).toBe('consumer');
    streams.invalidate(['FUEL']);
    expect((await streams.ensure(['FUEL'], 'consumer')).get('FUEL')).toBe(
      'unchanged',
    );
    expect(fake.infos).toBe(2);
    expect(streams.roleOf('FUEL')).toBe('consumer');
    expect(streams.roleOf('GEO')).toBeUndefined();
  });

  it('joins an ensure still in flight instead of starting another one', async () => {
    const { streams, fake } = manager();
    let release!: () => void;
    fake.gate = new Promise((resolve) => {
      release = resolve;
    });
    const first = streams.ensure(['FUEL']);
    const second = streams.ensure(['FUEL'], 'producer', { refresh: true });
    release();
    expect((await first).get('FUEL')).toBe('created');
    expect((await second).get('FUEL')).toBe('created');
    expect(fake.adds).toBe(1);
  });

  it('recognizes the publish errors of a missing stream', () => {
    const notEnabled = new Error('jetstream is not enabled');
    notEnabled.name = 'JetStreamNotEnabled';
    expect(isNoStreamError(notEnabled)).toBe(true);
    expect(isNoStreamError(new Error('503 no responders available'))).toBe(
      true,
    );
    expect(isNoStreamError(new Error('timeout'))).toBe(false);
    expect(isNoStreamError('no responders')).toBe(false);
  });
});
