# Changelog — `@darmawanweb/ais-its-nest`

All notable changes to this package are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Follow-ups reported by the services during their 0.2.0 upgrades (K1–K7 of the kit patch). Every
change is backward compatible at the source level (new options, new exports, additive union
members); the behaviour changes are listed under _Changed_ and step by step in
[UPGRADING.md](UPGRADING.md#upgrading-from-030-to-the-next-release). Needs the contracts release
of the same patch (optional `labels` of `audit.recorded.v1`).

### Added

- **Exclusive consumers give their pin up when the server may have moved it (K1, K2).**
  `pinContactTimeoutMs(pinnedTtlMs?)` (`./nats`; `pinContactTimeoutMsFor(settings)` and
  `idleHeartbeatMsFor(settings)` in `./internal`): `max(2 × heartbeat, pinnedTtlMs − expiry −
heartbeat)`, half the TTL from 3 to 90 s (15 s at the default 30 s). An active instance without
  confirmed contact with the server for that long (cut off from NATS) deactivates with the new
  reason `contact_lost` and subscribes afresh, so it is active again only through a new pin; a
  process that did not run for that long (`SIGSTOP`, a blocked event loop; monotonic clock checked
  before every dispatch, on every server contact, by a watchdog and when `state` is read)
  deactivates with `paused`, returns what it buffered and asks the server whether it still pins
  it before activating again (activation hooks first, `previous === pinId` for the same pin).
  `ExclusiveConsumerTransition` gains `'contact_lost' | 'paused'`; `ConsumeOutcome` gains
  `'returned'` (`aisits_events_consumed_total{outcome="returned"}`: not dispatched because this
  instance was not the confirmed active one, `nak` after `RETURNED_MESSAGE_DELAY_MS` = 1 s,
  dead-lettered on the last delivery); `DurableConsumerRunnerOptions.onStateChange` (synchronous,
  before any hook) and `clock` (tests).
- **Detector SDK: resolutions a crash would lose (K6).** Optional `AlertPersistence.loadUnannounced()`
  and `onResolutionPublished({ dedupKey, alertId, eventId })` (`UnannouncedResolution`,
  `PublishedResolution`); `AlertEmitter.restoreUnannounced(resolutions, { filter })`
  (`AlertRestoreUnannouncedOptions`), `DetectorEngine.restoreUnannounced(load)`,
  `DetectorActivationOptions.loadUnannounced`, `DetectorActivation.unannounced`. The runner queues
  the resolutions recorded with an event id but never confirmed published on every activation (at
  startup without an exclusive consumer), with their event id, after the rest of their cooldown.
- **Bounded NATS drain (K3).** `NatsModuleOptions.connectionDrainTimeoutMs` (default
  `DEFAULT_CONNECTION_DRAIN_TIMEOUT_MS` = 5 s), also bounded by what is left of
  `SHUTDOWN_TIMEOUT_MS` less 1 s.
- `withTransaction(…, { onRetry })` with `TransactionRetry` (`retry`, `retries`, `sqlState`,
  `delayMs`, `error`), called for every re-run after the rollback (K7).
- `AuditEntry.labels` (contracts `AuditLabels`): names known when the record is written, sent as
  `audit.recorded.v1` `labels`, each cut to `AUDIT_LABEL_MAX_LENGTH` (K5).
- `./http`: `PLATFORM_ADMIN_WITHOUT_API_KEYS_DESCRIPTION`, `platformAdminDescriptionOf(operation)`,
  `API_KEY_SCOPES_EXTENSION` (`x-api-key-scopes`) (K4).

### Changed

- **Exclusive consumers**: a message of an exclusive consumer is dispatched only while this
  instance is the confirmed active one for its pin, in the period it arrived in; otherwise it is
  returned (above). Reading `DurableConsumerRunner.state` (and `EventConsumers.state()`) first
  checks for a pause. The startup log line names the bound (`pin given up after … ms without
server contact`).
- **Detector SDK**: ticks stop as soon as the position consumer leaves the active role (the
  registry is set inactive from `onStateChange`, before `onDeactivated` waits for the handlers of
  the ended period), each tick re-checks the role (a stale role after a pause never ticks), and an
  activation that finished after the role was given up leaves the instance inactive. The
  deactivation log names the reason (`contact_lost`, `paused`).
- **OpenAPI (K4)**: the sentence added to `@RequirePlatformAdmin()` operations matches the guards:
  routes without `@AllowApiKey` say that API keys get `401 INVALID_API_KEY`
  (`PLATFORM_ADMIN_WITHOUT_API_KEYS_DESCRIPTION`); routes with it keep `PLATFORM_ADMIN_DESCRIPTION`.
  An operation whose own description already names `PLATFORM_ADMIN_REQUIRED` keeps its wording.
  Services regenerate `openapi.json`.
- **NATS shutdown (K3)**: `NatsClient.onApplicationShutdown` closes the connection with the warning
  `NATS drain did not finish within … ms (server not answering)` when the drain does not finish in
  time, instead of waiting for the `SHUTDOWN_TIMEOUT_MS` forced exit; a normal drain is unchanged.

### Fixed

- An exclusive-consumer instance cut off from NATS stayed active (and ticked) while the server
  pinned another instance after the TTL (K1, reported by surveillance).
- Messages buffered across a pause longer than the pinned TTL were dispatched afterwards under the
  old `Nats-Pin-Id` on stale state (duplicate `alert.resolved.v1`, K2, reported by surveillance).
- `SIGTERM` against a NATS server that accepts the connection but never answers ended with the
  forced exit (exit 1) instead of a clean stop (K3, reported by fleet).
- The platform-admin OpenAPI sentence claimed `403` for API keys on routes that answer `401
INVALID_API_KEY` first (K4, reported by fleet).

## [0.3.0] - 2026-11-22

Hardening from the reports of the nine services built on 0.2.0 (the `LOCAL WORKAROUND`s they
carry become removable): a per-key transactional outbox, message size limits, hot-standby
failover that keeps its pin and state, published alert resolutions, database error hygiene, path
parameter and validation helpers, and a lighter production install. Depends on
`@darmawanweb/ais-its-contracts` `^0.4.0`. Every change is backward compatible at the source
level (new options, new exports, additive fields, bug-fix defaults); the behaviour changes a
service must know are listed under _Changed_ and step by step in [UPGRADING.md](UPGRADING.md).

### Added

#### NATS (`./nats`)

- **Per-key outbox relay.** `outboxTableSql()` creates `seq` (identity, insertion order) and
  `next_attempt_at` with partial indexes; `outboxUpgradeSql()` is the idempotent DDL that upgrades
  a 0.2 table (backfills `seq` in the 0.2 order). On such tables every replica relays: rows of
  one `entity_key` in order, up to `publishConcurrency` (64) keys at once, one `UPDATE` per pass; a
  failed row backs off on its own (`retry: { baseMs, maxMs }`, equal jitter) and only its key
  waits. New options `mode` (`'per-key' | 'serial'`, detected from the table), `publishConcurrency`,
  `retry`, `maxAttempts`; `OutboxModule.forRootAsync({ useFactory, inject, imports })`;
  `OutboxConfigError`; `OutboxRelay.mode()`; `OutboxRelayResult.retrying`, `deferred`, `mode`;
  gauges `aisits_outbox_retrying_rows` and `aisits_outbox_failed_rows`; `DEFAULT_OUTBOX_RETRY_*`.
  0.2 tables keep the serial relay with a startup warning, and old and new relays never publish
  at the same time during a rolling upgrade (exclusive versus shared advisory lock).
- **Message size.** `NatsClient.maxPayloadBytes()`; `EventTooLargeError` (`type`, `sizeBytes`,
  `maxBytes`) thrown by the publisher **before** sending a message above the server's
  `max_payload` (`aisits_events_published_total{outcome="rejected"}`);
  `eventMessageSize(type, data, options?)` and `DEFAULT_HEADER_ALLOWANCE_BYTES`;
  `enqueueEvent(..., { maxBytes })` refuses a row before the `INSERT`;
  `NatsModuleOptions.minMaxPayloadBytes` (default `DEFAULT_MIN_MAX_PAYLOAD_BYTES` = 4 MiB) logs a
  warning at connect for a smaller server.
- **Streams.** `StreamManager.ensure(names, role, { refresh: true })`, `invalidate(names)` and
  `roleOf(name)` (`StreamEnsureOptions`).
- **Exclusive consumers.** `ExclusiveConsumerListener` (`onConsumerActivated`,
  `onConsumerDeactivated` on `@EventHandler` providers, with `ExclusiveConsumerEvent` and
  `ExclusiveConsumerTransition`); dispatch waits for the activation hook.
  `ConsumerState` (`starting | active | standby | shared`), `EventConsumers.state(name)`,
  `ConsumerHealth.state`; `aisits_events_consumer_activations_total{consumer}`.
- `DeadLetterError`: a handler error that copies the message to the DLQ on any delivery, then acks.
- `ReplayReport.completed` and `endedBy` (`ReplayEnd`: `'empty'`, `'end_of_stream'`, `'to'`,
  `'aborted'`, `'closed'`).
- Core subscriptions follow the contracts `delivery` (`'fanout'`: no queue group; an explicit
  `queue` still wins) and validate payloads against `CORE_SUBSCRIPTION_PAYLOADS`: the parsed
  payload is the handler's second argument (`CoreMessageHandler`, `CorePayloadSchema`), invalid
  messages are dropped as `aisits_core_messages_total{outcome="invalid"}`.

#### Database (`./db`)

- `sanitizeError`, `databaseErrorInfo`, `SanitizedDatabaseError`, `DatabaseErrorInfo`: database
  errors without bound parameters, `detail`, `where` and internal queries, through
  `DrizzleQueryError` and cause chains.
- `sqlStateOf(error)`, `isUniqueViolation(error, constraint?)`, `PG_SQLSTATES` (`UNIQUE_VIOLATION`,
  `FOREIGN_KEY_VIOLATION`, `NOT_NULL_VIOLATION`, `CHECK_VIOLATION`, `SERIALIZATION_FAILURE`,
  `DEADLOCK_DETECTED`, `LOCK_NOT_AVAILABLE` = `55P03`, `QUERY_CANCELED`) and `PgSqlState`.
- `TransactionOptions.retryDelayMs` (number or `(retry) => ms`, default 10–50 ms, client released
  while waiting).
- `rowDate(value)` / `rowDateOrNull(value)` for `db.execute(sql…)` rows, whose timestamps are
  strings.
- `refreshContinuousAggregate(pool, view, from, to, options?)`: a refresh on a dedicated client
  that retries TimescaleDB's `55P03` on overlapping refreshes (`retries` = `DEFAULT_REFRESH_RETRIES`
  5, `retryDelayMs`, `statementTimeoutMs`, `onRetry`).
