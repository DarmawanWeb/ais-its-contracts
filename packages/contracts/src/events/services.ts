/**
 * `SERVICE_NAME` of every platform process; used as the event `source`, in
 * `audit.v1.<service>` subjects and in logs and metrics.
 */
export const SERVICE_NAMES = [
  'auth',
  'fleet',
  'ais-ingestor',
  'ais-processor',
  'telemetry',
  'emission',
  'detection',
  'notification',
] as const;

/** A platform process name. */
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** Returns `true` when `value` is a platform process name. */
export function isServiceName(value: unknown): value is ServiceName {
  return SERVICE_NAMES.some((name) => name === value);
}
