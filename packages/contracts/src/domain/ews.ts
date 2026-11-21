import * as z from 'zod';

import { PREDICTED_NAV_STATUS } from './ais.js';
import { ALERT_TYPES, type AlertSeverity } from './alerts.js';
import type { Locale, LocalizedText } from './locale.js';

/**
 * Pipeline Early Warning System status (legacy `checkShipStatus`). The codes
 * are not contiguous: `2` is unused for parity with the legacy data.
 */
export const EWS_STATUS = {
  DANGER: 0,
  WARNING: 1,
  SAFE: 3,
} as const;

/** An EWS status code: `0` danger, `1` warning, `3` safe. */
export type EwsStatus = (typeof EWS_STATUS)[keyof typeof EWS_STATUS];

/** Every EWS status code. */
export const EWS_STATUSES: readonly EwsStatus[] = Object.values(EWS_STATUS);

/** Zod schema of {@link EwsStatus}. */
export const EwsStatusSchema = z
  .union([z.literal(0), z.literal(1), z.literal(3)])
  .describe('Pipeline EWS status: 0 danger, 1 warning, 3 safe');

/** Labels of every EWS status. */
export const EWS_STATUS_LABELS: Readonly<Record<EwsStatus, LocalizedText>> = {
  0: { en: 'Danger', id: 'Bahaya' },
  1: { en: 'Warning', id: 'Peringatan' },
  3: { en: 'Safe', id: 'Aman' },
};

/** Distance to the pipeline below which an anchored vessel is in danger. */
export const EWS_DANGER_DISTANCE_M = 500;

/** Distance to the pipeline below which an anchored vessel gets a warning. */
export const EWS_WARNING_DISTANCE_M = 1750;

/** Distance thresholds of the EWS classification, in meters. */
export interface EwsThresholds {
  /** Below this distance an anchored vessel is in danger (`EWS_DANGER_M`). */
  readonly dangerM: number;
  /** Below this distance an anchored vessel gets a warning (`EWS_WARNING_M`). */
  readonly warningM: number;
}

/** Legacy thresholds: danger below 500 m, warning below 1 750 m. */
export const EWS_DEFAULT_THRESHOLDS: EwsThresholds = {
  dangerM: EWS_DANGER_DISTANCE_M,
  warningM: EWS_WARNING_DISTANCE_M,
};

/**
 * Classifies a position against the nearest pipeline exactly like the legacy
 * `checkShipStatus` (spec 13.7): only vessels predicted at anchor
 * (`predictedNavstatus = 1`, the value the legacy passes) can be in danger
 * (`< 500 m`) or warned (`< 1 750 m`); everything else is safe.
 *
 * @param pipelineDistanceM distance to the nearest pipeline line in meters.
 * @param predictedNavstatus predicted navigational status (legacy `calculatePredictedNavStatus`).
 * @param thresholds distance thresholds; the legacy values by default.
 */
export function classifyEwsStatus(
  pipelineDistanceM: number,
  predictedNavstatus: number,
  thresholds: EwsThresholds = EWS_DEFAULT_THRESHOLDS,
): EwsStatus {
  if (predictedNavstatus === PREDICTED_NAV_STATUS.AT_ANCHOR) {
    if (pipelineDistanceM < thresholds.dangerM) return EWS_STATUS.DANGER;
    if (pipelineDistanceM < thresholds.warningM) return EWS_STATUS.WARNING;
  }
  return EWS_STATUS.SAFE;
}

/**
 * Severity of the `ews` alert raised for a status (registry levels: `0` →
 * `critical`, `1` → `warning`); `null` when the status raises no alert.
 */
export function ewsAlertSeverity(status: EwsStatus): AlertSeverity | null {
  switch (status) {
    case EWS_STATUS.DANGER:
      return ALERT_TYPES.ews.severityByLevel.danger;
    case EWS_STATUS.WARNING:
      return ALERT_TYPES.ews.severityByLevel.warning;
    case EWS_STATUS.SAFE:
      return null;
  }
}

/** Label of an EWS status in the given locale. */
export function ewsStatusLabel(
  status: EwsStatus,
  locale: Locale = 'en',
): string {
  return EWS_STATUS_LABELS[status][locale];
}
