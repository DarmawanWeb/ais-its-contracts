import * as z from 'zod';

/**
 * Format of the values of open vocabularies (alert types, catalog types,
 * domains, statuses): a lowercase token, safe as a NATS subject token.
 */
export const VOCABULARY_TOKEN_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * A value of an open vocabulary: one of the `Known` values (offered by editor
 * completion) or any future value. `string & {}` keeps the literal members
 * from collapsing into `string`.
 */
export type OpenVocabulary<Known extends string> = Known | (string & {});

/**
 * Zod schema of an open vocabulary: accepts every value matching
 * {@link VOCABULARY_TOKEN_PATTERN}, so data produced by a newer contracts
 * version still parses; the known values are documented as JSON Schema
 * `examples`.
 *
 * @internal
 */
export function openVocabularySchema<const Known extends readonly string[]>(
  known: Known,
  description: string,
): z.ZodType<OpenVocabulary<Known[number]>, string> {
  return z
    .string()
    .regex(VOCABULARY_TOKEN_PATTERN)
    .meta({ description, examples: [...known] });
}

/** Returns `true` when `value` is one of the `known` values. */
export function isKnownValue<const Known extends readonly string[]>(
  known: Known,
  value: unknown,
): value is Known[number] {
  return known.some((candidate) => candidate === value);
}
