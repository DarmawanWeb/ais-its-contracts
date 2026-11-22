# @darmawanweb/ais-its-contracts

Shared, **isomorphic** contracts of **AIS Maritime Intelligence** v2 — the single TypeScript source
of truth for everything that crosses a process boundary:

- **events** — the NATS JetStream event envelope, event types, payload schemas (zod 4), streams,
  durable consumers and subject builders (spec §7);
- **auth** — roles, permissions and the role matrix, API key format and scopes, access token claims,
  auth constants and tenancy helpers (spec §8);
- **domain** — AIS navstatus codes with English/Indonesian labels, EWS status and collision risk,
  the alert type registry, zone kinds and GeoJSON geometries, CII grades (legacy parity), haversine
  distance (legacy parity), unit helpers and UUID v7 ids;
- **realtime** — the socket.io protocol of the notification service: event names, message schemas,
  typed event maps, rooms and slippy-map tile math (spec §9);
- **api** — RFC 9457 problem details, shared error codes, pagination envelopes and ISO-8601
  timestamps (spec §5);
- **references** — the methodology catalog (spec §17): typed references and methods, the catalog
  shipped with this version (`REFERENCES`, `METHODS`), lookups and catalog validation.

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
pnpm add @darmawanweb/ais-its-contracts
```

Inside the central repository the package is consumed through the pnpm workspace and needs no
token. In GitHub Actions, `actions/setup-node` with `registry-url: https://npm.pkg.github.com`,
`scope: '@darmawanweb'` and `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` does the same.

Upgrading from `@darmawanweb/seemp-contracts` 0.1? Replace the package name in `package.json` and
in every import, then follow the breaking changes of 0.2.0 in the
[CHANGELOG](../../CHANGELOG.md).

## Entry points

| Import                                      | Contents                                                          |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `@darmawanweb/ais-its-contracts`            | everything below                                                  |
| `@darmawanweb/ais-its-contracts/events`     | envelope, event types, payloads, streams, consumers, subjects     |
| `@darmawanweb/ais-its-contracts/auth`       | roles, permissions, API keys, token claims, tenancy               |
| `@darmawanweb/ais-its-contracts/domain`     | AIS, EWS, collision risk, alert types, zones, GeoJSON, CII, units |
| `@darmawanweb/ais-its-contracts/realtime`   | socket.io events, schemas, rooms, tiles                           |
| `@darmawanweb/ais-its-contracts/api`        | problem details, error codes, pagination, timestamps              |
| `@darmawanweb/ais-its-contracts/references` | methodology catalog: references, methods, lookups, validation     |

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
} from '@darmawanweb/ais-its-contracts/events';

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
const { name, subjects: filters, maxAgeMs } = STREAMS.SAFETY; // 7 d, 1 message per subject
const durable = CONSUMERS['safety-positions'];
subjects.aisPosition(525005223); // "ais.position.v1.7.525005223" (mmsi % 16)
subjects.aisPositionPartitionFilter(7); // "ais.position.v1.7.>"
subjects.safetyState(525005223); // "safety.state.v1.525005223"
subjects.geoZone(zoneId); // "geo.zone.v1.<zoneId>"

// Consumer: staged validation tells what to do with a bad message.
const result = parseEnvelope(msg.data);
if (!result.success) {
  logger.warn({ reason: result.reason, issues: result.issues }, result.message);
  msg.term(); // invalid_json | invalid_envelope | invalid_payload (unknown_type: newer producer)
} else if (result.envelope.type === EVENT_TYPES.SAFETY_VESSEL_STATE_UPDATED) {
  handle(result.envelope.data); // typed SafetyVesselStateV1
}
```

`CONSUMERS` entries keep their literal types (since 0.4.0): `eventTypes` is a tuple of event type
literals, so the kit's `ConsumerEnvelope<'notification-fleet'>` is exactly
`fleet.vessel.upserted.v1 | fleet.vessel.deleted.v1` and a `switch (event.type)` over it is
exhaustive. Declare a consumer that `CONSUMERS` does not list yet with the builders, never with a
`: DurableConsumerDefinition` annotation (that widens `eventTypes` to every event type):

```ts
import {
  defineDurableConsumer,
  DEFAULT_MAX_DELIVER,
  EVENT_TYPES,
  fleetProjectionConsumer,
  positionFeedConsumer,
  SUBJECT_FILTERS,
  zoneProjectionConsumer,
} from '@darmawanweb/ais-its-contracts/events';

