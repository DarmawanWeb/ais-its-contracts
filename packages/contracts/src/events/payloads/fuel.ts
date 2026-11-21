import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { MmsiSchema } from '../../domain/ais.js';
import { UuidSchema } from '../../domain/id.js';
import { FuelReadingSourceSchema } from '../../domain/telemetry.js';

/** Payload of `fuel.reading.recorded.v1`: a stored fuel consumption reading. */
export const FuelReadingRecordedV1Schema = z
  .object({
    mmsi: MmsiSchema,
    time: IsoDateTimeSchema.describe(
      'Reading time; end of the measured period when periodStart is set',
    ),
    periodStart: IsoDateTimeSchema.nullable().describe(
      'Start of the measured period, null when unknown',
    ),
    fuelMeTon: z
      .number()
      .nonnegative()
      .describe('Main engine fuel consumed, metric tonnes'),
    fuelAeTon: z
      .number()
      .nonnegative()
      .describe('Auxiliary engine fuel consumed, metric tonnes'),
    deviceId: UuidSchema.nullable().describe('Reporting device, if any'),
    source: FuelReadingSourceSchema,
  })
  .meta({
    title: 'FuelReadingRecordedV1',
    description:
      'A fuel consumption reading accepted by the telemetry service.',
  });

/** Payload of `fuel.reading.recorded.v1`. */
export type FuelReadingRecordedV1 = z.infer<typeof FuelReadingRecordedV1Schema>;
