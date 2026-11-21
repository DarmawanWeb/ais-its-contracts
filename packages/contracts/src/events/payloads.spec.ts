import { describe, expect, it } from 'vitest';

import { EVENT_EXAMPLES } from './__fixtures__/examples.js';
import { EVENT_SCHEMAS, validateEvent } from './registry.js';
import { type EventType, EVENT_TYPE_LIST } from './types.js';

/** A mutation of the example payload that must be rejected at `path`. */
interface InvalidCase {
  readonly name: string;
  readonly patch: Record<string, unknown>;
  readonly path: string;
}

const INVALID_CASES: Readonly<Record<EventType, readonly InvalidCase[]>> = {
  'ais.raw.received.v1': [
    { name: '8-digit MMSI', patch: { mmsi: 52500522 }, path: 'mmsi' },
    { name: 'string MMSI', patch: { mmsi: '525005223' }, path: 'mmsi' },
    { name: 'unknown source', patch: { source: 'satellite' }, path: 'source' },
    { name: 'lat not available (91)', patch: { lat: 91 }, path: 'lat' },
    { name: 'lon not available (181)', patch: { lon: 181 }, path: 'lon' },
    { name: 'navstatus 16', patch: { navstatus: 16 }, path: 'navstatus' },
    {
      name: 'fractional navstatus',
      patch: { navstatus: 1.5 },
      path: 'navstatus',
    },
    { name: 'heading 400', patch: { hdg: 400 }, path: 'hdg' },
    { name: 'negative sog', patch: { sog: -0.1 }, path: 'sog' },
    { name: 'cog over 360', patch: { cog: 361 }, path: 'cog' },
    {
      name: 'timestamp with offset',
      patch: { positionTime: '2026-11-20T15:30:00+07:00' },
      path: 'positionTime',
    },
    {
      name: 'missing receivedAt',
      patch: { receivedAt: undefined },
      path: 'receivedAt',
    },
    { name: 'aisType missing', patch: { aisType: undefined }, path: 'aisType' },
  ],
  'ais.position.recorded.v1': [
    {
      name: 'predictedNavstatus 2',
      patch: { predictedNavstatus: 2 },
      path: 'predictedNavstatus',
    },
    {
      name: 'ewsStatus 2 (unused code)',
      patch: { ewsStatus: 2 },
      path: 'ewsStatus',
    },
    {
      name: 'negative coast distance',
      patch: { coastDistanceM: -1 },
      path: 'coastDistanceM',
    },
    {
      name: 'previous without time',
      patch: {
        previous: {
          lat: 1.19,
          lon: 103.9,
          sog: 9,
          cog: 70,
          hdg: 70,
          navstatus: 0,
          predictedNavstatus: 0,
        },
      },
      path: 'previous.time',
    },
    {
      name: 'missing previous (must be null)',
      patch: { previous: undefined },
      path: 'previous',
    },
  ],
  'fuel.reading.recorded.v1': [
    { name: 'negative ME fuel', patch: { fuelMeTon: -0.5 }, path: 'fuelMeTon' },
    { name: 'unknown source', patch: { source: 'satellite' }, path: 'source' },
    {
      name: 'non-uuid device',
      patch: { deviceId: 'meter-7' },
      path: 'deviceId',
    },
    {
      name: 'invalid time',
      patch: { time: '2026-02-30T00:00:00Z' },
      path: 'time',
    },
  ],
  'fleet.vessel.upserted.v1': [
    { name: 'non-uuid id', patch: { id: '42' }, path: 'id' },
    { name: 'unknown status', patch: { status: 'scrapped' }, path: 'status' },
    {
      name: 'voyage share over 100 %',
      patch: { annualVoyagePercentage: 120 },
      path: 'annualVoyagePercentage',
    },
    {
      name: 'zero capacity',
      patch: {
        dimensions: {
          ...EVENT_EXAMPLES['fleet.vessel.upserted.v1'].dimensions,
          capacity: 0,
        },
      },
      path: 'dimensions.capacity',
    },
    {
      name: 'capacity unit TEU',
      patch: {
        type: {
          ...EVENT_EXAMPLES['fleet.vessel.upserted.v1'].type,
          capacityUnit: 'TEU',
        },
      },
      path: 'type.capacityUnit',
    },
    {
      name: 'aux engine without sfoc',
      patch: {
        auxEngines: [
          {
            id: '01a1f8c2-54d9-7223-9107-678a5e6c8d7f',
            name: 'AE',
            rpm: 900,
            powerKw: 600,
          },
        ],
      },
      path: 'auxEngines.0.sfoc',
    },
    {
      name: 'port id not a uuid',
      patch: { portIds: ['tanjung-priok'] },
      path: 'portIds.0',
    },
  ],
  'fleet.vessel.deleted.v1': [
    {
      name: 'missing orgId (must be null)',
      patch: { orgId: undefined },
      path: 'orgId',
    },
    { name: 'MMSI too large', patch: { mmsi: 1_000_000_000 }, path: 'mmsi' },
  ],
  'emission.cii.updated.v1': [
    { name: 'grade F', patch: { grade: 'F' }, path: 'grade' },
    { name: 'zero required CII', patch: { required: 0 }, path: 'required' },
    {
      name: 'unknown method',
      patch: { lastMethod: 'guess' },
      path: 'lastMethod',
    },
    { name: 'fractional year', patch: { year: 2026.5 }, path: 'year' },
  ],
  'alert.raised.v1': [
    { name: 'unknown type', patch: { type: 'collision' }, path: 'type' },
    { name: 'unknown severity', patch: { severity: 'high' }, path: 'severity' },
    { name: 'empty dedupKey', patch: { dedupKey: '' }, path: 'dedupKey' },
    { name: 'data is an array', patch: { data: [1, 2] }, path: 'data' },
    {
      name: 'relatedMmsi invalid',
      patch: { relatedMmsi: 123 },
      path: 'relatedMmsi',
    },
  ],
  'notify.email.requested.v1': [
    { name: 'invalid recipient', patch: { to: 'not-an-email' }, path: 'to' },
    {
      name: 'unknown template',
      patch: { template: 'newsletter' },
      path: 'template',
    },
    { name: 'unsupported locale', patch: { locale: 'fr' }, path: 'locale' },
  ],
  'audit.recorded.v1': [
    {
      name: 'action without verb',
      patch: { action: 'vessel' },
      path: 'action',
    },
    {
      name: 'action in upper case',
      patch: { action: 'Vessel.Update' },
      path: 'action',
    },
    {
      name: 'unknown actor type',
      patch: { actorType: 'robot' },
      path: 'actorType',
    },
    { name: 'meta missing', patch: { meta: undefined }, path: 'meta' },
  ],
};