export const POSITIONS = positionFeedConsumer(
  'speed-limit-positions',
  'speed-limit',
  'Feeds the speed limit detector.',
); // stream AIS_POSITION, eventTypes ['ais.position.recorded.v1']
export const FLEET = fleetProjectionConsumer(
  'speed-limit-fleet',
  'speed-limit',
);
export const ZONES = zoneProjectionConsumer('speed-limit-zones', 'speed-limit');
export const ALERTS = defineDurableConsumer({
  durableName: 'speed-limit-alerts',
  stream: 'ALERTS',
  filterSubjects: [SUBJECT_FILTERS.ALERT],
  service: 'speed-limit',
  eventTypes: [EVENT_TYPES.ALERT_RAISED, EVENT_TYPES.ALERT_RESOLVED],
  maxDeliver: DEFAULT_MAX_DELIVER,
  description: 'Keeps the speed limit dashboard in sync with the alerts.',
});
```

### Alerts: the alert type registry

Every `alert.raised.v1` carries its `domain` (`safety` | `surveillance`) and the `methodId` of the
rule that raised it. Alert types live in the `ALERT_TYPES` registry; a detector that raises a new
type adds it there in a minor release. Consumers MUST accept unknown types: `AlertTypeSchema` parses
any lowercase token, so an older consumer keeps working when a newer detector raises a new type.

```ts
import {
  ALERT_TYPES,
  alertTypeLabel,
  collisionRiskAlertSeverity,
  defaultAlertSeverity,
  ewsAlertSeverity,
  isKnownAlertType,
} from '@darmawanweb/ais-its-contracts/domain';

ALERT_TYPES.collision.domain; // "safety"
defaultAlertSeverity('collision', 'high'); // "critical" (medium → "warning", low → null)
ewsAlertSeverity(0); // "critical": EWS danger
collisionRiskAlertSeverity('medium'); // "warning"
alertTypeLabel(alert.type, 'id'); // "Risiko tubrukan"; unknown types are shown by their id
if (!isKnownAlertType(alert.type)) renderGeneric(alert); // a type from a newer detector
```

**Resolutions (`alert.resolved.v1`, since 0.4.0).** When a detector ends an occurrence, safety and
surveillance publish `AlertResolvedV1` on the **raise's subject** `alert.v1.<alertType>.<mmsi>`
(stream `ALERTS`, so a durable consumer receives the raise before its resolution), with the
envelope id as `Nats-Msg-Id`. The payload repeats the occurrence's identity (`alertId` of the last
published raise, `type`, `domain`, `severity` = the highest published, `mmsi`, `relatedMmsi`,
`zoneId`, `dedupKey`, `methodId`) and adds `openedAt`, `resolvedAt`, `reason` (at most
`ALERT_RESOLUTION_REASON_MAX_LENGTH` = 500 characters) and `data`. Producers publish it only once
the alert cooldown since the last raise has passed (a re-raise within it cancels the resolution),
so it never contradicts an alert the detector still holds open. The consumer contract:

- resolve the **unresolved** (open or acknowledged) inbox alert with that `dedupKey`, setting
  `resolvedAt`, a system resolver and the `reason`;
- do nothing when the alert merged an occurrence **later** than `resolvedAt` (a newer raise won),
  or when there is no unresolved alert with that key;
- be idempotent by event id and run no alert-rule deliveries for it.

`CONSUMERS['notification-alerts']` delivers both `alert.raised.v1` and `alert.resolved.v1`.

### Zones and safety states

```ts
import {
  countGeometryPositions,
  geometryBBox,
  ZONE_MAX_VERTICES,
  zoneProperties,
} from '@darmawanweb/ais-its-contracts/domain';
import { ZoneSnapshotV1Schema } from '@darmawanweb/ais-its-contracts/events';
import {
  tileRoomForPosition,
  toRealtimeSafetyState,
  vesselRoom,
} from '@darmawanweb/ais-its-contracts/realtime';

const zone = ZoneSnapshotV1Schema.parse(data); // GeoJSON geometry in WGS84, kind, bufferM, …
countGeometryPositions(zone.geometry) <= ZONE_MAX_VERTICES; // 50 000 (geo service input rule)
geometryBBox(zone.geometry); // [minLon, minLat, maxLon, maxLat]
zoneProperties(zone).depthM; // typed per kind (ZONE_PROPERTY_SCHEMAS); invalid keys read as missing