- `MigrationsDirectoryNotFoundError` (`directory`, `cwd`) instead of an empty migration set when
  the migrations directory does not exist.

#### HTTP (`./http`) and root

- `MAX_PAGE` = 1 000 000 (`PageQueryDto.page` maximum, also in OpenAPI).
- Path parameters that read the raw segment and document it: `@UuidParam(name = 'id')`,
  `@IntParam(name, { min, max })`, `@MmsiParam(name = 'mmsi')`, the parsers `parseUuidParam`,
  `parseIntParam`, `parseMmsiParam` (`400 VALIDATION_FAILED` with field errors), `PathParamOptions`,
  `IntParamOptions`.
- `@IsOptionalNotNull()`: optional, but `null` is rejected (PATCH of `NOT NULL` columns).
- `cors.exposedHeaders` of `bootstrapService`, `createPlatformApp` and `buildTestApp`;
  `DEFAULT_EXPOSED_HEADERS`, `exposedHeadersOf()`.
- `OpenApiOptions.securitySchemes`, `REFRESH_COOKIE_SECURITY_SCHEME` (cookie `aisits_rt`),
  `OpenApiSecurityError`, `assertSecuritySchemesDeclared()`.
- `clientIp(request)`: the normalized client address for storage and throttle keys.
- `addPlatformAdminDescriptions`, `PLATFORM_ADMIN_ROLES_EXTENSION` (`x-required-roles`),
  `PLATFORM_ADMIN_DESCRIPTION`.
