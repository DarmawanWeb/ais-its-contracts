# @darmawanweb/ais-its-nest

NestJS 12 service kit of **AIS Maritime Intelligence** v2: everything a service needs to follow
`docs/PLATFORM_SPEC.md` (§4–§11) without re-implementing it — configuration, logging, the HTTP
bootstrap with RFC 9457 problem details, PostgreSQL with a forward-only SQL migrator, NATS
JetStream publishing and consumers, Valkey and rate limiters, authentication and authorization,
audit, health, metrics, tracing, an internal HTTP client, test helpers and the **Detector SDK**
(spec §18) on which the safety and surveillance services are built.

- ESM only (`"type": "module"`, built with `tsc`), Node.js ≥ 22.12 (24 in Docker/CI).
- Depends on [`@darmawanweb/ais-its-contracts`](../contracts) `^0.2.0` (events, subjects,
  permissions, problem types, alert registry).
- NestJS, Fastify, drizzle, swagger, terminus, class-validator/transformer, reflect-metadata and
  rxjs are **peer dependencies**; `testcontainers` and `@nestjs/testing` are optional peers used
  only by `./testing`.

```bash
pnpm add @darmawanweb/ais-its-contracts @darmawanweb/ais-its-nest \
  @nestjs/common @nestjs/core @nestjs/platform-fastify @nestjs/swagger @nestjs/terminus \
  fastify drizzle-orm class-validator class-transformer reflect-metadata rxjs zod
pnpm add -D @nestjs/testing testcontainers vitest unplugin-swc @swc/core pino-pretty
```

Inside the central repository the package resolves through the pnpm workspace; elsewhere map the
`@darmawanweb` scope to GitHub Packages in `~/.npmrc` (never in a repository `.npmrc`).

## Contents

| Import                                    | What                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@darmawanweb/ais-its-nest`               | `bootstrapService`, `exportOpenApi`, `defineConfig`/`loadConfig`/`ConfigModule`/`@InjectConfig`, errors, logging |
| `@darmawanweb/ais-its-nest/http`          | `ProblemDetailsFilter`, `createValidationPipe`, `configureApp`, OpenAPI helpers, Fastify adapter                 |
| `@darmawanweb/ais-its-nest/db`            | `DatabaseModule`, `@InjectPool`/`@InjectDb`, `withTransaction`, PostGIS helpers, migrator, `runMigrationsCli`    |
| `@darmawanweb/ais-its-nest/nats`          | `NatsModule`, `EventPublisher`, `@EventHandler`, `@OrderedEventHandler`, `OrderedConsumers`, `StreamReplayer`    |
| `@darmawanweb/ais-its-nest/redis`         | `RedisModule`, `@InjectRedis`, `FixedWindowRateLimiter`, `SlidingWindowRateLimiter`                              |
| `@darmawanweb/ais-its-nest/auth`          | `AuthModule` (global default-deny guard), decorators, principals, `assertOrgAccess`, `verifyAccessToken`         |
| `@darmawanweb/ais-its-nest/audit`         | `AuditModule`, `AuditService.record()`                                                                           |
| `@darmawanweb/ais-its-nest/health`        | `HealthModule`, `@ReadinessCheck()` for custom indicators                                                        |
| `@darmawanweb/ais-its-nest/metrics`       | `MetricsModule`, `MetricsService` (prom-client, prefix `aisits_`)                                                |
| `@darmawanweb/ais-its-nest/telemetry`     | `startTelemetry`, W3C trace context helpers, `withSpan`                                                          |
| `@darmawanweb/ais-its-nest/internal-http` | `InternalHttpClient`, `InternalHttpError`                                                                        |
| `@darmawanweb/ais-its-nest/analytics`     | Detector SDK: `Detector`, `@RegisterDetector`, `DetectorRunnerModule`, state, indexes, `AlertEmitter`, harness   |
| `@darmawanweb/ais-its-nest/testing`       | `startTestInfra`, `provisionServiceSchema`, `createTestJwtIssuer`, fake API keys, `buildTestApp`, `waitFor`      |

## The lifecycle rule

**No connection is opened in a constructor or in an async provider factory.** Every module
creates lazy clients and connects in `onModuleInit` (database, NATS, Valkey) or
`onApplicationBootstrap` (consumers, the detector runner), and closes them in
`beforeApplicationShutdown` / `onApplicationShutdown`. Consequences:

- `exportOpenApi()` builds the document of the real `AppModule` with no infrastructure at all
  (`pnpm openapi` in CI).
- Startup order is deterministic: config → logging → `onModuleInit` (connect, **migrate**, ensure
  streams) → `onApplicationBootstrap` (restore state, load projections, start consumers) → HTTP
  port opens. Readiness turns `503` as soon as a shutdown starts.
- Shutdown on `SIGTERM`/`SIGINT`: stop accepting requests → stop consumers and wait for in-flight
  handlers (bounded) → drain NATS → close the pool / quit Valkey → flush traces. A deadline
  (`SHUTDOWN_TIMEOUT_MS`, default 30 s) force-exits a stuck process.

Follow the same rule in service code: inject the pool or the publisher and use them from request
handlers, consumers or lifecycle hooks — never at construction time.

## A complete minimal service

The surveillance-style service below has configuration, a migration, a database-backed event
repository, a durable consumer, a detector, an authenticated route, Swagger, metrics and health.
It is the code of the scratch project used to verify each release.

```text
migrations/0001_init.sql
src/config.ts               zod env schema (base + own variables)
src/openapi.options.ts
src/app.module.ts
src/detectors.controller.ts
src/detectors/geofence.detector.ts
src/events/surveillance-events.repository.ts
src/events/fleet.projection.ts
src/main.ts                 telemetry first, then the server
src/server.ts               bootstrapService
src/migrate.ts              pnpm migrate
src/openapi.ts              pnpm openapi (no infrastructure needed)
```

```ts
// src/config.ts
import {
  type AppConfig,
  defineConfig,
  envInteger,
} from '@darmawanweb/ais-its-nest';
import * as z from 'zod';

