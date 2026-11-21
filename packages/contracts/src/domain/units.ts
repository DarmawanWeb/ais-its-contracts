import { METERS_PER_NAUTICAL_MILE } from './geo.js';

/**
 * Knots to meters per second factor of the legacy code (`speedKnot * 0.5144`).
 * The exact value is 1852 / 3600 = 0.51444…; the rounded legacy factor is kept
 * for numerical parity of the ported formulas.
 */
export const KNOTS_TO_MS = 0.5144;

/** Converts knots to meters per second with the legacy factor {@link KNOTS_TO_MS}. */
export function knotsToMs(knots: number): number {
  return knots * KNOTS_TO_MS;
}

/** Converts meters per second to knots (inverse of {@link knotsToMs}). */
export function msToKnots(metersPerSecond: number): number {
  return metersPerSecond / KNOTS_TO_MS;
}

/** Converts nautical miles to meters. */
export function nmToMeters(nauticalMiles: number): number {
  return nauticalMiles * METERS_PER_NAUTICAL_MILE;
}

/** Converts meters to nautical miles. */
export function metersToNm(meters: number): number {
  return meters / METERS_PER_NAUTICAL_MILE;
}