- Root: `trustedProxiesWarning()` (logged by `bootstrapService` in production when the default
  `TRUSTED_PROXIES` are trusted), `SENSITIVE_ERROR_FIELDS`, `resolvePinoPretty()`.

#### Auth, audit, metrics

- `@RequirePlatformAdmin()` (`PLATFORM_ADMIN_KEY`): `403 PLATFORM_ADMIN_REQUIRED` for everyone but
  platform administrators, API keys always refused, `x-required-roles: ['super_admin']` in
  OpenAPI.
- `AuditService.enqueue(client, entry, principal?, request?, { table? })`: an audit record in the
  caller's transaction through the outbox (`AuditEnqueueOptions`).
- `./metrics` re-exports the prom-client types `Counter`, `Gauge`, `Histogram`, `Registry`,
  `Summary`.

#### Detector SDK (`./analytics`)

- **Published resolutions**: `alert.resolved.v1` on the raise's subject
  (`AlertEmitterOptions.publishResolution`, `AlertResolutionPublisher`,
  `DetectorRunnerOptions.publishResolutions` default `true`), at once or when the alert cooldown
  since the last raise ends, cancelled by a re-raise within it; `AlertResolution.eventId`;
  `AlertResolveOptions.publish`, `domain`, `methodId`; `AlertEmitter.flush()`,
  `pendingResolutionCount`; `aisits_detector_alert_resolutions_total{detector}`.
