import * as z from 'zod';

import type { Locale, LocalizedText } from './locale.js';
import {
  isKnownValue,
  type OpenVocabulary,
  openVocabularySchema,
  VOCABULARY_TOKEN_PATTERN,
} from './vocabulary.js';

/**
 * Analytics domains that raise alerts (spec 7.3, 18): navigational safety
 * (safety service) and illegal-activity surveillance (surveillance service).
 */
export const ALERT_DOMAINS = ['safety', 'surveillance'] as const;

/** An analytics domain. */
export type AlertDomain = (typeof ALERT_DOMAINS)[number];

/** Zod schema of {@link AlertDomain}. */
export const AlertDomainSchema = z
  .enum(ALERT_DOMAINS)
  .describe('Analytics domain: safety or surveillance');

/** Labels of every analytics domain. */
export const ALERT_DOMAIN_LABELS: Readonly<Record<AlertDomain, LocalizedText>> =
  {
    safety: { en: 'Navigational safety', id: 'Keselamatan navigasi' },
    surveillance: { en: 'Surveillance', id: 'Pengawasan' },
  };

/** Returns `true` when `value` is an analytics domain. */
export function isAlertDomain(value: unknown): value is AlertDomain {
  return isKnownValue(ALERT_DOMAINS, value);
}

/** Label of an analytics domain in the given locale. */
export function alertDomainLabel(
  domain: AlertDomain,
  locale: Locale = 'en',
): string {
  return ALERT_DOMAIN_LABELS[domain][locale];
}

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

/** Alert types of the registry, in registry order (spec 7.3). */
export const KNOWN_ALERT_TYPES = [
  'ews',
  'collision',
  'transhipment',
  'anomaly',
  'dark',
  'geofence',
  'fishing',
] as const;

/** An alert type of the registry. */
export type KnownAlertType = (typeof KNOWN_ALERT_TYPES)[number];

/**
 * An alert type: a registry type or a type added by a newer detector.
 * Consumers MUST handle unknown types gracefully (spec 7.3), e.g. with
 * {@link isKnownAlertType} and {@link alertTypeLabel}.
 */
export type AlertType = OpenVocabulary<KnownAlertType>;

/** Format of every alert type, known or future: a lowercase subject token. */
export const ALERT_TYPE_PATTERN = VOCABULARY_TOKEN_PATTERN;

/** Registry entry of an alert type. */
export interface AlertTypeDefinition {
  /** The alert type, also the `<alertType>` token of `alert.v1.<alertType>.<mmsi>`. */
  readonly type: string;
  /** Analytics domain (and service) that raises the type. */
  readonly domain: AlertDomain;
  readonly label: LocalizedText;
  readonly description: LocalizedText;
  /** Severity of an occurrence the detector does not grade. */
  readonly defaultSeverity: AlertSeverity;
  /**
   * Severity of each graded level that raises an alert (e.g. EWS `danger` →
   * `critical`). Levels that are not listed raise no alert; empty when the
   * detector does not grade its occurrences.
   */
  readonly severityByLevel: Readonly<Record<string, AlertSeverity>>;
}

/**
 * Registry of the alert types (spec 7.3): domain, default severity mapping and
 * labels. A detector that raises a new type adds it here in a minor release.
 */
