import * as z from 'zod';

import type { Locale, LocalizedText } from './locale.js';

/** Kinds of zones (geofences) of the geo service registry (spec 7.4, 13.6). */
export const ZONE_KINDS = [
  'pipeline',
  'transhipment_area',
  'fishing_ground',
  'mpa',
  'restricted',
  'anchorage',
  'port',
  'tss_lane',
  'shallow_water',
  'custom',
] as const;

/** A zone kind. */
export type ZoneKind = (typeof ZONE_KINDS)[number];

/** Zod schema of {@link ZoneKind}. */
export const ZoneKindSchema = z.enum(ZONE_KINDS).describe('Zone kind');

/** Labels of every zone kind. */
export const ZONE_KIND_LABELS: Readonly<Record<ZoneKind, LocalizedText>> = {
  pipeline: { en: 'Pipeline corridor', id: 'Koridor pipa bawah laut' },
  transhipment_area: { en: 'Transhipment area', id: 'Area transhipment' },
  fishing_ground: { en: 'Fishing ground', id: 'Daerah penangkapan ikan' },
  mpa: { en: 'Marine protected area', id: 'Kawasan konservasi perairan' },
  restricted: { en: 'Restricted area', id: 'Area terlarang' },
  anchorage: { en: 'Anchorage', id: 'Area labuh jangkar' },
  port: { en: 'Port area', id: 'Area pelabuhan' },
  tss_lane: {
    en: 'Traffic separation scheme lane',
    id: 'Alur skema pemisah lalu lintas (TSS)',
  },
  shallow_water: { en: 'Shallow water', id: 'Perairan dangkal' },
  custom: { en: 'Custom zone', id: 'Zona khusus' },
};

/** Returns `true` when `value` is a zone kind. */
export function isZoneKind(value: unknown): value is ZoneKind {
  return ZONE_KINDS.some((kind) => kind === value);
}

/** Label of a zone kind in the given locale. */
export function zoneKindLabel(kind: ZoneKind, locale: Locale = 'en'): string {
  return ZONE_KIND_LABELS[kind][locale];
}

/** Largest number of positions (vertices) of a zone geometry the geo service accepts. */
export const ZONE_MAX_VERTICES = 50_000;
