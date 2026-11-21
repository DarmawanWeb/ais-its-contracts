import { describe, expect, it } from 'vitest';

import { EVENT_CATALOG, EVENT_DEFINITIONS } from './catalog.js';
import {
  CONSUMER_LIST,
  CONSUMERS,
  consumersOfEvent,
  consumersOfService,
  CORE_SUBSCRIPTIONS,
  DEFAULT_MAX_DELIVER,
  ORDERED_CONSUMERS,
} from './consumers.js';
import { EVENT_SCHEMAS } from './registry.js';
import { isServiceName, SERVICE_NAMES } from './services.js';
import {
  DUPLICATE_WINDOW_MS,
  NATS_HEADERS,
  STREAM_LIST,
  STREAM_NAMES,
  STREAMS,
  streamForSubject,
} from './streams.js';
import { subjectMatchesFilter } from './subject-match.js';
import { EVENT_TYPE_LIST } from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('STREAMS', () => {
  it('matches the stream table of spec 7.2 exactly', () => {
    const table = STREAM_LIST.map((stream) => [
      stream.name,
      stream.subjects,
      stream.retention,
      stream.maxAgeMs,
      stream.maxMsgsPerSubject,
    ]);
    expect(table).toEqual([
      ['AIS_RAW', ['ais.raw.v1.>'], 'limits', DAY, -1],
      ['AIS_POSITION', ['ais.position.v1.>'], 'limits', 7 * DAY, -1],
      ['FUEL', ['fuel.reading.v1.>'], 'limits', 30 * DAY, -1],
      ['FLEET', ['fleet.vessel.v1.>'], 'limits', 0, 1],
      ['GEO', ['geo.zone.v1.>'], 'limits', 0, 1],
      ['SAFETY', ['safety.state.v1.>'], 'limits', 7 * DAY, 1],
      ['EMISSION', ['emission.cii.v1.>'], 'limits', 30 * DAY, -1],
      ['ALERTS', ['alert.v1.>'], 'limits', 90 * DAY, -1],
      ['NOTIFY', ['notify.email.v1'], 'workqueue', 7 * DAY, -1],
      ['AUDIT', ['audit.v1.>'], 'limits', 30 * DAY, -1],
      ['DLQ', ['dlq.>'], 'limits', 14 * DAY, -1],
    ]);
  });

  it('uses file storage and the 2 minute dedup window everywhere', () => {
    expect(DUPLICATE_WINDOW_MS).toBe(120_000);
    for (const stream of STREAM_LIST) {
      expect(stream.storage).toBe('file');
      expect(stream.duplicateWindowMs).toBe(DUPLICATE_WINDOW_MS);
      expect(stream.description.length).toBeGreaterThan(0);
    }
  });

  it('is keyed by name and has no overlapping subjects', () => {
    expect(Object.keys(STREAMS)).toEqual([...STREAM_NAMES]);
    for (const [name, stream] of Object.entries(STREAMS)) {
      expect(stream.name).toBe(name);
    }
    const filters = STREAM_LIST.flatMap((stream) => stream.subjects);
    for (const filter of filters) {
      const sample = filter.replace('>', 'x');
      expect(
        STREAM_LIST.filter((stream) =>
          stream.subjects.some((own) => subjectMatchesFilter(sample, own)),
        ),
      ).toHaveLength(1);
    }
  });

  it('names the producer headers', () => {
    expect(NATS_HEADERS).toEqual({
      MSG_ID: 'Nats-Msg-Id',
      TRACEPARENT: 'traceparent',
    });
  });
});

