# Changelog — `@darmawanweb/ais-its-nest`

All notable changes to this package are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-21

Fixes of the 0.1.0 review (correctness, security and developer experience) and the shared
building blocks services were about to re-implement. Depends on
`@darmawanweb/ais-its-contracts` `^0.3.0`. Contains breaking changes (0.x minor); see _Migration_.

### Fixed

- **Durable consumers** — every received message is heartbeated (`working()` every
  `ackWaitMs / 3`) from its arrival until it is settled and the client buffer is bounded by
  `maxAckPending`: buffered or waiting messages are no longer redelivered while the original is
  still queued (duplicate handler runs, broken per-subject order).
- **Durable consumers** — the consume status is watched: a deleted or missing consumer or stream is
  recreated and consumption resumes (`aisits_events_consumer_recoveries_total`); a stalled or
  unrecoverable consumer turns readiness `nats` down instead of failing silently forever.
- **Stream ownership (spec §7.2)** — consumers never create-or-update the streams they read: a
  missing stream is created, an existing one is never changed. Producers
  (`NatsModule.forRoot({ streams })`) only **widen** a stream (subjects, retention, per-subject
  limit, dedup window); narrowing drift is logged, never applied (no purge, no undoing a newer
  producer's definition).
- **JWT verification** — the remote JWKS is stale-if-error (cached keys keep verifying for up to
  `maxStaleMs`, default 1 h, while auth is unreachable; background refresh; one refetch per
  cooldown for unknown `kid`s; no redirects), and every key-fetch failure (5xx, non-JSON, 3xx,
  network) answers `503 SERVICE_UNAVAILABLE` with `Retry-After`, never `401`.
- **AuthGuard** — handler-level `@RequirePermissions()` / `@AllowApiKey()` win over a
  controller-level `@Public()`; a controller-level `@AllowApiKey()` no longer opens methods with
  their own `@RequirePermissions()` to API keys; non-HTTP handlers are denied unless `@Public()`.
- **Client IP** — `X-Forwarded-For` is trusted only from `TRUSTED_PROXIES` (default loopback and
  private networks) instead of from every hop.
- **Rate limiting** — `guardAttempt(limiter, key, check)` reserves a unit atomically before an
  expensive check and refunds it on success (`refund()` on both limiters); the documented
  peek-then-consume login pattern (check-then-act) is replaced.
- **PostGIS** — `geographyIntersectsBBox` compares in lon/lat geometry space (box edges are
  parallels and meridians), fixing wrong results for wide boxes.
- **InternalHttpClient** — redirects are never followed (the internal token and the body stayed
  attached to the redirect target); a 3xx is an `InternalHttpError`.
- **Migrator** — a pending migration numbered below the newest applied one fails with
  `MigrationOrderError` unless `allowOutOfOrder` is set.
- **Test helpers** — a container is stopped even when its readiness wait fails; `buildTestApp()`
  closes the app when `init()` fails; RustFS is awaited until its S3 API answers;
  `createTestConfig()` keeps the schema's own `SERVICE_NAME` default (`TEST_SERVICE_NAME` only
  when the schema has none).
- **AlertEmitter** — every operation of a `dedupKey` (raise, resolve, publication retry) is
  serialized: concurrent raises of one pair open one occurrence, a resolve issued during a raise
  is applied, and `DetectorContext.alerts.resolve()` checks ownership in turn with the raise.
- **Detector isolation** — a timed-out call gets its `call.signal` aborted and the detector's next
  calls for the same vessel are skipped until it settles (`aisits_detector_skipped_total`): calls
  for one vessel never overlap.
- **DetectorContext.alerts** is scoped to the calling detector (`open`, `get`, `isOpen`, `resolve`).
- **Horizontal scaling** — the detector position consumer is exclusive by default (single active
  instance, NATS priority group `pinned_client`; replicas are standbys); `DETECTORS` subsets use
  their own durables.
- **PairSearch** uses event time (newest indexed position) for neighbour windows and pruning, so a
  backlog after an outage still finds its pairs.
- **VesselStateStore** — the Valkey mirror is namespaced per service
  (`aisits:<SERVICE_NAME>:vessel-state:`) and mirrored states only seed the store: the backlog of
  a restarted service reaches its detectors.
- **ZoneIndex / CompiledGeometry** — containment follows geodesic polygon edges (long edges are
  densified), agreeing with `distance()` and with PostGIS `geography`.
- **DetectorTestHarness** — positions without `time` are spaced by `stepMs` (default 10 s).
- README: the minimal service shows every file (event repository, migration, both tsconfigs),
  the install commands include TypeScript, `@types/node` and `vitest@^4.1`, and the `pg` /
  `ioredis` types come from the kit, so it compiles under pnpm's strict layout.
- Readiness turning `503`, consumer draining and shutdown completion are logged.
- Published source maps resolve: `src/` (without specs) ships with the package.

### Added

