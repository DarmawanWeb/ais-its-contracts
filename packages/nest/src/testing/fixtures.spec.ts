import type { GeoJsonGeometry } from '@darmawanweb/ais-its-contracts/domain';
import {
  AlertRaisedV1Schema,
  AlertResolvedV1Schema,
  VesselSnapshotV1Schema,
  ZoneSnapshotV1Schema,
} from '@darmawanweb/ais-its-contracts/events';
import { describe, expect, it } from 'vitest';

import {
  makeTestVesselSnapshot as analyticsVessel,
  makeTestZone as analyticsZone,
} from '../analytics/index.js';
import {
  makeTestAlertRaised,
  makeTestAlertResolved,
  makeTestVesselSnapshot,
  makeTestZone,
} from './index.js';

const square: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [104, 1],
      [104.1, 1],
      [104.1, 1.1],
      [104, 1.1],
      [104, 1],
    ],
  ],
};

describe('payload builders of ./testing (CORE-16)', () => {
  it('builds valid zone and vessel snapshots with overrides', () => {
    const zone = makeTestZone({ geometry: square, kind: 'restricted' });
    expect(ZoneSnapshotV1Schema.parse(zone)).toEqual(zone);
    expect(zone).toMatchObject({ kind: 'restricted', active: true });
    const vessel = makeTestVesselSnapshot({ mmsi: 525005223, name: 'KM X' });
    expect(VesselSnapshotV1Schema.parse(vessel)).toEqual(vessel);
    expect(vessel).toMatchObject({ mmsi: 525005223, name: 'KM X' });
    expect(() => makeTestVesselSnapshot({ mmsi: 12 })).toThrow();
  });

  it('are the builders ./analytics exports', () => {
    expect(analyticsZone).toBe(makeTestZone);
    expect(analyticsVessel).toBe(makeTestVesselSnapshot);
  });

  it('builds valid alert.raised.v1 payloads with overrides', () => {
    const raised = makeTestAlertRaised();
    expect(AlertRaisedV1Schema.parse(raised)).toEqual(raised);
    expect(raised.dedupKey).toBe(`ews:${raised.mmsi}:${raised.zoneId}`);
    const critical = makeTestAlertRaised({
      mmsi: 525100001,
      severity: 'critical',
      zoneId: null,
    });
    expect(critical).toMatchObject({
      mmsi: 525100001,
      severity: 'critical',
      zoneId: null,
      dedupKey: 'ews:525100001:none',
    });
    expect(makeTestAlertRaised().id).not.toBe(raised.id);
    // A registry type must keep its domain.
    expect(() => makeTestAlertRaised({ domain: 'surveillance' })).toThrow();
  });

  it('builds valid alert.resolved.v1 payloads, optionally of a raise', () => {
    const resolved = makeTestAlertResolved();
    expect(AlertResolvedV1Schema.parse(resolved)).toEqual(resolved);
    const raised = makeTestAlertRaised({ mmsi: 525100002 });
    const ofRaise = makeTestAlertResolved(
      { reason: 'left the pipeline zone' },
      raised,
    );
    expect(ofRaise).toMatchObject({
      alertId: raised.id,
      type: raised.type,
      mmsi: 525100002,
      dedupKey: raised.dedupKey,
      openedAt: raised.occurredAt,
      reason: 'left the pipeline zone',
    });
    expect(Date.parse(ofRaise.resolvedAt)).toBeGreaterThan(
      Date.parse(ofRaise.openedAt),
    );
    expect(() => makeTestAlertResolved({ reason: 'x'.repeat(501) })).toThrow();
  });
});
