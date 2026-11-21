import { setTimeout as sleep } from 'node:timers/promises';

import {
  type EventPayload,
  type EventType,
  makeEnvelope,
  type TypedEventEnvelope,
} from '@darmawanweb/ais-its-contracts/events';

/** Overrides of {@link makeTestEnvelope}. */
export interface TestEnvelopeOptions {
  /** Default `test`. */
  readonly source?: string | undefined;
  readonly id?: string | undefined;
  readonly time?: Date | undefined;
  readonly subject?: string | undefined;
  readonly traceparent?: string | undefined;
}

/**
 * A valid contracts envelope for tests (`source` defaults to `test`).
 *
 * @throws {InvalidEventError} when `data` violates the payload schema.
 */
export function makeTestEnvelope<Type extends EventType>(
  type: Type,
  data: EventPayload<Type>,
  options: TestEnvelopeOptions = {},
): TypedEventEnvelope<Type> {
  return makeEnvelope({
    type,
    data,
    source: options.source ?? 'test',
    id: options.id,
    time: options.time,
    subject: options.subject,
    traceparent: options.traceparent,
  });
}

/** Options of {@link waitFor}. */
export interface WaitForOptions {
  /** Default 5000 ms. */
  readonly timeoutMs?: number | undefined;
  /** Default 50 ms. */
  readonly intervalMs?: number | undefined;
  /** Prefix of the timeout error. */
  readonly message?: string | undefined;
}

/**
 * Polls `predicate` until it returns a truthy value (which is returned) or
 * the timeout elapses (the last thrown error is the cause).
 *
 * @example
 * const row = await waitFor(async () => (await repo.find(id)) ?? false, { timeoutMs: 10_000 });
 */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: WaitForOptions = {},
): Promise<Exclude<T, false | 0 | '' | null | undefined>> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value as Exclude<T, false | 0 | '' | null | undefined>;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${options.message ?? 'waitFor'}: condition not met within ${timeoutMs} ms`,
        {
          cause: lastError,
        },
      );
    }
    await sleep(intervalMs);
  }
}
