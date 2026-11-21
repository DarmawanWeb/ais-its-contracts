import * as z from 'zod';

/**
 * Format of the ids of the methodology catalog (methods and references):
 * lowercase alphanumeric tokens joined by `.`, `_` or `-`, e.g.
 * `cii.attained` or `imo-mepc-353-78`.
 */
export const CATALOG_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Zod schema of a method id of the methodology catalog (spec 17), as carried
 * by `@method` TSDoc tags, detector events, alerts and API responses.
 */
export const MethodIdSchema = z
  .string()
  .regex(CATALOG_ID_PATTERN)
  .describe('Method id of the methodology catalog, e.g. "cii.attained"');

/** Zod schema of a reference id of the methodology catalog. */
export const ReferenceIdSchema = z
  .string()
  .regex(CATALOG_ID_PATTERN)
  .describe('Reference id of the methodology catalog, e.g. "imo-mepc-353-78"');

/** Returns `true` when `value` is a well-formed catalog id. */
export function isCatalogId(value: unknown): value is string {
  return typeof value === 'string' && CATALOG_ID_PATTERN.test(value);
}
