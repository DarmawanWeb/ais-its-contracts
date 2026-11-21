import * as z from 'zod';

/**
 * Zod schema of a wire timestamp: ISO-8601 in UTC with a `Z` suffix and any
 * sub-second precision, as produced by `Date.prototype.toISOString()`.
 */
export const IsoDateTimeSchema = z.iso
  .datetime()
  .describe('ISO-8601 UTC timestamp, e.g. 2026-11-20T08:30:00.000Z');

/**
 * Bidirectional zod codec between a wire timestamp and a `Date`
 * (`z.decode(IsoDateTimeCodec, '…Z')` / `z.encode(IsoDateTimeCodec, date)`).
 */
export const IsoDateTimeCodec = z.codec(IsoDateTimeSchema, z.date(), {
  decode: (value) => new Date(value),
  encode: (date) => date.toISOString(),
});

/** Returns `true` when `value` is a valid wire timestamp. */
export function isIsoDateTime(value: unknown): boolean {
  return IsoDateTimeSchema.safeParse(value).success;
}

/**
 * Formats a `Date` (or epoch milliseconds) as a wire timestamp.
 *
 * @throws {RangeError} when the date is invalid.
 */
export function toIsoDateTime(value: Date | number): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid date');
  }
  return date.toISOString();
}

/**
 * Parses a wire timestamp into a `Date`.
 *
 * @throws {RangeError} when `value` is not an ISO-8601 UTC timestamp.
 */
export function parseIsoDateTime(value: string): Date {
  if (!isIsoDateTime(value)) {
    throw new RangeError(`Invalid ISO-8601 UTC timestamp: "${value}"`);
  }
  return new Date(value);
}

/** A resolved, closed time interval. */
export interface TimeRange {
  readonly from: Date;
  readonly to: Date;
}

/** Raw `from` / `to` query values; each may be missing. */
export interface TimeRangeInput {
  readonly from?: Date | string | null | undefined;
  readonly to?: Date | string | null | undefined;
}

/** Endpoint specific defaults and limits for {@link resolveTimeRange}. */
export interface TimeRangeOptions {
  /** Length of the range when `from` is missing, in milliseconds. */
  readonly defaultDurationMs: number;
  /** Longest accepted range in milliseconds (unbounded when omitted). */
  readonly maxDurationMs?: number | undefined;
  /** Clock used when `to` is missing; defaults to the current time. */
  readonly now?: Date | undefined;
}

const toDate = (value: Date | string): Date =>
  typeof value === 'string' ? parseIsoDateTime(value) : value;

/**
 * Applies the API time range convention: missing `to` = now, missing `from` =
 * `to - defaultDurationMs`.
 *
 * @throws {RangeError} when a bound is invalid, `from > to`, or the range is
 * longer than `maxDurationMs`.
 */
export function resolveTimeRange(
  input: TimeRangeInput,
  options: TimeRangeOptions,
): TimeRange {
  const to =
    input.to === undefined || input.to === null
      ? (options.now ?? new Date())
      : toDate(input.to);
  const from =
    input.from === undefined || input.from === null
      ? new Date(to.getTime() - options.defaultDurationMs)
      : toDate(input.from);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new RangeError('Invalid time range bound');
  }
  if (from.getTime() > to.getTime()) {
    throw new RangeError('"from" must not be after "to"');
  }
  if (
    options.maxDurationMs !== undefined &&
    to.getTime() - from.getTime() > options.maxDurationMs
  ) {
    throw new RangeError(
      `Time range must not exceed ${options.maxDurationMs} ms`,
    );
  }
  return { from, to };
}
