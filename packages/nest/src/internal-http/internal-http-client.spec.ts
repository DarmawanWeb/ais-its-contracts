import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  backoffWithJitter,
  InternalHttpClient,
} from './internal-http-client.js';
import { InternalHttpError } from './internal-http-error.js';

type Handler = (request: Request) => Response | Promise<Response>;

function fakeFetch(handlers: Handler[]): {
  fetch: typeof fetch;
  requests: Request[];
} {
  const requests: Request[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    requests.push(request);
    const handler =
      handlers[Math.min(requests.length - 1, handlers.length - 1)];
    if (handler === undefined) throw new TypeError('fetch failed');
    return handler(request);
  };
  return { fetch: fetchImpl, requests };
}

const json = (
  body: unknown,
  status = 200,
  type = 'application/json',
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': type },
  });

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

describe('InternalHttpClient', () => {
  it('never follows redirects, so the internal token and body stay with the target', async () => {
    const leaked: string[] = [];
    const elsewhere = createServer((request, response) => {
      leaked.push(String(request.headers['x-internal-token']));
      response.end('{}');
    });
    const elsewhereUrl = await listen(elsewhere);
    const target = createServer((_request, response) => {
      response.writeHead(307, { location: `${elsewhereUrl}/steal` }).end();
    });
    const targetUrl = await listen(target);
    try {
      const client = new InternalHttpClient({
        baseUrl: targetUrl,
        internalToken: 'prod-internal-secret',
        retries: 0,
      });
      const failure = await client
        .post('/internal/api-keys/introspect', { key: 'sk_secret' })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InternalHttpError);
      expect(failure).toMatchObject({ failure: 'http_status', status: 307 });
      expect(leaked).toEqual([]);
    } finally {
      target.close();
      elsewhere.close();
    }
  });

  it('sends the internal token, JSON and the user agent, and validates responses', async () => {
    const { fetch, requests } = fakeFetch([() => json({ active: false })]);
    const client = new InternalHttpClient({
      baseUrl: 'http://auth:3001',
      internalToken: 'secret',
      userAgent: 'fleet/0.1.0',
      fetch,
    });
    const result = await client.post(
      '/internal/api-keys/introspect',
      { key: 'k' },
      { schema: z.object({ active: z.boolean() }) },
    );
    expect(result).toEqual({ active: false });
    const request = requests[0];
    expect(request?.url).toBe('http://auth:3001/internal/api-keys/introspect');
    expect(request?.headers.get('x-internal-token')).toBe('secret');
    expect(request?.headers.get('user-agent')).toBe('fleet/0.1.0');
    expect(request?.headers.get('content-type')).toBe('application/json');
    expect(await request?.json()).toEqual({ key: 'k' });
  });

  it('retries idempotent requests on 502/503/504 and network errors only', async () => {
    const unavailable = (): Response => json({}, 503);
    const retried = fakeFetch([
      unavailable,
      () => Promise.reject(new TypeError('fetch failed')),
      () => json({ ok: true }),
    ]);
    const client = new InternalHttpClient({
      baseUrl: 'http://fleet:3002',
      fetch: retried.fetch,
      retryBaseDelayMs: 1,
    });
    expect(
      await client.get('/internal/vessels', {
        query: { mmsi: 525005223, skip: undefined },
      }),
    ).toEqual({ ok: true });
    expect(retried.requests).toHaveLength(3);
    expect(retried.requests[0]?.url).toBe(
      'http://fleet:3002/internal/vessels?mmsi=525005223',
    );

    const post = fakeFetch([unavailable, () => json({ ok: true })]);
    const postClient = new InternalHttpClient({
      baseUrl: 'http://fleet:3002',
      fetch: post.fetch,
      retryBaseDelayMs: 1,
    });
    await expect(postClient.post('/internal/x', {})).rejects.toMatchObject({
      status: 503,
      attempts: 1,
    });
    expect(
      await postClient.post('/internal/x', {}, { idempotent: true }),
    ).toEqual({ ok: true });
  });

  it('parses problem details of failures', async () => {
    const { fetch } = fakeFetch([
      () =>
        json(
          {
            type: 'urn:ais-its:problem:vessel-not-found',
            title: 'Vessel not found',
            status: 404,
            code: 'VESSEL_NOT_FOUND',
          },
          404,
          'application/problem+json',
        ),
    ]);
    const client = new InternalHttpClient({
      baseUrl: 'http://fleet:3002',
      fetch,
    });
    const failure = await client
      .get('/internal/vessels/1')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InternalHttpError);
    expect(failure).toMatchObject({
      failure: 'http_status',
      status: 404,
      code: 'VESSEL_NOT_FOUND',
      isTransient: false,
    });
  });

  it('times out slow attempts and reports invalid responses', async () => {
    const slow = fakeFetch([
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(
              request.signal.reason instanceof Error
                ? request.signal.reason
                : new Error('aborted'),
            );
          });
        }),
    ]);
    const client = new InternalHttpClient({
      baseUrl: 'http://slow',
      fetch: slow.fetch,
      timeoutMs: 20,
      retries: 0,
    });
    await expect(client.get('/x')).rejects.toMatchObject({
      failure: 'timeout',
    });

    const invalid = fakeFetch([() => json({ active: 'yes' })]);
    const strict = new InternalHttpClient({
      baseUrl: 'http://auth',
      fetch: invalid.fetch,
    });
    await expect(
      strict.get('/x', { schema: z.object({ active: z.boolean() }) }),
    ).rejects.toMatchObject({
      failure: 'invalid_response',
    });
  });

  it('draws full-jitter backoff delays below the ceiling', () => {
    expect(backoffWithJitter(3, 100, 2000, () => 0.999)).toBe(799);
    expect(backoffWithJitter(10, 100, 2000, () => 0.5)).toBe(1000);
  });
});
