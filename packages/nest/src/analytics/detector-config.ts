import type * as z from 'zod';

import type { ConfigIssue } from '../config/define-config.js';

/** Environment variable selecting the enabled detectors (comma list, default all). */
export const DETECTORS_ENV = 'DETECTORS';

/**
 * Parses `DETECTORS` (`"ews, collision"`): the listed ids, or `undefined`
 * (= every registered detector) when unset or blank.
 */
export function parseDetectorList(
  value: string | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id !== '');
  return ids.length === 0 ? undefined : [...new Set(ids)];
}

/** Environment prefix of a detector's configuration: `ews` → `EWS_`. */
export function detectorEnvPrefix(detectorId: string): string {
  return `${detectorId.toUpperCase()}_`;
}

/** The detector's variables with the prefix removed (`EWS_DANGER_M` → `DANGER_M`); blanks are dropped. */
export function detectorEnv(
  detectorId: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const prefix = detectorEnvPrefix(detectorId);
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(prefix) && value !== undefined && value !== '')
      values[name.slice(prefix.length)] = value;
  }
  return values;
}

/** Result of {@link parseDetectorConfig}. */
export type DetectorConfigResult<Config> =
  | { readonly success: true; readonly config: Config }
  | { readonly success: false; readonly issues: readonly ConfigIssue[] };

/**
 * Validates a detector's `<ID>_*` variables with its schema; issues name the
 * full variables (`EWS_DANGER_M`). Without a schema the configuration is `{}`.
 */
export function parseDetectorConfig<Config>(
  detectorId: string,
  schema: z.ZodType<Config> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): DetectorConfigResult<Config | Record<string, never>> {
  if (schema === undefined) return { success: true, config: {} };
  const result = schema.safeParse(detectorEnv(detectorId, env));
  if (result.success) return { success: true, config: result.data };
  const prefix = detectorEnvPrefix(detectorId);
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      variable:
        issue.path.length === 0
          ? `${prefix}*`
          : `${prefix}${issue.path.map(String).join('.')}`,
      message: issue.message,
    })),
  };
}
