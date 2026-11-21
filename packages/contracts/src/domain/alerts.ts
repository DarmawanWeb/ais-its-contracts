import * as z from 'zod';

import type { Locale, LocalizedText } from './locale.js';

/** Alert types raised by the detectors (ais-processor raises `ews`). */
export const ALERT_TYPES = [
  'ews',
  'transhipment',
  'anomaly',
  'dark',
  'geofence',
  'fishing',
] as const;

/** An alert type. */
export type AlertType = (typeof ALERT_TYPES)[number];

/** Zod schema of {@link AlertType}. */
export const AlertTypeSchema = z.enum(ALERT_TYPES).describe('Alert type');

/** Labels of every alert type. */
export const ALERT_TYPE_LABELS: Readonly<Record<AlertType, LocalizedText>> = {
  ews: {
    en: 'Pipeline early warning',
    id: 'Peringatan dini pipa bawah laut',
  },
  transhipment: { en: 'Illegal transhipment', id: 'Transhipment ilegal' },
  anomaly: {
    en: 'Navigational status anomaly',
    id: 'Anomali status navigasi',
  },
  dark: { en: 'AIS gap (dark vessel)', id: 'AIS terputus (kapal gelap)' },
  geofence: { en: 'Zone entry', id: 'Memasuki zona' },
  fishing: {
    en: 'Suspected illegal fishing',
    id: 'Dugaan penangkapan ikan ilegal',
  },
};

/** Alert severities in ascending order of urgency. */
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;

/** An alert severity. */
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** Zod schema of {@link AlertSeverity}. */
export const AlertSeveritySchema = z
  .enum(ALERT_SEVERITIES)
  .describe('Alert severity');

/** Labels of every alert severity. */
export const ALERT_SEVERITY_LABELS: Readonly<
  Record<AlertSeverity, LocalizedText>
> = {
  info: { en: 'Information', id: 'Informasi' },
  warning: { en: 'Warning', id: 'Peringatan' },
  critical: { en: 'Critical', id: 'Kritis' },
};

/**
 * Orders severities by urgency (`info < warning < critical`).
 *
 * @returns a negative number when `a` is less urgent than `b`, `0` when equal,
 * a positive number otherwise; usable with `Array.prototype.sort`.
 */
export function compareAlertSeverity(
  a: AlertSeverity,
  b: AlertSeverity,
): number {
  return ALERT_SEVERITIES.indexOf(a) - ALERT_SEVERITIES.indexOf(b);
}

/** Returns `true` when `severity` is at least as urgent as `minimum`. */
export function isSeverityAtLeast(
  severity: AlertSeverity,
  minimum: AlertSeverity,
): boolean {
  return compareAlertSeverity(severity, minimum) >= 0;
}

/** Lifecycle of an alert in the notification inbox. */
export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;

/** An alert inbox status. */
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** Zod schema of {@link AlertStatus}. */
export const AlertStatusSchema = z
  .enum(ALERT_STATUSES)
  .describe('Alert status');

/** Labels of every alert status. */
export const ALERT_STATUS_LABELS: Readonly<Record<AlertStatus, LocalizedText>> =
  {
    open: { en: 'Open', id: 'Terbuka' },
    acknowledged: { en: 'Acknowledged', id: 'Diterima' },
    resolved: { en: 'Resolved', id: 'Selesai' },
  };

/** Review lifecycle of a detection event (detection service). */
export const DETECTION_STATUSES = [
  'open',
  'confirmed',
  'dismissed',
  'resolved',
] as const;

/** A detection review status. */
export type DetectionStatus = (typeof DETECTION_STATUSES)[number];

/** Zod schema of {@link DetectionStatus}. */
export const DetectionStatusSchema = z
  .enum(DETECTION_STATUSES)
  .describe('Detection review status');

/** Labels of every detection status. */
export const DETECTION_STATUS_LABELS: Readonly<
  Record<DetectionStatus, LocalizedText>
> = {
  open: { en: 'Open', id: 'Terbuka' },
  confirmed: { en: 'Confirmed', id: 'Terkonfirmasi' },
  dismissed: { en: 'Dismissed', id: 'Diabaikan' },
  resolved: { en: 'Resolved', id: 'Selesai' },
};

/** Label of an alert type in the given locale. */
export function alertTypeLabel(type: AlertType, locale: Locale = 'en'): string {
  return ALERT_TYPE_LABELS[type][locale];
}
