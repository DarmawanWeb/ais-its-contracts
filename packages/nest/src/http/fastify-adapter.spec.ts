import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { baseConfigSchema, loadConfig } from '../config/define-config.js';
import { createFastifyAdapter } from './fastify-adapter.js';

const instances: FastifyInstance[] = [];

async function ipSeenBy(
  trustProxy: Parameters<typeof createFastifyAdapter>[0],
  remoteAddress: string,
  forwardedFor: string,
): Promise<string> {
  const fastify = createFastifyAdapter(trustProxy).getInstance();
  instances.push(fastify);
  fastify.get('/ip', (request) => ({ ip: request.ip }));
  const response = await fastify.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress,
    headers: { 'x-forwarded-for': forwardedFor },
  });
  return response.json<{ ip: string }>().ip;
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
});

describe('createFastifyAdapter proxy trust (client IP)', () => {
  it('ignores X-Forwarded-For from direct callers on public addresses by default', async () => {
    expect(await ipSeenBy({}, '198.51.100.9', '203.0.113.77')).toBe(
      '198.51.100.9',
    );
  });

  it('takes the client IP from a gateway on a private network', async () => {
    expect(await ipSeenBy({}, '10.0.3.7', '198.51.100.9')).toBe('198.51.100.9');
    // a forged left-most entry is not the hop the gateway appended
    expect(await ipSeenBy({}, '172.18.0.2', '203.0.113.77, 198.51.100.9')).toBe(
      '198.51.100.9',
    );
  });

  it('trusts exactly the configured TRUSTED_PROXIES, or none', async () => {
    const config = loadConfig(baseConfigSchema, {
      env: { SERVICE_NAME: 'proxy-test', TRUSTED_PROXIES: '10.0.0.0/8' },
      output: null,
    });
    expect(config.TRUSTED_PROXIES).toEqual(['10.0.0.0/8']);
    const trusted = { trustProxy: config.TRUSTED_PROXIES };
    expect(await ipSeenBy(trusted, '10.1.2.3', '198.51.100.9')).toBe(
      '198.51.100.9',
    );
    expect(await ipSeenBy(trusted, '172.18.0.2', '198.51.100.9')).toBe(
      '172.18.0.2',
    );
    const none = loadConfig(baseConfigSchema, {
      env: { SERVICE_NAME: 'proxy-test', TRUSTED_PROXIES: 'none' },
      output: null,
    });
    expect(none.TRUSTED_PROXIES).toEqual([]);
    expect(
      await ipSeenBy(
        { trustProxy: none.TRUSTED_PROXIES },
        '10.1.2.3',
        '198.51.100.9',
      ),
    ).toBe('10.1.2.3');
  });

  it('rejects invalid TRUSTED_PROXIES', () => {
    expect(() =>
      loadConfig(baseConfigSchema, {
        env: { SERVICE_NAME: 'proxy-test', TRUSTED_PROXIES: 'everyone' },
        output: null,
      }),
    ).toThrow(/TRUSTED_PROXIES/);
  });
});
