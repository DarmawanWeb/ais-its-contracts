import type { FieldError } from '../api/problem.js';

/** Why an event was rejected. */
export const EVENT_FAILURE_REASONS = [
  'invalid_json',
  'invalid_envelope',
  'unknown_type',
  'invalid_payload',
] as const;

/** Why an event was rejected. */
export type EventFailureReason = (typeof EVENT_FAILURE_REASONS)[number];

/** A rejected event with a log-friendly description. */
export interface EventFailure {
  readonly success: false;
  readonly reason: EventFailureReason;
  /** One-line summary, e.g. `Invalid payload of ais.raw.received.v1: mmsi: …`. */
  readonly message: string;
  /** Field-level problems (empty for `invalid_json` / `unknown_type`). */
  readonly issues: readonly FieldError[];
  /** Event type when it could be read, else `null`. */
  readonly type: string | null;
}

/**
 * Builds an {@link EventFailure} whose message lists every issue.
 *
 * @internal
 */
export function eventFailure(
  reason: EventFailureReason,
  summary: string,
  type: string | null,
  issues: readonly FieldError[] = [],
): EventFailure {
  const details = issues
    .map(
      (issue) =>
        `${issue.field === '' ? '(root)' : issue.field}: ${issue.message}`,
    )
    .join('; ');
  return {
    success: false,
    reason,
    message: details === '' ? summary : `${summary}: ${details}`,
    issues,
    type,
  };
}

/** Thrown by `makeEnvelope` when a produced event violates its contract. */
export class InvalidEventError extends Error {
  override readonly name = 'InvalidEventError';

  constructor(readonly failure: EventFailure) {
    super(failure.message);
  }

  /** Field-level problems of the rejected event. */
  get issues(): readonly FieldError[] {
    return this.failure.issues;
  }
}
