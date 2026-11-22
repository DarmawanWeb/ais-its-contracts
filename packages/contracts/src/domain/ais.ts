import * as z from 'zod';

import type { Locale, LocalizedText } from './locale.js';

/**
 * AIS feeds: the two legacy upstream socket.io servers (`primary`, `batam`) and
 * API-key authenticated pushers (`pusher`).
 */
export const AIS_SOURCES = ['primary', 'batam', 'pusher'] as const;

/** An AIS feed. */
export type AisSource = (typeof AIS_SOURCES)[number];

/** Zod schema of {@link AisSource}. */
export const AisSourceSchema = z
  .enum(AIS_SOURCES)
  .describe('AIS feed the message came from');

/** Smallest valid MMSI (9 digits). */
export const MMSI_MIN = 100_000_000;

/** Largest valid MMSI (9 digits). */
export const MMSI_MAX = 999_999_999;

/** Zod schema of a Maritime Mobile Service Identity: an integer with 9 digits. */
export const MmsiSchema = z
  .int()
  .min(MMSI_MIN)
  .max(MMSI_MAX)
  .describe('Maritime Mobile Service Identity (9 digits)');

/** Returns `true` when `value` is an integer MMSI with exactly 9 digits. */
export function isValidMmsi(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MMSI_MIN &&
    value <= MMSI_MAX
  );
}

/** AIS latitude value meaning "not available". */
export const LATITUDE_NOT_AVAILABLE = 91;

/** AIS longitude value meaning "not available". */
export const LONGITUDE_NOT_AVAILABLE = 181;

/** AIS true heading value meaning "not available". */
export const HEADING_NOT_AVAILABLE = 511;

/** AIS course over ground value meaning "not available". */
export const COG_NOT_AVAILABLE = 360;

/** AIS speed over ground value meaning "not available" (102.3 kn). */
export const SOG_NOT_AVAILABLE = 102.3;

/** Zod schema of speed over ground in knots, `[0, 102.3]`. */
export const SogSchema = z
  .number()
  .min(0)
  .max(SOG_NOT_AVAILABLE)
  .describe('Speed over ground in knots (102.3 = not available)');

/** Zod schema of course over ground in degrees, `[0, 360]`. */
export const CogSchema = z
  .number()
  .min(0)
  .max(COG_NOT_AVAILABLE)
  .describe('Course over ground in degrees (360 = not available)');

/** Zod schema of true heading in degrees: `[0, 360)` or `511` (not available). */
export const HeadingSchema = z
  .union([z.number().min(0).lt(360), z.literal(HEADING_NOT_AVAILABLE)])
  .describe('True heading in degrees 0..359 (511 = not available)');

/**
 * AIS navigational status codes (ITU-R M.1371, message types 1-3).
 *
 * @method navstatus.ais_codes
 */
export const NAV_STATUS = {
  UNDER_WAY_USING_ENGINE: 0,
  AT_ANCHOR: 1,
  NOT_UNDER_COMMAND: 2,
  RESTRICTED_MANOEUVRABILITY: 3,
  CONSTRAINED_BY_DRAUGHT: 4,
  MOORED: 5,
  AGROUND: 6,
  ENGAGED_IN_FISHING: 7,
  UNDER_WAY_SAILING: 8,
  RESERVED_HSC: 9,
  RESERVED_WIG: 10,
  TOWING_ASTERN: 11,
  PUSHING_AHEAD: 12,
  RESERVED: 13,
  AIS_SART_ACTIVE: 14,
  UNDEFINED: 15,
} as const;

/** An AIS navigational status code `0..15`. */
export type NavStatus = (typeof NAV_STATUS)[keyof typeof NAV_STATUS];

/** Every navigational status code in ascending order. */
export const NAV_STATUS_CODES: readonly NavStatus[] = Object.values(NAV_STATUS);

/** Zod schema of a navigational status code (integer `0..15`). */
export const NavStatusSchema = z
  .int()
  .min(0)
  .max(15)
  .describe('AIS navigational status 0..15');

