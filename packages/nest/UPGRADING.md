# Upgrading services to `@darmawanweb/ais-its-nest` 0.3

- [Upgrading from 0.3.0 to the next release](#upgrading-from-030-to-the-next-release) (the kit
  patch K1–K9, unreleased)
- [Upgrading from 0.2 to 0.3.0](#upgrading-from-02-to-030)

## Upgrading from 0.3.0 to the next release

Additive and backward compatible; no rollout order. Bump both packages when they are released,
then per service:

1. **Every service with `@RequirePlatformAdmin()` routes** (auth, emission, fleet, geo):
   regenerate `openapi.json` — the generated sentence now matches the guards (`401
INVALID_API_KEY` for API keys on routes without `@AllowApiKey`). fleet: drop the counter-sentence
   of `POST /vessels/:id/republish` ("…the note below applies to API keys only on routes that
   accept them") and the README remark that the kit's sentence is wrong.
2. **Every service with exclusive consumers or the Detector SDK** (ais-pipeline, safety,
   surveillance, and every `exclusive` `@EventHandler`): `ExclusiveConsumerEvent.reason` may now
   also be `'contact_lost'` or `'paused'` — code that compares with `'stopped'` / `'unpinned'`
   keeps working, an exhaustive `switch` needs the two new cases. Dashboards may show
   `aisits_events_consumed_total{outcome="returned"}` (messages handed back, not failures).
   surveillance: replace the README _Platform issues_ (1) and (2) by the kit behaviour (an
   instance cut off from NATS gives its pin up within `pinContactTimeoutMs(pinnedTtlMs)`; messages
   buffered across a pause are returned and the activation reload runs before dispatch) and keep
   the `AlertKeyLock` alignment (it still covers a handler that was running when the process
   stopped). The `SIGSTOP` test in `test/ha.int.test.ts` can assert that the resumed instance
   handles none of its buffered positions and publishes no duplicate `alert.resolved.v1`.
3. **Optional — NATS drain** (fleet, every service): the drain at shutdown is bounded
   (`connectionDrainTimeoutMs`, default 5 s, and the `SHUTDOWN_TIMEOUT_MS` budget); fleet can drop
   the known limitation "Stop while NATS does not answer".
4. **Optional — transaction retries** (fleet): replace the logging in the `retryDelayMs` function
   of `src/db/database.ts` by `withTransaction(pool, fn, { retries, onRetry: ({ retry, retries,
sqlState }) => { logger.warn(…); counter.inc({ sqlstate: sqlState }); } })`.
5. **Audit labels** (`audit.recorded.v1` `labels`):
   - **auth** (consumer): in `AuditLogConsumer.onAuditRecorded`, take each name from
     `data.labels` when the member is present — `targetLabel` from any source for target types
     auth does not own (`OWN_TARGET_TYPES`), `actorName`, `actorEmail` and `orgName` (and
     `targetLabel` of its own target types) only when `event.source` is auth itself, as today —
     and resolve the missing ones with `AuditLogsRepository.labelsFor`; keep reading
     `meta.auditLabels` (`capturedLabelsOf`) for records written by auth 0.2.0 that are still in
     the outbox or the stream, and strip it from the stored `meta` as now. auth (producer): pass the
     captured names as `entry.labels` to `AuditService.enqueue` instead of `withCapturedLabels(meta,
…)`, and drop `withCapturedLabels` once no 0.2.0 replica writes records.
   - **producers** (fleet, geo, telemetry, notification, emission, safety, surveillance): pass
     `labels: { targetLabel }` with the name of the audited entity as it is in the transaction of
     the change (fleet: the vessel name, `Name (IMO …)`; geo: the zone name; telemetry: the device
     name; notification: the alert rule / channel name; emission: the scenario or measure name),
     e.g. `audit.enqueue(client, { action, targetType, targetId, meta, labels: { targetLabel:
vessel.name } }, principal, request)`. A record without `labels` is stored as before.
6. **Resolutions a crash would lose** (safety, surveillance; optional `AlertPersistence` hooks):
   - migration: `ALTER TABLE events ADD COLUMN IF NOT EXISTS resolution_event_id uuid, ADD COLUMN
IF NOT EXISTS resolution_announced_at timestamptz;` and a partial index `ON events
(resolved_at) WHERE resolution_event_id IS NOT NULL AND resolution_announced_at IS NULL`
     (recent rows only: the chunks are not compressed yet);
   - `onResolved(resolution)`: also store `resolution_event_id = resolution.eventId ?? NULL`;
   - the reopen path (`onUpdated` with `reopened: true`) also sets `resolution_event_id = NULL`;
   - `onResolutionPublished({ alertId, eventId })`: `UPDATE events SET resolution_announced_at =
now() WHERE alert_id = $1 AND resolution_event_id = $2`;
   - `loadUnannounced()`: the rows `WHERE resolved_at IS NOT NULL AND resolution_event_id IS NOT
NULL AND resolution_announced_at IS NULL AND resolved_at > now() - interval '1 day'`, mapped
     like `loadOpen` (with `publishedAt` = the last published raise) plus `resolvedAt`, `reason`,
     `data` and `eventId`;
   - README: remove the known limitation "A crash between a resolution and the end of its
     cooldown loses that `alert.resolved.v1`".
7. **Methodology catalog** (auth): add the `@method` tags of the 13 `security` methods (see the
   repository CHANGELOG) — one line each in the TSDoc of: `src/domain/password-hashing.ts`
   `ARGON2_PARAMETERS` (`@method security.password_hashing`), `src/domain/password-policy.ts`
   `checkPasswordPolicy` (`security.password_policy`),
   `src/modules/throttling/auth-throttle.service.ts` `THROTTLE_LIMITS` (`security.login_throttle`),
   `src/domain/refresh-rotation.ts` `decideRefresh` (`security.refresh_rotation`),
   `src/domain/secret-box.ts` `sealSecret` (`security.secret_encryption`),
   `src/domain/signing-key-rules.ts` `retirementGraceSeconds` (`security.signing_key_lifecycle`),
   `src/domain/totp.ts` `verifyTotp` (`security.totp`), `src/domain/access-rules.ts`
   `grantableScopes` (`security.api_key_scope_grant`),
   `src/modules/organizations/members.service.ts` `MembersService.invite`
   (`security.invitation_consent`), `src/common/principals.ts` `clientInfo` (`security.client_ip`),
   `src/domain/api-key-lifecycle.ts` `rotationGraceEnd` (`security.api_key_rotation`) and
   `src/modules/audit-logs/audit-log-csv.ts` `csvCell` (`security.csv_injection`); then
   `GET /api/v2/auth/methodology` lists them and the README _Methodology & references_ table links
   `docs/METHODOLOGY.md#security.*`. `pnpm references:verify` reports exactly these 12 missing tags
   until they are added.

## Upgrading from 0.2 to 0.3.0

From kit **0.2.x** with contracts **0.3.x** to kit **0.3.0** with contracts **0.4.0**. Every
change is backward compatible at the source level: a service compiles and runs after the version
bump, apart from the TypeScript narrowing described in step 2. The work is mostly **deleting the
local workarounds** the services carry for the problems they reported (search the service for
`LOCAL WORKAROUND`, `PLATFORM WORKAROUND` and `WORKAROUND`). What changed and why:
[CHANGELOG.md](CHANGELOG.md) (kit) and the repository [CHANGELOG](../../CHANGELOG.md) (contracts).

- [Rollout order](#rollout-order)
- [Step 1 — dependencies](#step-1--dependencies-every-service)
- [Step 2 — types that became exact](#step-2--types-that-became-exact)
- [Step 3 — behaviour to check](#step-3--behaviour-to-check-every-service)
- [Step 4 — per service](#step-4--per-service)
- [Step 5 — verify and document](#step-5--verify-and-document)
- [Workaround → kit API](#workaround--kit-api)

## Rollout order

1. contracts 0.4.0 → kit 0.3.0 → template → services.
2. **notification before safety and surveillance.** Kit 0.3.0 publishes `alert.resolved.v1` by
   default; a notification instance on contracts 0.3 acknowledges the unknown type and skips it
   (with a warning), so resolutions published before notification is upgraded never close inbox
   alerts. Upgrade and deploy notification (with its `alert.resolved.v1` handler) first.
3. The other services in any order. Mixed versions interoperate:
   - the notification fan-out keeps its subject and payload (`aisits.notification.realtime.v1`);
   - an outbox table upgraded with `outboxUpgradeSql()` still works for 0.2 replicas, and a 0.2
     serial relay (exclusive advisory lock) never publishes together with a 0.3 per-key relay
     (shared lock);
   - exclusive consumers of 0.2 and 0.3 share a durable; a 0.2 instance still keeps its pin for a
     TTL after it stops, a 0.3 instance releases it at once.

## Step 1 — dependencies (every service)

```bash
pnpm add @darmawanweb/ais-its-contracts@^0.4.0 @darmawanweb/ais-its-nest@^0.3.0
pnpm add -D testcontainers @nestjs/testing pino-pretty   # if not yet devDependencies
pnpm remove prom-client                                   # if only its types are used
```

- The kit no longer declares `testcontainers`, `@nestjs/testing` and `pino-pretty` (not even as
  optional peers). `./testing` imports the first two, so a service that uses `./testing` lists
  them as **devDependencies**; pretty logs (`LOG_PRETTY`) need `pino-pretty` as a devDependency.
- The kit no longer depends on `@opentelemetry/sdk-node` (tracing uses the trace SDK; about
  20 MB less per image). Nothing to change in `src/main.ts`.
- Metric types (`Counter`, `Gauge`, `Histogram`, `Summary`, `Registry`) come from the kit: `import type` them from `@darmawanweb/ais-its-nest/metrics`. A direct `prom-client` dependency is only needed for
  APIs the kit does not wrap.
- `.pnpmfile.cjs`: **remove** the `@darmawanweb/ais-its-nest` entry (it stripped the 0.2 optional
  peers; with 0.3 it is a no-op) and **add** `@nestjs/terminus` → `@grpc/grpc-js`,
  `@grpc/proto-loader`: terminus declares them as optional peers, testcontainers' `dockerode`
  brings them into the dev tree, and pnpm then links them into the production install (about
  11 MB with `protobufjs`). The template's hook:

  ```js
  const COMPILE_TIME_PEERS = {
    '@nestjs/swagger': ['typescript'],
    '@nestjs/terminus': ['@grpc/grpc-js', '@grpc/proto-loader'],
  };
  ```

- Check the image: `pnpm install --prod --frozen-lockfile` in a copy of the service (or the
  Docker build) must not contain `testcontainers`, `dockerode`, `ssh2`, `@nestjs/testing`,
  `pino-pretty`, `@grpc/grpc-js`, `protobufjs` or `@opentelemetry/sdk-node`
  (`ls node_modules/.pnpm | grep -E '^(testcontainers|dockerode|ssh2|@grpc|protobufjs|@opentelemetry\+sdk-node)'`).

## Step 2 — types that became exact

- **Consumer envelopes narrow.** Contracts `CONSUMERS` entries keep literal types, so
  `ConsumerEnvelope<'telemetry-fleet'>` is exactly the union of `fleet.vessel.upserted.v1` and `fleet.vessel.deleted.v1`. Delete runtime `event.type` checks and unreachable fallbacks that only
  existed because the type was the union of every event, and write exhaustive switches
  (`default: { const never: never = event; … }` compiles now). Consumers declared in a service
  with a `: DurableConsumerDefinition` annotation still widen: use contracts
  `defineDurableConsumer({...})`, `positionFeedConsumer(...)`, `fleetProjectionConsumer(...)` or
  `zoneProjectionConsumer(...)`.
- **`notification-alerts` delivers `alert.resolved.v1` too**, so `ConsumerEnvelope<'notification-alerts'>`
  is a union and notification must handle both (step 4).
- `AlertEmitter.retryPending()` returns `AlertPublicationResult` (three more fields): a test that
  asserts the old object with `toEqual` switches to `toMatchObject`.

## Step 3 — behaviour to check (every service)

| Change                                                                                                                               | What to do                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup warning when the NATS server's `max_payload` is below 4 MiB                                                                  | Compose and `infra/nats/nats.conf` set 4MB; set `max_payload: 4MB` on the Helm/external NATS (or `NatsModule.forRoot({ minMaxPayloadBytes })` to accept less deliberately) |
| The test NATS server runs with `max_payload` 4MB (was 1MB)                                                                           | tests that relied on 1 MB pass `nats: { maxPayload: '1MB' }` to `startTestInfra` / `testInfraGlobalSetup`                                                                  |
| Production warning while `TRUSTED_PROXIES` is the default (loopback and private networks)                                            | set `TRUSTED_PROXIES` to the gateway's address or CIDR in Helm/compose and document it in `.env.example`                                                                   |
| `PageQueryDto.page` ≤ 1 000 000; path parameter, security and `x-required-roles` documentation                                       | regenerate `openapi.json` (`pnpm openapi`); `buildOpenApiDocument` now throws `OpenApiSecurityError` for an undeclared security scheme reference                           |
| CORS exposes `ETag` and `Location` by default                                                                                        | remove manual `Access-Control-Expose-Headers` code; add own headers with `bootstrapService({ cors: { exposedHeaders } })`                                                  |
| `Content-Type: application/json` with an empty body parses to `undefined`                                                            | bodiless `POST`s (acks, republish) work; a DTO-validated route still answers `400 VALIDATION_FAILED`                                                                       |
| Database errors are sanitized in logs, DLQ headers, `outbox.last_error` and problem details                                          | drop local sanitizing wrappers (auth); log with `{ err: sanitizeError(e) }` where the service logs database errors itself                                                  |
| Tracing exports traces only (no OTLP metrics), honours `OTEL_SDK_DISABLED`, the sampler, propagator and batch variables              | nothing for the platform's collector setup; `b3` propagation and `OTEL_NODE_RESOURCE_DETECTORS` are not supported                                                          |
| Exclusive consumers pull with `expires = pinnedTtlMs / 3` (≤ 30 s), re-subscribe after an unpin and release the pin on graceful stop | longer `pinnedTtlMs` set only against idle unpinning can return to the 30 s default; rolling updates of several replicas are fine                                          |
| Detector services: an instance is inactive until pinned; ticks run only on the active instance; resolutions are published            | see the detector checklist below                                                                                                                                           |
| Outbox tables of 0.2 run in serial mode with a startup warning                                                                       | add the `outboxUpgradeSql()` migration (step 4) to get per-key relaying                                                                                                    |
| Core subscriptions: the default queue group follows the contracts definition (`delivery: 'fanout'` = every instance)                 | drop `queue: false` for `notification-realtime-fanout`                                                                                                                     |
| `@EventHandler` with `concurrency > 1` on a single literal subject and `orderBySubject: true` logs a warning                         | set `orderBySubject: false` when parallelism is intended (notification e-mail already does)                                                                                |

**Detector checklist (safety, surveillance, template detector variant).**

1. `AlertPersistence.loadOpen()` is now also the failover reload: return every open occurrence
   with `domain`, `methodId`, `detector` (when stored), `firstOccurredAt` and `lastOccurredAt`
   (event times). Without `loadOpen` a takeover may raise again what the previous instance raised
   (a warning is logged at bootstrap).
2. Use `update.occurredAt` (event time) in `onUpdated` rather than `update.at`; implement
   `onRepeated(alert, occurredAt)` if the table stores a last-seen time
   (`last_seen_at = GREATEST(last_seen_at, $occurredAt)`), throttled by `alertRepeatedIntervalMs`
   (default 60 s).
3. Move local "reset on failover" logic into `Detector.onActivated(context, call)`.
4. `onZoneChanged` / `onVesselChanged` run on every instance: check `context.isActive()` before
   raising or resolving there. Ticks and timers of the runner run only on the active instance;
   timers a detector runs itself check `context.isActive()`.
5. Resolutions publish `alert.resolved.v1` (after the alert cooldown since the last raise). An
   occurrence ended by another writer (`RESOLVED_ELSEWHERE`-style) is closed with
   `context.alerts.forget(key)` or `resolve(key, { publish: false })`, never published twice.
6. `persistence: { useClass: X }` now provides `X` itself (one instance): remove `X` from the
   module's `providers` and use `app.get(X)` in tests.
7. Deployment: two or more replicas with rolling updates are supported; drop "one replica,
   `Recreate`" guidance and resync gaps.
8. Tests that expect ticks without any position must publish a position first (activation
   happens on the first position after the pin) or use `exclusive: false`.

## Step 4 — per service

Each section lists the dependency changes, the code to change, the workaround files to delete
and the new behaviour to test. "Kit" means `@darmawanweb/ais-its-nest` 0.3.0, "contracts"
`@darmawanweb/ais-its-contracts` 0.4.0.

### auth

- **Dependencies:** bump both; `.pnpmfile.cjs` drops the `@darmawanweb/ais-its-nest` entry
  (testcontainers, `@nestjs/testing`) and gains the `@nestjs/terminus` gRPC peers; keep
  `@nestjs/swagger` → `typescript`. `src/common/metrics.ts` imports `Counter` / `Gauge` /
  `Histogram` from `@darmawanweb/ais-its-nest/metrics` (prom-client is an undeclared import today).
- **Delete:** `src/db/errors.ts` (`SanitizedDatabaseError`, `withoutQueryValues`) and its wrapping
  around writes in `src/modules/accounts/users.repository.ts` — the kit sanitizes logs, DLQ
  headers and problem details (keep an argon2 PHC scrub only if wanted: the kit keeps the
  driver's primary message). The local `isUniqueViolation` becomes the kit's
  (`@darmawanweb/ais-its-nest/db`). `src/domain/client-ip.ts` (`normalizeClientIp`) becomes the
  kit's `clientIp` (same case table) in sessions and throttles; audit ips are normalized by
  `AuditService`.
- **Change:** replace the `REFRESH_COOKIE_DESCRIPTION` workaround in
  `src/modules/authentication/auth.controller.ts` with
  `openapi: { securitySchemes: { refreshCookie: REFRESH_COOKIE_SECURITY_SCHEME } }` and
  `@ApiCookieAuth('refreshCookie')` on refresh and logout. The `auth-audit` consumer throws
  `DeadLetterError` for records that can never be stored (copied to `dlq.AUDIT.auth-audit` on the
  first delivery, then acked) instead of terminating or retrying them.
- **Optional:** write security-relevant audit records with `audit.enqueue(client, …)` inside the
  transaction (needs an outbox migration with `outboxTableSql()` and `OutboxModule`); use contracts
  `await hashApiKey(key)` in `src/domain/api-key-material.ts` (async, `TypeError` for a malformed
  key).
- **Docs:** `.env.example`/README: production `TRUSTED_PROXIES` = the gateway only. `@method`
  tags for `security.*` once the methodology owner catalogues them (not in 0.4.0).
- **Test:** `openapi.json` declares the cookie scheme and the page maximum; a unique violation
  answers `409` without the e-mail in logs; client ips in sessions are unchanged.

### fleet

- **Dependencies:** bump both; remove `prom-client` (kit metric types). No `.pnpmfile.cjs` kit
  entry exists; add the `@nestjs/terminus` gRPC peers.
- **Outbox:** replace the local `FleetOutboxRelay` (`src/modules/snapshots/outbox-relay.ts`,
  `outbox.repository.ts`, and the retry policy in `retry-backoff.ts` if only the relay uses it) with
  `OutboxModule.forRootAsync({ inject: [APP_CONFIG], useFactory })`. `fleet.outbox` already has
  `seq` (identity) and `next_attempt_at` (its `NOT NULL DEFAULT now()` fits the kit's due
  predicate), so it is detected as **per-key**. Keep `enqueueEvent` and `OutboxRelay.notify()`.
  Optionally add a migration with `outboxUpgradeSql('outbox')` for the kit's `outbox_retry_idx` and
  `outbox_failed_idx`; it also creates kit-named copies of fleet's pending `(seq)` and
  `(entity_key, seq)` indexes, so drop one of each pair.
- **Delete:** `ID_PIPE`, `MmsiParam` and `parseMmsiParam` (`src/modules/common/params.ts`) and
  `MMSI_PIPE` (`vessels.controller.ts`) → kit `@UuidParam()` / `@MmsiParam()`;
  `BoundedPageQueryDto` and the optional-not-null helper (`src/modules/common/validation.ts`) →
  kit `PageQueryDto` and `@IsOptionalNotNull()`; the `WORKAROUND` retry loop `inTransaction` in
  `src/db/database.ts` with its tests in `database.spec.ts` →
  `withTransaction(pool, (client) => work(drizzle({ client })), { retries })` (or drizzle's own
  transactions with `sqlStateOf`).
- **Change:** `POST /vessels/:id/republish` uses `@RequirePlatformAdmin()` instead of the in-handler
  `403 PLATFORM_ADMIN_REQUIRED` check (contracts now defines the code). `src/domain/fuel-formula.ts`
  becomes contracts `validateFuelFormula` / `parseFuelFormula` (limits, messages and positions are
  identical); keep the shared-corpus test as a regression test. Watch for the drizzle
  `.for('update', { of: table })` pitfall on `pgSchema` tables (README, Database).
- **Test:** path parameter errors are `400 VALIDATION_FAILED` with `field: 'id'`/`'mmsi'`; PATCH
  `{ field: null }` → 400; republish as a non-admin → `403 PLATFORM_ADMIN_REQUIRED`; a failing
  vessel's outbox rows no longer block other vessels; `openapi.json` shows `format: uuid`, the
  mmsi pattern and `x-required-roles`.
- The catalog `implementedBy` fixes (`samples.seed.ts`) are in the central catalog already.

### telemetry

- **Dependencies:** bump both; remove `prom-client`; add the `@nestjs/terminus` gRPC peers.
- **Change:** `src/consumers/fleet.consumer.ts` drops its `event.type` narrowing
  (`ConsumerEnvelope<'telemetry-fleet'>` is exact). `src/modules/devices/dto/update-device.dto.ts`
  uses the kit's `@IsOptionalNotNull()`.
- **Tests:** `test/relay.int.test.ts` drops the `new StreamManager(natsClient)` workaround (a
  deleted `FUEL` stream is re-ensured by the publisher, or use
  `streams.ensure(names, role, { refresh: true })`). `test/mqtt-gateway.int.test.ts` replaces the
  hand-started `nats:2.11-alpine` container and config file with
  `testInfraGlobalSetup({ nats: { mqtt: true } })` and `testInfra('nats').nats.mqttUrl`.
- **Methodology:** add `@method telemetry.reading_validation` to
  `src/domain/fuel-reading.ts#readingViolations` and the id to `IMPLEMENTED_METHOD_IDS`.

### ais-pipeline

- **Dependencies:** bump both; `.pnpmfile.cjs` drops the kit entry and gains the
  `@nestjs/terminus` gRPC peers; keep `SERVICE.processor.migrationsDir` (it is the recommended
  fix for the migrations directory).
- **Delete:** `src/apps/processor/pipeline/exclusive-consumer-handover.ts` and its wiring in
  `pipeline.module.ts` (the kit unpins on graceful stop); the if-guards marked `WORKAROUND(platform, …)` and the unreachable fallback in `src/apps/processor/fleet/fleet.projection.ts`
  (exhaustive switch); `exposeHeader()` in `src/apps/processor/positions/positions.controller.ts`
  → `bootstrapService({ cors: { exposedHeaders: ['X-Truncated', 'X-Total-Count'] } })` in the
  processor's main.
- **Outbox:** add `migrations/0004_outbox_per_key.sql` with the output of `outboxUpgradeSql()`
  (the 0.2 table of `0003_outbox.sql`; run it while the outbox is small, it locks the table until
  commit), and configure the relay from validated config with
  `OutboxModule.forRootAsync({ inject: [APP_CONFIG], useFactory })` instead of the static
  `POSITION_OUTBOX`.
- **Change:** `raw-report.consumer.ts`: `pinnedTtlMs: 90_000` is no longer needed against idle
  unpinning; return to the 30 s default for faster failover or keep it deliberately.
  `last-position.store.ts` may clear its per-vessel cache in `onConsumerActivated`
  (`ExclusiveConsumerListener` on the consumer provider) instead of revalidating every entry
  against Valkey; `isCurrent` can stay as a defence.
- **Methodology:** `@method data.ais_position_time` on
  `src/shared/domain/normalize.ts#ituPositionTime`, `utcSecondLag` and `positionTimeOf` (keep
  `data.ais_ingest_rules` on `legacyPositionTime`, `normalizeAisMessage`, `resolveBatch` and
  `classifyMovement`); remove the "(proposed id …)" remarks (e.g. `simplify.ts`); add
  `data.ais_position_time` to `IMPLEMENTED_METHOD_IDS` (`geo.track_simplification` is catalogued).
- **Test:** regenerate both OpenAPI documents; a processor stop hands the pin over at once; a
  failing outbox key does not delay other vessels; the `X-Truncated` header is readable
  cross-origin.

### safety

- **Dependencies:** bump both; remove `prom-client`; add the `@nestjs/terminus` gRPC peers (the
  image loses testcontainers by itself).
- **Delete:** the `LOCAL WORKAROUND` `src/detectors/alert-state-sync.ts` with
  `alert-state-sync.spec.ts` and the `DETECTOR_GATE` wiring in `src/detectors/detectors.module.ts`
  (the kit reloads open alerts on activation and gates ticks); `src/detectors/alert-sightings.ts`
  with its spec and `ALERT_SIGHTINGS` → `DetectorEventsRepository.onRepeated(alert, occurredAt)`
  (`alertRepeatedIntervalMs` = the old `SIGHTING_INTERVAL_MS`, 60 s = the default).
- **Change:** `detector-events.repository.ts`: remove the `RESOLVED_ELSEWHERE` special case in
  `onResolved` (use `alerts.forget(key)` or `resolve(key, { publish: false })` for occurrences
  another writer ended — otherwise 0.3 publishes a resolution for each of them); use
  `update.occurredAt` in `onUpdated`; return `domain`, `methodId`, `firstOccurredAt` and
  `lastOccurredAt` from `loadOpen`. The collision detector implements `onActivated(context)` to
  drop its pair trackers (the former `onReset` callbacks) and compares against
  `OpenAlert.lastOccurredAt` (`collision.detector.ts`). `detectors.module.ts` passes
  `{ useClass: DetectorEventsRepository }` **and** lists the class in `providers`: remove it from
  `providers` (one instance).
- **Behaviour:** resolutions are published as `alert.resolved.v1` by default (`safety.events`
  remains the record; REST unchanged) and reach the inbox once `ALERT_COOLDOWN_S` since the last
  raise has passed, or at once on graceful stop or failover. Deploy after notification.
- **Deployment:** two or more replicas with rolling updates; the README guidance "one replica,
  `Recreate` rollout" and the resync gap of `DETECTOR_PINNED_TTL_MS / 2` go away;
  `DETECTOR_PINNED_TTL_MS` keeps setting the failover TTL.
- **Docs:** README, CHANGELOG; mark `ews.pipeline_distance_status` and `collision.cpa_tcpa`
  implemented (already done in the central catalog).
- **Test:** two-instance failover (stop A: B activates before its first position with A's open
  alerts and raises nothing twice); a resolution produces one `alert.resolved.v1` after the
  cooldown; a re-raise within the cooldown produces none; `last_seen_at` follows event time.

### surveillance

- **Dependencies:** bump both; nothing to strip (no kit entry in `.pnpmfile.cjs`); add the
  `@nestjs/terminus` gRPC peers.
- **Delete:** the `PLATFORM WORKAROUND` `src/detectors/shared/alert-coordinator.ts`,
  `postgres-alert-coordinator.ts` and `__testing__/local-alert-coordinator.ts` — the reload after a
  15 s pause and the 2-minute tick activity gate (the kit reloads on activation and ticks only on
  the active instance). Its `ENDED_ELSEWHERE` resolutions become `alerts.forget(key)` or
  `resolve(key, { publish: false })`; if the per-`dedupKey` advisory lock is still wanted, run
  "align, then raise/resolve" inside `alerts.withKey(key, async () => …)` (re-entrant).
  `src/db/rows.ts` → kit `rowDate` / `rowDateOrNull`.
- **Change:** detectors that run their own timers or raise from `onZoneChanged` /
  `onVesselChanged` check `context.isActive()`; the transhipment analyser on ticks runs only on the
  active instance automatically and resets its pair state in `onActivated`. The dark detector may
  use `OpenAlert.lastOccurredAt` / `firstOccurredAt` again (implement `onRepeated` if `last_seen_at`
  is stored). `loadOpen` (`toOpenAlert`) returns `domain` and `methodId`.
- **Tests:** `test/api.int.test.ts` can use `app.get(<events repository class>)` instead of
  `app.get(ALERT_PERSISTENCE)`.
- **Behaviour/docs:** resolutions are published by default (inbox closes after
  `ALERT_COOLDOWN_MIN`); update the README "Platform issues" and replica sections.

### emission

- **Dependencies:** bump both; remove `prom-client` and import the metric types from
  `@darmawanweb/ais-its-nest/metrics` in `segment-builder.service.ts`, `weather.service.ts` and
  `positions.consumer.ts`; `.pnpmfile.cjs` drops the kit entry and gains the `@nestjs/terminus`
  gRPC peers.
- **Delete:** the "WORKAROUND (platform issue)" runtime type checks in
  `src/consumers/positions.consumer.ts` and `src/consumers/fleet.consumer.ts` (exhaustive switches
  over the exact envelopes); `src/modules/cii/replay-completeness.ts` with its spec → the recompute
  job checks `ReplayReport.completed` / `endedBy` and writes results only for a completed replay;
  `src/db/errors.ts` (template leftover) → kit `isUniqueViolation` / `sqlStateOf` if still used.
- **Change:** `src/domain/expression/evaluator.ts` → contracts `parseFuelFormula` (parse once) plus
  `evaluateFuelFormula`; values are bit-identical, keep the golden tests. Default limits drop from
  1000 characters / depth 64 to 500 / 32 and literals must be finite (no stored formula is
  affected: fleet enforced both). Messages change: "Wrong number of arguments for pow" → "pow()
  takes 2 arguments, got 1", "Unexpected token" → `Unexpected ")"`, "Formula nested too deeply" →
  "Nested deeper than 32 levels", `''` → "Empty formula". Optionally replace the 55P03 retry of
  `src/modules/segments/aggregate-refresher.service.ts` with kit `refreshContinuousAggregate`
  (consider `statementTimeoutMs: 0` for the 400-day window).
- **Methodology:** drop the "v2" / proposed markers in `IMPLEMENTED_METHOD_IDS`
  (`emission.segment_window`, `cii.year_end_projection`, `seemp.simulation_combination`,
  `emission.dcs_summary` are catalogued).

### geo

- **Dependencies:** bump both; remove `prom-client`; add the `@nestjs/terminus` gRPC peers.
- **Delete:** the `LOCAL WORKAROUND` `GeoOutboxRelay` (`src/modules/outbox/geo-outbox.relay.ts`,
  `outbox-policy.ts`) → kit `OutboxModule` (per-key: `geo.outbox` has `seq` and `next_attempt_at`;
  metric names already match). The kit orders by `entity_key` (`NULL` = unordered), which is
  stricter than geo's `ordering_key`, never weaker; the column can stay unused or be dropped in a
  forward migration. `src/common/validation.ts` `IsOptionalNotNull` → the kit's.
- **Change:** `src/modules/outbox/publication-limits.ts` reads `NatsClient.maxPayloadBytes()`
  instead of `connection.info?.max_payload`; `src/domain/zone-publication.ts` measures with
  `eventMessageSize()` or passes `enqueueEvent(..., { maxBytes })` and maps `EventTooLargeError` to
  `422 ZONE_SNAPSHOT_TOO_LARGE`. `POST /zones/republish` uses `@RequirePlatformAdmin()`. Audit
  records use `audit.enqueue(client, …)` instead of `buildRecord` plus `enqueueEvent`. `ETag` is
  exposed cross-origin by default (the quoted-`updatedAt` ETag design stays).
- **Methodology:** `@method geo.zone_geometry_rules` on
  `src/domain/zone-geometry.ts#assertZoneGeometryRules`, `@method geo.zone_buffer_extent` on
  `src/modules/zones/zones.repository.ts#bufferedBBoxCondition`, `@method geo.map_simplification`
  on `src/domain/zone-map.ts#simplificationToleranceDeg`; add the three ids to
  `IMPLEMENTED_METHOD_IDS`.
- **Test:** a near-limit zone (about 1.5 MB) round trip, now possible because the test NATS
  defaults to 4MB; an oversized zone answers 422 before anything is enqueued; regenerate
  `openapi.json`.

### notification

Upgrade and deploy **first** (before safety and surveillance).

- **Dependencies:** bump both; remove `prom-client`; add the `@nestjs/terminus` gRPC peers.
- **Handle `alert.resolved.v1`** in `src/modules/alerts/alerts.consumer.ts` /
  `alert-ingest.service.ts` (TypeScript enforces it):
  - look up the unresolved (open or acknowledged) alert by `dedupKey` in `open_alerts`;
  - ignore the event when there is none or when its `last_occurred_at` is later than `resolvedAt`;
  - otherwise set status resolved, `resolved_at = resolvedAt`, `resolved_by` = NULL (system), store
    the reason and the event id, remove it from `open_alerts` and push `alert:updated` through the
    fan-out;
  - be idempotent via `processed_events` and run no rule deliveries.
- **Fan-out:** `src/modules/realtime/alert-broadcaster.ts` drops the local
  `REALTIME_FANOUT_SUBSCRIPTION` and `FanoutMessageSchema` and uses contracts
  `subjects.notificationRealtime()`, `RealtimeAlertFanoutSchema` and
  `@CoreSubscriptionHandler({ subscription: 'notification-realtime-fanout' })` **without**
  `queue: false` (the contracts `delivery: 'fanout'` already reaches every instance; the validated
  payload is the handler's second argument, invalid messages are counted as `invalid`). Same
  subject and payload, so mixed versions interoperate during the rollout.
- **Change:** `src/modules/vessels/fleet.projection.ts` becomes an exhaustive switch;
  `src/common/optional-not-null.ts` → kit `@IsOptionalNotNull()`; `test/support/fixtures.ts` uses
  `makeTestVesselSnapshot`, `makeTestAlertRaised` and `makeTestAlertResolved` from
  `@darmawanweb/ais-its-nest/testing`. Bodiless `POST /alerts/:id/ack` with
  `Content-Type: application/json` now works. `email.consumer.ts` keeps `orderBySubject: false`
  (the kit warns about the other combination).
- **Methodology:** the `notify.*` ids are catalogued, so the methodology endpoint shows details;
  drop the proposed markers; keep the route `notifications/methodology`.
- **Test:** a raise followed by its resolution resolves the inbox alert once (duplicate delivery
  is a no-op); a resolution older than a merged occurrence is ignored; `alert:updated` reaches
  sockets on another instance.

## Step 5 — verify and document

```bash
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm openapi            # regenerate openapi.json (page maximum, parameters, security, roles)
pnpm install --prod     # in a copy or the Docker build: no test or gRPC packages (step 1)
```

Run the central `pnpm --filter @darmawanweb/ais-its-contracts run references:verify` once every
service carries its new `@method` tags (it reports the missing ones until then). Update each
service's README (platform issues, replicas), CHANGELOG and `.env.example` (`TRUSTED_PROXIES`).

## Workaround → kit API

| Local workaround (0.2)                                             | 0.3 replacement                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| own outbox relay with per-key retries (fleet, geo)                 | `OutboxModule.forRoot/forRootAsync` (per-key mode), `outboxUpgradeSql()` for 0.2 tables                       |
| reading `connection.info.max_payload`, own size checks             | `NatsClient.maxPayloadBytes()`, `eventMessageSize()`, `enqueueEvent(..., { maxBytes })`, `EventTooLargeError` |
| `new StreamManager(client)` to bypass the memo                     | `streams.ensure(names, role, { refresh: true })`, `streams.invalidate(names)`                                 |
| long `pinnedTtlMs` against idle unpinning                          | default 30 s TTL (pull expiry TTL / 3)                                                                        |
| unpinning on shutdown (ais-pipeline handover)                      | built in: `stop()` releases the pin                                                                           |
| reload/gate after failover (safety sync, surveillance coordinator) | runner activation: `loadOpen` reload, `onActivated`, ticks only while active, `ExclusiveConsumerListener`     |
| `term`/retry for messages that can never be handled                | `throw new DeadLetterError(message)`                                                                          |
| replay completeness heuristics                                     | `ReplayReport.completed` / `endedBy`                                                                          |
| local fan-out core subscription with `queue: false`                | contracts `notification-realtime-fanout` (`delivery: 'fanout'`)                                               |
| sanitizing database errors (auth)                                  | built in; `sanitizeError()` for own logs                                                                      |
| local `isUniqueViolation`, SQLSTATE parsing, retry loops           | `isUniqueViolation`, `sqlStateOf`, `PG_SQLSTATES`, `withTransaction({ retries, retryDelayMs })`               |
| string → `Date` helpers for raw rows (surveillance)                | `rowDate`, `rowDateOrNull`                                                                                    |
| 55P03 retry around continuous-aggregate refreshes                  | `refreshContinuousAggregate()`                                                                                |
| `ParseUUIDPipe` / `ParseIntPipe` / local MMSI pipes                | `@UuidParam()`, `@IntParam()`, `@MmsiParam()`                                                                 |
| bounded page DTOs                                                  | `PageQueryDto` (`MAX_PAGE`)                                                                                   |
| `ValidateIf(v !== undefined)` helpers                              | `@IsOptionalNotNull()`                                                                                        |
| manual `Access-Control-Expose-Headers`                             | `bootstrapService({ cors: { exposedHeaders } })`                                                              |
| cookie auth described in prose                                     | `openapi.securitySchemes` + `REFRESH_COOKIE_SECURITY_SCHEME`                                                  |
| in-handler platform-admin checks                                   | `@RequirePlatformAdmin()`                                                                                     |
| `normalizeClientIp`                                                | `clientIp()`                                                                                                  |
| `buildRecord` + `enqueueEvent` for audit                           | `AuditService.enqueue(client, …)`                                                                             |
| direct `prom-client` for types                                     | `import type { Counter, … } from '@darmawanweb/ais-its-nest/metrics'`                                         |
| hand-started MQTT NATS container in tests                          | `startTestInfra({ nats: { mqtt: true } })`, `TestNats.mqttUrl`                                                |
| local zone / vessel / alert payload fixtures                       | `makeTestZone`, `makeTestVesselSnapshot`, `makeTestAlertRaised`, `makeTestAlertResolved`                      |
| `RESOLVED_ELSEWHERE` / `ENDED_ELSEWHERE` resolutions               | `alerts.forget(key)` or `resolve(key, { publish: false })`                                                    |
| sightings throttles for `last_seen_at`                             | `AlertPersistence.onRepeated` + `alertRepeatedIntervalMs`                                                     |
| `app.get(ALERT_PERSISTENCE)` in tests                              | `app.get(<repository class>)` for `{ useClass }`                                                              |
