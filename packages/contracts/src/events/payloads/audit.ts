import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { AuditActionSchema, AuditActorTypeSchema } from '../../domain/audit.js';
import { UuidSchema } from '../../domain/id.js';

/** Payload of `audit.recorded.v1`: one audited action. */
export const AuditRecordedV1Schema = z
  .object({
    actorType: AuditActorTypeSchema,
    actorId: UuidSchema.nullable().describe(
      'User or API key id; null for the system',
    ),
    orgId: UuidSchema.nullable(),
    action: AuditActionSchema,
    targetType: z.string().min(1).nullable().describe('e.g. "vessel"'),
    targetId: z.string().min(1).nullable(),
    ip: z.string().min(1).nullable(),
    userAgent: z.string().nullable(),
    meta: z.record(z.string(), z.unknown()).describe('Action details'),
    at: IsoDateTimeSchema,
  })
  .meta({
    title: 'AuditRecordedV1',
    description: 'An action recorded for the central audit log.',
  });

/** Payload of `audit.recorded.v1`. */
export type AuditRecordedV1 = z.infer<typeof AuditRecordedV1Schema>;
