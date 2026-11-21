import { describe, expect, it } from 'vitest';

import { KNOWN_ALERT_TYPES } from '../domain/alerts.js';
import { exampleEnvelope } from './__fixtures__/examples.js';
import { STREAMS, streamForSubject } from './streams.js';
import { subjectMatchesFilter } from './subject-match.js';
import {
  AIS_POSITION_PARTITIONS,
  aisPositionPartition,
  parseAisPositionSubject,
  SUBJECT_FILTERS,
  subjectForEvent,
  subjects,
  TELEMETRY_MQTT_TOPIC_PREFIX,
  telemetryMqttTopic,
} from './subjects.js';
import { EVENT_TYPE_LIST } from './types.js';

describe('subject builders', () => {
  it('builds every subject family of spec 7.3', () => {
    expect(subjects.aisRaw('primary')).toBe('ais.raw.v1.primary');
    expect(subjects.aisRaw('batam')).toBe('ais.raw.v1.batam');
    expect(subjects.aisRaw('pusher')).toBe('ais.raw.v1.pusher');
    expect(subjects.aisPosition(525005223)).toBe('ais.position.v1.7.525005223');
    expect(subjects.fuelReading(525005223)).toBe('fuel.reading.v1.525005223');
    expect(subjects.fleetVessel('01a1f8c2-54d9-7223-9107-543e8d90de1c')).toBe(
      'fleet.vessel.v1.01a1f8c2-54d9-7223-9107-543e8d90de1c',
    );
    expect(subjects.geoZone('01a1f8c2-54dc-7c3e-9a4b-2e6f8a1c3d5e')).toBe(
      'geo.zone.v1.01a1f8c2-54dc-7c3e-9a4b-2e6f8a1c3d5e',
    );
    expect(subjects.safetyState(525005223)).toBe('safety.state.v1.525005223');
    expect(subjects.ciiUpdated(525005223)).toBe('emission.cii.v1.525005223');
    expect(subjects.alert('transhipment', 525005223)).toBe(
      'alert.v1.transhipment.525005223',
    );
    expect(subjects.alert('collision', 525005223)).toBe(
      'alert.v1.collision.525005223',
    );
    expect(subjects.notifyEmail()).toBe('notify.email.v1');
    expect(subjects.audit('fleet')).toBe('audit.v1.fleet');
    expect(subjects.dlq('AIS_POSITION', 'emission-positions')).toBe(
      'dlq.AIS_POSITION.emission-positions',
    );
    expect(subjects.telemetryMqtt('device-42')).toBe(
      'aisits.telemetry.device-42',
    );
  });

  it('maps the MQTT topic of a device to its core NATS subject', () => {
    expect(TELEMETRY_MQTT_TOPIC_PREFIX).toBe('aisits/telemetry/');
    expect(telemetryMqttTopic('device-42')).toBe('aisits/telemetry/device-42');
    expect(telemetryMqttTopic('device-42').replaceAll('/', '.')).toBe(
      subjects.telemetryMqtt('device-42'),
    );
    for (const deviceId of ['a/b', 'a+', '#', 'a.b', '']) {
      expect(() => telemetryMqttTopic(deviceId), deviceId).toThrow(RangeError);
    }
  });

  it('accepts future alert types but rejects malformed ones', () => {
    expect(subjects.alert('anchor_dragging', 525005223)).toBe(
      'alert.v1.anchor_dragging.525005223',
    );
    for (const type of ['Ews', 'ews.v2', 'ews*', '', '1ews', 'ews-x']) {
      expect(() => subjects.alert(type, 525005223), type).toThrow(RangeError);
      expect(() => subjects.alertTypeFilter(type), type).toThrow(RangeError);
    }
  });

  it('builds filters that match exactly their family', () => {
    expect(subjects.aisPositionPartitionFilter(7)).toBe('ais.position.v1.7.>');
    expect(subjects.alertTypeFilter('ews')).toBe('alert.v1.ews.*');
    expect(
      subjectMatchesFilter(
        subjects.alert('ews', 525005223),
        subjects.alertTypeFilter('ews'),
      ),
    ).toBe(true);
    expect(
      subjectMatchesFilter(
        subjects.alert('dark', 525005223),
        subjects.alertTypeFilter('ews'),
      ),
    ).toBe(false);
  });

  it('rejects tokens that would break NATS subjects', () => {
    expect(() => subjects.fleetVessel('a.b')).toThrow(RangeError);
    expect(() => subjects.fleetVessel('')).toThrow(RangeError);
    expect(() => subjects.geoZone('zone.1')).toThrow(RangeError);
    expect(() => subjects.geoZone('>')).toThrow(RangeError);
    expect(() => subjects.audit('*')).toThrow(RangeError);
    expect(() => subjects.telemetryMqtt('dev >')).toThrow(RangeError);
    expect(() => subjects.dlq('DLQ', 'with space')).toThrow(RangeError);
  });

  it('rejects MMSIs that are not 9-digit integers', () => {
    for (const mmsi of [
      12345678,
      1000000000,
      525005223.5,
      -525005223,
      Number.NaN,
    ]) {
      expect(() => subjects.aisPosition(mmsi)).toThrow(RangeError);
      expect(() => subjects.fuelReading(mmsi)).toThrow(RangeError);
      expect(() => subjects.safetyState(mmsi)).toThrow(RangeError);
      expect(() => subjects.alert('ews', mmsi)).toThrow(RangeError);
    }
  });
});

