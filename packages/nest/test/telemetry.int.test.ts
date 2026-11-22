import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  currentTraceId,
  currentTraceparent,
  DEFAULT_IGNORED_PATHS,
  SpanKind,
  startTelemetry,
  type TelemetryHandle,
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

/** A span of an OTLP/HTTP JSON export. */
interface ExportedSpan {
  readonly scope: string;
  readonly name: string;
  readonly traceId: string;
  readonly kind: number;
}

/** The spans and resource attributes of the JSON exports received so far. */
function exportedSpans(collector: Collector): {
  readonly spans: ExportedSpan[];
  readonly resources: Record<string, unknown>[];
} {
  const spans: ExportedSpan[] = [];
  const resources: Record<string, unknown>[] = [];
  for (const request of collector.requests) {
    if (request.path !== '/v1/traces') continue;
    const body = JSON.parse(request.body.toString('utf8')) as {
      resourceSpans: {
        resource: {
          attributes: {
            key: string;
            value: { stringValue?: string; intValue?: number };
          }[];
        };
        scopeSpans: {
          scope: { name: string };
          spans: { name: string; traceId: string; kind: number }[];
        }[];
      }[];
    };
    for (const resourceSpans of body.resourceSpans) {
      resources.push(
        Object.fromEntries(
          resourceSpans.resource.attributes.map((attribute) => [
            attribute.key,
            attribute.value.stringValue ?? attribute.value.intValue,
          ]),
        ),
      );
      for (const scopeSpans of resourceSpans.scopeSpans)
        for (const span of scopeSpans.spans)
          spans.push({
            scope: scopeSpans.scope.name,
            name: span.name,
            traceId: span.traceId,
            kind: span.kind,
          });
    }
  }
  return { spans, resources };
}

/**
 * The enabled path of the tracing bootstrap with every instrumentation and
 * the ESM loader hook, as `main.ts` starts it (this file runs in its own
 * worker: the global tracer provider does not leak into other tests, and
 * the application modules are imported only after telemetry started).
 */
