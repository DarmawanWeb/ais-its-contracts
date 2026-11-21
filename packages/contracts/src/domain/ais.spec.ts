import { describe, expect, it } from 'vitest';

import {
  AIS_SOURCES,
  HeadingSchema,
  isNavStatus,
  isNavStatusAnomaly,
  isValidMmsi,
  MmsiSchema,
  NAV_STATUS,
  NAV_STATUS_CODES,
  NAV_STATUS_LABELS,
  navStatusLabel,
  type PredictedNavStatus,
} from './ais.js';
import {
  ALERT_SEVERITIES,
  ALERT_TYPE_LABELS,
  ALERT_TYPES,
  compareAlertSeverity,
  isSeverityAtLeast,
} from './alerts.js';
import {
  classifyEwsStatus,
  EWS_STATUS,
  EWS_STATUS_LABELS,
  EWS_STATUSES,
  ewsAlertSeverity,
  ewsStatusLabel,
} from './ews.js';
import { isUuid, newId, UuidV7Schema } from './id.js';
import { isLocale, LOCALES } from './locale.js';
import { ZONE_KIND_LABELS, ZONE_KINDS } from './zones.js';

describe('AIS vocabulary', () => {
  it('declares the AIS feeds', () => {
    expect(AIS_SOURCES).toEqual(['primary', 'batam', 'pusher']);
  });

  it('labels navstatus 0..15 in English and Indonesian', () => {
    expect(NAV_STATUS_CODES).toEqual(
      Array.from({ length: 16 }, (_, code) => code),
    );
    for (const code of NAV_STATUS_CODES) {
      for (const locale of LOCALES) {
        expect(NAV_STATUS_LABELS[code][locale].length).toBeGreaterThan(0);
      }
    }
    expect(navStatusLabel(NAV_STATUS.AT_ANCHOR)).toBe('At anchor');
    expect(navStatusLabel(1, 'id')).toBe('Berlabuh jangkar');
    expect(navStatusLabel(5, 'id')).toBe('Tertambat');
    expect(navStatusLabel(16)).toBe('Unknown (16)');
    expect(navStatusLabel(-1, 'id')).toBe('Tidak diketahui (-1)');
    expect(isNavStatus(15)).toBe(true);
    expect(isNavStatus(2.5)).toBe(false);
  });

  it('validates 9-digit MMSIs', () => {
    expect(isValidMmsi(525005223)).toBe(true);
    expect(isValidMmsi(100000000)).toBe(true);
    expect(isValidMmsi(99999999)).toBe(false);
    expect(isValidMmsi(1000000000)).toBe(false);
    expect(isValidMmsi(525005223.1)).toBe(false);
    expect(isValidMmsi('525005223')).toBe(false);
    expect(MmsiSchema.safeParse(525005223).success).toBe(true);
    expect(MmsiSchema.safeParse(52500522).success).toBe(false);
  });

  it('accepts headings 0..359 and 511 only', () => {
    for (const hdg of [0, 180.5, 359, 511]) {
      expect(HeadingSchema.safeParse(hdg).success, String(hdg)).toBe(true);
    }
    for (const hdg of [-1, 360, 400, 510]) {
      expect(HeadingSchema.safeParse(hdg).success, String(hdg)).toBe(false);
    }
  });

  it('flags navstatus anomalies exactly like the legacy web rule', () => {
    // Legacy apps/web anomaly filter, kept verbatim as the oracle.
    const legacyRule = (navstatus: number, predicted: number): boolean =>
      predicted === 0 ? navstatus === 1 : navstatus !== predicted;
    for (const navstatus of NAV_STATUS_CODES) {
      for (const predicted of [
        0, 1,
      ] as const satisfies readonly PredictedNavStatus[]) {
        expect(
          isNavStatusAnomaly(navstatus, predicted),
          `${navstatus}/${predicted}`,
        ).toBe(legacyRule(navstatus, predicted));
      }
    }
  });
});

describe('EWS', () => {
  it('uses the legacy codes and labels', () => {
    expect(EWS_STATUS).toEqual({ DANGER: 0, WARNING: 1, SAFE: 3 });
    expect(EWS_STATUSES).toEqual([0, 1, 3]);
    expect(ewsStatusLabel(0)).toBe('Danger');
    expect(ewsStatusLabel(3, 'id')).toBe('Aman');
    expect(Object.keys(EWS_STATUS_LABELS)).toEqual(['0', '1', '3']);
  });

  it.each([
    [0, 1, 0],
    [499.99, 1, 0],
    [500, 1, 1],
    [1749.99, 1, 1],
    [1750, 1, 3],
    [10, 0, 3],
    [10, 5, 3],
    [Number.NaN, 1, 3],
  ])(
    'classifies %s m with navstatus %s as %s (legacy checkShipStatus)',
    (distance, navstatus, expected) => {
      expect(classifyEwsStatus(distance, navstatus)).toBe(expected);
    },
  );

  it('maps EWS statuses to alert severities', () => {
    expect(ewsAlertSeverity(0)).toBe('critical');
    expect(ewsAlertSeverity(1)).toBe('warning');
    expect(ewsAlertSeverity(3)).toBeNull();
  });
});

describe('alerts and zones', () => {
  it('orders severities by urgency', () => {
    expect([...ALERT_SEVERITIES].reverse().sort(compareAlertSeverity)).toEqual([
      'info',
      'warning',
      'critical',
    ]);
    expect(isSeverityAtLeast('critical', 'warning')).toBe(true);
    expect(isSeverityAtLeast('info', 'warning')).toBe(false);
    expect(isSeverityAtLeast('warning', 'warning')).toBe(true);
  });

  it('labels every alert type and zone kind', () => {
    expect(Object.keys(ALERT_TYPE_LABELS)).toEqual([...ALERT_TYPES]);
    expect(Object.keys(ZONE_KIND_LABELS)).toEqual([...ZONE_KINDS]);
  });
});

describe('ids and locales', () => {
  it('generates UUID v7 ids', () => {
    const id = newId();
    expect(UuidV7Schema.safeParse(id).success).toBe(true);
    expect(isUuid(id)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
  });

  it('knows the supported locales', () => {
    expect(LOCALES).toEqual(['id', 'en']);
    expect(isLocale('id')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});
