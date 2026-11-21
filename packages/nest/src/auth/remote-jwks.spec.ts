import { beforeAll, describe, expect, it } from 'vitest';

import { DomainError } from '../errors/domain-error.js';
import {
  createTestJwtIssuer,
  type TestJwtIssuer,
} from '../testing/jwt-issuer.js';
import { createAccessTokenVerifier } from './access-token-verifier.js';
import {
  createResilientRemoteJwks,
  type KeySetUnavailableError,
} from './remote-jwks.js';

const URL_ = 'http://auth.test/.well-known/jwks.json';

/** A scripted JWKS endpoint: each call answers with the current behaviour. */
function fakeEndpoint(issuer: TestJwtIssuer) {
  const state = {
    mode: 'ok' as 'ok' | '503' | 'down' | 'html' | 'redirect',
    calls: 0,
    redirects: [] as (RequestInit['redirect'] | undefined)[],
  };
  const fetchImpl = ((_url: URL, init?: RequestInit) => {
    state.calls += 1;
    state.redirects.push(init?.redirect);
    switch (state.mode) {
      case 'ok':
        return Promise.resolve(Response.json(issuer.jwks));
      case '503':
        return Promise.resolve(new Response('closing', { status: 503 }));
      case 'html':
        return Promise.resolve(new Response('<html/>', { status: 200 }));
      case 'redirect':
        return Promise.resolve(
          new Response(null, {
            status: 307,
            headers: { location: 'https://elsewhere.test/jwks' },
          }),
        );
      case 'down':
        return Promise.reject(new TypeError('fetch failed: ECONNREFUSED'));
    }
  }) as typeof fetch;
  return { state, fetchImpl };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof DomainError) return error.status;
    throw error;
  }
}

describe('createResilientRemoteJwks (spec §8.2)', () => {
  let issuer: TestJwtIssuer;
  let token: string;

  beforeAll(async () => {
    issuer = await createTestJwtIssuer();
    token = await issuer.sign({ roles: ['viewer'] });
  });

  function setup(options: { readonly maxStaleMs?: number } = {}) {
    let now = 1_000_000;
    const endpoint = fakeEndpoint(issuer);
    const failures: KeySetUnavailableError[] = [];
    const jwks = createResilientRemoteJwks(URL_, {
      cacheMaxAgeMs: 60_000,
      maxStaleMs: options.maxStaleMs ?? 3_600_000,
      cooldownMs: 10_000,
      now: () => now,
      fetch: endpoint.fetchImpl,
      onRefreshError: (error) => failures.push(error),
    });
    const verifier = createAccessTokenVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      keyResolver: jwks.resolve,
    });
    return {
      endpoint,
      failures,
      verify: () => statusOf(verifier.verify(token)),
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('keeps verifying with cached keys while the JWKS endpoint fails (stale-if-error)', async () => {
    const { endpoint, failures, verify, advance } = setup();
    expect(await verify()).toBe(200);
    expect(endpoint.state.calls).toBe(1);

    endpoint.state.mode = '503';
    advance(120_000); // older than cacheMaxAge: refreshed in the background
    expect(await verify()).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(endpoint.state.calls).toBe(2);
    expect(failures).toHaveLength(1);

    endpoint.state.mode = 'down';
    advance(600_000);
    expect(await verify()).toBe(200);
    expect(await verify()).toBe(200); // cooldown: no fetch per request
    await new Promise((resolve) => setImmediate(resolve));
    expect(endpoint.state.calls).toBe(3);
  });

  it('answers 503, never 401, when no usable keys can be fetched', async () => {
    for (const mode of ['503', 'down', 'html', 'redirect'] as const) {
      const { endpoint, verify } = setup();
      endpoint.state.mode = mode;
      expect(await verify()).toBe(503);
    }
  });

  it('stops trusting cached keys after maxStale', async () => {
    const { endpoint, verify, advance } = setup({ maxStaleMs: 600_000 });
    expect(await verify()).toBe(200);
    endpoint.state.mode = 'down';
    advance(700_000);
    expect(await verify()).toBe(503);
    endpoint.state.mode = 'ok';
    advance(20_000);
    expect(await verify()).toBe(200);
  });

  it('does not follow redirects', async () => {
    const { endpoint, verify } = setup();
    endpoint.state.mode = 'redirect';
    await verify();
    expect(endpoint.state.redirects).toEqual(['manual']);
  });

  it('refetches once per cooldown for an unknown kid, then rejects the token (401)', async () => {
    const other = await createTestJwtIssuer({ kid: 'rotated-key' });
    const { endpoint, advance } = setup();
    const verifier = createAccessTokenVerifier({
      issuer: issuer.issuer,
      audience: issuer.audience,
      keyResolver: createResilientRemoteJwks(URL_, {
        cooldownMs: 10_000,
        fetch: endpoint.fetchImpl,
      }).resolve,
    });
    const foreign = await other.sign({ roles: ['viewer'] });
    expect(await statusOf(verifier.verify(foreign))).toBe(401);
    expect(await statusOf(verifier.verify(foreign))).toBe(401);
    advance(0);
    // first verification: initial fetch only (the cooldown starts with it)
    expect(endpoint.state.calls).toBe(1);
  });
});
