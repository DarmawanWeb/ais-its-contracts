# @darmawanweb/ais-its-nest

NestJS 12 service kit of **AIS Maritime Intelligence** v2: everything a service needs to follow
`docs/PLATFORM_SPEC.md` (§4–§11) without re-implementing it — configuration, logging, the HTTP
bootstrap with RFC 9457 problem details, PostgreSQL with a forward-only SQL migrator, NATS
JetStream publishing and consumers, Valkey and rate limiters, authentication and authorization,
audit, health, metrics, tracing, an internal HTTP client, test helpers and the **Detector SDK**
(spec §18) on which the safety and surveillance services are built.

- ESM only (`"type": "module"`, built with `tsc`), Node.js ≥ 22.12 (24 in Docker/CI).
- Depends on [`@darmawanweb/ais-its-contracts`](../contracts) `^0.4.0` (events, subjects,
  permissions, problem types, alert registry).
- NestJS, Fastify, drizzle, swagger, terminus, class-validator/transformer, reflect-metadata and
  rxjs are **peer dependencies**. `pg`, `ioredis` and `prom-client` are the kit's own
  dependencies: their types are re-exported (`Pool`, `PoolClient` from `./db`, `Redis` from
  `./redis`, `Counter`, `Gauge`, `Histogram`, `Summary`, `Registry` from `./metrics`), so services
  need no direct dependency on them under pnpm's strict layout.
- `./testing` imports `testcontainers` and `@nestjs/testing`, and pretty logs use `pino-pretty`:
  the kit does **not** declare them (since 0.3.0, not even as optional peers), so a service lists
  them as **devDependencies** and `pnpm install --prod` never puts them into an image.
- Upgrading from 0.2: [UPGRADING.md](UPGRADING.md) (step by step, per service).

```bash
pnpm add @darmawanweb/ais-its-contracts @darmawanweb/ais-its-nest \
  @nestjs/common @nestjs/core @nestjs/platform-fastify @nestjs/swagger @nestjs/terminus \
  fastify drizzle-orm class-validator class-transformer reflect-metadata rxjs zod
pnpm add -D typescript@~6.0.3 @types/node@^24 vitest@^4.1 unplugin-swc @swc/core \
  @nestjs/testing testcontainers pino-pretty
```

Inside the central repository the package resolves through the pnpm workspace; elsewhere map the
`@darmawanweb` scope to GitHub Packages in `~/.npmrc` (never in a repository `.npmrc`).