export const ALERT_TYPES = {
  ews: {
    type: 'ews',
    domain: 'safety',
    label: {
      en: 'Pipeline early warning',
      id: 'Peringatan dini pipa bawah laut',
    },
    description: {
      en: 'A vessel predicted at anchor near a subsea pipeline (warning below 1 750 m, danger below 500 m).',
      id: 'Kapal yang diprediksi berlabuh jangkar di dekat pipa bawah laut (peringatan di bawah 1.750 m, bahaya di bawah 500 m).',
    },
    defaultSeverity: 'warning',
    severityByLevel: { danger: 'critical', warning: 'warning' },
  },
  collision: {
    type: 'collision',
    domain: 'safety',
    label: { en: 'Collision risk', id: 'Risiko tubrukan' },
    description: {
      en: 'Risk of collision between two vessels from the closest point of approach (CPA / TCPA).',
      id: 'Risiko tubrukan dua kapal berdasarkan titik pendekatan terdekat (CPA / TCPA).',
    },
    defaultSeverity: 'warning',
    severityByLevel: { high: 'critical', medium: 'warning' },
  },
  transhipment: {
    type: 'transhipment',
    domain: 'surveillance',
    label: { en: 'Illegal transhipment', id: 'Transhipment ilegal' },
    description: {
      en: 'A suspected ship-to-ship transfer between two vessels close together at low speed.',
      id: 'Dugaan pemindahan muatan antarkapal oleh dua kapal yang berdekatan dengan kecepatan rendah.',
    },
    defaultSeverity: 'warning',
    severityByLevel: {},
  },
  anomaly: {
    type: 'anomaly',
    domain: 'surveillance',
    label: {
      en: 'Navigational status anomaly',
      id: 'Anomali status navigasi',
    },
    description: {
      en: "The reported navigational status contradicts the vessel's motion (predicted status).",
      id: 'Status navigasi yang dilaporkan bertentangan dengan pergerakan kapal (status prediksi).',
    },
    defaultSeverity: 'info',
    severityByLevel: {},
  },
  dark: {
    type: 'dark',
    domain: 'surveillance',
    label: { en: 'AIS gap (dark vessel)', id: 'AIS terputus (kapal gelap)' },
    description: {
      en: 'AIS reports stopped while the vessel was under way away from ports and anchorages.',
      id: 'Laporan AIS terhenti saat kapal berlayar jauh dari pelabuhan dan area labuh jangkar.',
    },
    defaultSeverity: 'warning',
    severityByLevel: {},
  },
  geofence: {
    type: 'geofence',
    domain: 'surveillance',
    label: { en: 'Zone entry', id: 'Memasuki zona' },
    description: {
      en: 'A vessel entered a restricted, protected or custom zone that alerts on entry.',
      id: 'Kapal memasuki zona terlarang, kawasan konservasi atau zona khusus yang memicu alert saat dimasuki.',
    },
    defaultSeverity: 'warning',
    severityByLevel: {},
  },
  fishing: {
    type: 'fishing',
    domain: 'surveillance',
    label: {
      en: 'Suspected illegal fishing',
      id: 'Dugaan penangkapan ikan ilegal',
    },
    description: {
      en: 'A loitering pattern typical of fishing inside a fishing ground or a restricted zone.',
      id: 'Pola gerak khas penangkapan ikan di dalam daerah penangkapan ikan atau zona terlarang.',
    },
    defaultSeverity: 'warning',
    severityByLevel: {},
  },
} as const satisfies {
  readonly [Type in KnownAlertType]: AlertTypeDefinition & {
    readonly type: Type;
  };
};

/** Every alert type definition in registry order. */
export const ALERT_TYPE_LIST: readonly AlertTypeDefinition[] =
  Object.values(ALERT_TYPES);

/**
 * Zod schema of an alert type, forward compatible: registry types and any
 * future type matching {@link ALERT_TYPE_PATTERN} parse, so consumers keep
 * working when a newer detector raises a new type.
 */
export const AlertTypeSchema = openVocabularySchema(
  KNOWN_ALERT_TYPES,
  'Alert type: a registry type (ALERT_TYPES) or a future type; consumers accept unknown types',
);

/** Zod schema of a registry alert type only (rejects unknown types). */
export const KnownAlertTypeSchema = z
  .enum(KNOWN_ALERT_TYPES)
  .describe('Alert type of the registry');

/** Returns `true` when `value` is an alert type of the registry. */
export function isKnownAlertType(value: unknown): value is KnownAlertType {
  return isKnownValue(KNOWN_ALERT_TYPES, value);
}

/** Returns `true` when `value` is a well-formed alert type, known or future. */
export function isAlertType(value: unknown): value is AlertType {
  return typeof value === 'string' && ALERT_TYPE_PATTERN.test(value);
}

/**
 * Registry entry of an alert type.
 *
 * @returns the definition, or `undefined` for a type unknown to this version.
 */
export function getAlertType(type: string): AlertTypeDefinition | undefined {
  return isKnownAlertType(type) ? ALERT_TYPES[type] : undefined;
}

/** Registry alert types raised by an analytics domain, in registry order. */
export function alertTypesOfDomain(
  domain: AlertDomain,
): readonly AlertTypeDefinition[] {
  return ALERT_TYPE_LIST.filter((definition) => definition.domain === domain);
}

/**
 * Label of an alert type in the given locale; unknown (future) types are
 * shown by their id.
 *
 * @example alertTypeLabel('collision', 'id') // "Risiko tubrukan"
 */
export function alertTypeLabel(type: AlertType, locale: Locale = 'en'): string {
  return getAlertType(type)?.label[locale] ?? type;
}

/**
 * Default severity of a registry alert type: the severity of a graded `level`
 * when given, else the type's default severity.
 *
 * @returns the severity, or `null` when `level` raises no alert (a level not
 * listed in `severityByLevel`, e.g. EWS `safe`).
 *
 * @example defaultAlertSeverity('collision', 'high') // "critical"
 */
export function defaultAlertSeverity(
  type: KnownAlertType,
  level?: string,
): AlertSeverity | null {
  const definition: AlertTypeDefinition = ALERT_TYPES[type];
  if (level === undefined) return definition.defaultSeverity;
  return Object.hasOwn(definition.severityByLevel, level)
    ? (definition.severityByLevel[level] ?? null)
    : null;
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
