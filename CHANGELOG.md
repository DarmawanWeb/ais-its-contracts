# Changelog

All notable changes to this repository are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the packages adhere to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Event types are versioned by their
`.vN` suffix and are never changed incompatibly.

## [Unreleased]

## [0.1.0] - 2026-11-20

### Added

#### `@darmawanweb/seemp-contracts`

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

[Unreleased]: https://github.com/DarmawanWeb/seemp-contracts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DarmawanWeb/seemp-contracts/releases/tag/v0.1.0