- **Activation**: `Detector.onActivated` / `onDeactivated`, `DetectorContext.isActive()`,
  `DetectorEngine.activate()` / `deactivate()` / `active` (`DetectorActivation`,
  `DetectorActivationOptions`), `DetectorRegistry.active`, `setActive`, `settled`, `owns`,
  `dispatchActivated`, `dispatchDeactivated`; `ActivationOutcome` and
  `aisits_detector_activations_total{outcome}`.
- `AlertEmitter.replaceOpen(alerts, { filter })` (`AlertReplaceOptions`, `AlertReplaceResult`),
  `forget(dedupKey, { accept })` (`AlertForgetOptions`), `withKey(dedupKey, fn)` (re-entrant);
  `DetectorAlerts.forget(dedupKey)`.
- Event times: `OpenAlert.firstOccurredAt` / `lastOccurredAt` (and `domain`, `methodId`),
  `AlertUpdate.occurredAt`, `AlertPersistence.onRepeated(alert, occurredAt)` throttled by
  `alertRepeatedIntervalMs` (`DEFAULT_ALERT_REPEATED_INTERVAL_MS` 60 s); `DEFAULT_ALERT_COOLDOWN_MS`.
- `DetectorTestHarness`: `resolvedEvents`, `activate()`, `deactivate()`, `active`, `maintain()`,
  options `alertRepeatedIntervalMs` and `publishResolutions`; `AlertEmitter.retryPending()`
  returns `AlertPublicationResult`.

#### Testing (`./testing`)

- `startTestInfra` / `testInfraGlobalSetup` accept `nats: { mqtt?, maxPayload? }` (`TestNatsOptions`),
  `TestNats.mqttUrl`, `testNatsConfig()`, `DEFAULT_TEST_NATS_MAX_PAYLOAD` (`'4MB'`).
