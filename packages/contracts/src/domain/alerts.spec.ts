import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ALERT_DOMAIN_LABELS,
  ALERT_DOMAINS,
  ALERT_SEVERITIES,
  ALERT_TYPE_LIST,
  ALERT_TYPE_PATTERN,
  ALERT_TYPES,
  alertDomainLabel,
  type AlertType,
  AlertTypeSchema,
  alertTypeLabel,
  alertTypesOfDomain,
  defaultAlertSeverity,
  getAlertType,
  isAlertDomain,
  isAlertType,
  isKnownAlertType,
  KNOWN_ALERT_TYPES,
  type KnownAlertType,
  KnownAlertTypeSchema,
} from './alerts.js';
import { LOCALES } from './locale.js';

describe('ALERT_TYPES registry (spec 7.3)', () => {
  it('registers the alert types of spec 7.3 in order, keyed by type', () => {
    expect(KNOWN_ALERT_TYPES).toEqual([
      'ews',
      'collision',
      'transhipment',
      'anomaly',
      'dark',
      'geofence',
      'fishing',
    ]);
    expect(Object.keys(ALERT_TYPES)).toEqual([...KNOWN_ALERT_TYPES]);
    expect(ALERT_TYPE_LIST.map((definition) => definition.type)).toEqual([
      ...KNOWN_ALERT_TYPES,
    ]);
    for (const [key, definition] of Object.entries(ALERT_TYPES)) {
      expect(definition.type).toBe(key);
      expect(ALERT_TYPE_PATTERN.test(key)).toBe(true);
    }
  });

  it('assigns each type to the domain of the service that raises it', () => {
    expect(alertTypesOfDomain('safety').map((d) => d.type)).toEqual([
      'ews',
      'collision',
    ]);
    expect(alertTypesOfDomain('surveillance').map((d) => d.type)).toEqual([
      'transhipment',
      'anomaly',
      'dark',
      'geofence',
      'fishing',
    ]);
  });

  it('maps graded detector levels to the severities of spec 13.7', () => {
    expect(ALERT_TYPES.ews.severityByLevel).toEqual({
      danger: 'critical',
      warning: 'warning',
    });
    expect(ALERT_TYPES.collision.severityByLevel).toEqual({
      high: 'critical',
      medium: 'warning',
    });
    expect(defaultAlertSeverity('ews', 'danger')).toBe('critical');
    expect(defaultAlertSeverity('collision', 'medium')).toBe('warning');
    expect(defaultAlertSeverity('collision', 'low')).toBeNull();
    expect(defaultAlertSeverity('ews', 'safe')).toBeNull();
    expect(defaultAlertSeverity('ews', 'toString')).toBeNull();
    expect(defaultAlertSeverity('dark')).toBe('warning');
    expect(defaultAlertSeverity('anomaly')).toBe('info');
    expect(defaultAlertSeverity('fishing', 'anything')).toBeNull();
  });

  it('labels and describes every type in every locale', () => {
    for (const definition of ALERT_TYPE_LIST) {
      expect(ALERT_SEVERITIES).toContain(definition.defaultSeverity);
      for (const severity of Object.values(definition.severityByLevel)) {
        expect(ALERT_SEVERITIES).toContain(severity);
      }
      for (const locale of LOCALES) {
        expect(definition.label[locale].length).toBeGreaterThan(0);
        expect(definition.description[locale].length).toBeGreaterThan(10);
      }
    }
    expect(alertTypeLabel('collision', 'id')).toBe('Risiko tubrukan');
    expect(alertTypeLabel('ews')).toBe('Pipeline early warning');
  });
});

describe('forward-compatible alert types', () => {
  it('parses registry and future types but rejects malformed ones', () => {
    for (const type of [...KNOWN_ALERT_TYPES, 'anchor_dragging', 'spoofing']) {
      expect(AlertTypeSchema.parse(type)).toBe(type);
      expect(isAlertType(type)).toBe(true);
    }
    for (const type of ['', 'Ews', 'ews.v2', 'ews-x', '1ews', 'ews*', 42]) {
      expect(AlertTypeSchema.safeParse(type).success, String(type)).toBe(false);
      expect(isAlertType(type)).toBe(false);
    }
    expect(KnownAlertTypeSchema.safeParse('anchor_dragging').success).toBe(
      false,
    );
    expect(KnownAlertTypeSchema.parse('collision')).toBe('collision');
  });

  it('distinguishes registry types from future ones', () => {
    expect(isKnownAlertType('geofence')).toBe(true);
    expect(isKnownAlertType('anchor_dragging')).toBe(false);
    expect(isKnownAlertType('constructor')).toBe(false);
    expect(getAlertType('dark')?.domain).toBe('surveillance');
    expect(getAlertType('anchor_dragging')).toBeUndefined();
    expect(getAlertType('__proto__')).toBeUndefined();
  });

  it('labels unknown types by their id', () => {
    expect(alertTypeLabel('anchor_dragging')).toBe('anchor_dragging');
    expect(alertTypeLabel('anchor_dragging', 'id')).toBe('anchor_dragging');
  });

  it('types the schema output as an open alert type', () => {
    expectTypeOf(AlertTypeSchema.parse('ews')).toEqualTypeOf<AlertType>();
    expectTypeOf<KnownAlertType>().toExtend<AlertType>();
    expectTypeOf<string>().toExtend<AlertType>();
  });
});

describe('alert domains', () => {
  it('declares the safety and surveillance domains with labels', () => {
    expect(ALERT_DOMAINS).toEqual(['safety', 'surveillance']);
    expect(Object.keys(ALERT_DOMAIN_LABELS)).toEqual([...ALERT_DOMAINS]);
    expect(alertDomainLabel('surveillance', 'id')).toBe('Pengawasan');
    expect(isAlertDomain('safety')).toBe(true);
    expect(isAlertDomain('detection')).toBe(false);
  });
});
