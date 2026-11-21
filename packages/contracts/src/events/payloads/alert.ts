import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { MmsiSchema } from '../../domain/ais.js';
import {
  ALERT_TYPES,
  AlertDomainSchema,
  AlertSeveritySchema,
  AlertTypeSchema,
  isKnownAlertType,
} from '../../domain/alerts.js';
import { LatitudeSchema, LongitudeSchema } from '../../domain/geo.js';
import { UuidSchema } from '../../domain/id.js';
import { MethodIdSchema } from '../../references/ids.js';

/**
 * Payload of `alert.raised.v1`: an occurrence detected by a safety or
 * surveillance detector. `type` is forward compatible (future types parse);
 * for a registry type, `domain` must be the registry domain of the type.
 */
export const AlertRaisedV1Schema = z
  .object({
    id: UuidSchema.describe('Alert id (also the inbox id)'),
    type: AlertTypeSchema,
    domain: AlertDomainSchema,
    severity: AlertSeveritySchema,
    mmsi: MmsiSchema,
    relatedMmsi: MmsiSchema.nullable().describe(
      'Second vessel involved (e.g. collision, transhipment)',
    ),
    title: z.string().min(1),
    message: z.string(),
    lat: LatitudeSchema.nullable(),
    lon: LongitudeSchema.nullable(),
    occurredAt: IsoDateTimeSchema,
    dedupKey: z
      .string()
      .min(1)
      .describe(
        'Open alerts with the same key are merged, e.g. "ews:<mmsi>:<zoneId>"',
      ),
    zoneId: UuidSchema.nullable(),
    methodId: MethodIdSchema.describe(
      'Methodology catalog id of the rule that raised the alert (spec 17)',
    ),
    data: z
      .record(z.string(), z.unknown())
      .describe('Detector specific details'),
  })
  .superRefine((alert, context) => {
    if (!isKnownAlertType(alert.type)) return;
    const expected = ALERT_TYPES[alert.type].domain;
    if (alert.domain !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['domain'],
        message: `Alert type "${alert.type}" belongs to domain "${expected}"`,
      });
    }
  })
  .meta({
    title: 'AlertRaisedV1',
    description:
      'An alert raised by a safety or surveillance detector (alert type registry ALERT_TYPES).',
  });

/** Payload of `alert.raised.v1`. */
export type AlertRaisedV1 = z.infer<typeof AlertRaisedV1Schema>;
