# Changelog — `@darmawanweb/ais-its-nest`

All notable changes to this package are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-21

First release of the NestJS 12 service kit of AIS Maritime Intelligence (spec 1.1, §4–§11 and
§18). ESM only, built with `tsc`, depends on `@darmawanweb/ais-its-contracts` `^0.2.0`.

### Added

- `.` — `bootstrapService()` (Fastify, prefix `api/v2`, helmet, CORS, `X-Request-Id`, Swagger at
  `/docs` + `/openapi.json`, graceful shutdown), `exportOpenApi()` without connections,
  `defineConfig()` / `loadConfig()` / `ConfigModule` / `@InjectConfig()` (spec §4 base schema),
  `DomainError` and `NotFoundError`, `ConflictError`, `ForbiddenError`, `UnauthorizedError`,
  `ValidationFailedError`, `RateLimitedError`, `BadRequestError`, `ServiceUnavailableError`,
  nestjs-pino logging with redaction and `createLogger()`.
- `./http` — RFC 9457 `ProblemDetailsFilter` (`urn:ais-its:problem:<slug>`), validation pipe,
  OpenAPI helpers, Fastify adapter.
- `./db` — `DatabaseModule` (pg pool with `search_path`, statement timeout, drizzle,
  `@InjectPool()` / `@InjectDb()`, readiness), `withTransaction()`, injection-safe PostGIS helpers,
  the forward-only SQL migrator (advisory lock, SHA-256 checksums, `-- aisits:no-transaction`),
  migrate-on-boot and `runMigrationsCli()`.
- `./nats` — `NatsModule` (reconnecting connection, drain, idempotent stream ensure),
  `EventPublisher`, the `@EventHandler` durable consumer framework (ack / nak with backoff / term /
  DLQ, heartbeats, per-subject ordering), `@OrderedEventHandler` and `OrderedConsumers` with
  `last_per_subject` snapshots and `caughtUp()`, `StreamReplayer`, event metrics.
- `./redis` — `RedisModule`, `@InjectRedis()`, `FixedWindowRateLimiter`,
  `SlidingWindowRateLimiter` (atomic Lua scripts).
- `./auth` — global default-deny `AuthGuard`, EdDSA access tokens (remote JWKS cache),
  API key introspection with positive/negative caches, `@Public()`, `@RequirePermissions()`,
  `@AllowApiKey()`, `@Internal()`, `@CurrentPrincipal()`, `UserPrincipal` / `ApiKeyPrincipal`,
  `assertOrgAccess()`, `verifyAccessToken()`.
- `./audit`, `./health`, `./metrics` (prefix `aisits_`), `./telemetry` (OTLP/HTTP, W3C trace
  context), `./internal-http` (`InternalHttpClient`).
- `./analytics` — the Detector SDK (spec §18): `Detector`, `@RegisterDetector()`,
  `DetectorRegistry` (`DETECTORS`, `<ID>_*` zod config, isolation, `aisits_detector_*`),
  `DetectorRunnerModule`, `VesselStateStore` (+ Valkey mirror), `TrackBuffer`, `PairSearch`,
  `ZoneIndex` (geodesic distances matching PostGIS `geography`, or Turf.js in the `sphere` model),
  `FleetDirectory`, `AlertEmitter`, `DetectorTestHarness`, geodesy helpers.
- `./testing` — `startTestInfra()`, `provisionServiceSchema()`, `createTestJwtIssuer()`, fake API
  key introspection, `buildTestApp()`, `createTestConfig()`, `makeTestEnvelope()`, `waitFor()`.
