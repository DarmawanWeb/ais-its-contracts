/**
 * The deadline of the graceful shutdown in progress: `bootstrapService`
 * starts it when `SIGTERM` / `SIGINT` arrives (`SHUTDOWN_TIMEOUT_MS`, after
 * which the process is force-exited), so shutdown hooks can bound their own
 * waits by what is left (e.g. the NATS drain).
 */
let deadline: number | undefined;

/** Starts the shutdown clock (first call wins; `timeoutMs <= 0`: no deadline). */
export function startShutdownDeadline(
  timeoutMs: number,
  now: number = performance.now(),
): void {
  if (timeoutMs > 0) deadline ??= now + timeoutMs;
}

/**
 * What is left of the shutdown budget, ms (`0` once exceeded); `undefined`
 * when no shutdown deadline runs (tests, `app.close()` without a signal).
 */
export function remainingShutdownMs(
  now: number = performance.now(),
): number | undefined {
  return deadline === undefined ? undefined : Math.max(0, deadline - now);
}

/** Forgets the deadline (tests). */
export function resetShutdownDeadline(): void {
  deadline = undefined;
}