// Notification gateway: SafetyVesselStateV1 has no coordinates, so it is pushed at the
// latest known position of the vessel (from AIS_POSITION).
const item = toRealtimeSafetyState(state, latestPosition);
io.to(vesselRoom(item.mmsi)).emit('vessel:safety', item); // immediately
batches.add(tileRoomForPosition(item.lon, item.lat), item); // 'safety:states' every 1 s
```

### Authorization

```ts
import {
  AccessTokenClaimsSchema,
  canAccessOrg,
  hashApiKey,
  parseApiKey,
  permissionsForRoles,
  userPrincipalFromClaims,
} from '@darmawanweb/ais-its-contracts/auth';

const claims = AccessTokenClaimsSchema.parse(jwtPayload); // after jose jwtVerify (iss "ais-its-auth")
const principal = userPrincipalFromClaims(claims);
permissionsForRoles(principal.roles).has('surveillance:review');
canAccessOrg(principal, vessel.orgId); // tenant-private rule of spec 8.5

parseApiKey(apiKeyHeader); // { id, secret, prefix: 'sk_<id>' } | null
await hashApiKey(apiKeyHeader); // api_keys.key_hash: SHA-256 hex (WebCrypto, async); TypeError for a non-key
```

`hashApiKey` (with `API_KEY_HASH_ALGORITHM` = `'SHA-256'`) is the single definition of the stored
key hash, for the auth service and every client that looks keys up; it works in Node.js and
browsers and never puts the key into an error message.

### Domain helpers with legacy parity

```ts
import {
  assignCiiGrade,
  ciiCapacity,
  classifyEwsStatus,
  haversineDistance,
  knotsToMs,
  navStatusLabel,
  newId,
} from '@darmawanweb/ais-its-contracts/domain';

haversineDistance(previous, current); // { nm, meters } with R = 3438 nm (legacy calculateDistance; alias legacyHaversineDistance)
assignCiiGrade(attained / required, vesselType.d); // 'A'..'E' (legacy assignGradeBasedOnDdVector)
ciiCapacity(vessel); // type.capacityFixed ?? dimensions.capacity (spec 13.5)
classifyEwsStatus(distanceM, predictedNavstatus); // 0 | 1 | 3 (legacy checkShipStatus)
knotsToMs(12); // legacy factor 0.5144
navStatusLabel(1, 'id'); // "Berlabuh jangkar"
newId(); // UUID v7
```

**Fuel formulas** (vessel fuel curves of fleet, evaluated by emission; method
`fuel.first_formula`): one grammar for both services — numbers, `speedKnot`, `+ - * / ^`
(right-associative, binding tighter than unary minus: `-2 ^ 2` is `-4`), parentheses and `exp`, `log`/`ln`, `sqrt`, `abs` (one argument),
`pow` (two) and the variadic `min`/`max`, within `FUEL_FORMULA_LIMITS` (500 characters, depth 32,
500 tokens; literals must be finite).

```ts
import {
  evaluateFuelFormula,
  FuelFormulaSyntaxError,
  parseFuelFormula,
  validateFuelFormula,
} from '@darmawanweb/ais-its-contracts/domain';

validateFuelFormula('0.02 * speedKnot ^ 3 + 1.5'); // { valid: true, errors: [] }
validateFuelFormula('pow(speedKnot)'); // { valid: false, errors: [{ message: 'pow() takes 2 arguments, got 1 at position 0', position: 0 }] }
const formula = parseFuelFormula(vessel.fuelFormula); // parse once (throws FuelFormulaSyntaxError { reason, position })
evaluateFuelFormula(formula, { speedKnot: 11.5 }); // raw IEEE result (t/day); check Number.isFinite
```

### Realtime (socket.io)

```ts
import { io, type Socket } from 'socket.io-client';
import {
  REALTIME_PATH,
  type RealtimeClientToServerEvents,
  type RealtimeServerToClientEvents,
  roomsForViewport,
} from '@darmawanweb/ais-its-contracts/realtime';

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
socket.on('positions', ({ items }) => drawVessels(items)); // RealtimePosition[]
socket.on('safety:states', ({ items }) => colourBySafety(items)); // RealtimeSafetyState[]

