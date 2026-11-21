import type * as z from 'zod';

import {
  type AppConfig,
  type ConfigSchema,
  ConfigValidationError,
} from './define-config.js';

/** Variables of a documentation build (`pnpm openapi`): quiet, no migrations. */
export const DOCUMENTATION_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  LOG_PRETTY: 'false',
  DB_MIGRATE_ON_BOOT: 'false',
};

/** Placeholders of string formats that a missing variable may require. */
const FORMAT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  url: 'http://openapi.invalid',
  email: 'openapi@example.invalid',
  uuid: '00000000-0000-7000-8000-000000000000',
};

/** A placeholder satisfying one zod issue of a missing variable, if one is known. */
function placeholderFor(issue: z.core.$ZodIssue): string | undefined {
  if (issue.code === 'invalid_type') {
    if (issue.expected === 'number' || issue.expected === 'int') return '1';
    if (issue.expected === 'boolean') return 'false';
    return issue.expected === 'string' ? 'openapi' : undefined;
  }
  if (issue.code === 'invalid_format') return FORMAT_PLACEHOLDERS[issue.format];
  if (issue.code === 'too_small') {
    if (issue.origin === 'string' && typeof issue.minimum === 'number')
      return 'x'.repeat(issue.minimum);
    return issue.origin === 'number' ? String(issue.minimum) : undefined;
  }
  if (issue.code === 'invalid_value') {
    const [first] = issue.values;
    return first === undefined ? undefined : String(first);
  }
  return undefined;
}

/**
 * Builds the configuration of a documentation build (`exportOpenApi`) from
 * `env` (default `process.env`) without requiring the runtime environment:
 * {@link DOCUMENTATION_ENV} is applied, and every REQUIRED variable that is
 * missing (e.g. `S3_ENDPOINT`, `KEY_ENCRYPTION_SECRET`) gets a placeholder
 * of its type, since the document is built without opening any connection.
 * Values that are present are validated as usual.
 *
 * @throws {ConfigValidationError} when a present value is invalid or a
 *   missing one has no derivable placeholder.
 */
export function documentationConfig<Schema extends ConfigSchema>(
  schema: Schema,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig<Schema> {
  const provided = new Set(
    Object.entries(env)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([name]) => name),
  );
  const input: Record<string, string | undefined> = {
    ...Object.fromEntries(
      Object.entries(env).filter(([, value]) => value !== ''),
    ),
    ...DOCUMENTATION_ENV,
  };
  // Each pass fills the placeholders the previous issues asked for (e.g. a
  // missing URL first fails as a string, then as a URL).
  for (let pass = 0; pass < 4; pass += 1) {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    let changed = false;
    for (const issue of result.error.issues) {
      const [name] = issue.path;
      if (typeof name !== 'string' || provided.has(name)) continue;
      const value = placeholderFor(issue);
      if (value !== undefined && input[name] !== value) {
        input[name] = value;
        changed = true;
      }
    }
    if (!changed) {
      throw new ConfigValidationError(
        result.error.issues.map((issue) => ({
          variable:
            issue.path.length === 0
              ? '(root)'
              : issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }
  }
  return schema.parse(input);
}
