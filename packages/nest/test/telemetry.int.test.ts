import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  currentTraceparent,
  SpanKind,
  startTelemetry,
  withSpan,
} from '../src/telemetry/index.js';

/** A fake OTLP/HTTP collector that records the requests it receives. */
interface Collector {
  readonly server: Server;
  readonly endpoint: string;
  readonly requests: { path: string; body: Buffer }[];
}

async function startCollector(): Promise<Collector> {
  const requests: { path: string; body: Buffer }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ path: request.url ?? '', body: Buffer.concat(chunks) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, endpoint: `http://127.0.0.1:${port}`, requests };
}

/**
 * The enabled path of the tracing bootstrap (this file runs in its own
 * worker, so the global tracer provider does not leak into other tests).
 */
describe('startTelemetry with an OTLP endpoint', () => {
  let collector: Collector;

  beforeAll(async () => {
    collector = await startCollector();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      collector.server.close(() => {
        resolve();
      });
    });
  });

  it('exports spans with the service resource to <endpoint>/v1/traces and flushes on shutdown', async () => {
    const handle = await startTelemetry({
      serviceName: 'telemetry-int',
      serviceVersion: '9.9.9',
      endpoint: `${collector.endpoint}/`,
      esmLoaderHook: false,
      instrumentations: ['undici'],
    });
    expect(handle.enabled).toBe(true);

    const traceparent = await withSpan(
      'unit-of-work',
      { kind: SpanKind.INTERNAL },
      () => Promise.resolve(currentTraceparent()),
    );
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    await handle.shutdown();
    await handle.shutdown(); // idempotent
    const traces = collector.requests.filter((r) => r.path === '/v1/traces');
    expect(traces.length).toBeGreaterThanOrEqual(1);
    const body = Buffer.concat(traces.map((r) => r.body)).toString('latin1');
    expect(body).toContain('telemetry-int');
    expect(body).toContain('unit-of-work');
  });
});
