import * as z from 'zod';

import type { Locale, LocalizedText } from './locale.js';

/** IMO CII rating grades, best (`A`) to worst (`E`). */
export const CII_GRADES = ['A', 'B', 'C', 'D', 'E'] as const;

/** A CII rating grade. */
export type CiiGrade = (typeof CII_GRADES)[number];

/** Zod schema of {@link CiiGrade}. */
export const CiiGradeSchema = z.enum(CII_GRADES).describe('CII rating grade');

/** Labels of every CII grade (IMO MEPC.354(78) wording). */
export const CII_GRADE_LABELS: Readonly<Record<CiiGrade, LocalizedText>> = {
  A: { en: 'Major superior', id: 'Sangat unggul' },
  B: { en: 'Minor superior', id: 'Unggul' },
  C: { en: 'Moderate', id: 'Sedang' },
  D: { en: 'Minor inferior', id: 'Kurang' },
  E: { en: 'Inferior', id: 'Buruk' },
};

/**
 * Rating boundaries ("d vector", IMO MEPC.354(78)) of a ship type, expressed as
 * multiples of the required CII: `exp(d1) .. exp(d4)` in IMO terms.
 */
export interface DdVector {
  readonly d1: number;
  readonly d2: number;
  readonly d3: number;
  readonly d4: number;
}

/** Zod schema of {@link DdVector}. */
export const DdVectorSchema = z
  .object({
    d1: z.number().positive(),
    d2: z.number().positive(),
    d3: z.number().positive(),
    d4: z.number().positive(),
  })
  .describe('CII rating boundaries as multiples of the required CII');

/**
 * Assigns the CII grade of a rating (`attained / required`).
 *
 * Exact parity with the legacy `assignGradeBasedOnDdVector`, including its
 * behaviour for non-finite ratings (`NaN` yields `E`) and for non-monotonic
 * vectors; hence the deliberately explicit condition chain.
 *
 * @example assignCiiGrade(0.97, { d1: 0.86, d2: 0.94, d3: 1.06, d4: 1.18 }) // "C"
 */
export function assignCiiGrade(rating: number, d: DdVector): CiiGrade {
  const { d1, d2, d3, d4 } = d;
  if (rating < d1) {
    return 'A';
  } else if (rating >= d1 && rating < d2) {
    return 'B';
  } else if (rating >= d2 && rating < d3) {
    return 'C';
  } else if (rating >= d3 && rating < d4) {
    return 'D';
  }
  return 'E';
}

/**
 * Absolute grade boundaries for a required CII (`d × required`, legacy
 * `getAnnualCiiByMMMSIWithDDVector`), in the unit of the attained CII.
 */
export function ciiGradeBoundaries(required: number, d: DdVector): DdVector {
  return {
    d1: d.d1 * required,
    d2: d.d2 * required,
    d3: d.d3 * required,
    d4: d.d4 * required,
  };
}

/** Members of a vessel snapshot that determine its CII capacity. */
export interface CiiCapacityInput {
  readonly type: { readonly capacityFixed?: number | null | undefined };
  readonly dimensions: { readonly capacity: number };
}

/**
 * Capacity used by the CII (spec 13.5): the regulation-fixed capacity of the
 * ship type when it has one (e.g. 279 000 for bulk carriers of 279 000 DWT and
 * above, MEPC.353(78)), else the capacity of the vessel.
 *
 * @example ciiCapacity(vesselSnapshot) // type.capacityFixed ?? dimensions.capacity
 */
export function ciiCapacity(vessel: CiiCapacityInput): number {
  return vessel.type.capacityFixed ?? vessel.dimensions.capacity;
}

/** Label of a CII grade in the given locale. */
export function ciiGradeLabel(grade: CiiGrade, locale: Locale = 'en'): string {
  return CII_GRADE_LABELS[grade][locale];
}

/**
 * Fuel estimation methods of a voyage segment in priority order (spec 13.5):
 * telemetry readings, the vessel's first fuel formula, the Holtrop model.
 */
export const FUEL_ESTIMATION_METHODS = [
  'telemetry',
  'first_formula',
  'holtrop',
] as const;

/** A fuel estimation method. */
export type FuelEstimationMethod = (typeof FUEL_ESTIMATION_METHODS)[number];

/** Zod schema of {@link FuelEstimationMethod}. */
export const FuelEstimationMethodSchema = z
  .enum(FUEL_ESTIMATION_METHODS)
  .describe('Fuel estimation method');
