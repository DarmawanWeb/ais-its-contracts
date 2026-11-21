import { describe, expect, it } from 'vitest';

import { ALERT_TYPES } from './alerts.js';
import { ewsAlertSeverity } from './ews.js';
import {
  COLLISION_RISK_LABELS,
  COLLISION_RISKS,
  collisionRiskAlertSeverity,
  collisionRiskLabel,
  CollisionRiskSchema,
  compareCollisionRisk,
  SAFETY_EVENT_STATUS_LABELS,
  SAFETY_EVENT_STATUSES,
  SafetyEventStatusSchema,
} from './safety.js';
import {
  SURVEILLANCE_EVENT_STATUS_LABELS,
  SURVEILLANCE_EVENT_STATUSES,
  SurveillanceEventStatusSchema,
} from './surveillance.js';

describe('collision risk', () => {
  it('declares the bands of SafetyVesselStateV1 in ascending order', () => {
    expect(COLLISION_RISKS).toEqual(['none', 'low', 'medium', 'high']);
    expect(
      ['high', 'none', 'medium', 'low'].sort((a, b) =>
        compareCollisionRisk(
          CollisionRiskSchema.parse(a),
          CollisionRiskSchema.parse(b),
        ),
      ),
    ).toEqual(['none', 'low', 'medium', 'high']);
    expect(CollisionRiskSchema.safeParse('extreme').success).toBe(false);
  });

  it('raises collision alerts for high (critical) and medium (warning) only', () => {
    expect(COLLISION_RISKS.map(collisionRiskAlertSeverity)).toEqual([
      null,
      null,
      'warning',
      'critical',
    ]);
    expect(collisionRiskAlertSeverity('high')).toBe(
      ALERT_TYPES.collision.severityByLevel.high,
    );
  });

  it('labels every band', () => {
    expect(Object.keys(COLLISION_RISK_LABELS)).toEqual([...COLLISION_RISKS]);
    expect(collisionRiskLabel('high', 'id')).toBe('Risiko tinggi');
    expect(collisionRiskLabel('none')).toBe('No risk');
  });
});

describe('EWS alert severity', () => {
  it('follows the registry levels of the ews alert type', () => {
    expect(ewsAlertSeverity(0)).toBe(ALERT_TYPES.ews.severityByLevel.danger);
    expect(ewsAlertSeverity(1)).toBe(ALERT_TYPES.ews.severityByLevel.warning);
    expect(ewsAlertSeverity(3)).toBeNull();
  });
});

describe('detector event statuses', () => {
  it('declares the safety event lifecycle (open → resolved)', () => {
    expect(SAFETY_EVENT_STATUSES).toEqual(['open', 'resolved']);
    expect(Object.keys(SAFETY_EVENT_STATUS_LABELS)).toEqual([
      ...SAFETY_EVENT_STATUSES,
    ]);
    expect(SafetyEventStatusSchema.safeParse('confirmed').success).toBe(false);
  });

  it('declares the surveillance review lifecycle', () => {
    expect(SURVEILLANCE_EVENT_STATUSES).toEqual([
      'open',
      'confirmed',
      'dismissed',
      'resolved',
    ]);
    expect(Object.keys(SURVEILLANCE_EVENT_STATUS_LABELS)).toEqual([
      ...SURVEILLANCE_EVENT_STATUSES,
    ]);
    expect(SURVEILLANCE_EVENT_STATUS_LABELS.dismissed.id).toBe('Diabaikan');
    expect(SurveillanceEventStatusSchema.parse('confirmed')).toBe('confirmed');
    expect(SurveillanceEventStatusSchema.safeParse('closed').success).toBe(
      false,
    );
  });
});
