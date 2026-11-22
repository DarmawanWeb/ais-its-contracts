import {
  EVENT_EXAMPLES,
  EXAMPLE_IDS,
} from '../../events/__fixtures__/examples.js';
import type { RealtimeAlertFanout } from '../fanout.js';
import { AUTHORITY_ROOM, orgRoom } from '../rooms.js';
import type { RealtimeAlert } from '../schemas.js';

const RAISED = EVENT_EXAMPLES['alert.raised.v1'];

/** The inbox view of the example `alert.raised.v1` after three occurrences. */
export const REALTIME_ALERT_EXAMPLE: RealtimeAlert = {
  id: RAISED.id,
  type: RAISED.type,
  domain: RAISED.domain,
  severity: RAISED.severity,
  status: 'open',
  mmsi: RAISED.mmsi,
  relatedMmsi: RAISED.relatedMmsi,
  title: RAISED.title,
  message: RAISED.message,
  lat: RAISED.lat,
  lon: RAISED.lon,
  zoneId: RAISED.zoneId,
  methodId: RAISED.methodId,
  occurredAt: RAISED.occurredAt,
  lastOccurredAt: '2026-11-20T08:41:00.000Z',
  occurrences: 3,
  data: RAISED.data,
};

/** A valid alert push fanned out to the authority and owner organization rooms. */
export const REALTIME_ALERT_FANOUT_EXAMPLE: RealtimeAlertFanout = {
  event: 'alert:updated',
  rooms: [AUTHORITY_ROOM, orgRoom(EXAMPLE_IDS.org)],
  alert: REALTIME_ALERT_EXAMPLE,
};