describe('position partitions', () => {
  it('uses mmsi % 16', () => {
    expect(AIS_POSITION_PARTITIONS).toBe(16);
    expect(aisPositionPartition(525005223)).toBe(525005223 % 16);
    expect(aisPositionPartition(100000000)).toBe(0);
    expect(aisPositionPartition(999999999)).toBe(15);
    expect(aisPositionPartition(563012345)).toBe(9);
  });

  it('spreads vessels over all partitions and every subject over exactly one partition filter', () => {
    const seen = new Set<number>();
    for (let mmsi = 525005200; mmsi < 525005264; mmsi += 1) {
      const partition = aisPositionPartition(mmsi);
      seen.add(partition);
      const subject = subjects.aisPosition(mmsi);
      const matches = Array.from({ length: AIS_POSITION_PARTITIONS }, (_, p) =>
        subjectMatchesFilter(subject, subjects.aisPositionPartitionFilter(p)),
      );
      expect(matches.filter(Boolean)).toHaveLength(1);
      expect(matches[partition]).toBe(true);
    }
    expect(seen.size).toBe(AIS_POSITION_PARTITIONS);
  });

  it('rejects partitions outside 0..15', () => {
    for (const partition of [-1, 16, 1.5, Number.NaN]) {
      expect(() => subjects.aisPositionPartitionFilter(partition)).toThrow(
        RangeError,
      );
    }
  });

  it('parses position subjects and checks partition consistency', () => {
    expect(parseAisPositionSubject('ais.position.v1.7.525005223')).toEqual({
      partition: 7,
      mmsi: 525005223,
    });
    expect(parseAisPositionSubject('ais.position.v1.6.525005223')).toBeNull();
    expect(parseAisPositionSubject('ais.position.v1.7.52500522')).toBeNull();
    expect(parseAisPositionSubject('ais.raw.v1.batam')).toBeNull();
  });
});

describe('subjectMatchesFilter', () => {
  it.each([
    ['ais.raw.v1.batam', 'ais.raw.v1.>', true],
    ['ais.raw.v1', 'ais.raw.v1.>', false],
    ['ais.raw.v1.batam.extra', 'ais.raw.v1.*', false],
    ['aisits.telemetry.device-1', 'aisits.telemetry.*', true],
    ['safety.state.v1.525005223', 'safety.state.v1.>', true],
    ['geo.zone.v1.z1', 'geo.zone.v1.*', true],
    ['notify.email.v1', 'notify.email.v1', true],
    ['notify.email.v2', 'notify.email.v1', false],
    ['alert.v1.ews.525005223', 'alert.*.ews.>', true],
    ['a.b', 'a.>.c', false],
  ])('%s against %s → %s', (subject, filter, expected) => {
    expect(subjectMatchesFilter(subject, filter)).toBe(expected);
  });
});