describe('startTelemetry with an OTLP endpoint (CORE-13: without NodeSDK)', () => {
  let collector: Collector;
  let handle: TelemetryHandle;

  beforeAll(async () => {
    collector = await startCollector();
    handle = await startTelemetry({
      serviceName: 'telemetry-int',
      serviceVersion: '9.9.9',
      endpoint: `${collector.endpoint}/`,
      // The in-process collector must not trace the exports it receives.
      ignorePaths: [...DEFAULT_IGNORED_PATHS, '/v1/traces'],
    });
    // vitest's module runner loads CommonJS externals such as ioredis around
    // the ESM loader hook (import-in-the-middle), which wraps them under plain
    // Node.js: requiring it once lets require-in-the-middle patch the shared
    // class, as a service's `node dist/main.js` does through the hook.
    createRequire(import.meta.url)('ioredis');
  });

  afterAll(async () => {
    await handle.shutdown();
    await new Promise<void>((resolve) => {
      collector.server.close(() => {
        resolve();
      });
    });
  });

  it('traces http, fastify, pg, ioredis, undici and NATS-propagated work, exported to <endpoint>/v1/traces', async () => {
    expect(handle.enabled).toBe(true);
    // Loaded after startTelemetry, as main.ts imports server.ts.
    const [
      { Controller, Get, Inject, Injectable, Module },
      { EVENT_TYPES, subjects },
      { Public },
      { baseConfigSchema },
      { DatabaseModule, InjectPool },
      { EventHandler, EventPublisher: Publisher, NatsModule },
      { InjectRedis, RedisModule },
      testing,
      infra,
    ] = await Promise.all([
      import('@nestjs/common'),
      import('@darmawanweb/ais-its-contracts/events'),
      import('../src/auth/index.js'),
      import('../src/config/index.js'),
      import('../src/db/index.js'),
      import('../src/nats/index.js'),
      import('../src/redis/index.js'),
      import('../src/testing/index.js'),
      import('./support/infra.js'),
    ]);

    const schema = infra.uniqueName('traced');
    const url = await testing.provisionServiceSchema(
      infra.testInfra().postgresAdminUrl,
      schema,
    );
    const mmsi = 300_000_000 + Math.floor(Math.random() * 600_000_000);
    const consumer = {
      durableName: infra.uniqueName('traced'),
      stream: 'FUEL',
      filterSubjects: [subjects.fuelReading(mmsi)],
      service: 'emission',
      eventTypes: [EVENT_TYPES.FUEL_READING_RECORDED],
      maxDeliver: 3,
      description: 'telemetry integration test consumer',
    } as const;
    const consumedTraceIds: (string | undefined)[] = [];

    @Injectable()
    class TracedConsumer {
      @EventHandler({ consumer })
      onReading(): void {
        consumedTraceIds.push(currentTraceId());
      }
    }

    @Controller('traced')
    class TracedController {
      constructor(
        @InjectPool() private readonly pool: Pool,
        @InjectRedis() private readonly redis: Redis,
        @Inject(Publisher)
        private readonly publisher: InstanceType<typeof Publisher>,
      ) {}

      @Public()
      @Get()
      async work(): Promise<{ readonly traceId: string | undefined }> {
        await this.pool.query('SELECT 1');
        await this.redis.ping();
        await (await fetch(`${collector.endpoint}/ping`)).text();
        await this.publisher.publishEvent(EVENT_TYPES.FUEL_READING_RECORDED, {
          mmsi,
          time: new Date().toISOString(),
          periodStart: null,
          fuelMeTon: 0.4,
          fuelAeTon: 0.05,
          deviceId: null,
          source: 'api',
        });
        return { traceId: currentTraceId() };
      }
    }

    @Module({
      imports: [
        DatabaseModule.forRoot(),
        RedisModule.forRoot(),
        NatsModule.forRoot({ streams: ['FUEL'] }),
      ],
      controllers: [TracedController],
      providers: [TracedConsumer],
    })
    class AppModule {}

    const app = await testing.buildTestApp(AppModule, {
      config: testing.createTestConfig(baseConfigSchema, {
        SERVICE_NAME: 'telemetry-int',
        DATABASE_URL: url,
        DATABASE_SCHEMA: schema,
        REDIS_URL: infra.testInfra().redisUrl,
        NATS_URL: infra.testInfra().natsUrl,
      }),
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(`${await app.getUrl()}/api/v2/traced`);
      const { traceId } = (await response.json()) as { traceId: string };
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      // The consumer ran inside the trace of the request (traceparent header).
      await testing.waitFor(() => consumedTraceIds.length > 0, {
        timeoutMs: 15_000,
      });
      expect(consumedTraceIds[0]).toBe(traceId);

      const traceparent = await withSpan(
        'unit-of-work',
        { kind: SpanKind.INTERNAL },
        () => Promise.resolve(currentTraceparent()),
      );
      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    } finally {
      await app.close();
    }

    await handle.shutdown();
    await handle.shutdown(); // idempotent
    const { spans, resources } = exportedSpans(collector);
    expect(resources[0]).toMatchObject({
      'service.name': 'telemetry-int',
      'service.version': '9.9.9',
    });
    expect(resources[0]?.['process.pid']).toBe(process.pid);
    const scopesOf = (id: string) =>
      new Set(
        spans.filter((span) => span.traceId === id).map((span) => span.scope),
      );
    const requestScopes = scopesOf(
      spans.find((span) => span.scope === '@fastify/otel')?.traceId ?? '',
    );
    for (const scope of [
      '@opentelemetry/instrumentation-http',
      '@fastify/otel',
      '@opentelemetry/instrumentation-pg',
      '@opentelemetry/instrumentation-ioredis',
      '@opentelemetry/instrumentation-undici',
      '@darmawanweb/ais-its-nest',
    ])
      expect(requestScopes).toContain(scope);
    expect(spans.map((span) => span.name)).toContain('unit-of-work');
    // No span of the exports themselves.
    expect(
      spans.some(
        (span) =>
          span.scope === '@opentelemetry/instrumentation-http' &&
          span.name.includes('/v1/traces'),
      ),
    ).toBe(false);
  });
});
