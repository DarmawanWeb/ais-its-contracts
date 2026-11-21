# @darmawanweb/seemp-contracts

Shared, **isomorphic** contracts of the SEEMP platform v2 — the single TypeScript source of truth
for everything that crosses a process boundary:

- **events** — the NATS JetStream event envelope, event types, payload schemas (zod 4), streams,
  durable consumers and subject builders (spec §7);
- **auth** — roles, permissions and the role matrix, API key format and scopes, access token claims,
  auth constants and tenancy helpers (spec §8);
- **domain** — AIS navstatus codes with English/Indonesian labels, EWS status, alert types and
  severities, zone kinds, CII grades (legacy parity), haversine distance (legacy parity), unit
  helpers and UUID v7 ids;
- **realtime** — the socket.io protocol of the notification service: event names, message schemas,
  typed event maps, rooms and slippy-map tile math (spec §9);
- **api** — RFC 9457 problem details, shared error codes, pagination envelopes and ISO-8601
  timestamps (spec §5).

The package runs unchanged in Node.js (≥ 22.12) and in browsers, ships ESM + CommonJS + type
declarations, is side-effect free (tree-shakable) and depends only on `zod` and `uuid`.

## Install

The package is published to GitHub Packages. Map the scope once in `~/.npmrc` with a token that
has `read:packages`:

```ini
@darmawanweb:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
pnpm add @darmawanweb/seemp-contracts
```

Inside the central repository the package is consumed through the pnpm workspace and needs no
token. In GitHub Actions, `actions/setup-node` with `registry-url: https://npm.pkg.github.com`,
`scope: '@darmawanweb'` and `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` does the same.

## Entry points

| Import                                  | Contents                                                      |
| --------------------------------------- | ------------------------------------------------------------- |
| `@darmawanweb/seemp-contracts`          | everything below                                              |
| `@darmawanweb/seemp-contracts/events`   | envelope, event types, payloads, streams, consumers, subjects |
| `@darmawanweb/seemp-contracts/auth`     | roles, permissions, API keys, token claims, tenancy           |
| `@darmawanweb/seemp-contracts/domain`   | AIS, EWS, alerts, zones, CII, geodesy, units, ids             |
| `@darmawanweb/seemp-contracts/realtime` | socket.io events, schemas, rooms, tiles                       |
| `@darmawanweb/seemp-contracts/api`      | problem details, error codes, pagination, timestamps          |

## Usage

### Publish and consume events

```ts
import {
  EVENT_TYPES,
  NATS_HEADERS,
  STREAMS,
  CONSUMERS,
  encodeEnvelope,
  makeEnvelope,
  parseEnvelope,
  subjectForEvent,
  subjects,
} from '@darmawanweb/seemp-contracts/events';

// Producer: validated envelope with a UUID v7 id; never build subjects by hand.
const envelope = makeEnvelope({
  type: EVENT_TYPES.AIS_POSITION_RECORDED,
  source: 'ais-processor',
  data: position, // AisPositionRecordedV1, validated (throws InvalidEventError)
  traceparent,
});
await js.publish(subjectForEvent(envelope), encodeEnvelope(envelope), {
  msgID: envelope.id, // NATS_HEADERS.MSG_ID, 2 minute dedup window
});

// Stream / consumer configuration is plain data (durations in ms).
const { name, subjects: filters, maxAgeMs } = STREAMS.AIS_POSITION;
const durable = CONSUMERS['emission-positions'];
subjects.aisPosition(525005223); // "ais.position.v1.7.525005223" (mmsi % 16)
subjects.aisPositionPartitionFilter(7); // "ais.position.v1.7.>"

// Consumer: staged validation tells what to do with a bad message.
const result = parseEnvelope(msg.data);
if (!result.success) {
  logger.warn({ reason: result.reason, issues: result.issues }, result.message);
  msg.term(); // invalid_json | invalid_envelope | invalid_payload (unknown_type: newer producer)
} else if (result.envelope.type === EVENT_TYPES.AIS_POSITION_RECORDED) {
  handle(result.envelope.data); // typed AisPositionRecordedV1
}
```

### Authorization

```ts
import {
  AccessTokenClaimsSchema,
  canAccessOrg,
  parseApiKey,
  permissionsForRoles,
  userPrincipalFromClaims,
} from '@darmawanweb/seemp-contracts/auth';

const claims = AccessTokenClaimsSchema.parse(jwtPayload); // after jose jwtVerify
const principal = userPrincipalFromClaims(claims);
permissionsForRoles(principal.roles).has('vessel:write');
canAccessOrg(principal, vessel.orgId); // tenant-private rule of spec 8.5

parseApiKey(apiKeyHeader); // { id, secret, prefix: 'sk_<id>' } | null
```

