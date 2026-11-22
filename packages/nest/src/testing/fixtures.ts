import {
  type GeoJsonGeometry,
  newId,
  type ZoneKind,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  type AlertRaisedV1,
  AlertRaisedV1Schema,
  type AlertResolvedV1,
  AlertResolvedV1Schema,
  type VesselSnapshotV1,
  VesselSnapshotV1Schema,
  type ZoneSnapshotV1,
  ZoneSnapshotV1Schema,
} from '@darmawanweb/ais-its-contracts/events';

// Builders of valid contract payloads for tests (no container, no Nest):
// zone and vessel snapshots of the GEO and FLEET streams and alert events.
// Every builder validates its result with the contracts schema, so an
// override that breaks the contract fails the test at once.

/** Default time of the builders: 2026-01-01T00:00:00.000Z. */
const DEFAULT_START = new Date('2026-01-01T00:00:00.000Z');

/** A synthetic zone: `geometry` is required (and `kind`, default `custom`). */
export type TestZoneInput = Pick<ZoneSnapshotV1, 'geometry'> &
  Partial<Omit<ZoneSnapshotV1, 'geometry'>>;

/** A valid `ZoneSnapshotV1` from a geometry and overrides (validated with the contracts schema). */
export function makeTestZone(
  input: TestZoneInput,
  updatedAt: Date = DEFAULT_START,
): ZoneSnapshotV1 {
  const id = input.id ?? newId();
  const kind: ZoneKind = input.kind ?? 'custom';
  const geometry: GeoJsonGeometry = input.geometry;
  return ZoneSnapshotV1Schema.parse({
    id,
    orgId: input.orgId ?? null,
    code: input.code ?? `${kind}-${id.slice(-8)}`,
    name: input.name ?? `Test ${kind} zone`,
    kind,
    geometry,
    bufferM: input.bufferM ?? 0,
    active: input.active ?? true,
    alertOnEnter: input.alertOnEnter ?? false,
    properties: input.properties ?? {},
    updatedAt: input.updatedAt ?? updatedAt.toISOString(),
  });
}

/**
 * A valid `VesselSnapshotV1` (a 52 000 DWT bulk carrier) with overrides,
 * validated with the contracts schema; nested objects are replaced, not merged.
 */
export function makeTestVesselSnapshot(
  overrides: Partial<VesselSnapshotV1> & Pick<VesselSnapshotV1, 'mmsi'>,
): VesselSnapshotV1 {
  return VesselSnapshotV1Schema.parse({
    id: newId(),
    orgId: null,
    imo: null,
    name: `Test vessel ${overrides.mmsi}`,
    flag: 'ID',
    builtYear: 2010,
    status: 'active',
    annualVoyagePercentage: 70,
    dimensions: {
      capacity: 52_000,
      dwt: 52_000,
      gt: 31_200,
      cb: 0.82,
      lwl: 186.5,
      b: 32.26,
      t: 12.1,
      cwp: 0.89,
      loa: 189.99,
      lpp: 182,
      cp: 0.83,
      cm: 0.99,
      cbnsp: 0.81,
      bulbousBow: true,
      cstern: 0,
      c1: 2.12,
      c2: 1,
      c3: 1,
      c5: 1,
      vs: 14.2,
    },
    type: {
      id: newId(),
      code: 'bulk_carrier',
      name: 'Bulk carrier',
      capacityUnit: 'DWT',
      a: 4745,
      c: 0.622,
      capacityFixed: null,
      d: { d1: 0.86, d2: 0.94, d3: 1.06, d4: 1.18 },
    },
    fuel: {
      id: newId(),
      code: 'HFO',
      name: 'Heavy fuel oil',
      carbonContent: 0.8493,
      conversionFactor: 3.114,
      density: 0.991,
    },
    mainEngine: null,
    auxEngines: [],
    auxEngineQuantity: 0,
    firstFuelFormula: null,
    portIds: [],
    updatedAt: DEFAULT_START.toISOString(),
    ...overrides,
  });
}

/** The zone of the default test alerts (`zoneId`). */
const TEST_ALERT_ZONE_ID = '0193a3c0-0000-7000-8000-0000000000e1';

/** The vessel of the default test alerts. */
const TEST_ALERT_MMSI = 525_005_223;

/**
 * A valid `alert.raised.v1` payload (an EWS warning: a vessel predicted at
 * anchor 1.2 km from a pipeline) with overrides, validated with the
 * contracts schema (for a registry `type`, `domain` must match it). The
 * default `dedupKey` is `ews:<mmsi>:<zoneId>` of the final values.
 *
 * @example
 * const alert = makeTestAlertRaised({ mmsi: 525100001, severity: 'critical' });
 * await publisher.publishEvent(EVENT_TYPES.ALERT_RAISED, alert, { id: alert.id });
 */
export function makeTestAlertRaised(
  overrides: Partial<AlertRaisedV1> = {},
): AlertRaisedV1 {
  const mmsi = overrides.mmsi ?? TEST_ALERT_MMSI;
  const zoneId =
    overrides.zoneId === undefined ? TEST_ALERT_ZONE_ID : overrides.zoneId;
  return AlertRaisedV1Schema.parse({
    id: newId(),
    type: 'ews',
    domain: 'safety',
    severity: 'warning',
    mmsi,
    relatedMmsi: null,
    title: 'Anchored 1.2 km from the pipeline',
    message: `Vessel ${mmsi} is predicted at anchor near the pipeline`,
    lat: -6.95,
    lon: 112.75,
    occurredAt: DEFAULT_START.toISOString(),
    dedupKey: `ews:${mmsi}:${zoneId ?? 'none'}`,
    zoneId,
    methodId: 'ews.pipeline_distance_status',
    data: { distanceM: 1_200 },
    ...overrides,
  });
}

/**
 * A valid `alert.resolved.v1` payload with overrides, validated with the
 * contracts schema: by default the resolution of
 * {@link makeTestAlertRaised}'s default occurrence (same type, domain,
 * vessel, zone and `dedupKey`), opened at 2026-01-01T00:00:00Z and
 * resolved 10 minutes later. Pass `alertId`, `dedupKey` and the other
 * identifying fields of a raise to resolve it, or use `fromRaise`.
 *
 * @param fromRaise a raise whose identity (`alertId`, type, domain,
 *   severity, vessels, zone, `dedupKey`, `openedAt` = `occurredAt`,
 *   `methodId`) the resolution takes before `overrides`.
 * @example
 * const resolved = makeTestAlertResolved({ reason: 'left the pipeline zone' }, raised);
 */
export function makeTestAlertResolved(
  overrides: Partial<AlertResolvedV1> = {},
  fromRaise?: AlertRaisedV1,
): AlertResolvedV1 {
  const raise = fromRaise ?? makeTestAlertRaised();
  const openedAt = overrides.openedAt ?? raise.occurredAt;
  return AlertResolvedV1Schema.parse({
    id: newId(),
    alertId: raise.id,
    type: raise.type,
    domain: raise.domain,
    severity: raise.severity,
    mmsi: raise.mmsi,
    relatedMmsi: raise.relatedMmsi,
    zoneId: raise.zoneId,
    dedupKey: raise.dedupKey,
    openedAt,
    resolvedAt: new Date(Date.parse(openedAt) + 10 * 60_000).toISOString(),
    reason: 'Condition ended',
    methodId: raise.methodId,
    data: {},
    ...overrides,
  });
}