// Server side: rooms for a viewport (zoom-6 tiles, or tile:all above 64 tiles).
roomsForViewport([94.5, -11.5, 141.5, 6.5]); // { mode: 'tiles', rooms: ['tile:6:48:30', …] }
```

**Fan-out between notification instances (since 0.4.0).** socket.io clients are connected to
different notification replicas, so an `alert:raised` / `alert:updated` push is first published
on the core NATS subject `aisits.notification.realtime.v1` (`subjects.notificationRealtime()`,
core subscription `notification-realtime-fanout` with `delivery: 'fanout'`: every instance
receives every message, no queue group) and each instance emits it to its own sockets. The payload
is `RealtimeAlertFanoutSchema`: `event` (`'alert:raised'` or `'alert:updated'`), `rooms` (1 to 16 room names) and `alert` (a `RealtimeAlert`); `CORE_SUBSCRIPTION_PAYLOADS[name]` maps every core subscription to its
payload schema, which the kit validates before calling the handler.

```ts
import {
  CORE_SUBSCRIPTIONS,
  coreSubscriptionDelivery,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { RealtimeAlertFanoutSchema } from '@darmawanweb/ais-its-contracts/realtime';

const fanout = CORE_SUBSCRIPTIONS.find(
  ({ name }) => name === 'notification-realtime-fanout',
);
coreSubscriptionDelivery(fanout!); // 'fanout' (a definition without delivery: 'queue')
nc.publish(
  subjects.notificationRealtime(),
  JSON.stringify(
    RealtimeAlertFanoutSchema.parse({ event: 'alert:updated', rooms, alert }),
  ),
);
```

### HTTP conventions

```ts
import {
  PROBLEM_CONTENT_TYPE,
  createProblem,
  issuesToFieldErrors,
  PageQuerySchema,
  toPaginated,
} from '@darmawanweb/ais-its-contracts/api';

reply
  .type(PROBLEM_CONTENT_TYPE)
  .status(404)
  .send(
    createProblem('VESSEL_NOT_FOUND', {
      detail: 'No vessel with MMSI 525005223',
    }),
  ); // type "urn:ais-its:problem:vessel-not-found"

const query = PageQuerySchema.parse(request.query); // { page: 1, pageSize: 20 } by default
toPaginated(rows, query, total); // { data, meta: { page, pageSize, total } }
```

Platform-wide operations (e.g. republishing every vessel or zone) answer
`403 PLATFORM_ADMIN_REQUIRED` ("Platform administrator required", since 0.4.0) to anyone but a
platform administrator; the kit's `@RequirePlatformAdmin()` produces it.

### Methodology catalog

```ts
import {
  getMethod,
  methodsByDomain,
  referencesOfMethod,
  validateCatalog,
} from '@darmawanweb/ais-its-contracts/references';

getMethod('cii.attained')?.formulaLatex; // rendered with KaTeX by the web app
methodsByDomain('safety'); // methods of a domain, in catalog order
referencesOfMethod('cii.attained'); // sources of the method and of its constants
validateCatalog({ references, methods }); // schema, unique ids, no dangling referenceIds
```

## Methodology catalog (`./references`)

The single source of truth of the catalog is `docs/references/references.json` and
`docs/references/methods.json` in the central repository (spec §17). `pnpm run references:sync`
copies them into the package:

1. reads both files — each a JSON array, or an object holding the array under `references` /
   `methods` next to a `$schema` member (`--from <dir>` overrides the default
   `../../../../docs/references`, i.e. the central repository in which this repository is checked
   out at `packages/ais-its-contracts`);
2. validates them with `validateCatalog`: the zod schemas `ReferenceSchema` / `MethodSchema`
   (optional members get their defaults), unique ids, no dangling `referenceIds` (of methods and of
   their constants) and traceability — every method cites a reference or is marked
   `needsCitation`;
3. writes the generated data modules `src/references/data/{references,methods}.ts` behind
   `REFERENCES` and `METHODS` (nothing is written when a check fails).

`pnpm run references:check` fails when the data modules differ from the catalog. Ids are lowercase
tokens joined by `.`, `_` or `-` (`cii.attained`, `imo-mepc-353-78`); `domain`, `status`, the
reference `type` and `verification` are open vocabularies (known values have labels, new values
are accepted). Editors can validate the catalog files with the generated JSON Schemas
`schemas/methodology.references.json` and `schemas/methodology.methods.json`.

**Statuses** (`METHOD_STATUSES`): `implemented` — the rule runs in a service (or in this package);
`implementedBy` names its owner and the module, as `<path>[#<symbol>][ (<remark>)]` relative to the
owner's root (`services/<owner>/`, or this package for owner `contracts`); `not_implemented` — a
documented method no service runs (yet); `planned` — kept for compatibility, no catalogued method
uses it since 0.4.0. Domains (`METHOD_DOMAINS`) include `notification` and `security` since 0.4.0.

`pnpm run references:verify [--services <dir>] [--from <dir>]` checks the catalog against the code
of the central repository (default `../../../../services`): every `implemented` method's module and
symbol exist and carry its `@method <id>` TSDoc tag, every tag names a catalogued method, a tagged
method is not left `planned` / `not_implemented`, and every implemented method has an owner. It
exits 1 and lists each problem (CI of the central repository runs it after the services carry
their tags).

## Event catalog

Generated from `EVENT_CATALOG`, `CONSUMERS` and `ORDERED_CONSUMERS`.

<!-- generated:events:start -->

| Event type                       | Payload                 | Subject                              | Stream         | Producers            | Consumers                                                                                                              |
| -------------------------------- | ----------------------- | ------------------------------------ | -------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ais.raw.received.v1`            | `AisRawReceivedV1`      | `ais.raw.v1.{source}`                | `AIS_RAW`      | ais-ingestor         | `ais-processor`                                                                                                        |
| `ais.position.recorded.v1`       | `AisPositionRecordedV1` | `ais.position.v1.{partition}.{mmsi}` | `AIS_POSITION` | ais-processor        | `emission-positions`, `safety-positions`, `surveillance-positions`, `notification-positions` (ordered)                 |
| `fuel.reading.recorded.v1`       | `FuelReadingRecordedV1` | `fuel.reading.v1.{mmsi}`             | `FUEL`         | telemetry            | `emission-fuel`                                                                                                        |
| `fleet.vessel.upserted.v1`       | `VesselSnapshotV1`      | `fleet.vessel.v1.{vesselId}`         | `FLEET`        | fleet                | `emission-fleet`, `safety-fleet`, `surveillance-fleet`, `notification-fleet`, `telemetry-fleet`, `ais-processor-fleet` |
| `fleet.vessel.deleted.v1`        | `VesselDeletedV1`       | `fleet.vessel.v1.{vesselId}`         | `FLEET`        | fleet                | `emission-fleet`, `safety-fleet`, `surveillance-fleet`, `notification-fleet`, `telemetry-fleet`, `ais-processor-fleet` |
| `geo.zone.upserted.v1`           | `ZoneSnapshotV1`        | `geo.zone.v1.{zoneId}`               | `GEO`          | geo                  | `safety-zones`, `surveillance-zones`                                                                                   |
| `geo.zone.deleted.v1`            | `ZoneDeletedV1`         | `geo.zone.v1.{zoneId}`               | `GEO`          | geo                  | `safety-zones`, `surveillance-zones`                                                                                   |
| `safety.vessel_state.updated.v1` | `SafetyVesselStateV1`   | `safety.state.v1.{mmsi}`             | `SAFETY`       | safety               | `notification-safety` (ordered)                                                                                        |
| `emission.cii.updated.v1`        | `CiiUpdatedV1`          | `emission.cii.v1.{mmsi}`             | `EMISSION`     | emission             | `notification-cii` (ordered)                                                                                           |
| `alert.raised.v1`                | `AlertRaisedV1`         | `alert.v1.{alertType}.{mmsi}`        | `ALERTS`       | safety, surveillance | `notification-alerts`                                                                                                  |
| `alert.resolved.v1`              | `AlertResolvedV1`       | `alert.v1.{alertType}.{mmsi}`        | `ALERTS`       | safety, surveillance | `notification-alerts`                                                                                                  |
| `notify.email.requested.v1`      | `EmailRequestedV1`      | `notify.email.v1`                    | `NOTIFY`       | auth, notification   | `notification-email`                                                                                                   |
| `audit.recorded.v1`              | `AuditRecordedV1`       | `audit.v1.{service}`                 | `AUDIT`        | every service        | `auth-audit`                                                                                                           |

<!-- generated:events:end -->

### Streams

Generated from `STREAMS`.

<!-- generated:streams:start -->

| Stream         | Subjects            | Retention | Max age | Max msgs / subject | Dedup window | Description                                                                                     |
| -------------- | ------------------- | --------- | ------- | ------------------ | ------------ | ----------------------------------------------------------------------------------------------- |
| `AIS_RAW`      | `ais.raw.v1.>`      | limits    | 1 d     | ∞                  | 2 min        | Normalized AIS reports published by the ais-ingestor.                                           |
| `AIS_POSITION` | `ais.position.v1.>` | limits    | 7 d     | ∞                  | 2 min        | Recorded positions partitioned by mmsi % 16 (ais.position.v1.<partition>.<mmsi>).               |
| `FUEL`         | `fuel.reading.v1.>` | limits    | 30 d    | ∞                  | 2 min        | Fuel consumption readings published by telemetry.                                               |
| `FLEET`        | `fleet.vessel.v1.>` | limits    | ∞       | 1                  | 2 min        | Latest vessel snapshot per vessel (projection source for every service).                        |
| `GEO`          | `geo.zone.v1.>`     | limits    | ∞       | 1                  | 2 min        | Latest zone snapshot per zone published by geo (projection source for safety and surveillance). |
| `SAFETY`       | `safety.state.v1.>` | limits    | 7 d     | 1                  | 2 min        | Latest navigational safety state per vessel published by safety.                                |
| `EMISSION`     | `emission.cii.v1.>` | limits    | 30 d    | ∞                  | 2 min        | Year-to-date CII updates published by emission.                                                 |
| `ALERTS`       | `alert.v1.>`        | limits    | 90 d    | ∞                  | 2 min        | Alerts raised by the safety and surveillance detectors (alert.v1.<alertType>.<mmsi>).           |
| `NOTIFY`       | `notify.email.v1`   | workqueue | 7 d     | ∞                  | 2 min        | Transactional e-mail requests (work queue).                                                     |
| `AUDIT`        | `audit.v1.>`        | limits    | 30 d    | ∞                  | 2 min        | Audit records of every service, consumed by auth.                                               |
| `DLQ`          | `dlq.>`             | limits    | 14 d    | ∞                  | 2 min        | Dead letters: messages that exceeded max_deliver, at dlq.<stream>.<consumer>.                   |

<!-- generated:streams:end -->

### Consumers

Generated from `CONSUMERS`, `ORDERED_CONSUMERS` and `CORE_SUBSCRIPTIONS`. Failed messages are
retried with exponential backoff and copied to `dlq.<stream>.<consumer>` after `max_deliver`.

<!-- generated:consumers:start -->

| Consumer                       | Kind                       | Stream / subject | Filter                            | Service       | Purpose                                                                                                         |
| ------------------------------ | -------------------------- | ---------------- | --------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `ais-processor`                | durable (max deliver 10)   | `AIS_RAW`        | `ais.raw.v1.>`                    | ais-processor | Enriches and records raw AIS reports.                                                                           |
| `emission-positions`           | durable (max deliver 10)   | `AIS_POSITION`   | `ais.position.v1.>`               | emission      | Builds voyage segments (fuel, CO2, CII) from positions.                                                         |
| `safety-positions`             | durable (max deliver 10)   | `AIS_POSITION`   | `ais.position.v1.>`               | safety        | Feeds the navigational safety detectors (ews, collision).                                                       |
| `surveillance-positions`       | durable (max deliver 10)   | `AIS_POSITION`   | `ais.position.v1.>`               | surveillance  | Feeds the surveillance detectors (transhipment, anomaly, dark, geofence, fishing).                              |
| `emission-fuel`                | durable (max deliver 10)   | `FUEL`           | `fuel.reading.v1.>`               | emission      | Telemetry fuel readings for segment fuel estimation.                                                            |
| `emission-fleet`               | durable (max deliver 10)   | `FLEET`          | `fleet.vessel.v1.>`               | emission      | Vessel projection (mmsi → vesselId, orgId) of emission.                                                         |
| `safety-fleet`                 | durable (max deliver 10)   | `FLEET`          | `fleet.vessel.v1.>`               | safety        | Vessel projection (mmsi → vesselId, orgId) of safety.                                                           |
| `surveillance-fleet`           | durable (max deliver 10)   | `FLEET`          | `fleet.vessel.v1.>`               | surveillance  | Vessel projection (mmsi → vesselId, orgId) of surveillance.                                                     |
| `notification-fleet`           | durable (max deliver 10)   | `FLEET`          | `fleet.vessel.v1.>`               | notification  | Vessel projection (mmsi → vesselId, orgId) of notification.                                                     |
| `telemetry-fleet`              | durable (max deliver 10)   | `FLEET`          | `fleet.vessel.v1.>`               | telemetry     | Vessel projection (mmsi → vesselId, orgId) of telemetry.                                                        |
| `ais-processor-fleet`          | durable (max deliver 10)   | `FLEET`          | `fleet.vessel.v1.>`               | ais-processor | Vessel projection (mmsi → vesselId, orgId) of ais-processor.                                                    |
| `safety-zones`                 | durable (max deliver 10)   | `GEO`            | `geo.zone.v1.>`                   | safety        | Zone projection with a spatial index (ZoneIndex) of safety.                                                     |
| `surveillance-zones`           | durable (max deliver 10)   | `GEO`            | `geo.zone.v1.>`                   | surveillance  | Zone projection with a spatial index (ZoneIndex) of surveillance.                                               |
| `notification-alerts`          | durable (max deliver 10)   | `ALERTS`         | `alert.v1.>`                      | notification  | Stores alerts in the inbox, applies alert rules and pushes them to clients; resolves them on alert.resolved.v1. |
| `notification-email`           | durable (max deliver 10)   | `NOTIFY`         | `notify.email.v1`                 | notification  | Renders and sends transactional e-mails.                                                                        |
| `auth-audit`                   | durable (max deliver 10)   | `AUDIT`          | `audit.v1.>`                      | auth          | Writes the central audit log.                                                                                   |
| `notification-positions`       | ordered (ephemeral)        | `AIS_POSITION`   | `ais.position.v1.>`               | notification  | Realtime position fan-out to WebSocket tile and vessel rooms.                                                   |
| `notification-safety`          | ordered (ephemeral)        | `SAFETY`         | `safety.state.v1.>`               | notification  | Realtime safety:states / vessel:safety fan-out to tile and vessel rooms.                                        |
| `notification-cii`             | ordered (ephemeral)        | `EMISSION`       | `emission.cii.v1.>`               | notification  | Realtime cii:updated fan-out to organization rooms.                                                             |
| `telemetry-mqtt`               | core NATS (queue group)    | —                | `aisits.telemetry.*`              | telemetry     | Raw device JSON from MQTT topic aisits/telemetry/<deviceId> (NATS MQTT gateway).                                |
| `notification-realtime-fanout` | core NATS (every instance) | —                | `aisits.notification.realtime.v1` | notification  | alert:raised / alert:updated pushes fanned out to every notification instance (Socket.IO rooms).                |

<!-- generated:consumers:end -->

### Alert types

Generated from `ALERT_TYPES` (spec §7.3). Severity by level maps the graded outcome of a detector
to the severity of the alert it raises; levels that are not listed raise none.

<!-- generated:alert-types:start -->

| Alert type     | Domain       | Default severity | Severity by level                    | Label (en / id)                                            |
| -------------- | ------------ | ---------------- | ------------------------------------ | ---------------------------------------------------------- |
| `ews`          | safety       | warning          | danger → critical, warning → warning | Pipeline early warning / Peringatan dini pipa bawah laut   |
| `collision`    | safety       | warning          | high → critical, medium → warning    | Collision risk / Risiko tubrukan                           |
| `transhipment` | surveillance | warning          | —                                    | Illegal transhipment / Transhipment ilegal                 |
| `anomaly`      | surveillance | info             | —                                    | Navigational status anomaly / Anomali status navigasi      |
| `dark`         | surveillance | warning          | —                                    | AIS gap (dark vessel) / AIS terputus (kapal gelap)         |
| `geofence`     | surveillance | warning          | —                                    | Zone entry / Memasuki zona                                 |
| `fishing`      | surveillance | warning          | —                                    | Suspected illegal fishing / Dugaan penangkapan ikan ilegal |

<!-- generated:alert-types:end -->

## Permission matrix

Generated from `ROLE_PERMISSIONS` (spec §8.4).

<!-- generated:permissions:start -->

| Permission            | `super_admin` | `org_admin` | `fleet_manager` | `authority` | `viewer` |
| --------------------- | ------------- | ----------- | --------------- | ----------- | -------- |
| `vessel:read`         | ✓             | ✓           | ✓               | ✓           | ✓        |
| `vessel:write`        | ✓             | ✓           | ✓               |             |          |
| `reference:write`     | ✓             |             |                 |             |          |
| `ais:read`            | ✓             | ✓           | ✓               | ✓           | ✓        |
| `telemetry:read`      | ✓             | ✓           | ✓               |             |          |
| `telemetry:write`     | ✓             | ✓           | ✓               |             |          |
| `device:manage`       | ✓             | ✓           |                 |             |          |
| `cii:read`            | ✓             | ✓           | ✓               |             | ✓        |
| `seemp:read`          | ✓             | ✓           | ✓               |             | ✓        |
| `seemp:simulate`      | ✓             | ✓           | ✓               |             |          |
| `safety:read`         | ✓             | ✓           | ✓               | ✓           | ✓        |
| `surveillance:read`   | ✓             | ✓           | ✓               | ✓           | ✓        |
| `surveillance:review` | ✓             |             |                 | ✓           |          |
| `zone:read`           | ✓             | ✓           | ✓               | ✓           | ✓        |
| `zone:write`          | ✓             | ✓           |                 | ✓           |          |
| `alert:read`          | ✓             | ✓           | ✓               | ✓           | ✓        |
| `alert:ack`           | ✓             | ✓           | ✓               | ✓           |          |
| `alert_rule:write`    | ✓             | ✓           | ✓               | ✓           |          |
| `user:manage`         | ✓             | ✓           |                 |             |          |
| `org:manage`          | ✓             |             |                 |             |          |
| `api_key:manage`      | ✓             | ✓           |                 |             |          |
| `audit:read`          | ✓             | ✓           |                 |             |          |
| `report:read`         | ✓             | ✓           | ✓               |             |          |

API key scopes: `ais:ingest`, `telemetry:ingest`, `ais:read`.

<!-- generated:permissions:end -->

## JSON Schema and AsyncAPI

`pnpm run schemas` regenerates the committed artifacts from the zod schemas:

- `schemas/<event type>.json` — JSON Schema (draft 2020-12, `$id` `urn:ais-its:schema:events:<type>`)
  of every payload, plus `schemas/event-envelope.json`;
- `schemas/methodology.{references,methods}.json` — JSON Schemas of the methodology catalog files;
- `asyncapi.json` — AsyncAPI 3.0 document with every channel (subject), message (envelope +
  payload, with an example) and producer/consumer operation (extensions `x-ais-its-*`);
- the catalog tables of this README.

`pnpm run schemas:check` fails when an artifact is outdated (run in CI). The schemas describe what
consumers accept: unknown members are allowed and ignored.

## Versioning

- The package follows [semantic versioning](https://semver.org). Breaking changes of an exported
  TypeScript API require a major version (a minor version while the package is `0.x`).
- **Event types are versioned by their `.vN` suffix and never changed incompatibly.** A compatible
  change (a new optional member, a new enum value consumers can ignore) keeps the type and ships in
  a minor release; anything else is a new type (`….v2`) published side by side until every
  consumer has migrated.
- New alert types are compatible: they are added to `ALERT_TYPES` in a minor release and older
  consumers parse them as plain strings.
- Removing an event type, a permission, a role or an error code is a major change.
- Consumers ignore (strip) unknown payload members, so producers may be upgraded first.
- A **new event type** is a minor release, but a consumer that should act on it must be upgraded
  before its producers: the kit acknowledges and skips event types a consumer version does not know
  (e.g. `alert.resolved.v1` in 0.4.0: upgrade notification before safety and surveillance).

## Development

```bash
pnpm build             # tsup: dist/ (ESM .js, CJS .cjs, .d.ts/.d.cts)
pnpm test              # vitest
pnpm typecheck         # tsc (sources, tests, scripts) + the isomorphic build config
pnpm lint
pnpm run schemas       # JSON Schemas, asyncapi.json, README tables
pnpm references:sync   # copy docs/references/*.json of the central repository (validated)
pnpm references:verify # catalog against the services' @method tags and implementedBy modules
pnpm check:package     # dist smoke test (ESM + CJS), publint, are-the-types-wrong
```

## License

UNLICENSED — private. Use and modification are restricted to authorized users only.
