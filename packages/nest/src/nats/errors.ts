/**
 * Thrown by an event handler for a transient failure (dependency down,
 * conflict): the message is redelivered after a backoff delay, and
 * dead-lettered once `maxDeliver` deliveries failed. Any unknown error is
 * treated the same way.
 */
export class RetryableError extends Error {
  override readonly name: string = 'RetryableError';
  /** Overrides the backoff delay of the next delivery, ms. */
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: { readonly retryAfterMs?: number; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Thrown by an event handler when the message can never be processed
 * (business rule violation, unknown entity that will never exist): the
 * message is terminated (`term()`), not retried and not dead-lettered.
 */
export class NonRetryableError extends Error {
  override readonly name: string = 'NonRetryableError';

  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, { cause: options.cause });
  }
}

/**
 * Thrown by `EventPublisher` when an explicit subject differs from the
 * contracts subject of the event (`subjectForEvent`): a programming error
 * that would break per-subject compaction (`FLEET`, `GEO`, `SAFETY`) and
 * the consumers' filters. Nothing is published.
 */
export class EventSubjectMismatchError extends Error {
  override readonly name = 'EventSubjectMismatchError';
}
