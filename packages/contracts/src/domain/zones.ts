import * as z from 'zod';

import type { Locale, LocalizedText } from './locale.js';

/** Kinds of zones (geofences) managed by the detection service. */
export const ZONE_KINDS = [
  'pipeline',
  'transhipment_area',
  'fishing_ground',
  'mpa',
  'restricted',
  'port',
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
  port: { en: 'Port area', id: 'Area pelabuhan' },
  custom: { en: 'Custom zone', id: 'Zona khusus' },
};

/** Label of a zone kind in the given locale. */
export function zoneKindLabel(kind: ZoneKind, locale: Locale = 'en'): string {
  return ZONE_KIND_LABELS[kind][locale];
}