export const configSchema = defineConfig({
  SERVICE_NAME: z.string().default('surveillance'),
  SERVICE_VERSION: z.string().default('0.1.0'),
  PORT: envInteger(0, 65_535).default(3007),
  DATABASE_SCHEMA: z.string().default('surveillance'),
});
export type Config = AppConfig<typeof configSchema>;
```

```ts
// src/openapi.options.ts
import type { OpenApiOptions } from '@darmawanweb/ais-its-nest';

export const OPENAPI: OpenApiOptions = {
  title: 'AIS Maritime Intelligence — surveillance service',
  version: '0.1.0',
  tags: [{ name: 'surveillance', description: 'Illegal-activity detectors' }],
};
```

```ts
// src/app.module.ts
import { DetectorRunnerModule } from '@darmawanweb/ais-its-nest/analytics';
import { AuditModule } from '@darmawanweb/ais-its-nest/audit';
import { AuthModule } from '@darmawanweb/ais-its-nest/auth';
import { DatabaseModule } from '@darmawanweb/ais-its-nest/db';
import { NatsModule } from '@darmawanweb/ais-its-nest/nats';
import { Module } from '@nestjs/common';

import { DetectorsController } from './detectors.controller.js';
import { GeofenceDetector } from './detectors/geofence.detector.js';
import { FleetProjection } from './events/fleet.projection.js';
import { SurveillanceEventsRepository } from './events/surveillance-events.repository.js';

