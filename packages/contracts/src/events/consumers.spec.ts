import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CONSUMERS,
  DEFAULT_MAX_DELIVER,
  defineDurableConsumer,
  type DurableConsumerDefinition,
  fleetProjectionConsumer,
  positionFeedConsumer,
  zoneProjectionConsumer,
} from './consumers.js';
import { SUBJECT_FILTERS } from './subjects.js';
import { EVENT_TYPES, type EventType } from './types.js';

/** Event types delivered to the contracts consumer `Name`. */
type EventsOf<Name extends keyof typeof CONSUMERS> =
  (typeof CONSUMERS)[Name]['eventTypes'][number];

type FleetEvents = 'fleet.vessel.upserted.v1' | 'fleet.vessel.deleted.v1';
type ZoneEvents = 'geo.zone.upserted.v1' | 'geo.zone.deleted.v1';
type PositionEvents = 'ais.position.recorded.v1';

describe('CONSUMERS literal types', () => {
  it('keeps the exact event types of every durable consumer', () => {
    expectTypeOf<
      EventsOf<'ais-processor'>
    >().toEqualTypeOf<'ais.raw.received.v1'>();
    expectTypeOf<
      EventsOf<'emission-positions'>
    >().toEqualTypeOf<PositionEvents>();
    expectTypeOf<
      EventsOf<'safety-positions'>
    >().toEqualTypeOf<PositionEvents>();
    expectTypeOf<
      EventsOf<'surveillance-positions'>
    >().toEqualTypeOf<PositionEvents>();
    expectTypeOf<
      EventsOf<'emission-fuel'>
    >().toEqualTypeOf<'fuel.reading.recorded.v1'>();
    expectTypeOf<EventsOf<'emission-fleet'>>().toEqualTypeOf<FleetEvents>();
    expectTypeOf<EventsOf<'safety-fleet'>>().toEqualTypeOf<FleetEvents>();
    expectTypeOf<EventsOf<'surveillance-fleet'>>().toEqualTypeOf<FleetEvents>();
    expectTypeOf<EventsOf<'notification-fleet'>>().toEqualTypeOf<FleetEvents>();
    expectTypeOf<EventsOf<'telemetry-fleet'>>().toEqualTypeOf<FleetEvents>();
    expectTypeOf<
      EventsOf<'ais-processor-fleet'>
    >().toEqualTypeOf<FleetEvents>();
    expectTypeOf<EventsOf<'safety-zones'>>().toEqualTypeOf<ZoneEvents>();
    expectTypeOf<EventsOf<'surveillance-zones'>>().toEqualTypeOf<ZoneEvents>();
    expectTypeOf<EventsOf<'notification-alerts'>>().toEqualTypeOf<
      'alert.raised.v1' | 'alert.resolved.v1'
    >();
    expectTypeOf<
      EventsOf<'notification-email'>
    >().toEqualTypeOf<'notify.email.requested.v1'>();
    expectTypeOf<EventsOf<'auth-audit'>>().toEqualTypeOf<'audit.recorded.v1'>();
  });

  it('rejects foreign event types at compile time', () => {
    const fleet: EventsOf<'notification-fleet'> = 'fleet.vessel.deleted.v1';
    // @ts-expect-error audit records are not delivered to a fleet projection
    const audit: EventsOf<'notification-fleet'> = 'audit.recorded.v1';
    // @ts-expect-error e-mails are not delivered to a position feed
    const email: EventsOf<'emission-positions'> = 'notify.email.requested.v1';
    expect([fleet, audit, email]).toHaveLength(3);
  });

  it('keeps durable names, streams and services literal', () => {
    expectTypeOf(
      CONSUMERS['telemetry-fleet'].durableName,
    ).toEqualTypeOf<'telemetry-fleet'>();
    expectTypeOf(CONSUMERS['safety-zones'].stream).toEqualTypeOf<'GEO'>();
    expectTypeOf(
      CONSUMERS['emission-positions'].service,
    ).toEqualTypeOf<'emission'>();
  });
});

