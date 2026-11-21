import * as z from 'zod';

import { ALERT_TYPES, type AlertSeverity } from './alerts.js';
import type { Locale, LocalizedText } from './locale.js';

/** Collision risk bands of a vessel, in ascending order of risk (spec 13.7). */
export const COLLISION_RISKS = ['none', 'low', 'medium', 'high'] as const;

/** A collision risk band. */
export type CollisionRisk = (typeof COLLISION_RISKS)[number];

/** Zod schema of {@link CollisionRisk}. */
export const CollisionRiskSchema = z
  .enum(COLLISION_RISKS)
  .describe('Collision risk band from CPA / TCPA: none, low, medium, high');

/** Labels of every collision risk band. */
export const COLLISION_RISK_LABELS: Readonly<
  Record<CollisionRisk, LocalizedText>
> = {
  none: { en: 'No risk', id: 'Tidak berisiko' },
  low: { en: 'Low risk', id: 'Risiko rendah' },
  medium: { en: 'Medium risk', id: 'Risiko sedang' },
  high: { en: 'High risk', id: 'Risiko tinggi' },
};

/**
 * Orders collision risk bands (`none < low < medium < high`).
 *
 * @returns a negative number when `a` is lower than `b`, `0` when equal, a
 * positive number otherwise; usable with `Array.prototype.sort`.
 */
export function compareCollisionRisk(
  a: CollisionRisk,
  b: CollisionRisk,
): number {
  return COLLISION_RISKS.indexOf(a) - COLLISION_RISKS.indexOf(b);
}

/**
 * Severity of the `collision` alert raised for a band (registry levels:
 * `high` → `critical`, `medium` → `warning`); `null` for `low` and `none`.
 */
export function collisionRiskAlertSeverity(
  risk: CollisionRisk,
): AlertSeverity | null {
  switch (risk) {
    case 'high':
      return ALERT_TYPES.collision.severityByLevel.high;
    case 'medium':
      return ALERT_TYPES.collision.severityByLevel.medium;
    case 'low':
    case 'none':
      return null;
  }
}

/** Label of a collision risk band in the given locale. */
export function collisionRiskLabel(
  risk: CollisionRisk,
  locale: Locale = 'en',
): string {
  return COLLISION_RISK_LABELS[risk][locale];
}

/** Lifecycle of a safety event (`safety.events.status`, spec 13.7). */
export const SAFETY_EVENT_STATUSES = ['open', 'resolved'] as const;

/** A safety event status. */
export type SafetyEventStatus = (typeof SAFETY_EVENT_STATUSES)[number];

/** Zod schema of {@link SafetyEventStatus}. */
export const SafetyEventStatusSchema = z
  .enum(SAFETY_EVENT_STATUSES)
  .describe('Safety event status');

/** Labels of every safety event status. */
export const SAFETY_EVENT_STATUS_LABELS: Readonly<
  Record<SafetyEventStatus, LocalizedText>
> = {
  open: { en: 'Open', id: 'Terbuka' },
  resolved: { en: 'Resolved', id: 'Selesai' },
};
