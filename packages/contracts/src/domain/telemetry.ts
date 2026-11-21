import * as z from 'zod';

/** Origins of a fuel consumption reading. */
export const FUEL_READING_SOURCES = [
  'device',
  'mqtt',
  'api',
  'manual',
  'import',
] as const;

/** A fuel reading origin. */
export type FuelReadingSource = (typeof FUEL_READING_SOURCES)[number];

/** Zod schema of {@link FuelReadingSource}. */
export const FuelReadingSourceSchema = z
  .enum(FUEL_READING_SOURCES)
  .describe('Origin of the fuel reading');
