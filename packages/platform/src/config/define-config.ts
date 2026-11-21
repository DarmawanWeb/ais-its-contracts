import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type * as z from 'zod';

import {
  type BaseConfig,
  type BaseEnv,
  baseEnvSchema,
  DEV_INTERNAL_TOKEN,
  MIN_PRODUCTION_INTERNAL_TOKEN_LENGTH,
} from './env-schema.js';

/** The derived defaults applied on top of a parsed environment. */
export type WithDerivedDefaults<T> = Omit<T, 'LOG_PRETTY'> & {
  readonly LOG_PRETTY: boolean;
};

/**
 * Production safety rules shared by every service: the development
 * `INTERNAL_TOKEN` is refused and the database URL must be explicit.
 */
function checkProductionRules(env: BaseEnv, ctx: z.core.$RefinementCtx): void {
  if (env.NODE_ENV !== 'production') return;
  if (
    env.INTERNAL_TOKEN === DEV_INTERNAL_TOKEN ||
    env.INTERNAL_TOKEN.length < MIN_PRODUCTION_INTERNAL_TOKEN_LENGTH
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['INTERNAL_TOKEN'],
      message: `Must be a secret of at least ${MIN_PRODUCTION_INTERNAL_TOKEN_LENGTH} characters in production (not the development default)`,
    });
  }
  if (env.DATABASE_SCHEMA !== undefined && env.DATABASE_URL === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_URL'],
      message: 'Required in production when DATABASE_SCHEMA is set',
    });
  }
}

/**
 * Applies the defaults that depend on other variables (spec §4):
 * `LOG_PRETTY` is `true` in development, and outside production the
 * `DATABASE_URL` defaults to `postgres://<schema>_svc:<schema>_svc@localhost:5432/seemp`.
 */
function applyDerivedDefaults<T>(env: T): WithDerivedDefaults<T> {
  // `defineConfig` only accepts shapes whose outputs keep the base types, so
  // every parsed environment has the members of `BaseEnv`.
  const base = env as T & BaseEnv;
  const databaseUrl =
    base.DATABASE_URL ??
    (base.DATABASE_SCHEMA !== undefined && base.NODE_ENV !== 'production'
      ? `postgres://${base.DATABASE_SCHEMA}_svc:${base.DATABASE_SCHEMA}_svc@localhost:5432/seemp`
      : undefined);
  return {
    ...base,
    LOG_PRETTY: base.LOG_PRETTY ?? base.NODE_ENV === 'development',
    DATABASE_URL: databaseUrl,
  };
}

/**
 * A schema extension: new variables, or base variables overridden with a
 * schema of the same output type (typically another default).
 */
export type CompatibleShape = z.ZodRawShape & {
  readonly [Name in keyof BaseEnv]?: z.ZodType<BaseEnv[Name], unknown>;
};

/**
 * Builds the configuration schema of a service: the common variables of
 * spec §4 extended (or overridden) by the service's own ones, with the
 * production rules and derived defaults applied.
 *
 * @example
 * export const configSchema = defineConfig({
 *   SERVICE_NAME: z.string().default('fleet'),
 *   PORT: envInteger(0, 65_535).default(3002),
 *   DATABASE_SCHEMA: z.string().default('fleet'),
 *   S3_ENDPOINT: z.url(),
 * });
 * export type Config = AppConfig<typeof configSchema>;
 */
export function defineConfig<const Shape extends CompatibleShape>(shape: Shape) {
  return baseEnvSchema
    .extend(shape)
    .superRefine((env, ctx) => {
      checkProductionRules(env as typeof env & BaseEnv, ctx);
    })
    .transform(applyDerivedDefaults);
}

/** The schema of the common variables only (scripts, tools, tests). */
export const baseConfigSchema = defineConfig({});

/** Any schema built by {@link defineConfig} (its output extends {@link BaseConfig}). */
export type ConfigSchema = z.ZodType<BaseConfig>;

/**
 * The validated, frozen configuration type of a schema built with
 * {@link defineConfig}: `AppConfig<typeof configSchema>`.
 */
export type AppConfig<Schema extends z.ZodType> = Readonly<z.output<Schema>>;

/** One invalid variable. */
export interface ConfigIssue {
  /** Variable name (or `(root)`). */
  readonly variable: string;
  readonly message: string;
}

/** Thrown by {@link loadConfig} when the environment is invalid. */
export class ConfigValidationError extends Error {
  override readonly name = 'ConfigValidationError';

  constructor(readonly issues: readonly ConfigIssue[]) {
    super(formatConfigIssues(issues));
  }
}

/** Renders the issues as an indented, human-readable list. */
export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
  const noun = issues.length === 1 ? 'problem' : 'problems';
  return `Invalid configuration (${issues.length} ${noun}):\n${lines.join('\n')}`;
}

/** Options of {@link loadConfig}. */
export interface LoadConfigOptions {
  /**
   * Variables to validate instead of `process.env` (tests). When given, no
   * `.env` file is read.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * `.env` file loaded into `process.env` before validation when it exists
   * (relative to the working directory); `false` disables it. Variables that
   * are already set win over the file. Default `.env`.
   */
  readonly envFile?: string | false;
  /** Where the problems are printed; default `process.stderr`. `null` = silent. */
  readonly output?: Pick<NodeJS.WritableStream, 'write'> | null;
}

/**
 * Empty strings mean "unset": `.env.example` files keep optional variables as
 * `NAME=` and orchestrators often render missing values as empty strings.
 */
function withoutEmptyValues(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') result[name] = value;
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value)) deepFreeze(member);
  }
  return value;
}

/**
 * Validates the environment with `schema` (built by {@link defineConfig}) and
 * returns the frozen configuration. A service MUST refuse to start on invalid
 * configuration: every problem is printed (names and reasons, never values)
 * and a {@link ConfigValidationError} is thrown.
 *
 * @example
 * export const config = loadConfig(configSchema);
 */
export function loadConfig<Schema extends z.ZodType>(
  schema: Schema,
  options: LoadConfigOptions = {},
): AppConfig<Schema> {
  let source: Readonly<Record<string, string | undefined>>;
  if (options.env === undefined) {
    const envFile = options.envFile ?? '.env';
    if (envFile !== false) {
      const path = resolve(envFile);
      if (existsSync(path)) process.loadEnvFile(path);
    }
    source = process.env;
  } else {
    source = options.env;
  }

  const result = schema.safeParse(withoutEmptyValues(source));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      variable: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
      message: issue.message,
    }));
    const error = new ConfigValidationError(issues);
    const output = options.output === undefined ? process.stderr : options.output;
    output?.write(`${error.message}\n`);
    throw error;
  }
  return deepFreeze(result.data) as AppConfig<Schema>;
}
