import * as z from 'zod';

import {
  ERROR_CODE_PATTERN,
  ERROR_DEFINITIONS,
  type ErrorCode,
} from './error-codes.js';

/** Media type of RFC 9457 problem responses. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Prefix of the problem `type` URN of every platform error code (spec 5). */
export const PROBLEM_TYPE_BASE_URI = 'urn:ais-its:problem:';

/**
 * Problem `type` URI of an error code: the code in kebab case after
 * {@link PROBLEM_TYPE_BASE_URI}.
 *
 * @example problemTypeUri('VESSEL_NOT_FOUND') // "urn:ais-its:problem:vessel-not-found"
 */
export function problemTypeUri(code: string): string {
  return `${PROBLEM_TYPE_BASE_URI}${code.toLowerCase().replaceAll('_', '-')}`;
}

/** Zod schema of a field-level validation error. */
export const FieldErrorSchema = z
  .object({
    field: z.string().describe('Dot separated path, e.g. "positions.0.lat"'),
    message: z.string(),
    code: z.string().optional().describe('Machine readable reason'),
  })
  .describe('Field-level validation error');

/** A field-level validation error. */
export type FieldError = z.infer<typeof FieldErrorSchema>;

/**
 * Zod schema of an RFC 9457 problem details body as returned by every service.
 * Unknown extension members are preserved.
 */
export const ProblemDetailsSchema = z
  .looseObject({
    type: z.string().min(1).describe('Problem type URI'),
    title: z.string().min(1),
    status: z.int().min(100).max(599),
    detail: z.string().optional(),
    instance: z.string().optional().describe('Request path'),
    code: z
      .string()
      .regex(ERROR_CODE_PATTERN)
      .describe('Stable UPPER_SNAKE_CASE error code'),
    traceId: z.string().optional(),
    errors: z.array(FieldErrorSchema).optional(),
  })
  .describe('RFC 9457 problem details');

/** An RFC 9457 problem details body. */
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

/** Optional members of {@link createProblem}. */
export interface ProblemOptions {
  readonly detail?: string | undefined;
  readonly instance?: string | undefined;
  readonly traceId?: string | undefined;
  readonly errors?: readonly FieldError[] | undefined;
  /** Overrides the default title of the code. */
  readonly title?: string | undefined;
}

/**
 * Builds the problem details of a shared error code with its default status,
 * title and type URI.
 *
 * @example createProblem('VESSEL_NOT_FOUND', { detail: 'No vessel with MMSI 525005223' })
 */
export function createProblem(
  code: ErrorCode,
  options: ProblemOptions = {},
): ProblemDetails {
  const definition = ERROR_DEFINITIONS[code];
  return {
    type: problemTypeUri(code),
    title: options.title ?? definition.title,
    status: definition.status,
    code,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.instance === undefined ? {} : { instance: options.instance }),
    ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
    ...(options.errors === undefined ? {} : { errors: [...options.errors] }),
  };
}

/** Returns `true` when `value` has the shape of {@link ProblemDetails}. */
export function isProblemDetails(value: unknown): value is ProblemDetails {
  return ProblemDetailsSchema.safeParse(value).success;
}

/** Minimal structural view of a zod issue (stable across zod versions). */
export interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string | undefined;
}

/**
 * Converts zod issues into {@link FieldError}s, joining paths with dots
 * (`['positions', 0, 'lat']` → `"positions.0.lat"`; root issues → `""`).
 */
export function issuesToFieldErrors(
  issues: readonly IssueLike[],
): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
    ...(issue.code === undefined ? {} : { code: issue.code }),
  }));
}