describe('subjects and streams', () => {
  it('captures every concrete subject in the stream of its family', () => {
    const cases: [string, keyof typeof STREAMS][] = [
      [subjects.aisRaw('pusher'), 'AIS_RAW'],
      [subjects.aisPosition(525005223), 'AIS_POSITION'],
      [subjects.fuelReading(525005223), 'FUEL'],
      [subjects.fleetVessel('01a1f8c2-54d9-7223-9107-543e8d90de1c'), 'FLEET'],
      [subjects.geoZone('01a1f8c2-54dc-7c3e-9a4b-2e6f8a1c3d5e'), 'GEO'],
      [subjects.safetyState(525005223), 'SAFETY'],
      [subjects.ciiUpdated(525005223), 'EMISSION'],
      ...KNOWN_ALERT_TYPES.map((type): [string, keyof typeof STREAMS] => [
        subjects.alert(type, 525005223),
        'ALERTS',
      ]),
      [subjects.notifyEmail(), 'NOTIFY'],
      [subjects.audit('auth'), 'AUDIT'],
      [subjects.dlq('FLEET', 'emission-fleet'), 'DLQ'],
    ];
    for (const [subject, stream] of cases) {
      expect(streamForSubject(subject)?.name, subject).toBe(stream);
    }
  });

  it('keeps core NATS telemetry subjects out of JetStream', () => {
    expect(
      streamForSubject(subjects.telemetryMqtt('device-1')),
    ).toBeUndefined();
  });

  it('declares filters bound by the stream subjects', () => {
    expect(SUBJECT_FILTERS.AIS_RAW).toBe(STREAMS.AIS_RAW.subjects[0]);
    expect(SUBJECT_FILTERS.AIS_POSITION).toBe(STREAMS.AIS_POSITION.subjects[0]);
    expect(SUBJECT_FILTERS.FUEL_READING).toBe(STREAMS.FUEL.subjects[0]);
    expect(SUBJECT_FILTERS.FLEET_VESSEL).toBe(STREAMS.FLEET.subjects[0]);
    expect(SUBJECT_FILTERS.GEO_ZONE).toBe(STREAMS.GEO.subjects[0]);
    expect(SUBJECT_FILTERS.SAFETY_STATE).toBe(STREAMS.SAFETY.subjects[0]);
    expect(SUBJECT_FILTERS.CII_UPDATED).toBe(STREAMS.EMISSION.subjects[0]);
    expect(SUBJECT_FILTERS.ALERT).toBe(STREAMS.ALERTS.subjects[0]);
    expect(SUBJECT_FILTERS.NOTIFY_EMAIL).toBe(STREAMS.NOTIFY.subjects[0]);
    expect(SUBJECT_FILTERS.AUDIT).toBe(STREAMS.AUDIT.subjects[0]);
    expect(SUBJECT_FILTERS.DLQ).toBe(STREAMS.DLQ.subjects[0]);
  });
});

describe('subjectForEvent', () => {
  it('derives the publish subject of every event type', () => {
    const expected: Record<string, string> = {
      'ais.raw.received.v1': 'ais.raw.v1.batam',
      'ais.position.recorded.v1': 'ais.position.v1.7.525005223',
      'fuel.reading.recorded.v1': 'fuel.reading.v1.525005223',
      'fleet.vessel.upserted.v1':
        'fleet.vessel.v1.01a1f8c2-54d9-7223-9107-543e8d90de1c',
      'fleet.vessel.deleted.v1':
        'fleet.vessel.v1.01a1f8c2-54d9-7223-9107-543e8d90de1c',
      'geo.zone.upserted.v1':
        'geo.zone.v1.01a1f8c2-54dc-7c3e-9a4b-2e6f8a1c3d5e',
      'geo.zone.deleted.v1': 'geo.zone.v1.01a1f8c2-54dc-7c3e-9a4b-2e6f8a1c3d5e',
      'safety.vessel_state.updated.v1': 'safety.state.v1.525005223',
      'emission.cii.updated.v1': 'emission.cii.v1.525005223',
      'alert.raised.v1': 'alert.v1.ews.525005223',
      'notify.email.requested.v1': 'notify.email.v1',
      'audit.recorded.v1': 'audit.v1.fleet',
    };
    for (const type of EVENT_TYPE_LIST) {
      expect(subjectForEvent(exampleEnvelope(type, 'fleet')), type).toBe(
        expected[type],
      );
    }
  });
});