- `./http` — spec §5 list conventions: `PageQueryDto`, `CursorQueryDto`, `TimeRangeQueryDto`,
  `BBoxQueryDto`, `@IsBBox()`, `paginate()`, `pageOffsetOf()`, `cursorPage()`,
  `decodeQueryCursor()`, `resolveQueryTimeRange()`, `bboxOf()`, `PageMetaDto`,
  `CursorPageInfoDto`, `@ApiPageResponse()`, `@ApiCursorResponse()`; `serializeOpenApiDocument()`.
- `./db` — `withIdempotency()` (inbox table `processed_events`, `processedEventsTableSql()`,
  `pruneProcessedEvents()`), `quoteTableName()`, `distanceM()` / `withinM()`, and the re-exported
  `pg` types `Pool`, `PoolClient`, `QueryResult`, `QueryResultRow`.
- `./nats` — the transactional outbox (`OutboxModule`, `OutboxRelay`, `enqueueEvent()`,
  `outboxTableSql()`), `@CoreSubscriptionHandler()` for contracts `CORE_SUBSCRIPTIONS` (queue
  group, bounded concurrency, `aisits_core_*` metrics, drain), exclusive durable consumers
  (`exclusive` option), `NATS_DURABLE_PREFIX`, typed `@OrderedEventHandler()` envelopes, the `Msg`
  type.
- `./redis` — `guardAttempt()`, `refund()`, re-exported `Redis` / `RedisOptions` types.
- `.` — `exportOpenApi({ configSchema, env?, check? })` with `documentationConfig()` (placeholders
  for runtime-only variables) and `OpenApiDriftError`; `TRUSTED_PROXIES` and
  `NATS_DURABLE_PREFIX` in the base schema.
- `./analytics` — `DetectorRunnerModule.forRootAsync()`, `DETECTOR_ENV`, `DetectorDescriptionDto`,
  `@ApiDetectorsResponse()`, `Detector.alertTypes` (validated at registration and on raise),
  methodology catalog warnings for unknown method ids, `AlertResolveOptions`,
  `DetectorTestHarness.metricsText()`, `haversineM()` / `vincentyM()`.
- `./telemetry` — `SUPPORTED_INSTRUMENTATIONS`, `enabledInstrumentations()`.
- `./testing` — `testInfraGlobalSetup()`, `testInfra()`, `uniqueName()` (one container set per
  vitest run), `reapOrphanedTestContainers()` and `TEST_CONTAINER_LABELS` (containers of crashed
  runs are removed when Ryuk is disabled), `TEST_SERVICE_NAME`.
- `./internal` — runner plumbing for the kit's own tests (no semver guarantees).
- `etc/api-report.json` and `pnpm api:report`; `pnpm check:package` fails on unreviewed API changes.
- `pnpm check:readme` (CI): the README's minimal service is rebuilt from the README itself (every
  file block, the documented `pnpm add` commands against the packed tarballs), then type-checked,
  built, its OpenAPI exported and its unit and integration tests run.

### Changed

- **BREAKING** Runner plumbing moved from `./nats` to `./internal`: `DurableConsumerRunner`,
  `NatsConsumerRuntime`, `ConsumerRuntime`, `readDelivery`, `eventContextOf`, `decideFailure`,
  `retryDelayMs`, `ensureDurableConsumer`, `consumerDrift`, `durableConsumerConfig`,
  `orderedConsumerOptions`, `serverMaxDeliver`, `durableHandlerSettings`, `withDurableName`,
  `getEventHandlerMetadata`, `EVENT_HANDLER_METADATA`, `headerValue`, `OrderedConsumerRunner`,
  `orderedSpecOf`, `streamDrift`, `streamConfig`, `streamUpdateConfig`, `planStreamUpdate`.
- **BREAKING** `OrderedConsumerRef` is a contracts `ORDERED_CONSUMERS` key (typos no longer
  compile) or a definition.
- **BREAKING** `startTelemetry` instruments exactly `http`, `undici`, `pg` and `ioredis` (plus
  Fastify): the kit no longer depends on `@opentelemetry/auto-instrumentations-node` (77 packages,
  about 40 MB per image); `instrumentations` takes `InstrumentationName`s.
- **BREAKING** `exportOpenApi()` no longer calls `app.close()`: providers' shutdown hooks do not run
  during a documentation build.
- `AuditModule` is global. `StreamManager.ensure(names, role?)` takes the ensure role.

### Deprecated

- `EventPublisher.publish(subject, type, data)` — use `publishEvent(type, data)` (the subject is
  derived; an explicit subject must match). `haversineMeters`, `vincentyMeters`, `distanceMeters`,
  `withinMeters` — use the `…M` names (spec §5).

### Migration

- Import runner internals from `@darmawanweb/ais-its-nest/internal` (better: stop using them).
- Replace `publish(subjects.x(...), type, data)` by `publishEvent(type, data)`.
- Login-style throttles: replace `peek` + `consume` by `guardAttempt()`.
- Detector services: add `alertTypes` to detectors and scale with `DETECTORS` subsets (one active
  instance per subset); where several writers may exist, enforce one open occurrence per
  `dedup_key` in the database (see the README, _Alerts_).
- `pnpm openapi`: pass `configSchema` instead of `config: loadConfig(configSchema)`; run
  `node dist/openapi.js --check` in CI.

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