- Payload builders `makeTestZone`, `makeTestVesselSnapshot` (also still in `./analytics`),
  `makeTestAlertRaised`, `makeTestAlertResolved(overrides?, fromRaise?)`, `TestZoneInput`.
- `./internal` (no semver guarantees): `pullExpiresMsFor`, `orderingWarning`,
  `DurableConsumerRunnerOptions`, `ConsumerState`, `coreSubscriptionQueue`,
  `contractsCorePayloadSchema`, `checkCorePayload`, the message-size and outbox planning helpers,
  `isNoStreamError`.

### Changed

- **Production install.** `testcontainers`, `@nestjs/testing` and `pino-pretty` are no longer
  (optional) peer dependencies: `./testing` needs `testcontainers` and `@nestjs/testing` as the
  service's **devDependencies**, pretty logs need `pino-pretty` there (resolved from the service's
  `package.json` first). Tracing no longer uses `@opentelemetry/sdk-node`: it is built from
  `@opentelemetry/sdk-trace`, `@opentelemetry/context-async-hooks` and `@opentelemetry/core`
  3.1.1, exports traces only (OTLP/HTTP; NodeSDK's default OTLP metrics exporter, `b3` and
  `OTEL_NODE_RESOURCE_DETECTORS` are gone) and honours `OTEL_SDK_DISABLED`, the sampler,
  propagator, batch processor, span limit and resource variables. A minimal service's
  `pnpm install --prod` shrinks from 213 MB (324 packages, with `dockerode`, `ssh2`, `@grpc/grpc-js`,
  `protobufjs` and `sdk-node`) to 165 MB (183 packages, none of them): about 20 MB of the
  NodeSDK/gRPC tree and the testcontainers tree (35–40 MB in services without a peer-stripping
  hook; ais-pipeline measured 524 → 484 MB for it alone). `pnpm check:package` asserts it
  (`scripts/prod-install-smoke.mjs`).
- **Exclusive consumers** pull with `expires = min(30 s, max(1 s, pinnedTtlMs / 3))` and idle
  heartbeats at half of it, so an idle pinned instance keeps its pin; an unpinned instance goes
  standby and re-subscribes after 2 s; `stop()` releases the pin (only while this instance holds
  it), so a standby takes over at once. `pinnedTtlMs` below 3 s logs a warning.
- **Detector failover.** With the default exclusive consumer an instance starts inactive; its
  activation (first position after the pin) reloads `loadOpen()` with replace semantics, re-seeds
  vessel states from the mirror and runs `onActivated` before that position is dispatched.
  **Ticks run only on the active instance**; `DetectorEngine.tick()` and the harness's `tick()`
  do nothing while inactive. Rolling updates of several replicas are safe.
- **Resolutions are published by default** (`publishResolutions: false` to opt out); roll out
  notification (which handles `alert.resolved.v1`) first.
- `{ useClass: X }` persistence of `DetectorRunnerModule` provides `X` and `ALERT_PERSISTENCE` as one
  instance (`useExisting`), so `app.get(X)` works.
- Core subscriptions: the default queue group follows the contracts definition's `delivery`.
- CORS exposes `ETag` and `Location` in addition to `X-Request-Id`, `Retry-After` and
  `WWW-Authenticate`.
- `application/json` requests with an **empty body** parse to `undefined` (bodiless `POST`s with
  the header no longer answer `400 FST_ERR_CTP_EMPTY_JSON_BODY`); prototype-poisoning protection and
  the body limit are unchanged.
- `PageQueryDto.page` is at most `MAX_PAGE`; `pageOffsetOf` throws `RangeError` for unsafe values.
- `buildOpenApiDocument` (and `exportOpenApi`) fails with `OpenApiSecurityError` for an undeclared
  security scheme reference or a redefined `bearer`, `apiKey` or `internalToken`.
- Problem details of a database error outside production carry the driver's primary message
  only; logs, the DLQ `Ais-Its-Dlq-Error` header and `outbox.last_error` are sanitized;
  `REDACT_PATHS` adds `err.params` and `err.detail`.
