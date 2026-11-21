import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import {
  AisSourceSchema,
  CogSchema,
  HeadingSchema,
  MmsiSchema,
  NavStatusSchema,
  PredictedNavStatusSchema,
  SogSchema,
} from '../../domain/ais.js';
import { LatitudeSchema, LongitudeSchema } from '../../domain/geo.js';

/** Payload of `ais.raw.received.v1`: one normalized AIS position report. */
export const AisRawReceivedV1Schema = z
  .object({
    source: AisSourceSchema,
    receivedAt: IsoDateTimeSchema.describe('When the ingestor received it'),
    positionTime: IsoDateTimeSchema.describe(
      'Position time (legacy: timestamp - utc seconds)',
    ),
    mmsi: MmsiSchema,
    navstatus: NavStatusSchema,
    lat: LatitudeSchema,
    lon: LongitudeSchema,
    sog: SogSchema,
    cog: CogSchema,
    hdg: HeadingSchema,
    aisType: z
      .int()
      .nonnegative()
      .nullable()
      .describe('AIS message type (1-3 class A, 18/19 class B)'),
    receiverPort: z
      .string()
      .nullable()
      .describe('Receiver port reported by the upstream'),
  })
  .meta({
    title: 'AisRawReceivedV1',
    description: 'A validated, normalized AIS position report from a feed.',
  });

/** Payload of `ais.raw.received.v1`. */
export type AisRawReceivedV1 = z.infer<typeof AisRawReceivedV1Schema>;

/** The previously recorded position of a vessel, embedded in position events. */
export const PreviousPositionSchema = z
  .object({
    time: IsoDateTimeSchema,
    lat: LatitudeSchema,
    lon: LongitudeSchema,
    sog: SogSchema,
    cog: CogSchema,
    hdg: HeadingSchema,
    navstatus: NavStatusSchema,
    predictedNavstatus: PredictedNavStatusSchema,
  })
  .describe('Last recorded position of the vessel before this one');

/** The previously recorded position of a vessel. */
export type PreviousPosition = z.infer<typeof PreviousPositionSchema>;

/** Payload of `ais.position.recorded.v1`: an enriched, persisted position (AIS data only). */
export const AisPositionRecordedV1Schema = z
  .object({
    mmsi: MmsiSchema,
    time: IsoDateTimeSchema.describe('Position time'),
    source: AisSourceSchema,
    lat: LatitudeSchema,
    lon: LongitudeSchema,
    sog: SogSchema,
    cog: CogSchema,
    hdg: HeadingSchema,
    navstatus: NavStatusSchema,
    predictedNavstatus: PredictedNavStatusSchema,
    coastDistanceM: z
      .number()
      .nonnegative()
      .nullable()
      .describe('Distance to the Indonesian coastline in meters'),
    previous: PreviousPositionSchema.nullable(),
  })
  .meta({
    title: 'AisPositionRecordedV1',
    description:
      'A position recorded by the ais-processor, enriched with the predicted navstatus and the coast distance, plus the previous position of the vessel. It carries no safety fields: EWS and collision risk are computed by the safety service (SafetyVesselStateV1).',
  });

/** Payload of `ais.position.recorded.v1`. */
export type AisPositionRecordedV1 = z.infer<typeof AisPositionRecordedV1Schema>;