@Module({
  imports: [
    DatabaseModule.forRoot(), // pool + drizzle, migrations on boot (DB_MIGRATE_ON_BOOT)
    NatsModule.forRoot({ streams: ['ALERTS', 'AUDIT'] }), // streams this service PRODUCES to
    AuthModule.forRoot(), // global default-deny guard
    AuditModule,
    DetectorRunnerModule.forRoot({
      positions: 'surveillance-positions', // contracts CONSUMERS key
      persistence: { useClass: SurveillanceEventsRepository },
    }),
  ],
  controllers: [DetectorsController],
  providers: [GeofenceDetector, FleetProjection],
})
export class AppModule {}
```

```ts
// src/detectors.controller.ts
import {
  type DetectorDescription,
  DetectorRegistry,
} from '@darmawanweb/ais-its-nest/analytics';
import { RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('surveillance')
@Controller('surveillance/detectors') // → GET /api/v2/surveillance/detectors
export class DetectorsController {
  constructor(private readonly registry: DetectorRegistry) {}

  @RequirePermissions('surveillance:read')
  @Get()
  list(): DetectorDescription[] {
    return this.registry.describe(); // ids, method ids, active thresholds
  }
}
```

```ts
// src/events/fleet.projection.ts — a durable consumer writing a projection table
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { InjectPool } from '@darmawanweb/ais-its-nest/db';
import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';
import type { Pool } from 'pg';

@Injectable()
export class FleetProjection {
  constructor(@InjectPool() private readonly pool: Pool) {}

  @EventHandler({ consumer: 'surveillance-fleet' })
  async onVessel(event: ConsumerEnvelope<'surveillance-fleet'>): Promise<void> {
    switch (event.type) {
      case EVENT_TYPES.FLEET_VESSEL_UPSERTED:
        await this.pool.query(
          `INSERT INTO vessels (vessel_id, mmsi, org_id, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (vessel_id) DO UPDATE SET mmsi = EXCLUDED.mmsi, org_id = EXCLUDED.org_id,
             updated_at = EXCLUDED.updated_at WHERE vessels.updated_at <= EXCLUDED.updated_at`,
          [
            event.data.id,
            event.data.mmsi,
            event.data.orgId,
            event.data.updatedAt,
          ],
        );
        break;
      case EVENT_TYPES.FLEET_VESSEL_DELETED:
        await this.pool.query('DELETE FROM vessels WHERE vessel_id = $1', [
          event.data.id,
        ]);
        break;
    }
  }
}
```

```ts
// src/main.ts — instrumentation patches modules as they load: start it before the app
import { startTelemetry } from '@darmawanweb/ais-its-nest/telemetry';

await startTelemetry({ serviceName: 'surveillance', serviceVersion: '0.1.0' }); // no-op without OTEL_EXPORTER_OTLP_ENDPOINT
await import('./server.js');
```

```ts
// src/server.ts
import 'reflect-metadata';
import { bootstrapService, loadConfig } from '@darmawanweb/ais-its-nest';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { OPENAPI } from './openapi.options.js';

await bootstrapService({
  appModule: AppModule,
  config: loadConfig(configSchema),
  openapi: OPENAPI,
});
```

```ts
// src/migrate.ts — "migrate": "node dist/migrate.js"
import { runMigrationsCli } from '@darmawanweb/ais-its-nest/db';
import { configSchema } from './config.js';

await runMigrationsCli({ configSchema });
```

```ts
// src/openapi.ts — "openapi": "node dist/openapi.js" (writes ./openapi.json, opens no connection)
import 'reflect-metadata';
import { exportOpenApi, loadConfig } from '@darmawanweb/ais-its-nest';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { OPENAPI } from './openapi.options.js';

await exportOpenApi({
  appModule: AppModule,
  config: loadConfig(configSchema),
  openapi: OPENAPI,
});
```

The detector and the repository are shown in [Writing a detector](#writing-a-detector). The
`tsconfig.json` needs `module`/`moduleResolution: nodenext`, `experimentalDecorators` and
`emitDecoratorMetadata`; relative imports end in `.js`.

## Configuration (`.`)

`defineConfig(shape)` extends the spec §4 base schema (`baseEnvSchema`) with service variables or
typed overrides of base variables (another default), applies the production rules and the derived
defaults, and returns a zod schema. `loadConfig(schema)` loads `.env` when present
(`process.loadEnvFile`, already-set variables win), treats empty values as unset, validates,
**prints every problem** (names and reasons, never values) and throws `ConfigValidationError`;
the result is deep-frozen. `AppConfig<typeof schema>` is its type.

| Variable                                              | Default                                                                         | Notes                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `NODE_ENV`                                            | `development`                                                                   | `development` \| `test` \| `production`             |
| `SERVICE_NAME` / `SERVICE_VERSION`                    | (required) / `0.0.0`                                                            | logs, metrics, event `source`, `audit.v1.<service>` |
| `HOST` / `PORT`                                       | `0.0.0.0` / `3000`                                                              | override `PORT` per spec §3                         |
| `LOG_LEVEL` / `LOG_PRETTY`                            | `info` / `true` in development                                                  | `pino-pretty` optional peer                         |
| `DATABASE_URL`                                        | `postgres://<schema>_svc:<schema>_svc@localhost:5432/aisits` outside production | required in production                              |
| `DATABASE_SCHEMA`                                     | —                                                                               | `search_path=<schema>,public`                       |
| `DATABASE_POOL_MAX` / `DATABASE_STATEMENT_TIMEOUT_MS` | `10` / `30000`                                                                  |                                                     |
| `DB_MIGRATE_ON_BOOT`                                  | `true`                                                                          |                                                     |
| `NATS_URL`                                            | `nats://localhost:4222`                                                         | comma separated                                     |
| `REDIS_URL`                                           | `redis://localhost:6379`                                                        |                                                     |
| `AUTH_JWKS_URL`                                       | `http://localhost:3001/.well-known/jwks.json`                                   |                                                     |
| `AUTH_ISSUER` / `AUTH_AUDIENCE`                       | `ais-its-auth` / `ais-its-api`                                                  |                                                     |
| `AUTH_INTERNAL_URL`                                   | `http://localhost:3001`                                                         | API key introspection                               |
| `INTERNAL_TOKEN`                                      | `dev-internal-token-change-me`                                                  | refused in production (≥ 16 chars required)         |
| `CORS_ORIGINS`                                        | `http://localhost:5173,http://localhost:8000`                                   |                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                         | unset                                                                           | tracing only when set                               |
| `PUBLIC_BASE_URL`                                     | `http://localhost:8000`                                                         |                                                     |
| `SHUTDOWN_TIMEOUT_MS`                                 | `30000`                                                                         | graceful shutdown deadline                          |

Helpers for service variables: `envInteger(min, max?)`, `envBoolean()` (`true/false/1/0/yes/no/on/off`),
`envList()`, `envUrl(protocols)`. Inject the configuration with `@InjectConfig()`
(`constructor(@InjectConfig() private readonly config: Config) {}` — import `Config` with
`import type`).

## Logging (`.`)

nestjs-pino JSON lines with `service`, `version`, `requestId`, `traceId` and `principal` (id only);
`authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-internal-token` headers and `password`,
`token`, `secret`, `apiKey`, … fields are redacted; health and metrics probes are not logged; 5xx
log as `error`, 4xx as `warn`. Use Nest's `Logger` (`new Logger('Context')`) or inject
`PinoLogger`. Scripts without Nest use `createLogger({ service, level, pretty })`.

## HTTP (`.` and `./http`)

`bootstrapService({ appModule, config, openapi, configure?, cookies?, multipart?, adapter?, logging? })`
creates the Fastify app wrapped in the platform root module (config, logging, metrics, health,
validation pipe, problem details filter), then:

- global prefix `api/v2`, excluding `health/*`, `metrics`, `docs`, `openapi.json`, `internal/*`,
  `.well-known/*`;
- `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` → `400 VALIDATION_FAILED` with
  `errors: [{ field: 'positions.1.lat', message, code: 'isLatitude' }]`;
- `ProblemDetailsFilter`: every error becomes `application/problem+json`
  `{ type: 'urn:ais-its:problem:<slug>', title, status, detail, instance, code, traceId, requestId, …extra }`;
  unexpected errors are `500 INTERNAL_ERROR`, logged with their stack, with a generic detail in
  production; Fastify 4xx errors (`413`, `415`, malformed JSON) keep their status;
- helmet (CSP fit for Swagger UI), CORS from `CORS_ORIGINS` with credentials, `X-Request-Id`
  (incoming value reused when well-formed), HTTP RED metrics, `@fastify/cookie` (`cookies: true`)
  and `@fastify/multipart` (`multipart: true | options`);
- Swagger UI at `/docs`, JSON at `/openapi.json` (bearer default, `apiKey` and `internalToken`
  schemes, `ProblemDetails` default responses);
- graceful shutdown hooks, then `listen(HOST, PORT)`.

`exportOpenApi({ appModule, config, openapi, outFile? })` builds the same document without running
any lifecycle hook and writes `openapi.json`.

## Errors (`.`)

```ts
import {
  ConflictError,
  DomainError,
  NotFoundError,
} from '@darmawanweb/ais-its-nest';

throw new NotFoundError(`No vessel with MMSI ${mmsi}`, {
  code: 'VESSEL_NOT_FOUND',
  extra: { mmsi },
});
throw new ConflictError('MMSI already registered', {
  code: 'MMSI_ALREADY_EXISTS',
});
throw new DomainError('VESSEL_NOT_FOUND', { detail: '…' }); // shared contracts code
throw new DomainError('ZONE_GEOMETRY_INVALID', {
  status: 422,
  title: 'Invalid zone geometry',
  detail,
  extra,
});
```

Classes: `DomainError(code, { detail?, title?, errors?, extra?, headers?, cause? })`,
`NotFoundError`, `ConflictError`, `ForbiddenError`, `UnauthorizedError(detail, { challenge })`,
`ValidationFailedError(errors)`, `RateLimitedError({ retryAfterSeconds })` (sets `Retry-After`),
`BadRequestError`, `ServiceUnavailableError`. Shared codes come from contracts `ERROR_DEFINITIONS`.

## Database (`./db`)

```ts
DatabaseModule.forRoot({ schema?, migrationsDir? = './migrations', migrateOnBoot?, connectTimeoutMs? })
```

A lazy `pg.Pool` with `search_path=<DATABASE_SCHEMA>,public`, `DATABASE_POOL_MAX` and the statement
timeout; drizzle (`drizzle-orm/node-postgres`, pass `schema` for relational queries) — inject with
`@InjectPool()` (`Pool`) and `@InjectDb()` (`Database<typeof schema>`); readiness check
`database`. On init it waits for the database (bounded retries) and applies the migrations
**before the port opens**.

- `withTransaction(pool, async (client) => …, { isolationLevel?, readOnly?, retries? })` — retries
  serialization failures/deadlocks when `retries > 0`.
- PostGIS (all parameters bound, injection-safe): `geography('geom', { subtype: 'Point' })` drizzle
  column, `pointGeography(lon, lat)`, `geoJsonToGeography(geometry)`,
  `geographyAsGeoJson(column, digits?)` (selects a parsed GeoJSON object), `bboxEnvelope(bbox)`,
  `bboxEnvelopeGeography(bbox)`, `geographyIntersectsBBox(column, bbox)`, `distanceMeters(a, b)`,
  `withinMeters(a, b, meters)`.
- Migrator (spec §6): files `migrations/NNNN_snake_case.sql`, applied in order under a PostgreSQL
  advisory lock (concurrent instances wait), recorded in
  `<schema>.schema_migrations(version, name, checksum, applied_at)` with a SHA-256 checksum of the
  normalized SQL. An applied file that changed stops the boot (`MigrationChecksumMismatchError`).
  Each file runs in one transaction; a file whose **first line** is `-- aisits:no-transaction` runs
  statement by statement outside a transaction (continuous aggregates, `CREATE INDEX
CONCURRENTLY`). Services never run `CREATE EXTENSION`: the infrastructure creates
  `timescaledb`, `postgis` and `pgcrypto` in `public`.
- `runMigrationsCli({ configSchema, dir? })` for `pnpm migrate`; `runMigrations({ pool, schema, dir })`.

## NATS JetStream (`./nats`)

```ts
NatsModule.forRoot({ streams?: StreamName[], connectTimeoutMs?, requestTimeoutMs?, drainTimeoutMs? })
```

The connection reconnects forever with jittered backoff and drains on shutdown. `streams` lists the
contracts streams the service **produces** to: they are created or updated to the contracts
definition at boot (subjects, max age, per-subject limit, dedup window), never deleted. Consumers
ensure the stream they read and `DLQ`.

### Publishing

```ts
constructor(private readonly events: EventPublisher) {}

await this.events.publish(subjects.fleetVessel(vessel.id), EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot);
const { envelope, ack } = await this.events.publishEvent(EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED, state); // subject derived
await this.events.publishMany([{ type, data, subject?, options? }, …]);
// options: { msgId? (default envelope id), id?, time?, entityKey?, expect?, timeoutMs? }
```

The envelope gets `source = SERVICE_NAME`, a UUID v7 id, the time and `traceparent`; the payload is
validated against the contracts schema (`InvalidEventError`); headers: `Nats-Msg-Id`,
`traceparent`, `content-type: application/json`, `Ais-Its-Event-Type`.

### Durable consumers — one model: `@EventHandler` on provider methods

Decorate a method of a singleton provider; handlers are discovered when the application
bootstraps, one per durable consumer. The consumer (a contracts `CONSUMERS` key or an explicit
`DurableConsumerDefinition`) is created or updated idempotently (filter, ack wait, max deliver).

```ts
@EventHandler({ consumer: 'emission-positions', concurrency: 8, orderBySubject: true, maxDeliver?, ackWaitMs?, backoffMs? })
async onPosition(event: ConsumerEnvelope<'emission-positions'>, context: EventContext): Promise<void> { … }
// context: { subject, stream, consumer, streamSequence, deliveryCount, headers, storedAt, signal, working() }
```

| Outcome of a delivery                                             | Action                                                                     | `aisits_events_consumed_total{outcome}` |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| handler resolves                                                  | `ack`                                                                      | `ack`                                   |
| invalid JSON, envelope or payload                                 | `term` + warning log + `aisits_events_invalid_total`                       | `invalid`                               |
| event type unknown to this version / not handled by the consumer  | `ack` (forward compatibility)                                              | `skipped`                               |
| `NonRetryableError`                                               | `term` (never redelivered, not dead-lettered)                              | `term`                                  |
| `RetryableError` or any other error, `deliveryCount < maxDeliver` | `nak` with backoff (`retryAfterMs`, `backoffMs`, else 1 s × 2ⁿ ≤ 60 s)     | `nak`                                   |
| any retryable error at `deliveryCount = maxDeliver` (default 10)  | copy to `dlq.<stream>.<consumer>` with `Ais-Its-Dlq-*` headers, then `ack` | `dead_letter`                           |

Long handlers are kept alive with `working()` heartbeats (every `ackWaitMs / 2`). With
`concurrency > 1`, messages of the same subject (= same vessel) still run in order. Shutdown stops
pulling, waits for in-flight handlers up to `drainTimeoutMs` (then aborts `context.signal`) and naks
what was not started. Handlers must be idempotent (redeliveries happen).

### Ordered (ephemeral) consumers — fan-out, every instance gets every message

```ts
@OrderedEventHandler({ consumer: 'notification-safety', deliver: 'last_per_subject' })
onSafetyState(event: AnyEventEnvelope, context: EventContext): void { … }

const sub = await this.ordered.start({          // OrderedConsumers, at runtime
  name: 'zones-projection', stream: 'GEO', filterSubjects: [SUBJECT_FILTERS.GEO_ZONE],
  eventTypes: [EVENT_TYPES.GEO_ZONE_UPSERTED, EVENT_TYPES.GEO_ZONE_DELETED],
  deliver: 'last_per_subject',                   // 'new' | 'all' | 'last_per_subject' | { startTime } | { startSequence }
  handler: (event) => this.apply(event),
});
await sub.caughtUp();                            // the snapshot (pending at start) was handled
await sub.stop();
```

`last_per_subject` on a compacted stream (`FLEET`, `GEO`, `SAFETY`) delivers the latest snapshot of
every entity, then live changes. No acks; handler errors are logged and counted (`error`).

### Replay

`StreamReplayer.replay({ stream, filterSubjects, from, to?, eventTypes, handler, signal? })` reads a
time range with an ephemeral consumer up to the end of the stream at start (recomputations).

## Valkey (`./redis`)

`RedisModule.forRoot({ keyPrefix?, connectTimeoutMs? })` — lazy ioredis client connected on init
and quit on shutdown, `@InjectRedis()`, readiness check `redis`.

```ts
const logins = new FixedWindowRateLimiter(redis, {
  name: 'login-email',
  limit: 5,
  windowMs: 15 * 60_000,
});
const result = await logins.consume(email); // { allowed, remaining, resetAt, retryAfterMs, limit }
if (!result.allowed)
  throw new RateLimitedError({ retryAfterSeconds: result.retryAfterMs / 1000 });
```

Both limiters are single atomic Lua scripts. Fixed window counts every attempt; the sliding window
log (`SlidingWindowRateLimiter`) records only allowed requests and never exceeds `limit` in any
window. `peek(key)` reads without counting, `reset(key)` forgets.

## Authentication and authorization (`./auth`)

```ts
AuthModule.forRoot({ apiKeys? = true, keyResolver?, apiKeyIntrospector?, apiKeyCache?, imports? })
```

Registers a **global default-deny** guard (HTTP): every route needs a principal unless `@Public()`.

| Decorator                             | Effect                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@Public()`                           | anonymous access                                                                           |
| `@RequirePermissions('vessel:write')` | users need every listed permission (contracts `ROLE_PERMISSIONS`) → else `403 FORBIDDEN`   |
| `@AllowApiKey('ais:ingest')`          | the route also accepts `X-API-Key` with every listed scope → else `403 INSUFFICIENT_SCOPE` |
| `@Internal()`                         | `/internal/*` routes: constant-time `X-Internal-Token` check against `INTERNAL_TOKEN`      |
| `@CurrentPrincipal()`                 | parameter decorator: the `Principal` (`UserPrincipal` \| `ApiKeyPrincipal`)                |

- Access tokens: EdDSA, `iss`/`aud` from config, 30 s clock tolerance, contracts claim schema;
  keys from the remote JWKS (`AUTH_JWKS_URL`, cached 10 min, 30 s refetch cooldown) unless
  `keyResolver` is given (the auth service plugs its local keys, tests a test issuer).
- API keys only on `@AllowApiKey` routes: `POST {AUTH_INTERNAL_URL}/internal/api-keys/introspect`
  with `X-Internal-Token`, cached 60 s (active) / 10 s (unknown, revoked); when auth cannot be
  reached the request is **denied** with `503 SERVICE_UNAVAILABLE`.
- `401` = missing/invalid/expired credentials (with `WWW-Authenticate`), `403` = authenticated but
  not allowed.
- `UserPrincipal` (`id`, `sessionId`, `orgId`, `roles`, `permissions`, `can()`, `canAll()`,
  `isPlatformAdmin`, `hasAuthorityAccess`, `canAccessOrg()`), `ApiKeyPrincipal` (`id`, `orgId`,
  `scopes`, `hasScope()`, `canAccessOrg()`); `assertOrgAccess(principal, orgId)` and
  `assertPermission(principal, permission)` throw `403`.
- Outside HTTP (socket.io handshakes): inject `AccessTokenVerifier`, or call
  `verifyAccessToken(token, { issuer, audience, keyResolver: createRemoteKeyResolver(url) })`.

## Audit, health, metrics, tracing, internal HTTP

- **Audit** (`./audit`): `AuditService.record({ action: 'vessel.update', targetType, targetId, meta, orgId? }, principal?, request?)`
  publishes `audit.recorded.v1` to `audit.v1.<SERVICE_NAME>`; best effort (resolves `false` and
  counts `aisits_audit_failures_total` instead of throwing). Needs `NatsModule`.
- **Health** (`./health`, always on): `GET /health/live`, `GET /health/ready` aggregating the
  indicators registered by `DatabaseModule`, `NatsModule`, `RedisModule` and any provider
  decorated with `@ReadinessCheck()` implementing `{ healthKey, check(health) }`.
- **Metrics** (`./metrics`, always on): `GET /metrics`, default Node.js metrics prefixed `aisits_`,
  `aisits_http_requests_total` / `aisits_http_request_duration_seconds{method,route,status_code}`
  (route template), event and detector metrics; add your own with
  `metrics.counter({ name: 'ais_messages_total', help, labelNames })` (prefix added, get-or-create),
  `gauge()`, `histogram()`.
- **Tracing** (`./telemetry`): `startTelemetry({ serviceName, serviceVersion })` — OTLP/HTTP traces
  with http, Fastify, pg, ioredis and fetch instrumentation, a no-op without
  `OTEL_EXPORTER_OTLP_ENDPOINT`; call it before importing the app. Trace context travels in NATS
  headers and the envelope (`injectTraceContext`, `extractTraceContext`, `currentTraceparent`,
  `withSpan`).
- **Internal HTTP** (`./internal-http`): `InternalHttpClient.forService(config, baseUrl)` sends
  `X-Internal-Token`, JSON, `traceparent`; per-attempt timeout (5 s), limited jittered retries
  (2) for idempotent requests (`GET/HEAD/PUT/DELETE`, or `idempotent: true`) on network errors,
  timeouts and 502/503/504; failures are `InternalHttpError` with the remote problem details
  (`code`, `status`, `isTransient`).

## Detector SDK (`./analytics`)

Every analytics feature that reacts to vessel movement is **one class**: a NestJS provider that
implements `Detector` and is decorated with `@RegisterDetector()`. `DetectorRunnerModule` feeds it.

```ts
DetectorRunnerModule.forRoot({
  positions: 'safety-positions',        // durable AIS_POSITION consumer (contracts key or definition)
  concurrency?: 8,                      // vessels in parallel; one vessel's positions stay ordered
  zones?: true, fleet?: true,           // GEO / FLEET snapshots (ordered, last_per_subject)
  distanceModel?: 'wgs84',              // or 'sphere' (Turf.js / legacy parity)
  vesselState?: { maxVessels?, staleAfterMs?, mirror?: boolean | { keyPrefix?, ttlMs? } }, // mirror needs RedisModule
  pairSearch?: { cellSizeM?, maxAgeMs? },
  alertCooldownMs?: 600_000,
  persistence?: { useClass: MyEventsRepository },   // AlertPersistence
  env?, enabled?, callTimeoutMs?: 10_000, catchUpTimeoutMs?: 60_000, imports?,
})
```

Boot sequence: module init discovers and registers the detectors (unknown `DETECTORS` entries or
invalid `<ID>_*` variables stop the boot, listing every problem) → application bootstrap restores
open alerts (`persistence.loadOpen`) and mirrored vessel states, ensures `ALERTS`, loads the `GEO`
and `FLEET` snapshots and **waits until they are complete**, then starts the durable position
consumer and the ticks. Each instance holds every zone and vessel (ordered consumers), while
positions are shared between instances through the durable consumer; split work between
deployments with `DETECTORS`. Durable projections into tables (`safety-zones`,
`surveillance-fleet`, …) remain ordinary `@EventHandler` consumers.

For every position the runner first updates `VesselStateStore` and `PairSearch` (positions not
newer than the vessel's state are dropped: duplicates and out-of-order redeliveries), then calls
every enabled detector's `onPosition` concurrently. A detector that throws or exceeds
`callTimeoutMs` is logged and counted, never blocks the others, and never makes the message
redeliver. Zone and vessel changes reach `onZoneChanged` / `onVesselChanged` after the index was
updated (`initial: true` during the startup snapshot).

### Writing a detector

```ts
// src/detectors/geofence.detector.ts
import {
  type Detector,
  type DetectorContext,
  RegisterDetector,
  type VesselPosition,
} from '@darmawanweb/ais-its-nest/analytics';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

/** GEOFENCE_* variables, prefix removed: GEOFENCE_KINDS=restricted,mpa */
const geofenceConfig = z.object({
  KINDS: z
    .string()
    .default('restricted,mpa,custom')
    .transform((value) => value.split(',').map((kind) => kind.trim())),
});
type GeofenceConfig = z.output<typeof geofenceConfig>;

/**
 * Geofence entry: an alert while a vessel is inside a watched zone with `alertOnEnter`.
 *
 * @method geo.geofence_enter
 */
@RegisterDetector()
@Injectable()
export class GeofenceDetector implements Detector<GeofenceConfig> {
  readonly id = 'geofence'; // env prefix GEOFENCE_, metrics label, DETECTORS entry
  readonly domain = 'surveillance'; // must be the registry domain of the alert types it raises
  readonly methodIds = ['geo.geofence_enter'];
  readonly configSchema = geofenceConfig;
  // readonly tickIntervalMs = 60_000;              // + onTick(ctx, now) for time-based rules

  async onPosition(
    context: DetectorContext<GeofenceConfig>,
    position: VesselPosition,
  ): Promise<void> {
    const inside = context.zones
      .zonesAt(position, { useBuffer: false })
      .filter(
        (zone) => zone.alertOnEnter && context.config.KINDS.includes(zone.kind),
      );
    for (const zone of inside) {
      await context.alerts.raise({
        type: 'geofence',
        dedupKey: `geofence:${position.mmsi}:${zone.id}`,
        severity: 'warning',
        mmsi: position.mmsi,
        title: `Entered ${zone.name}`,
        message: `Vessel ${position.mmsi} entered ${zone.name} (${zone.kind})`,
        position,
        occurredAt: position.time,
        zoneId: zone.id,
        data: {
          zoneKind: zone.kind,
          orgId: context.fleet.orgOf(position.mmsi) ?? null,
        },
        // methodId defaults to methodIds[0]
      });
    }
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (
        open.type === 'geofence' &&
        !inside.some((zone) => zone.id === open.zoneId)
      ) {
        await context.alerts.resolve(open.dedupKey, {
          at: position.time,
          reason: 'left the zone',
        });
      }
    }
  }
}
```

Register it in a module's `providers`, add its method ids to the methodology catalog (spec §17),
document its `<ID>_*` variables in `.env.example`, and test it with the harness (below).

### What a detector gets (`DetectorContext<Config>`)

| Member    | Type                      | Use                                                                                                                                                                           |
| --------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`  | `Config`                  | parsed `<ID>_*` variables                                                                                                                                                     |
| `vessels` | `VesselStateStore`        | `get(mmsi)`, `isStale(mmsi, { maxAgeMs? })`, `fresh()`, `staleSince()`, `ageMs()` (LRU, optional Valkey mirror)                                                               |
| `pairs`   | `PairSearch<VesselState>` | `neighbours(origin, { radiusM, maxAgeMs?, filter?, limit? })` nearest first, `pairs({ radiusM })`                                                                             |
| `zones`   | `ZoneIndex`               | `zonesAt(point, { kinds?, useBuffer?, orgId? })`, `distance(zoneId, point)`, `near(point, radiusM, q)`, `nearest(point, { kinds, maxDistanceM? })`, `contains(zoneId, point)` |
| `fleet`   | `FleetDirectory`          | `byMmsi(mmsi)`, `byId(id)`, `orgOf(mmsi)` (`undefined` = unregistered vessel)                                                                                                 |
| `alerts`  | `DetectorAlerts`          | `raise(signal)`, `resolve(dedupKey, { at?, reason?, data? })`, `get()`, `isOpen()`, `open({ mmsi? })`                                                                         |
| `logger`  | `DetectorLogger`          | `log/warn/error/debug`                                                                                                                                                        |
| `now()`   | `() => Date`              | the SDK clock (fixed in tests)                                                                                                                                                |