### Domain helpers with legacy parity

```ts
import {
  assignCiiGrade,
  haversineDistance,
  knotsToMs,
  navStatusLabel,
  newId,
} from '@darmawanweb/seemp-contracts/domain';

haversineDistance(previous, current); // { nm, meters } with R = 3438 nm (legacy calculateDistance)
assignCiiGrade(attained / required, vesselType.d); // 'A'..'E' (legacy assignGradeBasedOnDdVector)
knotsToMs(12); // legacy factor 0.5144
navStatusLabel(1, 'id'); // "Berlabuh jangkar"
newId(); // UUID v7
```

### Realtime (socket.io)

```ts
import { io, type Socket } from 'socket.io-client';
import {
  REALTIME_PATH,
  type RealtimeClientToServerEvents,
  type RealtimeServerToClientEvents,
  roomsForViewport,
} from '@darmawanweb/seemp-contracts/realtime';

const socket: Socket<
  RealtimeServerToClientEvents,
  RealtimeClientToServerEvents
> = io({
  path: REALTIME_PATH,
  auth: { token: accessToken },
});
socket.emit(
  'viewport:set',
  { bbox: [94.5, -11.5, 141.5, 6.5], zoom: 5 },
  (ack) => {
    if (!ack.ok) console.error(ack.error.code);
  },
);

// Server side: rooms for a viewport (zoom-6 tiles, or tile:all above 64 tiles).
roomsForViewport([94.5, -11.5, 141.5, 6.5]); // { mode: 'tiles', rooms: ['tile:6:48:30', …] }
```

### HTTP conventions

```ts
import {
  PROBLEM_CONTENT_TYPE,
  createProblem,
  issuesToFieldErrors,
  PageQuerySchema,
  toPaginated,
} from '@darmawanweb/seemp-contracts/api';

reply
  .type(PROBLEM_CONTENT_TYPE)
  .status(404)
  .send(
    createProblem('VESSEL_NOT_FOUND', {
      detail: 'No vessel with MMSI 525005223',
    }),
  );

const query = PageQuerySchema.parse(request.query); // { page: 1, pageSize: 20 } by default
toPaginated(rows, query, total); // { data, meta: { page, pageSize, total } }
```

## Event catalog

Generated from `EVENT_CATALOG`, `CONSUMERS` and `ORDERED_CONSUMERS`.

<!-- generated:events:start -->

| Event type                  | Payload                 | Subject                              | Stream         | Producers                | Consumers                                                                                           |
| --------------------------- | ----------------------- | ------------------------------------ | -------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `ais.raw.received.v1`       | `AisRawReceivedV1`      | `ais.raw.v1.{source}`                | `AIS_RAW`      | ais-ingestor             | `ais-processor`                                                                                     |
| `ais.position.recorded.v1`  | `AisPositionRecordedV1` | `ais.position.v1.{partition}.{mmsi}` | `AIS_POSITION` | ais-processor            | `emission-positions`, `detection-positions`, `notification-positions` (ordered)                     |
| `fuel.reading.recorded.v1`  | `FuelReadingRecordedV1` | `fuel.reading.v1.{mmsi}`             | `FUEL`         | telemetry                | `emission-fuel`                                                                                     |
| `fleet.vessel.upserted.v1`  | `VesselSnapshotV1`      | `fleet.vessel.v1.{vesselId}`         | `FLEET`        | fleet                    | `emission-fleet`, `detection-fleet`, `notification-fleet`, `telemetry-fleet`, `ais-processor-fleet` |
| `fleet.vessel.deleted.v1`   | `VesselDeletedV1`       | `fleet.vessel.v1.{vesselId}`         | `FLEET`        | fleet                    | `emission-fleet`, `detection-fleet`, `notification-fleet`, `telemetry-fleet`, `ais-processor-fleet` |
| `emission.cii.updated.v1`   | `CiiUpdatedV1`          | `emission.cii.v1.{mmsi}`             | `EMISSION`     | emission                 | `notification-cii` (ordered)                                                                        |
| `alert.raised.v1`           | `AlertRaisedV1`         | `alert.v1.{alertType}.{mmsi}`        | `ALERTS`       | ais-processor, detection | `notification-alerts`                                                                               |
| `notify.email.requested.v1` | `EmailRequestedV1`      | `notify.email.v1`                    | `NOTIFY`       | auth, notification       | `notification-email`                                                                                |
| `audit.recorded.v1`         | `AuditRecordedV1`       | `audit.v1.{service}`                 | `AUDIT`        | every service            | `auth-audit`                                                                                        |