- `AuditService.buildRecord` (and so `record()`) normalizes the request ip with `clientIp`.
- The test NATS server runs from a generated configuration with `max_payload` 4 MB (was the
  server default of 1 MB); pass `nats: { maxPayload: '1MB' }` for the old limit.
- Outbox rows that can never be published (invalid payload, subject mismatch, above
  `max_payload`, `maxAttempts`) are parked in both modes; `OutboxRelay.onApplicationBootstrap()` is
  async; `OutboxRelayResult.rejected` counts every parked row.
- Constructors that Nest injects gained optional parameters: `EventPublisher` (a `StreamManager`),
  `DetectorRunner` (the `ALERT_PERSISTENCE` hook), `DurableConsumerRunner` (`./internal`,
  activation hooks).
- `MigrationFileError.name` is typed `string` (subclasses).

### Fixed

- Bound parameters of failed queries (e.g. password hashes, e-mail addresses) no longer reach
  logs, problem details, DLQ headers or `outbox.last_error` (`DrizzleQueryError` carried them in
  its message and enumerable `params`).
- `withTransaction` retried a bare `40001` / `40P01` but a drizzle-wrapped one only once; it now
  detects SQLSTATEs through the cause chain.
- `page=99999999999999999999` passed validation and produced `OFFSET 2e21`.
- A stream deleted at runtime was never created again: the `StreamManager` memo now refreshes on
  consumer recovery, dead-lettering and a failed publish to a produced stream (which retries once),
  and `EventPublisher` really receives its `StreamManager` (it lacked an explicit `@Inject`).
- An idle single exclusive instance was unpinned by the server (pull expiry equal to the pinned
  TTL) and its next message waited up to a TTL; an unpinned instance never pulled again; a stopped
  instance kept the pin for the full TTL.
- A message whose activation hook still failed on its last delivery was lost silently; it is
  dead-lettered.
- A replay whose connection closed rejected with `ClosedConnectionError`; it ends as `'closed'`.
- A standby that took over kept the open-alert state it loaded at boot (re-raising or missing
  occurrences the previous instance changed), and detector ticks ran on every replica.
- `OpenAlert.lastSeenAt` / `openedAt` used the emitter clock where services needed event times
  (`firstOccurredAt`, `lastOccurredAt`, `onRepeated`).
- One failing outbox row blocked every entity key behind it (per-key mode).

### Removed

- Dependency `@opentelemetry/sdk-node` (replaced by `@opentelemetry/sdk-trace`,
  `@opentelemetry/context-async-hooks` and `@opentelemetry/core`).
- `peerDependencies` / `peerDependenciesMeta` entries `testcontainers`, `@nestjs/testing` and
  `pino-pretty`.

### Migration

Step by step, with the local workarounds each service can delete:
[UPGRADING.md](UPGRADING.md). In short:

1. Publish order: contracts 0.4.0 → kit 0.3.0 → template → services, and **notification before
   safety and surveillance** (old notification instances ack-skip `alert.resolved.v1`).
2. `pnpm add @darmawanweb/ais-its-contracts@^0.4.0 @darmawanweb/ais-its-nest@^0.3.0`, keep
   `testcontainers`, `@nestjs/testing` (and `pino-pretty`) as devDependencies, drop the kit entry of
   `.pnpmfile.cjs` and add the `@nestjs/terminus` gRPC peers to it.
3. Services with an outbox table of 0.2: add a migration with `outboxUpgradeSql()` (or keep the
   serial relay, with a startup warning).
4. Detector services: implement `loadOpen` (with `domain`, `methodId`, event times), optionally
   `onRepeated`; check `isActive()` in zone/vessel hooks that raise or resolve; pass
   `publish: false` for resolutions of occurrences another writer already ended.
5. Regenerate `openapi.json` (page maximum, path parameter schemas, security schemes,
   `x-required-roles`) and set `TRUSTED_PROXIES` to the gateway in production.

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