/** English and Indonesian labels of every navigational status. */
export const NAV_STATUS_LABELS: Readonly<Record<NavStatus, LocalizedText>> = {
  0: { en: 'Under way using engine', id: 'Berlayar menggunakan mesin' },
  1: { en: 'At anchor', id: 'Berlabuh jangkar' },
  2: { en: 'Not under command', id: 'Tidak terkendali' },
  3: { en: 'Restricted manoeuvrability', id: 'Kemampuan olah gerak terbatas' },
  4: { en: 'Constrained by draught', id: 'Terbatas oleh sarat air' },
  5: { en: 'Moored', id: 'Tertambat' },
  6: { en: 'Aground', id: 'Kandas' },
  7: { en: 'Engaged in fishing', id: 'Sedang menangkap ikan' },
  8: { en: 'Under way sailing', id: 'Berlayar menggunakan layar' },
  9: { en: 'Reserved (high-speed craft)', id: 'Dicadangkan (kapal cepat)' },
  10: { en: 'Reserved (wing in ground)', id: 'Dicadangkan (wing in ground)' },
  11: {
    en: 'Power-driven vessel towing astern',
    id: 'Kapal bermesin menunda di buritan',
  },
  12: {
    en: 'Power-driven vessel pushing ahead or towing alongside',
    id: 'Kapal bermesin mendorong di depan atau menunda di samping',
  },
  13: { en: 'Reserved for future use', id: 'Dicadangkan' },
  14: { en: 'AIS-SART active', id: 'AIS-SART aktif' },
  15: { en: 'Undefined', id: 'Tidak terdefinisi' },
};

/** Returns `true` when `value` is a navigational status code `0..15`. */
export function isNavStatus(value: unknown): value is NavStatus {
  return NAV_STATUS_CODES.some((code) => code === value);
}

/**
 * Human-readable label of a navigational status.
 *
 * @example navStatusLabel(1, 'id') // "Berlabuh jangkar"
 */
export function navStatusLabel(code: number, locale: Locale = 'en'): string {
  if (isNavStatus(code)) {
    return NAV_STATUS_LABELS[code][locale];
  }
  return locale === 'id' ? `Tidak diketahui (${code})` : `Unknown (${code})`;
}

/**
 * Navigational status predicted from motion (legacy
 * `calculatePredictedNavStatus`): `1` = the vessel behaves as if at anchor.
 */
export const PREDICTED_NAV_STATUS = {
  NOT_AT_ANCHOR: 0,
  AT_ANCHOR: 1,
} as const;

/** A predicted navigational status, `0` or `1`. */
export type PredictedNavStatus =
  (typeof PREDICTED_NAV_STATUS)[keyof typeof PREDICTED_NAV_STATUS];

/** Zod schema of {@link PredictedNavStatus}. */
export const PredictedNavStatusSchema = z
  .union([z.literal(0), z.literal(1)])
  .describe('Predicted navigational status: 1 = at anchor, 0 = not at anchor');

/** Labels of the predicted navigational statuses. */
export const PREDICTED_NAV_STATUS_LABELS: Readonly<
  Record<PredictedNavStatus, LocalizedText>
> = {
  0: {
    en: 'Not at anchor (predicted)',
    id: 'Tidak berlabuh jangkar (prediksi)',
  },
  1: { en: 'At anchor (predicted)', id: 'Berlabuh jangkar (prediksi)' },
};

/**
 * Navigational status anomaly rule of the legacy web app: the reported status
 * contradicts the predicted one, i.e. `(predicted = 0 ∧ navstatus = 1) ∨
 * (predicted = 1 ∧ navstatus ≠ 1)`.
 */
export function isNavStatusAnomaly(
  navstatus: number,
  predictedNavstatus: PredictedNavStatus,
): boolean {
  return predictedNavstatus === PREDICTED_NAV_STATUS.NOT_AT_ANCHOR
    ? navstatus === NAV_STATUS.AT_ANCHOR
    : navstatus !== NAV_STATUS.AT_ANCHOR;
}