<!-- generated:events:end -->

### Streams

Generated from `STREAMS`.

<!-- generated:streams:start -->

| Stream         | Subjects            | Retention | Max age | Max msgs / subject | Dedup window | Description                                                                       |
| -------------- | ------------------- | --------- | ------- | ------------------ | ------------ | --------------------------------------------------------------------------------- |
| `AIS_RAW`      | `ais.raw.v1.>`      | limits    | 1 d     | ∞                  | 2 min        | Normalized AIS reports published by the ais-ingestor.                             |
| `AIS_POSITION` | `ais.position.v1.>` | limits    | 7 d     | ∞                  | 2 min        | Recorded positions partitioned by mmsi % 16 (ais.position.v1.<partition>.<mmsi>). |
| `FUEL`         | `fuel.reading.v1.>` | limits    | 30 d    | ∞                  | 2 min        | Fuel consumption readings published by telemetry.                                 |
| `FLEET`        | `fleet.vessel.v1.>` | limits    | ∞       | 1                  | 2 min        | Latest vessel snapshot per vessel (projection source for every service).          |
| `EMISSION`     | `emission.cii.v1.>` | limits    | 30 d    | ∞                  | 2 min        | Year-to-date CII updates published by emission.                                   |
| `ALERTS`       | `alert.v1.>`        | limits    | 90 d    | ∞                  | 2 min        | Alerts raised by ais-processor (ews) and detection.                               |
| `NOTIFY`       | `notify.email.v1`   | workqueue | 7 d     | ∞                  | 2 min        | Transactional e-mail requests (work queue).                                       |
| `AUDIT`        | `audit.v1.>`        | limits    | 30 d    | ∞                  | 2 min        | Audit records of every service, consumed by auth.                                 |
| `DLQ`          | `dlq.>`             | limits    | 14 d    | ∞                  | 2 min        | Dead letters: messages that exceeded max_deliver, at dlq.<stream>.<consumer>.     |

<!-- generated:streams:end -->

### Consumers

Generated from `CONSUMERS`, `ORDERED_CONSUMERS` and `CORE_SUBSCRIPTIONS`. Failed messages are
retried with exponential backoff and copied to `dlq.<stream>.<consumer>` after `max_deliver`.

<!-- generated:consumers:start -->

| Consumer                 | Kind                     | Stream / subject | Filter              | Service       | Purpose                                                                         |
| ------------------------ | ------------------------ | ---------------- | ------------------- | ------------- | ------------------------------------------------------------------------------- |
| `ais-processor`          | durable (max deliver 10) | `AIS_RAW`        | `ais.raw.v1.>`      | ais-processor | Enriches and records raw AIS reports.                                           |
| `emission-positions`     | durable (max deliver 10) | `AIS_POSITION`   | `ais.position.v1.>` | emission      | Builds voyage segments (fuel, CO2, CII) from positions.                         |
| `detection-positions`    | durable (max deliver 10) | `AIS_POSITION`   | `ais.position.v1.>` | detection     | Feeds the transhipment, anomaly, dark, geofence and fishing detectors.          |
| `emission-fuel`          | durable (max deliver 10) | `FUEL`           | `fuel.reading.v1.>` | emission      | Telemetry fuel readings for segment fuel estimation.                            |
| `emission-fleet`         | durable (max deliver 10) | `FLEET`          | `fleet.vessel.v1.>` | emission      | Vessel projection (mmsi → vesselId, orgId) of emission.                         |
| `detection-fleet`        | durable (max deliver 10) | `FLEET`          | `fleet.vessel.v1.>` | detection     | Vessel projection (mmsi → vesselId, orgId) of detection.                        |
| `notification-fleet`     | durable (max deliver 10) | `FLEET`          | `fleet.vessel.v1.>` | notification  | Vessel projection (mmsi → vesselId, orgId) of notification.                     |
| `telemetry-fleet`        | durable (max deliver 10) | `FLEET`          | `fleet.vessel.v1.>` | telemetry     | Vessel projection (mmsi → vesselId, orgId) of telemetry.                        |
| `ais-processor-fleet`    | durable (max deliver 10) | `FLEET`          | `fleet.vessel.v1.>` | ais-processor | Vessel projection (mmsi → vesselId, orgId) of ais-processor.                    |
| `notification-alerts`    | durable (max deliver 10) | `ALERTS`         | `alert.v1.>`        | notification  | Stores alerts in the inbox, applies alert rules and pushes them to clients.     |
| `notification-email`     | durable (max deliver 10) | `NOTIFY`         | `notify.email.v1`   | notification  | Renders and sends transactional e-mails.                                        |
| `auth-audit`             | durable (max deliver 10) | `AUDIT`          | `audit.v1.>`        | auth          | Writes the central audit log.                                                   |
| `notification-positions` | ordered (ephemeral)      | `AIS_POSITION`   | `ais.position.v1.>` | notification  | Realtime position fan-out to WebSocket tile and vessel rooms.                   |
| `notification-cii`       | ordered (ephemeral)      | `EMISSION`       | `emission.cii.v1.>` | notification  | Realtime cii:updated fan-out to organization rooms.                             |
| `telemetry-mqtt`         | core NATS                | —                | `seemp.telemetry.*` | telemetry     | Raw device JSON from MQTT topic seemp/telemetry/<deviceId> (NATS MQTT gateway). |