Detectors that need history own a `TrackBuffer` (`new TrackBuffer<VesselPosition>({ maxPoints: 64,
maxAgeMs: 45 * 60_000 })`: `push(mmsi, point)`, `points(mmsi, { since })`, `tail(mmsi, n)`,
`last(mmsi)`, `prune(now)`). Distances are geodesic metres: `'wgs84'` (Vincenty) matches PostGIS
`ST_Distance(geography)` within 1 cm in the test suite; `'sphere'` matches `@turf/distance` /
`@turf/nearest-point-on-line` 7 exactly, which the legacy EWS rule used. Lines and polygon edges are
great-circle arcs; containment uses the even–odd rule; geometries must not cross the antimeridian.
Helpers: `geodesicDistanceM`, `haversineMeters`, `vincentyMeters`, `distanceToArc`,
`nearestPointOnArc`, `initialBearingDeg`, `destinationPoint`, `searchBox`.

### Alerts (`AlertEmitter`)

One state machine per `dedupKey`; `AlertRaisedV1` payloads are validated (registry domain,
`methodId` format) and published to `alert.v1.<type>.<mmsi>` with the envelope id = alert id.

| Signal for a key                                                                                                    | Outcome        | Published              | Persistence hook                                |
| ------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------- | ----------------------------------------------- |
| nothing open                                                                                                        | `raised`       | yes                    | `onRaised(alert, 'raised')` (first)             |
| open, higher severity                                                                                               | `escalated`    | yes (new id, same key) | `onRaised(alert, 'escalated')`                  |
| open, same severity                                                                                                 | `unchanged`    | no                     | —                                               |
| open, lower severity                                                                                                | `de-escalated` | no                     | `onUpdated({ reason: 'de-escalated' })`         |
| back to an already published severity within `alertCooldownMs`, or re-raised after a resolution within the cooldown | `suppressed`   | no                     | `onUpdated({ reason: 'suppressed', reopened })` |
| `resolve(key)`                                                                                                      | `true`/`false` | no                     | `onResolved(resolution)`                        |

