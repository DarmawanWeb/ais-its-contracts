import * as z from 'zod';

/** Who performed an audited action. */
export const AUDIT_ACTOR_TYPES = ['user', 'api_key', 'system'] as const;

/** An audit actor type. */
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Zod schema of {@link AuditActorType}. */
export const AuditActorTypeSchema = z
  .enum(AUDIT_ACTOR_TYPES)
  .describe('Kind of actor that performed the action');

/**
 * Format of an audit action: dot separated lowercase tokens, at least
 * `<resource>.<verb>` (e.g. `vessel.update`, `auth.password.change`).
 */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

/** Zod schema of an audit action (see {@link AUDIT_ACTION_PATTERN}). */
export const AuditActionSchema = z
  .string()
  .regex(AUDIT_ACTION_PATTERN)
  .describe('Audited action "<resource>.<verb>", e.g. "vessel.update"');