<!-- generated:consumers:end -->

## Permission matrix

Generated from `ROLE_PERMISSIONS` (spec §8.4).

<!-- generated:permissions:start -->

| Permission         | `super_admin` | `org_admin` | `fleet_manager` | `authority` | `viewer` |
| ------------------ | ------------- | ----------- | --------------- | ----------- | -------- |
| `vessel:read`      | ✓             | ✓           | ✓               | ✓           | ✓        |
| `vessel:write`     | ✓             | ✓           | ✓               |             |          |
| `reference:write`  | ✓             |             |                 |             |          |
| `ais:read`         | ✓             | ✓           | ✓               | ✓           | ✓        |
| `telemetry:read`   | ✓             | ✓           | ✓               |             |          |
| `telemetry:write`  | ✓             | ✓           | ✓               |             |          |
| `device:manage`    | ✓             | ✓           |                 |             |          |
| `cii:read`         | ✓             | ✓           | ✓               |             | ✓        |
| `seemp:read`       | ✓             | ✓           | ✓               |             | ✓        |
| `seemp:simulate`   | ✓             | ✓           | ✓               |             |          |
| `detection:read`   | ✓             | ✓           | ✓               | ✓           | ✓        |
| `detection:review` | ✓             |             |                 | ✓           |          |
| `zone:read`        | ✓             | ✓           | ✓               | ✓           | ✓        |
| `zone:write`       | ✓             | ✓           |                 | ✓           |          |
| `alert:read`       | ✓             | ✓           | ✓               | ✓           | ✓        |
| `alert:ack`        | ✓             | ✓           | ✓               | ✓           |          |
| `alert_rule:write` | ✓             | ✓           | ✓               | ✓           |          |
| `user:manage`      | ✓             | ✓           |                 |             |          |
| `org:manage`       | ✓             |             |                 |             |          |
| `api_key:manage`   | ✓             | ✓           |                 |             |          |
| `audit:read`       | ✓             | ✓           |                 |             |          |
| `report:read`      | ✓             | ✓           | ✓               |             |          |

API key scopes: `ais:ingest`, `telemetry:ingest`, `ais:read`.

<!-- generated:permissions:end -->

## JSON Schema and AsyncAPI

`pnpm run schemas` regenerates the committed artifacts from the zod schemas:

- `schemas/<event type>.json` — JSON Schema (draft 2020-12) of every payload, plus
  `schemas/event-envelope.json`;
- `asyncapi.json` — AsyncAPI 3.0 document with every channel (subject), message (envelope +
  payload, with an example) and producer/consumer operation;
- the catalog tables of this README.

`pnpm run schemas:check` fails when an artifact is outdated (run in CI). The schemas describe what
consumers accept: unknown members are allowed and ignored.

## Versioning

- The package follows [semantic versioning](https://semver.org). Breaking changes of an exported
  TypeScript API require a major version.
- **Event types are versioned by their `.vN` suffix and never changed incompatibly.** A compatible
  change (a new optional member, a new enum value consumers can ignore) keeps the type and ships in
  a minor release; anything else is a new type (`….v2`) published side by side until every
  consumer has migrated.
- Removing an event type, a permission, a role or an error code is a major change.
- Consumers ignore (strip) unknown payload members, so producers may be upgraded first.

## Development

```bash
pnpm build          # tsup: dist/ (ESM .js, CJS .cjs, .d.ts/.d.cts)
pnpm test           # vitest
pnpm typecheck      # tsc (sources, tests, scripts) + the isomorphic build config
pnpm lint
pnpm run schemas    # JSON Schemas, asyncapi.json, README tables
pnpm check:package  # dist smoke test (ESM + CJS), publint, are-the-types-wrong
```

## License

UNLICENSED — private. Use and modification are restricted to authorized users only.
