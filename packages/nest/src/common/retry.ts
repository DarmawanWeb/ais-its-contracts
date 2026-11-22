import { setTimeout as sleep } from 'node:timers/promises';

import { safeErrorMessage } from '../db/errors.js';

/** Options of {@link retryUntilDeadline}. */
export interface RetryOptions {
  /** Give up once this much time passed since the first attempt, ms. */
  readonly deadlineMs: number;
  /** First delay, ms. Default 250. */
  readonly initialDelayMs?: number | undefined;
  /** Largest delay, ms. Default 5000. */
  readonly maxDelayMs?: number | undefined;
  /** Called before each wait (logging). */
  readonly onRetry?:
    ((error: unknown, attempt: number, delayMs: number) => void) | undefined;
  /** Aborts the waiting (shutdown). */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Calls `fn` until it resolves, with exponential backoff (×2, capped), until
 * `deadlineMs` elapsed; then rethrows the last error. Used to wait for
 * dependencies at startup (database, NATS) without hanging forever.
 */
export async function retryUntilDeadline<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const startedAt = Date.now();
  let delay = options.initialDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 5000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const remaining = options.deadlineMs - (Date.now() - startedAt);
      if (remaining <= 0 || options.signal?.aborted === true) throw error;
      const wait = Math.min(delay, maxDelay, remaining);
      options.onRetry?.(error, attempt, wait);
      await sleep(wait, undefined, { signal: options.signal });
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

/**
 * Message of an unknown thrown value, safe for logs, dead letter headers and
 * `outbox.last_error`: a database error gives the driver's primary message
 * (never drizzle's `Failed query: … params: …`, which holds every bound
 * value), any other error its message, anything else `String(value)`.
 */
export function errorMessage(error: unknown): string {
  return safeErrorMessage(error);
}
