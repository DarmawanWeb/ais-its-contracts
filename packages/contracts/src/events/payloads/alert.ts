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
 * Issue of an alert payload whose `domain` is not the registry domain of its
 * (registry) `type`; future types are not checked.
 */
function checkAlertDomain(
  alert: { readonly type: string; readonly domain: string },
  context: z.RefinementCtx,
): void {
  if (!isKnownAlertType(alert.type)) return;
  const expected = ALERT_TYPES[alert.type].domain;
  if (alert.domain !== expected) {
    context.addIssue({
      code: 'custom',
      path: ['domain'],
      message: `Alert type "${alert.type}" belongs to domain "${expected}"`,
    });
  }
}

/** Maximum length of the `reason` of `alert.resolved.v1`. */
export const ALERT_RESOLUTION_REASON_MAX_LENGTH = 500;

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
  .superRefine(checkAlertDomain)
  .meta({
    title: 'AlertRaisedV1',
    description:
      'An alert raised by a safety or surveillance detector (alert type registry ALERT_TYPES).',
  });

/** Payload of `alert.raised.v1`. */
export type AlertRaisedV1 = z.infer<typeof AlertRaisedV1Schema>;

/**
 * Payload of `alert.resolved.v1`: the end of an alert occurrence (the vessel
 * is safe again, a pair has passed, …), published by the detector that
 * raised it on the raise's subject `alert.v1.<alertType>.<mmsi>`, so raise
 * and resolve of one occurrence stay ordered in the stream and in
 * per-subject dispatch. `type` is forward compatible; for a registry type,
 * `domain` must be the registry domain of the type.
 *
 * Consumer contract (the notification inbox): resolve the unresolved (open or
 * acknowledged) alert with this `dedupKey`, unless it merged an occurrence
 * later than `resolvedAt` (a re-raise after the condition ended); do nothing
 * when there is none; be idempotent by `id`.
 */
export const AlertResolvedV1Schema = z
  .object({
    id: UuidSchema.describe(
      'Resolution id (the envelope id and Nats-Msg-Id of the event); consumers are idempotent by it',
    ),
    alertId: UuidSchema.describe(
      'Id of the last alert.raised.v1 of the resolved occurrence',
    ),
    type: AlertTypeSchema,
    domain: AlertDomainSchema,
    severity: AlertSeveritySchema.describe(
      'Severity of the last published raise of the occurrence',
    ),
    mmsi: MmsiSchema,
    relatedMmsi: MmsiSchema.nullable().describe(
      'Second vessel involved (e.g. collision, transhipment)',
    ),
    zoneId: UuidSchema.nullable(),
    dedupKey: z
      .string()
      .min(1)
      .describe(
        'Key of the resolved occurrence (the dedupKey of its alert.raised.v1 events)',
      ),
    openedAt: IsoDateTimeSchema.describe('Start of the occurrence'),
    resolvedAt: IsoDateTimeSchema.describe(
      'End of the condition (signal time, normally not before openedAt)',
    ),
    reason: z
      .string()
      .max(ALERT_RESOLUTION_REASON_MAX_LENGTH)
      .nullable()
      .describe('Why the occurrence ended, e.g. "left the pipeline zone"'),
    methodId: MethodIdSchema.describe(
      'Methodology catalog id of the rule that raised the alert (spec 17)',
    ),
    data: z
      .record(z.string(), z.unknown())
      .describe('Detector specific details of the resolution'),
  })
  .superRefine(checkAlertDomain)
  .meta({
    title: 'AlertResolvedV1',
    description:
      'The end of an alert occurrence, published by the detector that raised it on the same subject. Consumers resolve the unresolved inbox alert with this dedupKey unless it merged an occurrence later than resolvedAt, do nothing when there is none, and are idempotent by id.',
  });

/** Payload of `alert.resolved.v1`. */
export type AlertResolvedV1 = z.infer<typeof AlertResolvedV1Schema>;