`AlertPersistence` (all optional): `onRaised`, `onUpdated`, `onResolved`, `loadOpen` (restores
open occurrences at boot so a restart does not re-raise them). The hook runs **before** publishing,
so the service's `events` table records every occurrence; implementations must be idempotent.
Publishing retries for 5 s; an alert that still cannot be published stays pending (already
persisted, same id, so JetStream deduplicates) and is published by the next signal of its key or
by the runner's 30 s housekeeping (`retryPending()`), which also prunes expired cooldowns and stale
neighbour entries.

### Metrics

`aisits_detector_evaluations_total{detector}`, `aisits_detector_duration_seconds{detector}`
(`onPosition` and `onTick` calls), `aisits_detector_alerts_total{detector,severity}`,
`aisits_detector_errors_total{detector,hook}`, `aisits_detector_positions_total{outcome}`.

### Testing a detector without NATS (`DetectorTestHarness`)

```ts
import { DetectorTestHarness } from '@darmawanweb/ais-its-nest/analytics';
import { describe, expect, it } from 'vitest';

import { GeofenceDetector } from './geofence.detector.js';

describe('GeofenceDetector', () => {
  it('alerts on entry and resolves on exit', async () => {
    const harness = DetectorTestHarness.create({
      detectors: [new GeofenceDetector()],
      env: { GEOFENCE_KINDS: 'restricted' }, // never process.env
      now: new Date('2026-01-01T00:00:00Z'),
    });
    const zone = await harness.zone({
      kind: 'restricted',
      alertOnEnter: true,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [104, 1],
            [104.1, 1],
            [104.1, 1.1],
            [104, 1.1],
            [104, 1],
          ],
        ],
      },
    });
    await harness.position({ mmsi: 525005223, lat: 1.05, lon: 104.05 }); // defaults: time = clock, previous = last fed
    expect(harness.alerts).toEqual([
      expect.objectContaining({
        type: 'geofence',
        zoneId: zone.id,
        severity: 'warning',
      }),
    ]);

    harness.advance(60_000);
    await harness.position({ mmsi: 525005223, lat: 1.2, lon: 104.2 });
    expect(harness.resolutions).toHaveLength(1);
    expect(harness.logs.filter((line) => line.startsWith('error'))).toEqual([]); // isolated failures land here
  });
});
```

