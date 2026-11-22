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
 * Thrown by an event handler when the message can never be processed but
 * must be kept for an operator (a value the store rejects, a payload that
 * needs a manual fix): on any delivery, the message is copied at once to
 * `dlq.<stream>.<consumer>` with the `Ais-Its-Dlq-*` headers
 * (`Ais-Its-Dlq-Error-Name: DeadLetterError`) and acknowledged, without the
 * remaining retries (outcome `dead_letter`). Use {@link NonRetryableError}
 * to drop a message, {@link RetryableError} to retry it.
 *
 * @example
 * if (!fitsColumn(event.data.name)) throw new DeadLetterError('name longer than 255 characters');
 */
export class DeadLetterError extends Error {
  override readonly name: string = 'DeadLetterError';

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

/**
 * An event whose NATS message (encoded envelope plus headers) is larger
 * than the server's `max_payload`, or than an explicit limit: it can never
 * be published as is. Thrown by `EventPublisher` before anything is sent,
 * by `enqueueEvent({ maxBytes })` before the row is written, and recorded
 * by the outbox relay, which parks the row (`failed_at`) instead of
 * retrying it. The message always contains `max_payload`.
 */
export class EventTooLargeError extends Error {
  override readonly name = 'EventTooLargeError';
  /** Event type of the message. */
  readonly type: string;
  /** Size of the message (or its estimate), bytes. */
  readonly sizeBytes: number;
  /** The limit it exceeds, bytes. */
  readonly maxBytes: number;

  constructor(
    type: string,
    sizeBytes: number,
    maxBytes: number,
    options: { readonly cause?: unknown } = {},
  ) {
    super(
      `${type} message of ${sizeBytes} bytes exceeds the NATS max_payload of ${maxBytes} bytes`,
      { cause: options.cause },
    );
    this.type = type;
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}
