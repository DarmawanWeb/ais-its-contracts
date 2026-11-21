# Changelog

All notable changes to this repository are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the packages adhere to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Event types are versioned by their
`.vN` suffix and are never changed incompatibly.

## [Unreleased]

### Added

#### `@darmawanweb/ais-its-nest` 0.1.0

- First release of the NestJS 12 service kit (formerly the unreleased `packages/platform`),
  ESM only, built with `tsc`; see [`packages/nest/CHANGELOG.md`](packages/nest/CHANGELOG.md).

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