The harness also offers `track(points)`, `vessel(snapshot)`, `removeZone(id)`, `removeVessel(v)`,
`tick(now?)`, `setTime()`, `updates`, `describe()`, `metrics.render()` and the shared state in
`services`; `makeTestZone()` and `makeTestVesselSnapshot()` build valid contracts payloads.

## Testing guide (`./testing`)

Unit tests live next to the code (`*.spec.ts`), integration tests in `test/*.int.test.ts` against
real containers. vitest needs SWC for decorator metadata:

```ts
// vitest.config.ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    env: { TESTCONTAINERS_RYUK_DISABLED: 'true' },
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
```

| Helper                                                                                              | What                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTestInfra({ postgres?, nats?, redis?, s3?, smtp? })`                                          | containers (`TEST_IMAGES`: `timescale/timescaledb-ha:pg17`, `nats:2.11-alpine`, `valkey/valkey:8-alpine`, `rustfs/rustfs:latest`, `axllent/mailpit:latest`), returns exactly the requested endpoints + `stop()`        |
| `provisionServiceSchema(adminUrl, schema)`                                                          | replicates `infra/postgres/bootstrap.sql` for one schema (extensions in `public`, LOGIN role `<schema>_svc` with password = role name, schema owned by it, `USAGE` on `public`) and returns the service `DATABASE_URL` |
| `createTestJwtIssuer({ issuer?, audience? })`                                                       | Ed25519 issuer: `sign({ roles, orgId, userId?, expiresInSeconds? })`, `issue()` (token + expected principal), `signRaw()`, `keyResolver` (for `AuthModule`), `serveJwks()` (real JWKS URL)                             |
| `startFakeApiKeyIntrospection({ internalToken })`, `FakeApiKeyIntrospector`, `generateTestApiKey()` | the auth service's introspection endpoint (HTTP) or in-memory                                                                                                                                                          |
| `createTestConfig(schema, env)`                                                                     | validated config from `env` only (`NODE_ENV=test`, silent logs, no migrations unless set)                                                                                                                              |
| `buildTestApp(appModule, { config, overrides?, logging?, cookies?, multipart?, configure? })`       | the real platform composition, initialized (hooks run), use `app.inject()`; `app.close()`                                                                                                                              |
| `makeTestEnvelope(type, data, options?)`                                                            | a valid contracts envelope                                                                                                                                                                                             |
| `waitFor(predicate, { timeoutMs?, intervalMs? })`                                                   | polls until truthy and returns the value                                                                                                                                                                               |

```ts
// test/geofence.int.test.ts
import {
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import {
  makeTestZone,
  toPositionPayload,
  ZoneIndex,
} from '@darmawanweb/ais-its-nest/analytics';
import { ACCESS_TOKEN_KEY_RESOLVER } from '@darmawanweb/ais-its-nest/auth';
import { EventPublisher, NatsClient } from '@darmawanweb/ais-its-nest/nats';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  provisionServiceSchema,
  startTestInfra,
  waitFor,
} from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configSchema } from '../src/config.js';

