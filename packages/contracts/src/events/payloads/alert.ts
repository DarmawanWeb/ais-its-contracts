import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { MmsiSchema } from '../../domain/ais.js';
import { AlertSeveritySchema, AlertTypeSchema } from '../../domain/alerts.js';
import { LatitudeSchema, LongitudeSchema } from '../../domain/geo.js';
import { UuidSchema } from '../../domain/id.js';

/** Payload of `alert.raised.v1`: an occurrence detected by a detector. */
export const AlertRaisedV1Schema = z
  .object({
    id: UuidSchema.describe('Alert id (also the inbox id)'),
    type: AlertTypeSchema,
    severity: AlertSeveritySchema,
    mmsi: MmsiSchema,
    relatedMmsi: MmsiSchema.nullable().describe(
      'Second vessel involved (e.g. transhipment)',
    ),
    title: z.string().min(1),
    message: z.string(),
    lat: LatitudeSchema.nullable(),
    lon: LongitudeSchema.nullable(),
    occurredAt: IsoDateTimeSchema,
    dedupKey: z
      .string()
      .min(1)
      .describe('Open alerts with the same key are merged, e.g. "ews:<mmsi>"'),
    zoneId: UuidSchema.nullable(),
    data: z
      .record(z.string(), z.unknown())
      .describe('Detector specific details'),
  })
  .meta({
    title: 'AlertRaisedV1',
    description: 'An alert raised by ais-processor (ews) or detection.',
  });

/** Payload of `alert.raised.v1`. */
export type AlertRaisedV1 = z.infer<typeof AlertRaisedV1Schema>;