const withPatch = (type: EventType, patch: Record<string, unknown>) => {
  const payload: Record<string, unknown> = {
    ...EVENT_EXAMPLES[type],
    ...patch,
  };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) Reflect.deleteProperty(payload, key);
  }
  return payload;
};

describe('event payload schemas (spec 7.4)', () => {
  it.each(EVENT_TYPE_LIST)('%s accepts a realistic example', (type) => {
    const result = EVENT_SCHEMAS[type].safeParse(EVENT_EXAMPLES[type]);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.data).toEqual(EVENT_EXAMPLES[type]);
  });

  it.each(EVENT_TYPE_LIST)('%s rejects invalid payloads', (type) => {
    const cases = INVALID_CASES[type];
    expect(cases.length).toBeGreaterThan(0);
    for (const invalid of cases) {
      const result = validateEvent(type, withPatch(type, invalid.patch));
      expect(result.success, `${type}: ${invalid.name}`).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('invalid_payload');
        expect(
          result.issues.map((issue) => issue.field),
          `${type}: ${invalid.name}`,
        ).toContain(invalid.path);
      }
    }
  });

  it.each(EVENT_TYPE_LIST)(
    '%s strips unknown members (forward compatible)',
    (type) => {
      const result = validateEvent(type, {
        ...EVENT_EXAMPLES[type],
        addedInAFutureMinorVersion: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('addedInAFutureMinorVersion');
      }
    },
  );

  it('accepts the "not available" heading and nullable members', () => {
    const position = {
      ...EVENT_EXAMPLES['ais.position.recorded.v1'],
      hdg: 511,
      coastDistanceM: null,
      pipelineDistanceM: null,
      previous: null,
    };
    expect(validateEvent('ais.position.recorded.v1', position).success).toBe(
      true,
    );
    const raw = {
      ...EVENT_EXAMPLES['ais.raw.received.v1'],
      aisType: null,
      receiverPort: null,
    };
    expect(validateEvent('ais.raw.received.v1', raw).success).toBe(true);
  });

  it('reports unknown event types', () => {
    const result = validateEvent('ais.raw.received.v9', {});
    expect(result).toMatchObject({
      success: false,
      reason: 'unknown_type',
      type: 'ais.raw.received.v9',
    });
  });
});