**Production images.** Optional peers of other packages are linked to whatever dev package
satisfies them, and then reach `pnpm install --prod`: `@nestjs/swagger` declares `typescript`
(its CLI plugin) and `@nestjs/terminus` declares `@grpc/grpc-js` / `@grpc/proto-loader`, which
testcontainers' Docker client brings into the dev tree (about 9 MB with protobufjs). Services keep
a `.pnpmfile.cjs` that drops these peers (the template's hook):

```js
// .pnpmfile.cjs
const PEERS = {
  '@nestjs/swagger': ['typescript'],
  '@nestjs/terminus': ['@grpc/grpc-js', '@grpc/proto-loader'],
};
const without = (record, names) =>
  record &&
  Object.fromEntries(
    Object.entries(record).filter(([name]) => !names.includes(name)),
  );
module.exports = {
  hooks: {
    readPackage(manifest) {
      const peers = PEERS[manifest.name];
      if (peers === undefined) return manifest;
      return {
        ...manifest,
        peerDependencies: without(manifest.peerDependencies, peers),
        peerDependenciesMeta: without(manifest.peerDependenciesMeta, peers),
      };
    },
  },
};
```

`pnpm check:package` proves it on every change: `scripts/prod-install-smoke.mjs` installs the
packed kit with `--prod` into a scratch service (with this hook and the test packages as
devDependencies), asserts that none of `testcontainers`, `dockerode`, `ssh2`, `cpu-features`,
`@nestjs/testing`, `pino-pretty`, `@grpc/grpc-js`, `protobufjs` and `@opentelemetry/sdk-node` is
installed, and loads every entry point except `./testing` from it.

## Contents

| Import                                    | What                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@darmawanweb/ais-its-nest`               | `bootstrapService`, `exportOpenApi`, `defineConfig`/`loadConfig`/`ConfigModule`/`@InjectConfig`, errors, logging |
| `@darmawanweb/ais-its-nest/http`          | `ProblemDetailsFilter`, validation pipe, OpenAPI helpers, Fastify adapter, list/query DTOs, path parameters      |
| `@darmawanweb/ais-its-nest/db`            | `DatabaseModule`, `withTransaction`, `withIdempotency`, SQLSTATE helpers, row dates, PostGIS helpers, migrator   |
| `@darmawanweb/ais-its-nest/nats`          | `NatsModule`, `EventPublisher`, `@EventHandler`, `@OrderedEventHandler`, `@CoreSubscriptionHandler`, outbox      |
| `@darmawanweb/ais-its-nest/redis`         | `RedisModule`, `@InjectRedis`, `FixedWindowRateLimiter`, `SlidingWindowRateLimiter`, `guardAttempt`              |
| `@darmawanweb/ais-its-nest/auth`          | `AuthModule` (global default-deny guard), decorators, principals, `assertOrgAccess`, `verifyAccessToken`         |
| `@darmawanweb/ais-its-nest/audit`         | `AuditModule`, `AuditService.record()` (best effort) and `enqueue()` (transactional outbox)                      |
| `@darmawanweb/ais-its-nest/health`        | `HealthModule`, `@ReadinessCheck()` for custom indicators                                                        |
| `@darmawanweb/ais-its-nest/metrics`       | `MetricsModule`, `MetricsService` (prom-client, prefix `aisits_`), metric types                                  |
| `@darmawanweb/ais-its-nest/telemetry`     | `startTelemetry`, W3C trace context helpers, `withSpan`                                                          |
| `@darmawanweb/ais-its-nest/internal-http` | `InternalHttpClient`, `InternalHttpError`                                                                        |
| `@darmawanweb/ais-its-nest/analytics`     | Detector SDK: `Detector`, `@RegisterDetector`, `DetectorRunnerModule`, state, indexes, `AlertEmitter`, harness   |
| `@darmawanweb/ais-its-nest/testing`       | `startTestInfra`, `testInfraGlobalSetup`/`testInfra`, `buildTestApp`, payload builders, … (devDependencies)      |
| `@darmawanweb/ais-its-nest/internal`      | runner plumbing for the kit's own tests and diagnostics — **no semver guarantees**, never import it in services  |

The public API of every subpath is recorded in [`etc/api-report.json`](etc/api-report.json) and
checked in CI (`pnpm check:package`), so every addition or removal is a reviewed semver decision.

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
Every file is shown, and CI rebuilds it from this README (`pnpm check:readme`: the blocks below
are written into a pnpm project, the install commands above run against the packed tarballs,
then typecheck, build, `openapi` and the tests); `templates/nest-service` of the central
repository is the full-featured version of this layout (`pnpm new:service`).

```text
tsconfig.json / tsconfig.build.json
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

```jsonc
// tsconfig.json — type-checks src and test (`pnpm typecheck`)
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "skipLibCheck": true, // drizzle-orm ships declarations of every driver
    "sourceMap": true,
    "types": ["node"],
    "noEmit": true,
  },
  "include": ["src", "test"],
}
```

```jsonc
// tsconfig.build.json — compiles src to dist (`pnpm build`)
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"],
  "exclude": ["src/**/*.spec.ts"],
}
```

```sql
-- migrations/0001_init.sql
CREATE TABLE vessels (
  vessel_id uuid PRIMARY KEY,
  mmsi integer NOT NULL UNIQUE,
  org_id uuid,
  updated_at timestamptz NOT NULL
);

CREATE TABLE events (
  id uuid NOT NULL,
  time timestamptz NOT NULL,
  detector text NOT NULL,
  type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  mmsi integer NOT NULL,
  related_mmsi integer,
  zone_id uuid,
  dedup_key text NOT NULL,
  method_id text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at timestamptz,
  PRIMARY KEY (id, time)
);
SELECT create_hypertable('events', by_range('time', INTERVAL '7 days'));
CREATE INDEX events_open_dedup_key ON events (dedup_key) WHERE status = 'open';
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
import { MIGRATIONS_DIR } from './service.js';

@Module({
  imports: [
    DatabaseModule.forRoot({ migrationsDir: MIGRATIONS_DIR }), // pool + drizzle, migrations on boot (DB_MIGRATE_ON_BOOT)
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
  ApiDetectorsResponse,
  DetectorDescriptionDto,
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
  @ApiDetectorsResponse() // documented response schema
  list(): DetectorDescriptionDto[] {
    // ids, domains, method ids, alert types and active thresholds
    return this.registry
      .describe()
      .map((detector) => new DetectorDescriptionDto(detector));
  }
}
```

```ts
// src/events/surveillance-events.repository.ts — the AlertEmitter persistence hook
import type { AlertSeverity } from '@darmawanweb/ais-its-contracts/domain';
import type { AlertRaisedV1 } from '@darmawanweb/ais-its-contracts/events';
import type {
  AlertPersistence,
  AlertResolution,
  OpenAlert,
} from '@darmawanweb/ais-its-nest/analytics';
import { InjectPool, type Pool, rowDate } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';

interface OpenEventRow {
  id: string;
  time: Date | string;
  detector: string;
  type: string;
  severity: AlertSeverity;
  mmsi: number;
  related_mmsi: number | null;
  zone_id: string | null;
  dedup_key: string;
  method_id: string;
}

@Injectable()
export class SurveillanceEventsRepository implements AlertPersistence {
  constructor(@InjectPool() private readonly pool: Pool) {}

  /** Open occurrences, restored at boot and reloaded on every failover (activation). */
  async loadOpen(): Promise<OpenAlert[]> {
    const { rows } = await this.pool.query<OpenEventRow>(
      `SELECT DISTINCT ON (dedup_key) id, time, detector, type, severity, mmsi, related_mmsi,
         zone_id, dedup_key, method_id
       FROM events WHERE status = 'open' ORDER BY dedup_key, time DESC`,
    );
    return rows.map((row): OpenAlert => {
      const time = rowDate(row.time);
      return {
        alertId: row.id,
        dedupKey: row.dedup_key,
        type: row.type,
        mmsi: row.mmsi,
        relatedMmsi: row.related_mmsi,
        zoneId: row.zone_id,
        severity: row.severity,
        publishedSeverity: row.severity,
        openedAt: time,
        publishedAt: time,
        lastSeenAt: time,
        firstOccurredAt: time, // event times: the column holds the signal's occurredAt
        lastOccurredAt: time,
        domain: 'surveillance',
        methodId: row.method_id,
        detector: row.detector,
      };
    });
  }

  /** Called BEFORE the alert is published: the events table records every occurrence. */
  async onRaised(alert: AlertRaisedV1): Promise<void> {
    await this.pool.query(
      `INSERT INTO events (id, time, detector, type, severity, mmsi, related_mmsi, zone_id,
         dedup_key, method_id, title, message, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT DO NOTHING`, // idempotent: a retried publication re-runs the hook
      [
        alert.id,
        alert.occurredAt,
        alert.type,
        alert.type,
        alert.severity,
        alert.mmsi,
        alert.relatedMmsi,
        alert.zoneId,
        alert.dedupKey,
        alert.methodId,
        alert.title,
        alert.message,
        alert.data,
      ],
    );
  }

  async onResolved(resolution: AlertResolution): Promise<void> {
    await this.pool.query(
      `UPDATE events SET status = 'resolved', resolved_at = $2
       WHERE dedup_key = $1 AND status = 'open'`,
      [resolution.alert.dedupKey, resolution.resolvedAt],
    );
  }
}
```

```ts
// src/events/fleet.projection.ts — a durable consumer writing a projection table
import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { InjectPool, type Pool } from '@darmawanweb/ais-its-nest/db';
import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';

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
import { MIGRATIONS_DIR } from './service.js';

await runMigrationsCli({ configSchema, dir: MIGRATIONS_DIR });
```

```ts
// src/openapi.ts — "openapi": "node dist/openapi.js" (writes ./openapi.json, opens no connection)
// CI: "node dist/openapi.js --check" fails when the committed openapi.json is stale.
import 'reflect-metadata';
import { exportOpenApi } from '@darmawanweb/ais-its-nest';

import { AppModule } from './app.module.js';
import { configSchema } from './config.js';
import { OPENAPI } from './openapi.options.js';

await exportOpenApi({
  appModule: AppModule,
  configSchema, // runtime-only variables (S3_ENDPOINT, secrets…) get placeholders
  openapi: OPENAPI,
  check: process.argv.includes('--check'),
});
```

The detector is shown in [Writing a detector](#writing-a-detector). Relative imports end in
`.js`. Never read `process.env` at import time in `app.module.ts` (it is imported before
`loadConfig()` reads `.env`): take values from the typed configuration (`@InjectConfig()`,
`APP_CONFIG` in `forRootAsync` factories).

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
| `LOG_LEVEL` / `LOG_PRETTY`                            | `info` / `true` in development                                                  | needs `pino-pretty` (a devDependency)               |
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
| `TRUSTED_PROXIES`                                     | `loopback,linklocal,uniquelocal`                                                | production: the gateway's address or CIDR only      |
| `NATS_DURABLE_PREFIX`                                 | empty                                                                           | prefix of every durable name (shared test servers)  |

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

Database errors never leak bound values: the problem filter, the migrate CLI, the DLQ
`Ais-Its-Dlq-Error` header and `outbox.last_error` use the sanitized error (`sanitizeError()` of
`./db`: driver message, SQLSTATE, constraint, table, column and the SQL text without parameters;
`params`, `detail`, `where` and the driver's `cause` are dropped), and the redaction paths include
`err.params` and `err.detail`. Log your own database errors as `{ err: sanitizeError(error) }`.
The pretty transport (`pino-pretty`) is resolved from the service's own `package.json` first.

## HTTP (`.` and `./http`)

`bootstrapService({ appModule, config, openapi, configure?, cookies?, multipart?, cors?, adapter?, logging? })`
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
- helmet (CSP fit for Swagger UI), CORS from `CORS_ORIGINS` with credentials and the exposed
  headers `X-Request-Id`, `Retry-After`, `WWW-Authenticate`, `ETag` and `Location`
  (`DEFAULT_EXPOSED_HEADERS`; add your own with `cors: { exposedHeaders: ['X-Truncated'] }`,
  also accepted by `buildTestApp` and `createPlatformApp`; `*` and invalid names throw),
  `X-Request-Id` (incoming value reused when well-formed), HTTP RED metrics, `@fastify/cookie`
  (`cookies: true`) and `@fastify/multipart` (`multipart: true | options`);
- JSON bodies: a request with `Content-Type: application/json` and **no body** (e.g. a bodiless
  `POST /alerts/:id/ack`) is accepted with an undefined body; any other body goes to Fastify's
  parser with the body limit and `__proto__` / `constructor` poisoning protection (`400`, `413`).
  A service that needs its own JSON parser removes the platform's first
  (`removeContentTypeParser('application/json')` in `configure`);
- Swagger UI at `/docs`, JSON at `/openapi.json` (bearer default, `apiKey` and `internalToken`
  schemes, `ProblemDetails` default responses). Declare further schemes with
  `openapi.securitySchemes`, e.g. the refresh cookie
  `{ aisits_rt: REFRESH_COOKIE_SECURITY_SCHEME }` with `@ApiCookieAuth('aisits_rt')`: a reference
  to an undeclared scheme, or a redefinition of `bearer`, `apiKey` or `internalToken`, fails
  `buildOpenApiDocument` and `exportOpenApi` with `OpenApiSecurityError`;
- client IP (`request.ip`, audit records, per-IP throttles) from `X-Forwarded-For` only when the
  connection comes from a `TRUSTED_PROXIES` address (comma list of IPs, CIDRs or `loopback`,
  `linklocal`, `uniquelocal`; `none` trusts nobody): a direct caller cannot pick its IP. **In
  production set `TRUSTED_PROXIES` to the gateway's address or CIDR only** (the default trusts
  every private network, so any pod could pick its IP; `bootstrapService` logs a warning when
  production runs with it). `clientIp(request)` normalizes an address for storage and throttle
  keys in a form PostgreSQL `inet` accepts (brackets, ports and IPv6 zone ids removed, `null` for
  anything that is not an address);
  `AuditService` applies it to audit records;
- graceful shutdown hooks (with log lines for readiness turning `503`, draining and completion),
  then `listen(HOST, PORT)`.

`exportOpenApi({ appModule, configSchema | config, openapi, outFile?, check? })` builds the same
document **without running any lifecycle hook** (providers are constructed; neither init nor
shutdown hooks run, so no connection is opened or closed) and writes `openapi.json`. With
`configSchema` the configuration is derived by `documentationConfig()`: present variables are
validated, missing required ones get placeholders of their type. `check: true` compares with the
committed file and throws `OpenApiDriftError` instead of writing.

### Lists and queries (spec §5)

```ts
import {
  ApiCursorResponse, ApiPageResponse, BBoxQueryDto, bboxOf, cursorPage, CursorQueryDto,
  decodeQueryCursor, pageOffsetOf, PageQueryDto, paginate, resolveQueryTimeRange,
} from '@darmawanweb/ais-its-nest/http';
import { IntersectionType } from '@nestjs/swagger';

class ListVesselsQuery extends PageQueryDto { /* + @IsOptional() @IsString() search?: string */ }
class ListEventsQuery extends IntersectionType(CursorQueryDto, TimeRangeQueryDto, BBoxQueryDto) {}

@Get() @ApiPageResponse(VesselDto)            // { data: VesselDto[], meta: { page, pageSize, total } }
async list(@Query() query: ListVesselsQuery) {
  const [rows, total] = await this.vessels.page(pageOffsetOf(query), query.pageSize);
  return paginate(rows, query, total);
}

@Get('events') @ApiCursorResponse(EventDto)   // { data: EventDto[], page: { nextCursor, limit } }
async events(@Query() query: ListEventsQuery) {
  const { from, to } = resolveQueryTimeRange(query, { defaultDurationMs: 86_400_000 });
  const after = decodeQueryCursor(query, CursorSchema); // 400 VALIDATION_FAILED for a foreign cursor
  const rows = await this.events.list({ from, to, bbox: bboxOf(query), after, limit: query.limit + 1 });
  return cursorPage(rows, query.limit, (row) => ({ time: row.time.toISOString(), id: row.id }));
}
```

`page` 1 … `MAX_PAGE` (1 000 000, default 1; larger values answer `400 VALIDATION_FAILED`, and
`pageOffsetOf()` throws `RangeError` for an unsafe offset), `pageSize` ≤ 100 (default 20),
`limit` ≤ 500 (default 100), cursors are opaque base64url JSON, `from`/`to` strict ISO-8601,
`bbox=minLon,minLat,maxLon,maxLat` (`@IsBBox()`).

### Path parameters and optional fields

```ts
import { IntParam, IsOptionalNotNull, MmsiParam, UuidParam } from '@darmawanweb/ais-its-nest/http';

@Get(':id')
get(@UuidParam() id: string) { … }                       // 'id' by default; documented as string/uuid
@Get('by-mmsi/:mmsi')
byMmsi(@MmsiParam() mmsi: number) { … }                  // 9 digits → number; pattern ^[0-9]{9}$
@Get('years/:year')
year(@IntParam('year', { min: 2000, max: 2100 }) year: number) { … }

class UpdateVesselDto {
  @IsOptionalNotNull() @IsString() name?: string;         // absent: unchanged; null: 400
  @IsOptional() @IsString() imo?: string | null;          // null is meaningful (clears the column)
}
```

The decorators read the **raw path segment** (the global pipe never converts it) and fail with
`400 VALIDATION_FAILED` and a field error (`{ field: 'id', code: 'isUuid' }`, `isMmsi`, `isInt`,
`min`, `max`) instead of the bare `400` of `ParseUUIDPipe` / `ParseIntPipe`; they also document
the parameter's schema in OpenAPI. The parsers (`parseUuidParam`, `parseIntParam`,
`parseMmsiParam`) are exported for other inputs. A route whose path lacks the decorated `:name`
answers `500` (programming error). `@IsOptional()` lets `null` through, which a `PATCH` would
write into a `NOT NULL` column: use `IsOptionalNotNull()` (validates every value except
`undefined`) for optional fields that are not nullable.

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

An unexpected database error answers `500 INTERNAL_ERROR`; outside production its `detail` is the
driver's primary message only (e.g. `duplicate key value violates unique constraint "…"`), never
the bound parameters or the `DETAIL` line that quotes the row. Map expected violations yourself
(`isUniqueViolation(error, 'vessels_mmsi_key')` → `409`).

## Database (`./db`)

```ts
DatabaseModule.forRoot({ schema?, migrationsDir? = './migrations', migrateOnBoot?, connectTimeoutMs? })
```

```ts
// src/service.ts — resolve migrations from the package, not from the working directory
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../migrations', import.meta.url),
);
```

A lazy `pg.Pool` with `search_path=<DATABASE_SCHEMA>,public`, `DATABASE_POOL_MAX` and the statement
timeout; drizzle (`drizzle-orm/node-postgres`, pass `schema` for relational queries) — inject with
`@InjectPool()` (`Pool`) and `@InjectDb()` (`Database<typeof schema>`); readiness check
`database`. On init it waits for the database (bounded retries) and applies the migrations
**before the port opens**.

- `withTransaction(pool, async (client) => …, { isolationLevel?, readOnly?, retries?, retryDelayMs?, onRetry? })`
  — retries serialization failures (`40001`) and deadlocks (`40P01`) when `retries > 0`, also when
  drizzle wrapped them (`DrizzleQueryError`: run drizzle on the transaction's client,
  `drizzle({ client })`); between attempts the client is released and the retry waits
  `retryDelayMs` (a number or `(retry) => ms`, default random 10–50 ms). `onRetry({ retry,
retries, sqlState, delayMs, error })` is called for every re-run (after the rollback, before
  the pause), e.g. to count re-runs by SQLSTATE; an exception it throws never changes the outcome.
- SQLSTATEs: `sqlStateOf(error)` follows the `cause` chain (drizzle wraps driver errors) and
  returns the 5-character code; `isUniqueViolation(error, constraint?)`; `PG_SQLSTATES`
  (`UNIQUE_VIOLATION`, `FOREIGN_KEY_VIOLATION`, `CHECK_VIOLATION`, `NOT_NULL_VIOLATION`,
  `SERIALIZATION_FAILURE`, `DEADLOCK_DETECTED`, `LOCK_NOT_AVAILABLE` = `55P03`, `QUERY_CANCELED`).
- Error hygiene: `sanitizeError(error)` / `databaseErrorInfo(error)` / `SanitizedDatabaseError`
  keep the driver message, code, constraint, table, column, schema, routine and the SQL text, and
  drop the bound values (`params`, `detail`, `where`); the kit's own logs, DLQ headers, outbox
  errors and problem details already use them.
- Raw rows: ``db.execute(sql`…`)`` returns `timestamptz`, `timestamp`, `date` and `interval` values
  as **strings** (drizzle replaces pg's type parsers for its queries; typed drizzle columns are
  converted, raw rows are not). Type such columns `Date | string` and convert with
  `rowDate(value)` / `rowDateOrNull(value)` (pg's own timestamp parser; ISO strings with `T`
  accepted; `infinity` and garbage throw `RangeError`).
- drizzle pitfall: on tables of a `pgSchema(...)`, `.for('update' | 'share', { of: table })`
  renders a schema-qualified relation that PostgreSQL rejects ("FOR UPDATE must specify unqualified relation names"); lock without `of` (or name the alias in raw SQL).
- TimescaleDB continuous aggregates: refresh at runtime with
  `refreshContinuousAggregate(pool, 'segments_daily', from, to, { retries? = 5, retryDelayMs?, statementTimeoutMs?, onRetry? })`
  — it runs `CALL refresh_continuous_aggregate()` on a dedicated client (never in a transaction)
  and retries `55P03` (TimescaleDB rejects overlapping refreshes at once, e.g. the policy job and
  a manual refresh) with equal-jitter backoff; it resolves `{ attempts }`. In a
  `-- aisits:no-transaction` migration, materialize first and **add the refresh policy after**
  (`CALL refresh_continuous_aggregate(...)`, then `add_continuous_aggregate_policy(...)`): the
  other order races the policy job's first run.
- Idempotent handlers (spec §7.1): `withIdempotency(pool, { consumer, eventId }, (client) => …)`
  records the envelope id in `processed_events` in the same transaction as the handler's writes
  and returns `{ duplicate: true }` for a redelivery (a failing handler records nothing). Create
  the table with `processedEventsTableSql()` in a migration, prune with `pruneProcessedEvents()`.
- PostGIS (all parameters bound, injection-safe): `geography('geom', { subtype: 'Point' })` drizzle
  column, `pointGeography(lon, lat)`, `geoJsonToGeography(geometry)`,
  `geographyAsGeoJson(column, digits?)` (selects a parsed GeoJSON object), `bboxEnvelope(bbox)`,
  `geographyIntersectsBBox(column, bbox)` (compared in lon/lat **geometry** space, so a box's
  edges are parallels and meridians even for country-wide viewports; index `USING gist
((geom::geometry))`), `distanceM(a, b)`, `withinM(a, b, meters)` (`distanceMeters` /
  `withinMeters` are deprecated aliases).
- Migrator (spec §6): files `migrations/NNNN_snake_case.sql`, applied in order under a PostgreSQL
  advisory lock (concurrent instances wait), recorded in
  `<schema>.schema_migrations(version, name, checksum, applied_at)` with a SHA-256 checksum of the
  normalized SQL. An applied file that changed stops the boot (`MigrationChecksumMismatchError`),
  and so does a pending file numbered below the newest applied one (`MigrationOrderError`, e.g. a
  migration merged from another branch: renumber it, or pass `allowOutOfOrder: true`).
  Each file runs in one transaction; a file whose **first line** is `-- aisits:no-transaction` runs
  statement by statement outside a transaction (continuous aggregates, `CREATE INDEX
CONCURRENTLY`). Services never run `CREATE EXTENSION`: the infrastructure creates
  `timescaledb`, `postgis` and `pgcrypto` in `public`.
- `runMigrationsCli({ configSchema, dir? })` for `pnpm migrate`; `runMigrations({ pool, schema, dir })`.
  Relative directories resolve against the **working directory**: pass the absolute
  `MIGRATIONS_DIR` above to `DatabaseModule.forRoot({ migrationsDir })` and
  `runMigrationsCli({ dir })`, so a process started from another directory (a container
  `WORKDIR`, a second app of the repository) still finds them. A missing directory fails with
  `MigrationsDirectoryNotFoundError` (`directory`, `cwd`), not with an empty migration set.

## NATS JetStream (`./nats`)

```ts
NatsModule.forRoot({ streams?: StreamName[], connectTimeoutMs?, requestTimeoutMs?, drainTimeoutMs?, connectionDrainTimeoutMs?, minMaxPayloadBytes? })
```

The connection reconnects forever with jittered backoff and drains on shutdown, for at most
`connectionDrainTimeoutMs` (default `DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS`, 5 s) and never longer
than what is left of `SHUTDOWN_TIMEOUT_MS` less 1 s: a server that accepts the connection but
never answers (a paused container) no longer turns `SIGTERM` into the forced exit
(`Graceful shutdown exceeded … ms, exiting`, exit 1); the connection is closed with the warning
`NATS drain did not finish within … ms (server not answering)`.
`NatsClient.maxPayloadBytes()` is the server's `max_payload` (`undefined` before connect); the
kit logs a warning at connect when it is below `minMaxPayloadBytes` (default 4 MiB, the platform's
`infra/nats/nats.conf`; set the option to accept a smaller server deliberately).

**Stream ownership (spec §7.2).** `streams` lists the contracts streams the service **produces**
to: they are created when missing and **widened** to the contracts definition (new subjects,
longer retention, larger per-subject limit or dedup window), never narrowed — a narrowing change
(services pin different contracts versions; NATS purges at once on a lowered limit) is only logged
for an operator. Consumers never change a stream: a missing source stream (or `DLQ`) is created
so services can boot in any order, an existing one is left as it is. A stream deleted at runtime
is created again: a publish to a produced stream that fails with "no stream" re-ensures it and
retries once, and consumer recovery and dead-lettering re-ensure with
`StreamManager.ensure(names, role, { refresh: true })` (`invalidate(names)` forgets the memo).

### Publishing

```ts
constructor(private readonly events: EventPublisher) {}

const { envelope, ack } = await this.events.publishEvent(EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot); // subject derived
await this.events.publishMany([{ type, data, subject?, options? }, …]); // acks in input order
// options: { msgId? (default envelope id), id?, time?, entityKey?, expect?, timeoutMs? }
```

The subject always comes from the event (contracts `subjectForEvent`); an explicit subject that
differs is refused with `EventSubjectMismatchError` (the deprecated `publish(subject, type, data)`
checks it too).

The envelope gets `source = SERVICE_NAME`, a UUID v7 id, the time and `traceparent`; the payload is
validated against the contracts schema (`InvalidEventError`); headers: `Nats-Msg-Id`,
`traceparent`, `content-type: application/json`, `Ais-Its-Event-Type`.

**Message size.** A message larger than the server's `max_payload` is rejected **before** it is
sent with `EventTooLargeError` (`type`, `sizeBytes`, `maxBytes`; counted as
`aisits_events_published_total{outcome="rejected"}`). Measure a payload up front with
`eventMessageSize(type, data)` (encoded envelope + 1 KiB header allowance) and compare it with
`NatsClient.maxPayloadBytes()`, e.g. to answer `422` for a zone snapshot that can never be
published; `enqueueEvent(client, type, data, { maxBytes })` refuses such a row before the
`INSERT`.

### Durable consumers — one model: `@EventHandler` on provider methods

Decorate a method of a singleton provider; handlers are discovered when the application
bootstraps, one per durable consumer. The consumer (a contracts `CONSUMERS` key or an explicit
`DurableConsumerDefinition`) is created, or its own settings updated, idempotently (filter, ack
wait, max deliver, max ack pending).

```ts
@EventHandler({ consumer: 'emission-positions', concurrency: 8, orderBySubject: true, maxDeliver?, ackWaitMs?, backoffMs?, maxAckPending?, exclusive? })
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
| `DeadLetterError` (a message that can never be handled)           | copy to the DLQ at once (any delivery), then `ack`                         | `dead_letter`                           |

- **No redelivery while waiting.** Every received message is heartbeated (`working()` every
  `ackWaitMs / 3`) from its arrival until it is settled — while it waits for its subject's turn or
  a handler slot and while it runs — and the client buffer is bounded by `maxAckPending`.
- **Order.** With `concurrency > 1`, messages of the same subject (= same vessel) still run one
  after the other in stream order. A message that is **nak'd** is redelivered after its backoff,
  so later messages of its subject may be handled before the retry: handlers that need strict
  per-entity order compare versions/times (`previous`, `updatedAt`) or fail with
  `NonRetryableError`. A consumer whose filter is a **single literal subject** (e.g.
  `notify.email.v1`) has one subject only, so `orderBySubject: true` (the default) runs it one
  message at a time whatever `concurrency` says: set `orderBySubject: false` for parallelism
  (the kit logs a warning at start for this combination).
- **Recovery.** The consume loop's status is watched: a deleted or missing consumer (or stream) is
  recreated and consumption resumes; a consumer without messages or server heartbeats for 60 s,
  or failing to recover, turns readiness `nats` down (`aisits_events_consumer_recoveries_total`).
- **Single active instance.** `exclusive: true | { pinnedTtlMs }` (NATS ≥ 2.11 priority group
  `pinned_client`, default TTL 30 s) delivers to one replica; the others stand by and take over
  when it stops pulling — see [Exclusive consumers](#exclusive-consumers-hot-standby).
- `NATS_DURABLE_PREFIX` prefixes every durable name (test suites sharing one server).
- Shutdown stops pulling, waits for in-flight handlers up to `drainTimeoutMs` (then aborts
  `context.signal`) and naks what was not started. Handlers must be idempotent (redeliveries
  happen; see `withIdempotency`).

### Exclusive consumers (hot standby)

- **Pull expiry follows the TTL.** An exclusive instance pulls with
  `expires = min(30 s, max(1 s, pinnedTtlMs / 3))` and idle heartbeats at half of it, so an idle
  but healthy pinned instance keeps its pin (with the 0.2 expiry equal to the TTL the server
  unpinned an idle instance, and its next message waited up to a TTL). A `pinnedTtlMs` below
  3 000 ms logs a warning.
- **Unpinned instances re-subscribe.** When the server pins another instance (or the operator
  unpins), the instance goes `standby`, closes its pull and subscribes again after 2 s, so it is
  ready to take over again later.
- **Graceful stop releases the pin.** `stop()` unpins the consumer (only while this instance still
  holds the pin), so a standby takes over at once instead of after the TTL: rolling updates of
  several replicas are fine.
- **Activation hooks.** Providers with `@EventHandler` methods may implement
  `ExclusiveConsumerListener` (`onConsumerActivated(event)`, `onConsumerDeactivated(event)`, with
  `{ consumer, stream, pinId, previous, reason: 'pinned' | 'unpinned' | 'stopped' | 'contact_lost' | 'paused' }`).
  Dispatch waits until `onConsumerActivated` settled, so state reloaded there is complete before
  the first message of the new pin; a failing hook naks with backoff (dead-letters the message on
  its last delivery). `aisits_events_consumer_activations_total{consumer}` counts activations.
- **Cut off from NATS: the pin is given up.** The server unpins an instance `pinnedTtlMs` after
  the last pull carrying its pin reached it. An active instance that has had no confirmed contact
  with the server (a message, an idle heartbeat, a pull status) for
  `pinContactTimeoutMs(pinnedTtlMs)` = `max(2 × heartbeat, pinnedTtlMs − expiry − heartbeat)` —
  half the TTL from 3 to 90 s, 15 s at the default 30 s — deactivates itself (`contact_lost`:
  `onConsumerDeactivated` runs after the handlers of the period, the Detector SDK's ticks stop at
  once) and subscribes afresh: it becomes active again only through a **new** pin (it releases
  the old one first if the server still holds it). Every contact belongs to a pull at most one
  expiry old, so the server cannot have pinned another instance before this bound, with one
  heartbeat interval of margin for transit (5 s at the default TTL); a healthy instance hears from
  the server every heartbeat and gives its pin up only after missing about three in a row (slow
  handlers and event-loop stalls well below the bound never trigger it). Below a TTL of 3 000 ms
  the bound cannot be kept (the kit warns at start).
- **Paused process: nothing stale is dispatched.** When the process did not run for longer than
  the same bound (`SIGSTOP`, a blocked event loop; measured with the monotonic clock before every
  dispatch, on every server contact, by a watchdog and when `state` is read), the instance stops
  acting as active (`paused`): what it buffered meanwhile is **returned** (`nak` after
  `RETURNED_MESSAGE_DELAY_MS` = 1 s, `aisits_events_consumed_total{outcome="returned"}`, not a
  handler failure; dead-lettered instead on its last delivery), and the server is asked which
  instance it pins. If it still (or again) pins this one, `onConsumerActivated` runs again —
  `previous === pinId` for the same pin — before any message is dispatched; otherwise it
  subscribes afresh as a standby. A handler that was already running when the process stopped
  finishes after the pause (the deactivation hook waits for it).
- **State.** `EventConsumers.state(name)` and `ConsumerHealth.state` report `starting`,
  `active`, `standby` or `shared` (not exclusive). Reading the runner's `state` first checks for a
  pause, so a timer that fires right after `SIGCONT` sees `standby`, not a stale `active`.

### Ordered (ephemeral) consumers — fan-out, every instance gets every message

```ts
@OrderedEventHandler({ consumer: 'notification-safety', deliver: 'last_per_subject' }) // contracts ORDERED_CONSUMERS key
onSafetyState(event: ConsumerEnvelope<'notification-safety'>, context: EventContext): void { … }

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
time range with an ephemeral consumer up to the end of the stream at start (recomputations). The
`ReplayReport` says whether the range was read completely: `completed` is `true` for `endedBy`
`'empty'`, `'end_of_stream'` and `'to'`, `false` for `'aborted'` (the signal) and `'closed'` (the
connection closed or drained mid-replay — the replay ends instead of rejecting; handler errors
still reject). Write derived results only for a completed replay.

### Core NATS subscriptions

```ts
@CoreSubscriptionHandler({ subscription: 'telemetry-mqtt', concurrency?: 16, maxPending?: 1000, queue? })
async onDeviceMessage(message: Msg): Promise<void> { const json = message.json<unknown>(); … }

@CoreSubscriptionHandler({ subscription: 'notification-realtime-fanout' }) // delivery 'fanout'
onFanout(message: Msg, payload: RealtimeAlertFanout): void { … }            // validated payload
```

Contracts `CORE_SUBSCRIPTIONS` (e.g. `aisits.telemetry.*` from the MQTT gateway): subscribed at
bootstrap, handled with bounded concurrency inside the log context; failures are logged and
counted (`aisits_core_messages_total{subscription,outcome}`), overflow beyond `maxPending` is
dropped and counted; drained on shutdown. Core NATS has no redelivery.

- **Delivery** follows the contracts definition: `delivery: 'queue'` (the default) subscribes in
  the queue group `SERVICE_NAME`, so replicas share the messages; `delivery: 'fanout'` (e.g.
  `notification-realtime-fanout`, `aisits.notification.realtime.v1`) gives every instance every
  message. An explicit `queue` (a group name, or `false`) still wins.
- **Payloads** are validated against contracts `CORE_SUBSCRIPTION_PAYLOADS[name]` when the
  definition has a schema (`RealtimeAlertFanoutSchema`; `telemetry-mqtt` accepts anything): the
  parsed value is the handler's second argument, an invalid message is dropped and counted as
  `outcome="invalid"`.

### Transactional outbox

```ts
// migration: outboxTableSql() (new table) or outboxUpgradeSql() (table of kit 0.2)
OutboxModule.forRoot({ table?, pollIntervalMs?: 500, batchSize?: 100, retentionMs?: 24h, autoStart?,
  mode?, publishConcurrency?: 64, retry?: { baseMs?: 1000, maxMs?: 300_000 }, maxAttempts? })
OutboxModule.forRootAsync({ inject: [APP_CONFIG], useFactory: (config: Config) => ({ … }), imports? })

await withTransaction(this.pool, async (client) => {
  await this.vessels.update(client, id, changes);
  await enqueueEvent(client, EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot, { maxBytes? }); // validated now
});
this.outbox.notify(); // OutboxRelay: publish now instead of at the next poll
```

`OutboxRelay` publishes committed rows only (never rolled-back ones), with the row id as envelope
id (`Nats-Msg-Id`, so a retry after a lost ack is deduplicated). The mode is detected from the
table:

- **`per-key`** (tables with `seq` and `next_attempt_at`, i.e. `outboxTableSql()` of 0.3 or a 0.2
  table after `outboxUpgradeSql()`): every replica relays. A pass claims up to `batchSize` due rows
  (`FOR UPDATE SKIP LOCKED`, `seq` order), publishes up to `publishConcurrency` entity keys at
  once — the rows of one key one after the other — and marks them in one `UPDATE`. A failed row
  gets `attempts + 1`, a sanitized `last_error` and a `next_attempt_at` with equal-jitter
  exponential backoff (`retry`); **only its key waits**, the other keys keep flowing. Rows
  without `entity_key` are unordered. Order is insertion order (`seq` is assigned at `INSERT`), so
  writers that change one entity concurrently must serialize (lock the entity row before
  `enqueueEvent`).
- **`serial`** (0.2 tables without the columns): one instance at a time publishes oldest first
  and a pass stops at the first failure (the 0.2 relay). A warning at start names
  `outboxUpgradeSql`; an explicit `mode: 'per-key'` on such a table throws `OutboxConfigError`.

Upgrade a 0.2 table with a migration generated once from
`node -e "import('@darmawanweb/ais-its-nest/nats').then((m) => console.log(m.outboxUpgradeSql()))"`:
it is idempotent, numbers the existing rows in their 0.2 order and locks the table until the
migration commits (run it while the outbox is small). During a rolling upgrade old serial relays
(exclusive advisory lock) and new per-key relays (shared lock) never publish at the same time.

In both modes a row that can never be published is **parked** (`failed_at`) and its key continues:
a payload that no longer validates, a subject mismatch, a message larger than the server's
`max_payload` (`EventTooLargeError`), or `maxAttempts` failed attempts (default unlimited).
Published rows are deleted after `retentionMs`. `relayOnce()` returns
`{ published, rejected, skipped, failed, retrying, deferred, mode }`. Metrics:
`aisits_outbox_relayed_total{type,outcome}`, `aisits_outbox_pending`,
`aisits_outbox_oldest_pending_seconds`, `aisits_outbox_retrying_rows` (pending rows that failed at
least once) and `aisits_outbox_failed_rows` (parked rows).

`AuditService.enqueue(client, entry, principal?, request?)` writes an audit record into the same
outbox inside the caller's transaction (see [Audit](#audit-health-metrics-tracing-internal-http)).

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
window. `peek(key)` reads without counting, `refund(key, cost?)` returns units, `reset(key)`
forgets.

**Throttling failed attempts** (login, MFA): never `peek` and then `consume` on failure — that is
check-then-act, and concurrent attempts all pass the `peek`. Reserve first with `guardAttempt`:

```ts
const user = await guardAttempt(logins, email, () =>
  this.verifyPassword(email, password),
);
// reserves 1 unit atomically BEFORE the check (429 RateLimitedError when none is left), keeps it
// when the check throws (a failure), refunds it when the check resolves ({ onSuccess: 'refund' | 'reset' | 'keep' })
```

## Authentication and authorization (`./auth`)

```ts
AuthModule.forRoot({ apiKeys? = true, keyResolver?, apiKeyIntrospector?, apiKeyCache?, imports? })
```

Registers a **global default-deny** guard: every route needs a principal unless `@Public()`.
Handler metadata wins over controller metadata: `@RequirePermissions()` / `@AllowApiKey()` on a
method protect it even under a controller-level `@Public()`, and a controller-level
`@AllowApiKey()` does not open methods that declare their own `@RequirePermissions()` to API keys.
Non-HTTP handlers (WebSocket, RPC) are denied unless marked `@Public()` (authenticate their
connection with `AccessTokenVerifier` instead).

| Decorator                             | Effect                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `@Public()`                           | anonymous access                                                                           |
| `@RequirePermissions('vessel:write')` | users need every listed permission (contracts `ROLE_PERMISSIONS`) → else `403 FORBIDDEN`   |
| `@AllowApiKey('ais:ingest')`          | the route also accepts `X-API-Key` with every listed scope → else `403 INSUFFICIENT_SCOPE` |
| `@RequirePlatformAdmin()`             | only platform administrators (`super_admin`) → else `403 PLATFORM_ADMIN_REQUIRED`          |
| `@Internal()`                         | `/internal/*` routes: constant-time `X-Internal-Token` check against `INTERNAL_TOKEN`      |
| `@CurrentPrincipal()`                 | parameter decorator: the `Principal` (`UserPrincipal` \| `ApiKeyPrincipal`)                |

`@RequirePlatformAdmin()` (class or method) replaces in-handler `isPlatformAdmin` checks of
platform-wide operations (e.g. `POST /vessels/:id/republish`): it combines with
`@RequirePermissions()`, API keys are always refused, and a handler-level `@Public()` or
`@RequirePlatformAdmin()` wins over the controller level. The OpenAPI operation gets
`x-required-roles: ['super_admin']` and a sentence in its description (added by
`buildOpenApiDocument`, so `exportOpenApi` documents it) that matches what the guards answer on
that route: `PLATFORM_ADMIN_DESCRIPTION` ("other users and API keys get 403
PLATFORM_ADMIN_REQUIRED") when it accepts API keys (`@AllowApiKey`, `x-api-key-scopes`), else
`PLATFORM_ADMIN_WITHOUT_API_KEYS_DESCRIPTION` ("other users get 403 PLATFORM_ADMIN_REQUIRED, and
API keys are not accepted on this route (401 INVALID_API_KEY)"). An operation whose own
description already names `PLATFORM_ADMIN_REQUIRED` keeps its own wording.

- Access tokens: EdDSA, `iss`/`aud` from config, 30 s clock tolerance, contracts claim schema;
  keys from the remote JWKS (`AUTH_JWKS_URL`) unless `keyResolver` is given (the auth service plugs
  its local keys, tests a test issuer). The JWKS is refreshed in the background after 10 min and
  **stale-if-error**: while auth is unreachable the cached keys keep verifying for up to 1 h;
  an unknown `kid` refetches at most every 30 s; redirects are not followed. Failures to fetch
  keys answer `503 SERVICE_UNAVAILABLE` (with `Retry-After`), never `401`, so clients do not log
  users out during an auth deploy.
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

- **Audit** (`./audit`): `AuditService.record({ action: 'vessel.update', targetType, targetId, meta, orgId?, labels? }, principal?, request?)`
  publishes `audit.recorded.v1` to `audit.v1.<SERVICE_NAME>`; best effort (resolves `false` and
  counts `aisits_audit_failures_total` instead of throwing). `labels` (`{ actorName?, actorEmail?,
orgName?, targetLabel? }`, each `string | null`, cut to `AUDIT_LABEL_MAX_LENGTH` = 200) are the
  names known when the record is written, e.g. `{ targetLabel: vessel.name }` in the transaction of
  a vessel change, so the audit log shows the name of the time even after a rename or deletion;
  without them the payload is unchanged (the audit log resolves names itself). `AuditModule` is global: import it
  once in `AppModule`. Needs `NatsModule`. Security-relevant records that must not be lost go
  through the transactional outbox instead:
  `await audit.enqueue(client, entry, principal?, request?, { table? })` inside the transaction
  of the change (needs `outboxTableSql()` and `OutboxModule`; it throws, unlike `record()`, and a
  rolled-back transaction never publishes it). Both normalize the request ip with `clientIp`.
- **Health** (`./health`, always on): `GET /health/live`, `GET /health/ready` aggregating the
  indicators registered by `DatabaseModule`, `NatsModule`, `RedisModule` and any provider
  decorated with `@ReadinessCheck()` implementing `{ healthKey, check(health) }`.
- **Metrics** (`./metrics`, always on): `GET /metrics`, default Node.js metrics prefixed `aisits_`,
  `aisits_http_requests_total` / `aisits_http_request_duration_seconds{method,route,status_code}`
  (route template), event and detector metrics; add your own with
  `metrics.counter({ name: 'ais_messages_total', help, labelNames })` (prefix added, get-or-create),
  `gauge()`, `histogram()`. Type fields with the re-exported prom-client types
  (`import type { Counter, Gauge, Histogram } from '@darmawanweb/ais-its-nest/metrics'`), so a
  service needs no `prom-client` dependency of its own.
- **Tracing** (`./telemetry`): `startTelemetry({ serviceName, serviceVersion, instrumentations? })`
  — OTLP/HTTP traces with Fastify plus `SUPPORTED_INSTRUMENTATIONS` (`http`, `undici`, `pg`,
  `ioredis`; the kit depends on exactly these, `OTEL_NODE_ENABLED_INSTRUMENTATIONS` narrows them),
  a no-op without `OTEL_EXPORTER_OTLP_ENDPOINT`; call it before importing the app. Trace context travels in NATS
  headers and the envelope (`injectTraceContext`, `extractTraceContext`, `currentTraceparent`,
  `withSpan`). Since 0.3 the pipeline is built from the trace SDK (`@opentelemetry/sdk-trace`,
  `BatchSpanProcessor`, `AsyncLocalStorageContextManager`) instead of `@opentelemetry/sdk-node`,
  which removes about 20 MB of gRPC/protobuf exporters from every image. It exports **traces
  only** (OTLP/HTTP; no OTLP metrics or logs — metrics stay on `/metrics`) and honours
  `OTEL_SDK_DISABLED`, `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`, `OTEL_PROPAGATORS`
  (`tracecontext`, `baggage`, `none`), `OTEL_BSP_*`, the `OTEL_SPAN_*` / `OTEL_ATTRIBUTE_*`
  limits, `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME`; `OTEL_NODE_RESOURCE_DETECTORS` and
  `b3` are not supported.
- **Internal HTTP** (`./internal-http`): `InternalHttpClient.forService(config, baseUrl)` sends
  `X-Internal-Token`, JSON, `traceparent`; per-attempt timeout (5 s), limited jittered retries
  (2) for idempotent requests (`GET/HEAD/PUT/DELETE`, or `idempotent: true`) on network errors,
  timeouts and 502/503/504; failures are `InternalHttpError` with the remote problem details
  (`code`, `status`, `isTransient`). Redirects are never followed (the internal token and the
  body stay with the configured host): a 3xx is an `InternalHttpError`.

## Detector SDK (`./analytics`)

Every analytics feature that reacts to vessel movement is **one class**: a NestJS provider that
implements `Detector` and is decorated with `@RegisterDetector()`. `DetectorRunnerModule` feeds it.

```ts
DetectorRunnerModule.forRoot({
  positions: 'safety-positions',        // durable AIS_POSITION consumer (contracts key or definition)
  exclusive?: true,                     // single active instance; other replicas stand by (failover)
  concurrency?: 8,                      // vessels in parallel; one vessel's positions stay ordered
  zones?: true, fleet?: true,           // GEO / FLEET snapshots (ordered, last_per_subject)
  distanceModel?: 'wgs84',              // or 'sphere' (Turf.js / legacy parity)
  vesselState?: { maxVessels?, staleAfterMs?, mirror?: boolean | { keyPrefix?, ttlMs? } }, // mirror needs RedisModule
  pairSearch?: { cellSizeM?, maxAgeMs? },
  alertCooldownMs?: 600_000,
  alertRepeatedIntervalMs?: 60_000,     // event-time throttle of AlertPersistence.onRepeated
  publishResolutions?: true,            // publish alert.resolved.v1 (false: only persist resolutions)
  persistence?: { useClass: MyEventsRepository },   // AlertPersistence, under the ALERT_PERSISTENCE token
  env?, enabled?, callTimeoutMs?: 10_000, catchUpTimeoutMs?: 60_000, imports?,
})
DetectorRunnerModule.forRootAsync({       // options from the typed configuration
  inject: [APP_CONFIG],
  useFactory: (config: Config) => ({ positions: 'safety-positions', concurrency: config.SAFETY_CONCURRENCY }),
  persistence?: { useClass: MyEventsRepository },
})
```

`DETECTORS` and `<ID>_*` are read from the `DETECTOR_ENV` provider (`options.env ?? process.env`,
read when the module is built — after `loadConfig()` loaded `.env`); tests override it:
`buildTestApp(AppModule, { config, overrides: [{ provide: DETECTOR_ENV, useValue: { DETECTORS: 'geofence' } }] })`.

Boot sequence: module init discovers and registers the detectors (unknown `DETECTORS` entries or
invalid `<ID>_*` variables stop the boot, listing every problem) → application bootstrap restores
open alerts (`persistence.loadOpen`) and mirrored vessel states, ensures `ALERTS`, loads the `GEO`
and `FLEET` snapshots and **waits until they are complete**, then starts the durable position
consumer and the ticks. Each instance holds every zone and vessel (ordered consumers). Detector
state (vessel states, tracks, neighbours, open alerts) lives in memory, so positions go to **one
active instance** (`exclusive`, default `true`): further replicas are hot standbys that take over
when it stops, not extra throughput. Scale out by splitting detectors over deployments with
`DETECTORS` — each subset consumes through its own durable (`<positions>-<sorted ids>`), so
differently configured deployments never split the feed. Durable projections into tables
(`safety-zones`, `surveillance-fleet`, …) remain ordinary `@EventHandler` consumers.

**Failover and activation.** With the default exclusive consumer an instance starts **inactive**
and becomes active when the server pins it (its first position after the pin, NATS ≥ 2.11). The
activation runs before that position is dispatched: ticks pause, running detector calls settle,
pending resolution events are published, the open alerts are **reloaded** from
`persistence.loadOpen()` with replace semantics (`AlertEmitter.replaceOpen`, scoped to the
enabled detectors' occurrences, so what the previous instance raised or resolved is taken over
and not raised twice), the vessel states are re-seeded from the Valkey mirror (best effort) and
every detector's `onActivated(context, call)` runs (drop local state such as pair trackers or
streaks). Then `context.isActive()` turns `true`. A failing `loadOpen` fails the activation, which
is retried with the next message. Losing the pin (another instance took over), giving it up (cut
off from NATS, or after a pause of the process — see _Exclusive consumers_) or a graceful stop
runs the reverse: ticks stop **at once** (the role change is seen before the handlers of the
period settle; a tick that fires right after a pause re-checks the role first), running calls
settle, pending resolutions are published, then `onDeactivated`. After a pause the instance
becomes active again only once the server confirmed its pin, with the full activation (reload)
before any position is dispatched.

**Resolutions a crash would lose.** A resolution waits in memory until the alert cooldown since
the last raise ended (or is cancelled by a re-raise within it). To announce it even when the
process crashes in that window, give the persistence hook `loadUnannounced()` and
`onResolutionPublished({ dedupKey, alertId, eventId })`: store `AlertResolution.eventId` in
`onResolved`, mark the row announced in `onResolutionPublished`, and return the resolved rows with
an event id and no announcement mark (`UnannouncedResolution`: the occurrence as it ended —
`publishedAt` = its last published raise —, `resolvedAt`, `reason`, `data`, `eventId`) from
`loadUnannounced`. The runner queues them on every activation (at startup without an exclusive
consumer; `DetectorActivation.unannounced` counts them) with their stored event id, so consumers
deduplicate a second announcement; they go out when the rest of the cooldown has passed, and a
re-raise within it reopens the occurrence as before. Both hooks are optional: without them a crash
within the cooldown still loses the announcement. **Ticks run only on the active instance**; `onZoneChanged` / `onVesselChanged`
run on every instance, so check `context.isActive()` before raising or resolving there. A
graceful stop releases the pin at once, so services may run two or more replicas with **rolling
updates** (no `Recreate` strategy needed). Without `loadOpen` a takeover keeps the standby's own
boot-time state and may raise again what the previous instance raised (a warning is logged at
bootstrap). With `exclusive: false` every instance is always active.

For every position the runner first updates `VesselStateStore` and `PairSearch` (positions not
newer than the vessel's state are dropped: duplicates and out-of-order redeliveries; states
restored from the Valkey mirror only seed the store, so the backlog after a restart still reaches
the detectors), then calls every enabled detector's `onPosition` concurrently. A detector that
throws or exceeds `callTimeoutMs` is logged and counted and never makes the message redeliver; a
late call gets its `call.signal` aborted and, until it settles, that detector's next calls for the
same vessel are skipped (`aisits_detector_skipped_total`), so calls for one vessel never overlap.
The message is acknowledged once every detector settled, so a slow detector slows the feed: give
slow detectors their own deployment (`DETECTORS`). Ticks run on timers between positions; both
paths go through the same `AlertEmitter`, which serializes all operations of a `dedupKey`. Zone
and vessel changes reach `onZoneChanged` / `onVesselChanged` after the index was updated
(`initial: true` during the startup snapshot). Neighbour queries and pruning use **event time**
(the newest indexed position), never the wall clock, so a backlog after an outage still finds its
pairs. The vessel state mirror is namespaced per service (`aisits:<SERVICE_NAME>:vessel-state:`).

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
  readonly methodIds = ['geo.geofence_enter']; // methodology catalog ids (unknown ids are warned about)
  readonly alertTypes = ['geofence'] as const; // checked against the registry at boot and on raise
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
    // `open()` only lists this detector's occurrences.
    for (const open of context.alerts.open({ mmsi: position.mmsi })) {
      if (!inside.some((zone) => zone.id === open.zoneId)) {
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

| Member       | Type                      | Use                                                                                                                                                                           |
| ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`     | `Config`                  | parsed `<ID>_*` variables                                                                                                                                                     |
| `vessels`    | `VesselStateStore`        | `get(mmsi)`, `isStale(mmsi, { maxAgeMs? })`, `fresh()`, `staleSince()`, `ageMs()` (LRU, optional Valkey mirror)                                                               |
| `pairs`      | `PairSearch<VesselState>` | `neighbours(origin, { radiusM, maxAgeMs?, filter?, limit? })` nearest first, `pairs({ radiusM })`                                                                             |
| `zones`      | `ZoneIndex`               | `zonesAt(point, { kinds?, useBuffer?, orgId? })`, `distance(zoneId, point)`, `near(point, radiusM, q)`, `nearest(point, { kinds, maxDistanceM? })`, `contains(zoneId, point)` |
| `fleet`      | `FleetDirectory`          | `byMmsi(mmsi)`, `byId(id)`, `orgOf(mmsi)` (`undefined` = unregistered vessel)                                                                                                 |
| `alerts`     | `DetectorAlerts`          | `raise(signal)`, `resolve(dedupKey, { at?, reason?, data?, publish? })`, `forget(dedupKey)`, `get()`, `isOpen()`, `open({ mmsi? })` — scoped to THIS detector's occurrences   |
| `logger`     | `DetectorLogger`          | `log/warn/error/debug`                                                                                                                                                        |
| `now()`      | `() => Date`              | the SDK clock (fixed in tests)                                                                                                                                                |
| `isActive()` | `() => boolean`           | `true` while this instance is the active one (always with `exclusive: false`); ticks run only then                                                                            |

Detectors that need history own a `TrackBuffer` (`new TrackBuffer<VesselPosition>({ maxPoints: 64,
maxAgeMs: 45 * 60_000 })`: `push(mmsi, point)`, `points(mmsi, { since })`, `tail(mmsi, n)`,
`last(mmsi)`, `prune(now)`). Distances are geodesic metres: `'wgs84'` (Vincenty) matches PostGIS
`ST_Distance(geography)` within 1 cm in the test suite; `'sphere'` matches `@turf/distance` /
`@turf/nearest-point-on-line` 7 exactly, which the legacy EWS rule used. Lines and polygon edges are
great-circle arcs, for containment too (long polygon edges are densified at compile time), so
`contains()` and `distance()` agree with each other and with PostGIS `ST_Covers(geography)`;
geometries must not cross the antimeridian. Zone `properties` are typed per kind with the
contracts `zoneProperties(zone)` (e.g. `depthM` of `shallow_water`). Helpers: `geodesicDistanceM`,
`haversineM`, `vincentyM`, `distanceToArc`, `nearestPointOnArc`, `initialBearingDeg`,
`destinationPoint`, `searchBox`.

### Alerts (`AlertEmitter`)

One state machine per `dedupKey`; every operation of a key (raise, resolve, publication retry)
runs to completion before the next starts, so the two vessels of a pair, a tick and a position, or
a resolve during a raise never open two occurrences or lose a resolution. `AlertRaisedV1`
payloads are validated (registry domain, `methodId` format) and published to
`alert.v1.<type>.<mmsi>` with the envelope id = alert id. The serialization is in-process,
which is enough with the single active instance of the runner; where several writers may exist,
also enforce one open occurrence per `dedup_key` in the database (a partial unique index
`(dedup_key) WHERE status = 'open'` on a plain table — a hypertable's unique indexes must include
its time column, so keep open occurrences in a small companion table there).

| Signal for a key                                                                                                    | Outcome        | Published              | Persistence hook                                |
| ------------------------------------------------------------------------------------------------------------------- | -------------- | ---------------------- | ----------------------------------------------- |
| nothing open                                                                                                        | `raised`       | yes                    | `onRaised(alert, 'raised')` (first)             |
| open, higher severity                                                                                               | `escalated`    | yes (new id, same key) | `onRaised(alert, 'escalated')`                  |
| open, same severity                                                                                                 | `unchanged`    | no                     | `onRepeated(alert, occurredAt)` (throttled)     |
| open, lower severity                                                                                                | `de-escalated` | no                     | `onUpdated({ reason: 'de-escalated' })`         |
| back to an already published severity within `alertCooldownMs`, or re-raised after a resolution within the cooldown | `suppressed`   | no                     | `onUpdated({ reason: 'suppressed', reopened })` |
| `resolve(key)`                                                                                                      | `true`/`false` | `alert.resolved.v1`    | `onResolved(resolution)`                        |

`AlertPersistence` (all optional): `onRaised`, `onUpdated`, `onResolved`, `onRepeated`,
`loadOpen` (restores open occurrences at boot and on every activation, so a restart or a failover
does not re-raise them). The hook runs **before** publishing, so the service's `events` table
records every occurrence; implementations must be idempotent. Publishing retries for 5 s; an
alert that still cannot be published stays pending (already persisted, same id, so JetStream
deduplicates) and is published by the next signal of its key or by the runner's 30 s housekeeping
(`retryPending()`), which also prunes expired cooldowns and stale neighbour entries.

**Resolutions are published** (`publishResolutions`, default `true`): `resolve()` announces
`alert.resolved.v1` on the raise's subject `alert.v1.<type>.<mmsi>` (stream `ALERTS`, envelope id
= `AlertResolution.eventId`; payload `alertId`, `type`, `domain`, `severity` = the highest
published, `mmsi`, `relatedMmsi`, `zoneId`, `dedupKey`, `openedAt` = first occurrence,
`resolvedAt`, `reason` ≤ 500 characters, `methodId`, `data`), so notification closes the inbox
alert. Timing:

- at once when the key's last published raise is at least `alertCooldownMs` old;
- otherwise when that window ends (published by the 30 s housekeeping, before the key's next
  raise, or by `flush()`); a **re-raise within the window cancels it** (the occurrence is reopened
  as `suppressed`, or escalated), so flapping adds no notifications and the inbox never shows
  resolved while the detector holds the alert open;
- pending resolutions are published on deactivation and graceful stop (`flush()`, bounded to
  10 s); a crash inside the window loses only the event (the resolution itself is persisted).

`resolve(key, { publish: false })` only persists (e.g. an occurrence another writer already
ended); an occurrence without `domain` / `methodId` (restored from an old `loadOpen`) gets the
detector's domain and first method id. An immediate publication failure rejects `resolve()`
after the resolution was recorded, like `raise()`.

**Takeover and coordination.** `alerts.replaceOpen(occurrences, { filter? })` replaces the open
state (in the filter's scope) without calling hooks and returns `{ restored, forgotten }` — the
runner uses it on activation; `alerts.forget(dedupKey, { accept? })` drops one key's open and
cooldown state without hooks (then a new signal is `raised` again);
`alerts.withKey(dedupKey, fn)` runs `fn` inside the key's serialization (re-entrant: `raise` /
`resolve` of the same key inside `fn` run at once), e.g. to align with the database under the
key's turn. A persistence hook must not call the emitter for its own key (it runs inside the turn).

**Clocks.** `OpenAlert.openedAt`, `publishedAt` and `lastSeenAt` are emitter-clock times;
`firstOccurredAt` and `lastOccurredAt` are **event times** (the signals' `occurredAt`, never moving
backwards; `loadOpen` rows without them default to `openedAt` / `lastSeenAt`), and so is
`AlertUpdate.occurredAt`. Store event times in the service's tables: `onRepeated(alert, occurredAt)`
is called for an `unchanged` signal of an open key at most once per `alertRepeatedIntervalMs`
(default 60 s) of event time, e.g. for `last_seen_at = GREATEST(last_seen_at, occurredAt)`.
`loadOpen` should return `domain`, `methodId`, `firstOccurredAt` and `lastOccurredAt`.

**Injection.** The hook is provided under the `ALERT_PERSISTENCE` token; `{ useClass: X }` also
provides `X` itself (one instance, so tests can `app.get(X)`). Do not list `X` in the service
module's `providers` as well (that would be a second instance).

### Metrics

`aisits_detector_evaluations_total{detector}`, `aisits_detector_duration_seconds{detector}`
(`onPosition` and `onTick` calls), `aisits_detector_alerts_total{detector,severity}`,
`aisits_detector_errors_total{detector,hook}`, `aisits_detector_skipped_total{detector,hook}`
(hooks include `onActivated` and `onDeactivated`), `aisits_detector_positions_total{outcome}`,
`aisits_detector_alert_resolutions_total{detector}` (resolutions by `context.alerts.resolve()`)
and `aisits_detector_activations_total{outcome="completed"|"failed"}`; the exclusive position
consumer also counts `aisits_events_consumer_activations_total{consumer}`.

### Testing a detector without NATS (`DetectorTestHarness`)

```ts
// src/detectors/geofence.detector.spec.ts
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
    await harness.position({ mmsi: 525005223, lat: 1.05, lon: 104.05 }); // defaults: time = clock (or the vessel's last + stepMs), previous = last fed
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

    // alert.resolved.v1 goes out once the alert cooldown (10 min) since the
    // raise is over: a re-entry before then reopens the same alert instead.
    expect(harness.resolvedEvents).toEqual([]);
    harness.advance(10 * 60_000);
    await harness.maintain(); // the runner's 30 s housekeeping
    expect(harness.resolvedEvents).toEqual([
      expect.objectContaining({
        alertId: harness.alerts[0]?.id,
        dedupKey: `geofence:525005223:${zone.id}`,
        reason: 'left the zone',
      }),
    ]);
  });
});
```

`DetectorTestHarness.create(options)`:

| Option                    | Default                    | What                                                                                                 |
| ------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `detectors`               | (required)                 | detector instances under test                                                                        |
| `env`                     | `{}` (never `process.env`) | `DETECTORS` and `<ID>_*` variables                                                                   |
| `enabled`                 | from `DETECTORS`           | enabled ids                                                                                          |
| `now`                     | `2026-01-01T00:00:00Z`     | initial clock                                                                                        |
| `alertCooldownMs`         | 10 min                     | like the runner                                                                                      |
| `alertRepeatedIntervalMs` | 60 s                       | event-time throttle of `onRepeated`                                                                  |
| `publishResolutions`      | `true`                     | record resolutions as published `alert.resolved.v1` (`resolvedEvents`)                               |
| `distanceModel`           | `'wgs84'`                  | or `'sphere'`                                                                                        |
| `pairSearch`              | runner defaults            | `{ cellSizeM?, maxAgeMs? }`                                                                          |
| `vesselState`             | runner defaults            | `{ maxVessels?, staleAfterMs? }` (no mirror)                                                         |
| `persistence`             | none                       | an `AlertPersistence` to exercise (calls are recorded either way); its `loadOpen` feeds `activate()` |
| `callTimeoutMs`           | 10 s                       | upper bound of a detector call                                                                       |
| `stepMs`                  | 10 s                       | spacing of positions fed without `time`                                                              |

The harness also offers `track(points)` (positions without `time` are spaced by `stepMs`, so a
synthetic track is never reduced to its first point), `vessel(snapshot)`, `removeZone(id)`,
`removeVessel(v)`, `tick(now?)`, `setTime()`, `advance(ms)`, `maintain()` (publishes due
resolutions and retries, like the runner's housekeeping), `activate()` / `deactivate()` / `active`
(failover: reload from `persistence.loadOpen`, `onActivated` / `onDeactivated`; the harness starts
active), the records `alerts`, `updates`, `resolutions`, `resolvedEvents` and `logs`
(`clearRecords()`), `describe()`, `metricsText()` and the shared state in `services`;
`makeTestZone()` and `makeTestVesselSnapshot()` build valid contracts payloads (also exported by
`./testing`).

In application tests the persistence hook is `app.get(ALERT_PERSISTENCE)` or, for
`{ useClass: X }`, `app.get(X)` (the same instance).

## Testing guide (`./testing`)

Unit tests live next to the code (`*.spec.ts`), integration tests in `test/*.int.test.ts` against
real containers. `./testing` imports `testcontainers` and `@nestjs/testing`, which the kit does not
declare: list both as **devDependencies** of the service (they then never reach a production
install). vitest needs SWC for decorator metadata:

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

| Helper                                                                                                                                         | What                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTestInfra({ postgres?, nats?, redis?, s3?, smtp? })`                                                                                     | containers (`TEST_IMAGES`: `timescale/timescaledb-ha:pg17`, `nats:2.11-alpine`, `valkey/valkey:8-alpine`, `rustfs/rustfs:latest`, `axllent/mailpit:latest`), returns exactly the requested endpoints + `stop()`                          |
| `nats: { mqtt?, maxPayload? }`                                                                                                                 | NATS from a generated config (`testNatsConfig()`): JetStream, `max_payload` `DEFAULT_TEST_NATS_MAX_PAYLOAD` = `'4MB'` like `infra/nats/nats.conf` (`'1MB'` for the old default), `mqtt: true` adds the MQTT gateway (`TestNats.mqttUrl`) |
| `testInfraGlobalSetup(options)`, `testInfra(...names)`, `uniqueName(prefix)`                                                                   | one set of containers for the whole run (vitest `globalSetup`), endpoints in every test file, unique schema/durable names                                                                                                                |
| `reapOrphanedTestContainers()`                                                                                                                 | removes labelled test containers of crashed runs (called by `startTestInfra` when Ryuk is disabled)                                                                                                                                      |
| `provisionServiceSchema(adminUrl, schema)`                                                                                                     | replicates `infra/postgres/bootstrap.sql` for one schema (extensions in `public`, LOGIN role `<schema>_svc` with password = role name, schema owned by it, `USAGE` on `public`) and returns the service `DATABASE_URL`                   |
| `createTestJwtIssuer({ issuer?, audience? })`                                                                                                  | Ed25519 issuer: `sign({ roles, orgId, userId?, expiresInSeconds? })`, `issue()` (token + expected principal), `signRaw()`, `keyResolver` (for `AuthModule`), `serveJwks()` (real JWKS URL)                                               |
| `startFakeApiKeyIntrospection({ internalToken })`, `FakeApiKeyIntrospector`, `generateTestApiKey()`                                            | the auth service's introspection endpoint (HTTP) or in-memory                                                                                                                                                                            |
| `createTestConfig(schema, env)`                                                                                                                | validated config from `env` only (`NODE_ENV=test`, silent logs, no migrations unless set; the schema's `SERVICE_NAME` default is kept)                                                                                                   |
| `buildTestApp(appModule, { config, overrides?, logging?, cookies?, multipart?, configure? })`                                                  | the real platform composition, initialized (hooks run), use `app.inject()`; `app.close()`                                                                                                                                                |
| `makeTestEnvelope(type, data, options?)`                                                                                                       | a valid contracts envelope                                                                                                                                                                                                               |
| `makeTestZone(input)`, `makeTestVesselSnapshot(overrides)`, `makeTestAlertRaised(overrides?)`, `makeTestAlertResolved(overrides?, fromRaise?)` | valid `geo.zone.upserted.v1`, `fleet.vessel.upserted.v1`, `alert.raised.v1` and `alert.resolved.v1` payloads (validated with the contracts schemas; a resolution built from a raise shares its ids)                                      |
| `waitFor(predicate, { timeoutMs?, intervalMs? })`                                                                                              | polls until truthy and returns the value                                                                                                                                                                                                 |

Share one set of containers between test files: `vitest.int.config.ts` gets
`globalSetup: ['test/global-setup.ts']` with

```ts
// test/global-setup.ts
import { testInfraGlobalSetup } from '@darmawanweb/ais-its-nest/testing';

export const setup = testInfraGlobalSetup({ postgres: true, nats: true });
```

and each file reads the endpoints with `testInfra('postgres', 'nats')`, provisions its own schema
and sets `NATS_DURABLE_PREFIX: uniqueName('t')` so that parallel files never share durable
consumers. A single file can also start its own containers:

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
pnpm check:package  # dist smoke test, publint, attw (ESM only), API report, production-install smoke
pnpm api:report     # regenerate etc/api-report.json after a reviewed API change
pnpm check:readme   # rebuild and test the README's minimal service from the packed tarballs (Docker)
```

Releases follow the package's Keep a Changelog file ([CHANGELOG.md](CHANGELOG.md)); upgrade steps
for services are in [UPGRADING.md](UPGRADING.md).
