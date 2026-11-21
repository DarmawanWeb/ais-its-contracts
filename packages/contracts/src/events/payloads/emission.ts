import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { MmsiSchema } from '../../domain/ais.js';
import {
  CiiGradeSchema,
  FuelEstimationMethodSchema,
} from '../../domain/cii.js';
import { UuidSchema } from '../../domain/id.js';

/** Payload of `emission.cii.updated.v1`: year-to-date CII of a vessel. */
export const CiiUpdatedV1Schema = z
  .object({
    mmsi: MmsiSchema,
    vesselId: UuidSchema,
    orgId: UuidSchema.nullable(),
    year: z.int().min(2000).max(2200),
    asOf: IsoDateTimeSchema.describe('Time of the last segment included'),
    distanceNm: z.number().nonnegative().describe('Distance sailed, nm'),
    fuelMeTon: z.number().nonnegative().describe('Main engine fuel, t'),
    fuelAeTon: z.number().nonnegative().describe('Auxiliary engine fuel, t'),
    co2Ton: z.number().nonnegative().describe('CO2 emitted, t'),
    attained: z
      .number()
      .nonnegative()
      .describe('Attained CII, g CO2 / (capacity · nm)'),
    required: z.number().positive().describe('Required CII for the year'),
    rating: z.number().nonnegative().describe('attained / required'),
    grade: CiiGradeSchema,
    lastMethod: FuelEstimationMethodSchema.describe(
      'Fuel method of the most recent segment',
    ),
  })
  .meta({
    title: 'CiiUpdatedV1',
    description: 'Year-to-date Carbon Intensity Indicator of a vessel.',
  });

/** Payload of `emission.cii.updated.v1`. */
export type CiiUpdatedV1 = z.infer<typeof CiiUpdatedV1Schema>;
