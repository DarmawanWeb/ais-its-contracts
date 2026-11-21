import { NonRetryableError, RetryableError } from './errors.js';

/** First retry delay of the default exponential backoff, ms. */
export const DEFAULT_INITIAL_BACKOFF_MS = 1000;

/** Largest retry delay of the default exponential backoff, ms. */
export const DEFAULT_MAX_BACKOFF_MS = 60_000;

/** Retry behaviour of a durable consumer. */
export interface DeliveryPolicy {
  /** Deliveries before a failing message is dead-lettered. */
  readonly maxDeliver: number;
  /**
   * Delay before delivery `n + 1` after failed delivery `n` is
   * `backoffMs[n - 1]` (the last value repeats). Default: exponential
   * 1 s, 2 s, 4 s, … capped at 60 s.
   */
  readonly backoffMs?: readonly number[] | undefined;
}

/** What to do with a message whose handler failed. */
export type FailureDecision =
  /** Redeliver after `delayMs`. */
  | { readonly action: 'nak'; readonly delayMs: number }
  /** Never redeliver (`NonRetryableError`). */
  | { readonly action: 'term' }
  /** Copy to `dlq.<stream>.<consumer>` and ack (deliveries exhausted). */
  | { readonly action: 'dead_letter' };

/**
 * Delay before the next delivery after `deliveryCount` failed deliveries
 * (1-based).
 */
export function retryDelayMs(deliveryCount: number, backoffMs?: readonly number[]): number {
  const failures = Math.max(1, Math.trunc(deliveryCount));
  if (backoffMs !== undefined && backoffMs.length > 0) {
    return Math.max(0, backoffMs[Math.min(failures, backoffMs.length) - 1] ?? 0);
  }
  return Math.min(DEFAULT_MAX_BACKOFF_MS, DEFAULT_INITIAL_BACKOFF_MS * 2 ** (failures - 1));
}

/**
 * Decides the fate of a failed delivery (spec §7.1): `NonRetryableError` →
 * term; deliveries exhausted (`deliveryCount >= maxDeliver`) → dead letter;
 * otherwise nak with backoff (`RetryableError.retryAfterMs` wins).
 */
export function decideFailure(error: unknown, deliveryCount: number, policy: DeliveryPolicy): FailureDecision {
  if (error instanceof NonRetryableError) return { action: 'term' };
  if (deliveryCount >= policy.maxDeliver) return { action: 'dead_letter' };
  if (error instanceof RetryableError && error.retryAfterMs !== undefined) {
    return { action: 'nak', delayMs: Math.max(0, error.retryAfterMs) };
  }
  return { action: 'nak', delayMs: retryDelayMs(deliveryCount, policy.backoffMs) };
}
