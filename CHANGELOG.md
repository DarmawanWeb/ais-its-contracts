# Changelog

All notable changes to this repository are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the packages adhere to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Event types are versioned by their
`.vN` suffix and are never changed incompatibly.

## [Unreleased]

Kit and contracts follow-ups reported by the services during their 0.2.0 upgrades (K1–K9). The
kit's changes (exclusive consumers that give their pin up when cut off from NATS or after a pause,
bounded NATS drain, guard-accurate platform-admin OpenAPI sentence, transaction `onRetry`, audit
labels, resolutions a crash would lose) are listed in
[`packages/nest/CHANGELOG.md`](packages/nest/CHANGELOG.md) and the service steps in
[`packages/nest/UPGRADING.md`](packages/nest/UPGRADING.md#upgrading-from-030-to-the-next-release).
Everything is additive; no rollout order is required.

### Added

#### `@darmawanweb/ais-its-contracts`

- **`audit.recorded.v1` `labels`** (optional, K5): `AuditLabelsSchema` / `AuditLabels`
  (`actorName`, `actorEmail`, `orgName`, `targetLabel`, each optional and `string | null`, at most
  `AUDIT_LABEL_MAX_LENGTH` = 200 characters): the names the producer knew when it wrote the record.
  A compatible change of the event type: consumers on 0.4.0 strip the member, producers on 0.4.0
  never send it (JSON Schema and AsyncAPI regenerated).
- **Methodology catalog: the `security` domain gets its methods (K9).** 13 methods —
  `security.password_hashing`, `security.password_policy`, `security.login_throttle`,
  `security.refresh_rotation`, `security.secret_encryption`, `security.signing_key_lifecycle`,
  `security.totp`, `security.api_key_scope_grant`, `security.invitation_consent`,
  `security.client_ip`, `security.api_key_rotation`, `security.csv_injection` (owner `auth`) and
  `security.api_key_hashing` (owner `contracts`, `hashApiKey` now carries its `@method` tag) — and
  15 references (RFC 9106, RFC 9700, RFC 6238, RFC 4226, RFC 7519, RFC 8725, RFC 8037, RFC 7638,
  RFC 7517, RFC 5869, NIST SP 800-63B-4, NIST SP 800-38D, the OWASP Password Storage and
  Authentication cheat sheets, OWASP CSV Injection), appended so citation numbers stay stable,
  each checked on 2026-11-27 (identity and the cited content through search extracts; two marked
  `partially_verified` where the content was seen only in secondary quotations). Design defaults
  stay `needsCitation`; `security.password_policy` records its deviation from NIST SP 800-63B-4.
  The catalog has 122 methods (117 implemented, 5 not implemented) and 164 references.

### Changed

- Methodology catalog: `ietf-rfc-4180` and `nist-fips-180-4` re-checked (now `verified`);
  the notes of `fuel.first_formula` name the 0.2.0 code locations (fleet validates with
  `validateFuelFormula` in `src/modules/common/validation.ts#IsFuelFormula`, emission parses and
  evaluates in `src/domain/fuel/first-formula.ts`) instead of the removed
  `src/domain/fuel-formula.ts#parseFuelFormula` and `src/domain/expression/evaluator.ts` (K8).

## [0.4.0] - 2026-11-22

`@darmawanweb/ais-its-contracts` 0.4.0 and `@darmawanweb/ais-its-nest` 0.3.0: the hardening reported
by the services built on 0.3.0 / 0.2.0. Everything is additive (new event type, new exports,
literal consumer types, catalog data); the kit's changes are listed in
[`packages/nest/CHANGELOG.md`](packages/nest/CHANGELOG.md) and the service upgrade steps in
[`packages/nest/UPGRADING.md`](packages/nest/UPGRADING.md). Upgrade **notification before
safety and surveillance**: kit 0.3.0 publishes `alert.resolved.v1` by default, and an old
notification acknowledges event types it does not know.

### Added

#### `@darmawanweb/ais-its-contracts`

- **`alert.resolved.v1`** (`EVENT_TYPES.ALERT_RESOLVED`, `AlertResolvedV1Schema`, `AlertResolvedV1`,
  `ALERT_RESOLUTION_REASON_MAX_LENGTH` = 500): published by safety and surveillance on the raise's
  subject `alert.v1.<alertType>.<mmsi>` in stream `ALERTS` (entity key = mmsi), with `alertId`,
  `type`, `domain`, `severity`, `mmsi`, `relatedMmsi`, `zoneId`, `dedupKey`, `openedAt`,
  `resolvedAt`, `reason`, `methodId`, `data`. Consumer contract (TSDoc): resolve the unresolved
  inbox alert with that `dedupKey` unless it merged an occurrence later than `resolvedAt`; do
  nothing when there is none; idempotent by event id. JSON Schema
  `schemas/alert.resolved.v1.json` and the AsyncAPI message.
- **Notification fan-out** core subscription `notification-realtime-fanout`
  (`aisits.notification.realtime.v1`, `SUBJECT_FILTERS.NOTIFICATION_REALTIME`,
  `subjects.notificationRealtime()`, `delivery: 'fanout'`) with the payload
  `RealtimeAlertFanoutSchema` (`{ event: 'alert:raised' | 'alert:updated', rooms, alert }`,
  `REALTIME_FANOUT_MAX_ROOMS` 16, `REALTIME_FANOUT_MAX_ROOM_LENGTH` 128) in `./realtime`, and
  `CORE_SUBSCRIPTION_PAYLOADS` (payload schema per core subscription). `CoreSubscriptionDefinition`
  gains `delivery?: 'queue' | 'fanout'` (`CORE_SUBSCRIPTION_DELIVERIES`,
  `DEFAULT_CORE_SUBSCRIPTION_DELIVERY` = `'queue'`, `coreSubscriptionDelivery()`). The subject and
  payload are the ones notification already uses, so mixed versions interoperate.
- Consumer builders with literal types: `defineDurableConsumer(definition)`,
  `positionFeedConsumer(durableName, service, description)`,
  `fleetProjectionConsumer(durableName, service)`, `zoneProjectionConsumer(durableName, service)`.
- `ERROR_DEFINITIONS.PLATFORM_ADMIN_REQUIRED` (`403`, "Platform administrator required").
- `hashApiKey(key)` (async WebCrypto SHA-256, lowercase hex: the definition of
  `api_keys.key_hash`; `TypeError` for a non-key, never echoing it) and `API_KEY_HASH_ALGORITHM`.
- The shared fuel formula grammar of fleet and emission in `./domain`: `parseFuelFormula`,
  `evaluateFuelFormula`, `validateFuelFormula`, `FUEL_FORMULA_LIMITS` (500 characters, depth 32,
  500 tokens), `FUEL_FORMULA_VARIABLE` (`speedKnot`), `FUEL_FORMULA_FUNCTIONS`,
  `FuelFormulaSyntaxError` (`reason`, `position`) and the node, context, limit and validation
  types (method `fuel.first_formula`). A 200 000-input differential fuzz against both services'
  implementations found no verdict difference with fleet and bit-identical values with emission.
- Methodology catalog: 18 methods (13 ids services already tagged, plus `geo.zone_geometry_rules`,
  `geo.zone_buffer_extent`, `geo.map_simplification`, `telemetry.reading_validation`,
  `data.ais_position_time`), 9 references (appended, so citation numbers are stable; marked
  unverified and `needsCitation`), the domains `notification` and `security`, and the status
  `not_implemented`. The catalog has 109 methods (104 implemented, 5 not implemented, 0 planned)
  and 149 references.
- `pnpm references:verify [--services <dir>]` (`scripts/verify-references.ts`): every
  implemented method's `implementedBy` module and symbol exist and carry its `@method` tag, every
  tag names a catalogued method, and no status is stale (`implementedBy.module` grammar:
  `<path>[#<symbol>][ (<remark>)]`).

### Changed

#### `@darmawanweb/ais-its-contracts`

- `CONSUMERS` entries keep literal types (type-only; runtime values unchanged), so the kit's
  `ConsumerEnvelope<'notification-fleet'>` is exactly the two fleet events and a
  `switch (event.type)` can be exhaustive. A definition annotated `: DurableConsumerDefinition`
  still widens to every event type: use `defineDurableConsumer`.
- `CONSUMERS['notification-alerts']` delivers `alert.raised.v1` **and** `alert.resolved.v1`
  (`ConsumerEnvelope<'notification-alerts'>` becomes a union; TypeScript makes notification handle
  it).
- `CORE_SUBSCRIPTIONS['telemetry-mqtt']` declares `delivery: 'queue'` (the default).
- The catalog statuses are corrected: all 82 methods marked `planned` are `implemented` (they were
  tagged in service code), 38 `implementedBy` values point at verified `module#symbol`s, and 14
  methods name secondary implementations in their notes. `@method` tags were added to
  `haversineDistance`, `NAV_STATUS`, `assignCiiGrade` and `ciiGradeBoundaries`.
- AsyncAPI: one channel and message per core subscription, `x-ais-its-consumer.delivery` on core
  operations.

## [0.3.0] - 2026-11-21

`@darmawanweb/ais-its-contracts` 0.3.0 and `@darmawanweb/ais-its-nest` 0.2.0 (review fixes; the
kit's changes are listed in [`packages/nest/CHANGELOG.md`](packages/nest/CHANGELOG.md)).

### Changed

#### `@darmawanweb/ais-its-contracts`

- **BREAKING** `ORDERED_CONSUMERS` is keyed by name (`as const`, like `CONSUMERS`), with the
  `OrderedConsumerName` type; the array is `ORDERED_CONSUMER_LIST`.
- The `service` of `DurableConsumerDefinition`, `OrderedConsumerDefinition` and
  `CoreSubscriptionDefinition` is an open vocabulary (`OpenVocabulary<ServiceName>`): a new service
  declares its consumers before `SERVICE_NAMES` lists it, without type assertions.

### Fixed

#### `@darmawanweb/ais-its-contracts`

- The methodology catalog (`./references`: `REFERENCES`, `METHODS`) is synced from
  `docs/references` (140 references, 91 methods); 0.2.0 shipped it empty. A test guards against an
  empty catalog and CI checks it against the central repository (`references:check`).
- `ApiKeyIntrospectionResultSchema` is forward compatible: scopes unknown to this version are
  dropped (like unknown roles of access tokens) instead of failing the whole introspection.

### Added

#### `@darmawanweb/ais-its-contracts`

- Kind-specific zone properties: `ZONE_PROPERTY_SCHEMAS` (`pipeline.markers`,
  `shallow_water.depthM`, `tss_lane.directionDeg`/`maxSpeedKn`, harbour `unlocode`/`maxDraughtM`,
  area `authority`/`legalBasis`, `source`/`note` everywhere), `ZoneProperties<Kind>` and the
  lenient reader `zoneProperties(zone)`.
- `legacyHaversineDistance`: the legacy CII haversine (R = 3438 nm) under an unambiguous name.

#### `@darmawanweb/ais-its-nest` 0.2.0

- See [`packages/nest/CHANGELOG.md`](packages/nest/CHANGELOG.md) (first published as 0.1.0, the
  NestJS 12 service kit with the Detector SDK).

## [0.2.0] - 2026-11-21

Implements spec 1.1: the platform is now **AIS Maritime Intelligence** (`ais-its-*`) and
navigational safety, surveillance and geofences are separate services (`safety`, `surveillance`,
`geo`) built on the Detector SDK. 0.2.0 contains breaking changes; see _Migration_ below.

### Changed

#### `@darmawanweb/ais-its-contracts`

- **BREAKING** The package is renamed from `@darmawanweb/seemp-contracts` to
  `@darmawanweb/ais-its-contracts`; the repository moved to
  `https://github.com/DarmawanWeb/ais-its-contracts`.
- **BREAKING** `AisPositionRecordedV1` no longer carries `ewsStatus` and `pipelineDistanceM`: the
  AIS pipeline publishes AIS data only, EWS is computed by the safety service
  (`SafetyVesselStateV1`). `RealtimePosition` and `toRealtimePosition` lose `ewsStatus` as well.
- **BREAKING** `AlertRaisedV1` requires `domain` (`safety` | `surveillance`, checked against the
  registry for known types) and `methodId` (methodology catalog id). `RealtimeAlert` carries both.
- **BREAKING** `ALERT_TYPES` is now the alert type registry (domain, default severity, severity by
  detector level, labels and descriptions in `id`/`en`) instead of a string array; the array is
  `KNOWN_ALERT_TYPES`. `AlertTypeSchema` is forward compatible (any lowercase token parses, so
  types of newer detectors are accepted); `KnownAlertTypeSchema` accepts registry types only.
  `AlertType` is an open union (`KnownAlertType | (string & {})`).
- **BREAKING** Permissions `detection:read` / `detection:review` are replaced by `safety:read`,
  `surveillance:read` and `surveillance:review` with the matrix of spec 8.4.
- **BREAKING** Durable consumers `detection-positions` / `detection-fleet` and the service name
  `detection` are replaced by `safety-*` / `surveillance-*` consumers and the service names `geo`,
  `safety` and `surveillance` (spec 7.3).
- **BREAKING** Identity constants: default JWT issuer `ais-its-auth`, audience `ais-its-api`,
  refresh cookie `aisits_rt`; webhook signature header `X-AIS-ITS-Signature` (plus the new
  `X-AIS-ITS-Timestamp`).
- **BREAKING** Problem `type` URIs are URNs: `urn:ais-its:problem:<slug>`
  (`PROBLEM_TYPE_BASE_URI`).
- **BREAKING** Core NATS telemetry subject `aisits.telemetry.<deviceId>` (MQTT topic
  `aisits/telemetry/<deviceId>`); `SUBJECT_FILTERS.TELEMETRY_MQTT` is `aisits.telemetry.*`.
- **BREAKING** The error code `DETECTION_NOT_FOUND` is replaced by `SAFETY_EVENT_NOT_FOUND` and
  `SURVEILLANCE_EVENT_NOT_FOUND`; `DETECTION_STATUSES` by `SURVEILLANCE_EVENT_STATUSES` (and the new
  `SAFETY_EVENT_STATUSES`).
- `classifyEwsStatus(distanceM, predictedNavstatus, thresholds?)` documents that it takes the
  predicted navstatus (as the legacy `checkShipStatus` call sites do) and accepts configured
  thresholds (`EWS_DANGER_M` / `EWS_WARNING_M`); `ewsAlertSeverity` follows the registry.
- `ZONE_KINDS` adds `anchorage`, `tss_lane` and `shallow_water` (spec 7.4); zones belong to the geo
  service.
- JSON Schema `$id`s are URNs (`urn:ais-its:schema:events:<type>`); AsyncAPI document titled
  _AIS Maritime Intelligence Events_ with `x-ais-its-*` extensions; the `alertType` subject
  parameter lists the registry types as `examples` instead of a closed `enum`.

### Added

#### `@darmawanweb/ais-its-contracts`

- Streams `GEO` (`geo.zone.v1.>`, one message per subject, no max age) and `SAFETY`
  (`safety.state.v1.>`, one message per subject, 7 d).
- Events `geo.zone.upserted.v1` (`ZoneSnapshotV1`), `geo.zone.deleted.v1` (`ZoneDeletedV1`) and
  `safety.vessel_state.updated.v1` (`SafetyVesselStateV1`, with `ClosestEncounterSchema`), exactly
  as spec 7.4; their subjects (`subjects.geoZone(zoneId)`, `subjects.safetyState(mmsi)`), catalog
  entries, entity keys, JSON Schemas and AsyncAPI channels.
- Consumers of spec 7.3: `safety-positions`, `surveillance-positions`, `safety-fleet`,
  `surveillance-fleet`, `safety-zones`, `surveillance-zones` and the ordered consumer
  `notification-safety` (notification now has ordered consumers on `AIS_POSITION`, `SAFETY` and
  `EMISSION`).
- `VesselSnapshotV1.type.capacityFixed` (optional, nullable) and `ciiCapacity(vessel)`
  (`type.capacityFixed ?? dimensions.capacity`, spec 13.5).
- Domain: `ALERT_DOMAINS` with labels, alert registry helpers (`isKnownAlertType`, `isAlertType`,
  `getAlertType`, `alertTypesOfDomain`, `alertTypeLabel` with a fallback for unknown types,
  `defaultAlertSeverity`), collision risk bands (`COLLISION_RISKS`, `compareCollisionRisk`,
  `collisionRiskAlertSeverity`, labels), GeoJSON geometry schemas (RFC 7946, WGS84, closed rings)
  with `geometryPositions`, `countGeometryPositions` and `geometryBBox`, `ZONE_MAX_VERTICES`,
  `isZoneKind`, `LocalizedTextSchema` and the `OpenVocabulary` type.
- Realtime (spec 9): `RealtimeSafetyState`, `SafetyStatesBatch`, `toRealtimeSafetyState(state,
position)` and the server events `safety:states` and `vessel:safety`.
- Subpath `./references`: the methodology catalog model of spec 17 (`ReferenceSchema`,
  `MethodSchema` with variables, constants, implementation and legacy links; open vocabularies for
  domains, statuses, reference types and verification with `id`/`en` labels), `REFERENCES` and
  `METHODS` loaded from generated data modules (empty until the catalog is synced),
  `getReference`, `getMethod`, `methodsByDomain`, `referencesOfMethod`, `createMethodologyIndex`
  and `validateCatalog` (schemas, unique ids, no dangling `referenceIds`, every method cites a
  source or is marked `needsCitation`). `MethodIdSchema` validates `methodId` / `methodIds`.
- `pnpm run references:sync` (and `references:check`) copies `docs/references/{references,methods}.json`
  of the central repository into the package after validation; JSON Schemas of both catalog files
  (`schemas/methodology.*.json`).
- `subjects.telemetryMqtt` counterpart `telemetryMqttTopic(deviceId)` and
  `TELEMETRY_MQTT_TOPIC_PREFIX`; README catalog table of the alert types.

### Fixed

- The CommonJS build could emit invalid code (`InvalidEventError`) when `@swc/core` is present in
  the workspace: decorator metadata is disabled in the isomorphic build configuration so tsup no
  longer routes the build through its SWC plugin.

### Migration from `@darmawanweb/seemp-contracts` 0.1

| 0.1                                                     | 0.2                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `@darmawanweb/seemp-contracts[/subpath]`                | `@darmawanweb/ais-its-contracts[/subpath]`                     |
| `position.ewsStatus`, `position.pipelineDistanceM`      | `SafetyVesselStateV1` on `SAFETY` (`safety.state.v1.<mmsi>`)   |
| `ALERT_TYPES` (array)                                   | `KNOWN_ALERT_TYPES`; `ALERT_TYPES[type]` is the registry entry |
| `ALERT_TYPE_LABELS[type]`                               | `ALERT_TYPES[type].label` or `alertTypeLabel(type, locale)`    |
| `detection:read` / `detection:review`                   | `safety:read`, `surveillance:read` / `surveillance:review`     |
| `CONSUMERS['detection-positions' \| 'detection-fleet']` | `safety-*` / `surveillance-*` consumers                        |
| `DETECTION_STATUSES`, `DetectionStatus`                 | `SURVEILLANCE_EVENT_STATUSES`, `SurveillanceEventStatus`       |
| `DETECTION_NOT_FOUND`                                   | `SAFETY_EVENT_NOT_FOUND`, `SURVEILLANCE_EVENT_NOT_FOUND`       |
| `seemp-auth` / `seemp-api` / `seemp_rt`                 | `ais-its-auth` / `ais-its-api` / `aisits_rt`                   |
| `https://seemp.dev/problems/<slug>`                     | `urn:ais-its:problem:<slug>`                                   |
| `seemp.telemetry.<deviceId>`                            | `aisits.telemetry.<deviceId>`                                  |
| `X-Seemp-Signature`                                     | `X-AIS-ITS-Signature` (+ `X-AIS-ITS-Timestamp`)                |
| `AlertRaisedV1` without `domain` / `methodId`           | both required                                                  |

## [0.1.0] - 2026-11-20

### Added

#### `@darmawanweb/seemp-contracts` (now `@darmawanweb/ais-its-contracts`)

- Isomorphic package (Node.js ≥ 22.12 and browsers) built with tsup to ESM, CommonJS and type
  declarations, with the subpath exports `./events`, `./auth`, `./domain`, `./realtime` and `./api`.
- `events`: `EventEnvelope` zod factory and `EventEnvelopeSchema`, `makeEnvelope` (UUID v7 id,
  ISO time, validated payload), `parseEnvelope` with staged failure reasons, `encodeEnvelope`,
  `validateEvent`, the `EVENT_TYPES` and `EVENT_SCHEMAS` registry, payload schemas of every event of
  spec 7.4 (`AisRawReceivedV1`, `AisPositionRecordedV1`, `FuelReadingRecordedV1`,
  `VesselSnapshotV1`, `VesselDeletedV1`, `CiiUpdatedV1`, `AlertRaisedV1`, `EmailRequestedV1`,
  `AuditRecordedV1`), `STREAMS` (spec 7.2), `CONSUMERS`, ordered consumers and core subscriptions
  (spec 7.3), `subjects` builders (position partitions `mmsi % 16`), `subjectForEvent` and the
  `EVENT_CATALOG`.
- `auth`: `ROLES`, `PERMISSIONS`, `ROLE_PERMISSIONS` (spec 8.4), `permissionsForRoles`, API key
  scopes and the `sk_<id>_<secret>` format helpers, `AccessTokenClaimsSchema` (spec 8.2), auth
  constants (`seemp_rt` cookie, `X-API-Key`, `X-Internal-Token`, `X-Request-Id`), API key
  introspection schemas and tenancy helpers (`canAccessOrg`, `isPlatformAdmin`, …).
- `domain`: AIS navstatus codes with English and Indonesian labels, AIS sources, predicted navstatus
  and the anomaly rule, EWS status with labels and legacy thresholds, alert types / severities /
  statuses, zone kinds, CII grades with `assignCiiGrade` (parity with the legacy
  `assignGradeBasedOnDdVector`), haversine distance with `R = 3438 nm` (parity with the legacy
  `calculateDistance`), unit helpers (legacy factor 0.5144) and `newId()` (UUID v7).
- `realtime`: socket.io path, event names, schemas (`ViewportSetRequest`,
  `VesselSubscribeRequest`, `RealtimePosition`, `PositionsBatch`, `RealtimeAlert`,
  `RealtimeError`), typed event maps, rooms (`tile:6:<x>:<y>`, `tile:all`, `vessel:<mmsi>`, …) and
  slippy-map tile math (spec 9).
- `api`: RFC 9457 `ProblemDetailsSchema`, `createProblem`, shared error codes, page and cursor
  pagination schemas and helpers, ISO-8601 timestamp helpers and codec (spec 5).
- Generated, committed artifacts: JSON Schemas of every payload (`schemas/`), the AsyncAPI 3.0
  document (`asyncapi.json`) and the README catalog tables.
- Golden tests against values produced by executing the legacy MVP functions.

#### Repository

- pnpm workspace (`packages/*`), shared TypeScript, ESLint (flat config, typescript-eslint),
  Prettier, EditorConfig, Husky + commitlint + lint-staged configuration.
- GitHub Actions: CI (format, lint, typecheck, test, build, package checks, generated artifacts) and
  release on `v*` tags publishing to GitHub Packages; Dependabot configuration.

[Unreleased]: https://github.com/DarmawanWeb/ais-its-contracts/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DarmawanWeb/ais-its-contracts/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DarmawanWeb/ais-its-contracts/releases/tag/v0.1.0