describe('durable consumer builders', () => {
  it('builds the same runtime values as the registry entries', () => {
    expect(
      positionFeedConsumer(
        'emission-positions',
        'emission',
        'Builds voyage segments (fuel, CO2, CII) from positions.',
      ),
    ).toEqual(CONSUMERS['emission-positions']);
    expect(
      fleetProjectionConsumer('notification-fleet', 'notification'),
    ).toEqual(CONSUMERS['notification-fleet']);
    expect(zoneProjectionConsumer('safety-zones', 'safety')).toEqual(
      CONSUMERS['safety-zones'],
    );
    expect(CONSUMERS['notification-fleet']).toEqual({
      durableName: 'notification-fleet',
      stream: 'FLEET',
      filterSubjects: ['fleet.vessel.v1.>'],
      service: 'notification',
      eventTypes: ['fleet.vessel.upserted.v1', 'fleet.vessel.deleted.v1'],
      maxDeliver: 10,
      description:
        'Vessel projection (mmsi → vesselId, orgId) of notification.',
    });
    expect(CONSUMERS['surveillance-zones']).toEqual({
      durableName: 'surveillance-zones',
      stream: 'GEO',
      filterSubjects: ['geo.zone.v1.>'],
      service: 'surveillance',
      eventTypes: ['geo.zone.upserted.v1', 'geo.zone.deleted.v1'],
      maxDeliver: 10,
      description:
        'Zone projection with a spatial index (ZoneIndex) of surveillance.',
    });
  });

  it('types consumers of services outside the registry', () => {
    const positions = positionFeedConsumer(
      'speed-limit-positions',
      'speed-limit',
      'Feeds the speed limit detector.',
    );
    expectTypeOf(
      positions.durableName,
    ).toEqualTypeOf<'speed-limit-positions'>();
    expectTypeOf(positions.service).toEqualTypeOf<'speed-limit'>();
    expectTypeOf<
      (typeof positions)['eventTypes'][number]
    >().toEqualTypeOf<PositionEvents>();
    expectTypeOf(positions).toExtend<DurableConsumerDefinition>();

    const fleet = fleetProjectionConsumer('speed-limit-fleet', 'speed-limit');
    expectTypeOf<
      (typeof fleet)['eventTypes'][number]
    >().toEqualTypeOf<FleetEvents>();
    expect(fleet.description).toBe(
      'Vessel projection (mmsi → vesselId, orgId) of speed-limit.',
    );
    const zones = zoneProjectionConsumer('speed-limit-zones', 'speed-limit');
    expectTypeOf<
      (typeof zones)['eventTypes'][number]
    >().toEqualTypeOf<ZoneEvents>();
    expect(zones.filterSubjects).toEqual([SUBJECT_FILTERS.GEO_ZONE]);
  });

  it('keeps the literal types of a custom definition and returns it unchanged', () => {
    const input = {
      durableName: 'speed-limit-alerts',
      stream: 'ALERTS',
      filterSubjects: [SUBJECT_FILTERS.ALERT],
      service: 'speed-limit',
      eventTypes: [EVENT_TYPES.ALERT_RAISED, EVENT_TYPES.ALERT_RESOLVED],
      maxDeliver: DEFAULT_MAX_DELIVER,
      description: 'Keeps a dashboard in sync with the alerts.',
    } as const;
    const definition = defineDurableConsumer(input);
    expect(definition).toBe(input);
    expectTypeOf<(typeof definition)['eventTypes'][number]>().toEqualTypeOf<
      'alert.raised.v1' | 'alert.resolved.v1'
    >();
    const inline = defineDurableConsumer({
      durableName: 'speed-limit-fuel',
      stream: 'FUEL',
      filterSubjects: [SUBJECT_FILTERS.FUEL_READING],
      service: 'speed-limit',
      eventTypes: [EVENT_TYPES.FUEL_READING_RECORDED],
      maxDeliver: 5,
      description: 'Fuel readings.',
    });
    expectTypeOf<
      (typeof inline)['eventTypes'][number]
    >().toEqualTypeOf<'fuel.reading.recorded.v1'>();
    expectTypeOf(inline.stream).toEqualTypeOf<'FUEL'>();
    // A definition annotated with the interface widens to every event type.
    const _widened: DurableConsumerDefinition = inline;
    expectTypeOf<
      (typeof _widened)['eventTypes'][number]
    >().toEqualTypeOf<EventType>();
  });

  it('refuses definitions that do not satisfy the contract', () => {
    defineDurableConsumer({
      durableName: 'x',
      // @ts-expect-error not a stream of spec 7.2
      stream: 'POSITIONS',
      filterSubjects: ['x.>'],
      service: 'x',
      eventTypes: [],
      maxDeliver: 1,
      description: 'x',
    });
    defineDurableConsumer({
      durableName: 'x',
      stream: 'FUEL',
      filterSubjects: ['x.>'],
      service: 'x',
      // @ts-expect-error not an event type
      eventTypes: ['fuel.reading.v1'],
      maxDeliver: 1,
      description: 'x',
    });
    expect(true).toBe(true);
  });
});
