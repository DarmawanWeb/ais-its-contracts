import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  remainingShutdownMs,
  resetShutdownDeadline,
  startShutdownDeadline,
} from '../common/shutdown-deadline.js';
import type { BaseConfig } from '../config/env-schema.js';
import { connectionDrainBoundMs, NatsClient } from './nats-client.js';
import {
  DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS,
  type NatsModuleOptions,
} from './nats.options.js';

/** A NatsClient whose connection is `connection` (no server involved). */
function clientWith(
  connection: object,
  options: NatsModuleOptions = {},
): NatsClient {
  const client = new NatsClient({} as BaseConfig, options);
  Reflect.set(client, 'handles', { connection });
  Reflect.set(client, 'connected', true);
  return client;
}

function fakeConnection(drain: () => Promise<void>) {
  return {
    isClosed: vi.fn(() => false),
    drain: vi.fn(drain),
    close: vi.fn(() => Promise.resolve()),
  };
}

describe('connectionDrainBoundMs', () => {
  it('is the configured bound, or what is left of the shutdown budget less 1 s', () => {
    expect(DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS).toBe(5000);
    expect(connectionDrainBoundMs(undefined, undefined)).toBe(5000);
    expect(connectionDrainBoundMs(2000, undefined)).toBe(2000);
    expect(connectionDrainBoundMs(undefined, 30_000)).toBe(5000);
    expect(connectionDrainBoundMs(undefined, 3500)).toBe(2500);
    expect(connectionDrainBoundMs(undefined, 500)).toBe(0);
    expect(connectionDrainBoundMs(-1, undefined)).toBe(0);
  });
});

describe('shutdown deadline', () => {
  afterEach(() => {
    resetShutdownDeadline();
  });

  it('counts down from the first start only', () => {
    expect(remainingShutdownMs()).toBeUndefined();
    startShutdownDeadline(30_000, 1000);
    startShutdownDeadline(5000, 2000); // a second signal does not restart it
    expect(remainingShutdownMs(11_000)).toBe(20_000);
    expect(remainingShutdownMs(40_000)).toBe(0);
    resetShutdownDeadline();
    startShutdownDeadline(0);
    expect(remainingShutdownMs()).toBeUndefined();
  });
});

describe('NatsClient.onApplicationShutdown (K3)', () => {
  afterEach(() => {
    resetShutdownDeadline();
    vi.restoreAllMocks();
  });

  it('drains a healthy connection without closing it or warning', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const connection = fakeConnection(() => Promise.resolve());
    const client = clientWith(connection);
    await client.onApplicationShutdown();
    expect(connection.drain).toHaveBeenCalledTimes(1);
    expect(connection.close).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('closes the connection after the bound when the server never answers', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const connection = fakeConnection(() => new Promise<void>(() => undefined));
    const client = clientWith(connection, { connectionDrainTimeoutMs: 300 });
    const startedAt = performance.now();
    await client.onApplicationShutdown();
    const took = performance.now() - startedAt;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(1000);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /NATS drain did not finish within 300 ms \(server not answering\): closing the connection/,
    );
  });

  it('bounds the drain by what is left of SHUTDOWN_TIMEOUT_MS', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // 1.3 s left of the budget: 0.3 s for the drain, 1 s for the hooks after it.
    startShutdownDeadline(1300);
    const connection = fakeConnection(() => new Promise<void>(() => undefined));
    const client = clientWith(connection);
    const startedAt = performance.now();
    await client.onApplicationShutdown();
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('closes the connection when the drain fails, and never hangs on close', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const connection = {
      ...fakeConnection(() => Promise.reject(new Error('connection closed'))),
      close: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const client = clientWith(connection);
    const startedAt = performance.now();
    await client.onApplicationShutdown();
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      'NATS drain failed: connection closed',
    );
  });
});