let infra: Awaited<
  ReturnType<typeof startTestInfra<{ postgres: true; nats: true }>>
>;
let app: NestFastifyApplication;

beforeAll(async () => {
  infra = await startTestInfra({ postgres: true, nats: true });
  const databaseUrl = await provisionServiceSchema(
    infra.postgres.adminUrl,
    'surveillance',
  );
  const jwt = await createTestJwtIssuer();
  app = await buildTestApp(AppModule, {
    config: createTestConfig(configSchema, {
      DATABASE_URL: databaseUrl,
      DATABASE_SCHEMA: 'surveillance',
      DB_MIGRATE_ON_BOOT: 'true',
      NATS_URL: infra.nats.url,
    }),
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: jwt.keyResolver },
    ],
  });
});

afterAll(async () => {
  await app.close();
  await infra.stop();
});

it('raises a geofence alert from a published position', async () => {
  const publisher = app.get(EventPublisher);
  const zone = makeTestZone({
    kind: 'restricted',
    alertOnEnter: true,
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [104, 1],
          [104.1, 1],
          [104.1, 1.1],
          [104, 1.1],
          [104, 1],
        ],
      ],
    },
  });
  await publisher.publishEvent(EVENT_TYPES.GEO_ZONE_UPSERTED, zone);
  await waitFor(() => app.get(ZoneIndex).has(zone.id)); // live projection
  await publisher.publishEvent(
    EVENT_TYPES.AIS_POSITION_RECORDED,
    toPositionPayload({
      mmsi: 525005223,
      time: new Date(),
      source: 'primary',
      lat: 1.05,
      lon: 104.05,
      sog: 3,
      cog: 90,
      hdg: 90,
      navstatus: 0,
      predictedNavstatus: 0,
      coastDistanceM: null,
      previous: null,
    }),
  );
  const { manager } = app.get(NatsClient);
  const stored = await waitFor(() =>
    manager.streams.getMessage('ALERTS', {
      last_by_subj: subjects.alert('geofence', 525005223),
    }),
  );
  const parsed = parseEnvelope(stored.data);
  expect(parsed.success && parsed.envelope.data).toMatchObject({
    type: 'geofence',
    zoneId: zone.id,
  });
});
```

## Development of this package

```bash
pnpm build          # tsc -p tsconfig.build.json → dist/
pnpm test           # unit (src/**/*.spec.ts) + integration (test/**/*.int.test.ts, starts containers)
pnpm test:unit      # no Docker needed
pnpm lint && pnpm typecheck
pnpm check:package  # smoke test of dist through the exports map, publint, attw (ESM only)
```

Releases follow the repository's Keep a Changelog file ([CHANGELOG.md](CHANGELOG.md)).
