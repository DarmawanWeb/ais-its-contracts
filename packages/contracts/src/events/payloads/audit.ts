import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { AuditActionSchema, AuditActorTypeSchema } from '../../domain/audit.js';
import { UuidSchema } from '../../domain/id.js';

/** Longest name in {@link AuditLabelsSchema} (characters). */
export const AUDIT_LABEL_MAX_LENGTH = 200;

const AuditLabelSchema = z.string().max(AUDIT_LABEL_MAX_LENGTH).nullable();

/**
 * Names of an audit record's actor, organization and target as its producer
 * knew them when it wrote the record (in the transaction of the change),
 * so the audit log shows the names at the time of the action even after a
 * later rename or deletion. Every member is optional: absent = the producer
 * does not say (the audit log may resolve the name itself), `null` = it has
 * none. At most {@link AUDIT_LABEL_MAX_LENGTH} characters each.
 */
export const AuditLabelsSchema = z
  .object({
    actorName: AuditLabelSchema.optional().describe(
      'Display name of the actor (user or API key) at the time of the action',
    ),
    actorEmail: AuditLabelSchema.optional().describe(
      'E-mail address of the acting user at the time of the action',
    ),
    orgName: AuditLabelSchema.optional().describe(
      'Name of the organization (orgId) at the time of the action',
    ),
    targetLabel: AuditLabelSchema.optional().describe(
      'Human-readable name of the target (targetType/targetId) at the time of the action, e.g. a vessel name',
    ),
  })
  .meta({
    title: 'AuditLabels',
    description:
      'Names of the actor, organization and target known to the producer when it wrote the record.',
  });

/** Names carried by an audit record (see {@link AuditLabelsSchema}). */
export type AuditLabels = z.infer<typeof AuditLabelsSchema>;

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
    labels: AuditLabelsSchema.optional().describe(
      'Names known to the producer when it wrote the record (optional: consumers built on older contracts ignore it)',
    ),
  })
  .meta({
    title: 'AuditRecordedV1',
    description: 'An action recorded for the central audit log.',
  });

/** Payload of `audit.recorded.v1`. */
export type AuditRecordedV1 = z.infer<typeof AuditRecordedV1Schema>;