describe('CONSUMERS', () => {
  it('declares the durable consumers of spec 7.3', () => {
    expect(
      CONSUMER_LIST.map((consumer) => [consumer.durableName, consumer.stream]),
    ).toEqual([
      ['ais-processor', 'AIS_RAW'],
      ['emission-positions', 'AIS_POSITION'],
      ['safety-positions', 'AIS_POSITION'],
      ['surveillance-positions', 'AIS_POSITION'],
      ['emission-fuel', 'FUEL'],
      ['emission-fleet', 'FLEET'],
      ['safety-fleet', 'FLEET'],
      ['surveillance-fleet', 'FLEET'],
      ['notification-fleet', 'FLEET'],
      ['telemetry-fleet', 'FLEET'],
      ['ais-processor-fleet', 'FLEET'],
      ['safety-zones', 'GEO'],
      ['surveillance-zones', 'GEO'],
      ['notification-alerts', 'ALERTS'],
      ['notification-email', 'NOTIFY'],
      ['auth-audit', 'AUDIT'],
    ]);
  });

  it('is keyed by durable name with filters inside the stream', () => {
    for (const [key, consumer] of Object.entries(CONSUMERS)) {
      expect(consumer.durableName).toBe(key);
      expect(consumer.maxDeliver).toBe(DEFAULT_MAX_DELIVER);
      expect(isServiceName(consumer.service)).toBe(true);
      const stream = STREAMS[consumer.stream];
      for (const filter of consumer.filterSubjects) {
        expect(stream.subjects).toContain(filter);
      }
      for (const type of consumer.eventTypes) {
        expect(EVENT_CATALOG[type].stream).toBe(consumer.stream);
      }
    }
    expect(DEFAULT_MAX_DELIVER).toBe(10);
  });

  it('keeps the work queue single-consumer', () => {
    expect(CONSUMER_LIST.filter((c) => c.stream === 'NOTIFY')).toHaveLength(1);
  });

  it('declares ordered consumers and core subscriptions of notification and telemetry', () => {
    expect(ORDERED_CONSUMERS.map((c) => [c.name, c.stream, c.service])).toEqual(
      [
        ['notification-positions', 'AIS_POSITION', 'notification'],
        ['notification-safety', 'SAFETY', 'notification'],
        ['notification-cii', 'EMISSION', 'notification'],
      ],
    );
    for (const consumer of ORDERED_CONSUMERS) {
      for (const type of consumer.eventTypes) {
        expect(EVENT_CATALOG[type].stream).toBe(consumer.stream);
      }
      for (const filter of consumer.filterSubjects) {
        expect(STREAMS[consumer.stream].subjects).toContain(filter);
      }
    }
    expect(CORE_SUBSCRIPTIONS).toEqual([
      expect.objectContaining({
        subject: 'aisits.telemetry.*',
        service: 'telemetry',
      }),
    ]);
  });

  it('feeds safety and surveillance with positions, zones and vessels only', () => {
    for (const service of ['safety', 'surveillance'] as const) {
      expect(
        consumersOfService(service).map((c) => [c.durableName, c.stream]),
      ).toEqual([
        [`${service}-positions`, 'AIS_POSITION'],
        [`${service}-fleet`, 'FLEET'],
        [`${service}-zones`, 'GEO'],
      ]);
    }
    expect(
      consumersOfEvent('geo.zone.deleted.v1').map((c) =>
        'durableName' in c ? c.durableName : c.name,
      ),
    ).toEqual(['safety-zones', 'surveillance-zones']);
    expect(
      consumersOfEvent('safety.vessel_state.updated.v1').map((c) =>
        'durableName' in c ? c.durableName : c.name,
      ),
    ).toEqual(['notification-safety']);
  });

  it('declares no consumer of the removed detection service', () => {
    const names = [
      ...CONSUMER_LIST.map((c) => c.durableName),
      ...ORDERED_CONSUMERS.map((c) => c.name),
    ];
    expect(names.filter((name) => name.startsWith('detection'))).toEqual([]);
    expect(SERVICE_NAMES).not.toContain('detection');
  });

  it('finds consumers by service and by event type', () => {
    expect(consumersOfService('emission').map((c) => c.durableName)).toEqual([
      'emission-positions',
      'emission-fuel',
      'emission-fleet',
    ]);
    expect(
      consumersOfEvent('ais.position.recorded.v1').map((c) =>
        'durableName' in c ? c.durableName : c.name,
      ),
    ).toEqual([
      'emission-positions',
      'safety-positions',
      'surveillance-positions',
      'notification-positions',
    ]);
  });
});

describe('EVENT_CATALOG', () => {
  it('documents every event type with a schema and a stream', () => {
    expect(Object.keys(EVENT_CATALOG).sort()).toEqual(
      [...EVENT_TYPE_LIST].sort(),
    );
    expect(Object.keys(EVENT_SCHEMAS).sort()).toEqual(
      [...EVENT_TYPE_LIST].sort(),
    );
    for (const definition of EVENT_DEFINITIONS) {
      expect(STREAM_NAMES).toContain(definition.stream);
      for (const producer of definition.producers) {
        expect(SERVICE_NAMES).toContain(producer);
      }
      expect(consumersOfEvent(definition.type).length).toBeGreaterThan(0);
    }
  });

  it('uses subject patterns captured by the declared stream', () => {
    for (const definition of EVENT_DEFINITIONS) {
      const sample = definition.subject.replace(
        /\{(\w+)\}/g,
        (_, name: string) => {
          const allowed = definition.parameters[name]?.enum;
          return allowed?.[0] ?? '525005223';
        },
      );
      expect(streamForSubject(sample)?.name, definition.type).toBe(
        definition.stream,
      );
      const parameters = [...definition.subject.matchAll(/\{(\w+)\}/g)].map(
        (match) => match[1],
      );
      expect(Object.keys(definition.parameters).sort()).toEqual(
        parameters.sort(),
      );
    }
  });
});
