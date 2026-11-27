import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { baseConfigSchema } from '../src/config/index.js';
import { NatsClient } from '../src/nats/index.js';
import { createTestConfig } from '../src/testing/index.js';
import { testInfra } from './support/infra.js';
import { startTcpLink, type TcpLink } from './support/tcp-link.js';

/** K3: the connection drain at shutdown against a server that stops answering. */
describe('NatsClient shutdown (bounded drain)', () => {
  const links: TcpLink[] = [];

  afterEach(async () => {
    for (const link of links.splice(0)) {
      link.release();
      await link.close();
    }
    vi.restoreAllMocks();
  });

  async function connectedThrough(
    connectionDrainTimeoutMs?: number,
  ): Promise<{ client: NatsClient; link: TcpLink }> {
    const link = await startTcpLink(testInfra().natsUrl);
    links.push(link);
    const client = new NatsClient(
      createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'nats-shutdown-test',
        NATS_URL: link.url,
      }),
      { connectionDrainTimeoutMs },
    );
    const { connection } = await client.ready();
    // Something to drain: a subscription and an unflushed publish.
    connection.subscribe('nats-shutdown-test.>');
    connection.publish('nats-shutdown-test.ping', 'x');
    return { client, link };
  }

  it('drains normally while the server answers', async () => {
    const { client } = await connectedThrough();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const startedAt = performance.now();
    await client.onApplicationShutdown();
    expect(performance.now() - startedAt).toBeLessThan(2000);
    expect(client.connection.isClosed()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('closes after the bound when the server accepts the connection but never answers', async () => {
    const { client, link } = await connectedThrough(1500);
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    // Like a paused server container: the connection stays open, nothing comes back.
    link.hold();
    const startedAt = performance.now();
    await client.onApplicationShutdown();
    const took = performance.now() - startedAt;
    expect(took).toBeGreaterThanOrEqual(1450);
    expect(took).toBeLessThan(3500);
    expect(client.connection.isClosed()).toBe(true);
    expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(
      'NATS drain did not finish within 1500 ms (server not answering): closing the connection, unflushed publishes are lost',
    );
  });
});
