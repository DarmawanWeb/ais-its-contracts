import {
  DEFAULT_AUTH_AUDIENCE,
  DEFAULT_AUTH_ISSUER,
} from '@darmawanweb/ais-its-contracts/auth';
import { isIP } from 'node:net';

import * as z from 'zod';

/** Default `INTERNAL_TOKEN` of local development; refused in production. */
export const DEV_INTERNAL_TOKEN = 'dev-internal-token-change-me';

/** Minimum length of `INTERNAL_TOKEN` in production. */
export const MIN_PRODUCTION_INTERNAL_TOKEN_LENGTH = 16;

/** Runtime environments (`NODE_ENV`). */
export const NODE_ENVS = ['development', 'test', 'production'] as const;

/** A runtime environment. */
export type NodeEnv = (typeof NODE_ENVS)[number];

/** pino log levels accepted by `LOG_LEVEL`. */
export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

/** A pino log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Boolean environment variable: `true`/`false`, `1`/`0`, `yes`/`no`,
 * `on`/`off` (case-insensitive). `z.coerce.boolean()` is not used on purpose:
 * it turns the string `"false"` into `true`.
 */
export function envBoolean() {
  return z.stringbool({
    truthy: ['true', '1', 'yes', 'on'],
    falsy: ['false', '0', 'no', 'off'],
    case: 'insensitive',
  });
}

/** Integer environment variable (decimal string), with inclusive bounds. */
export function envInteger(min: number, max: number = Number.MAX_SAFE_INTEGER) {
  return z.coerce.number().int().min(min).max(max);
}

/** Comma separated list; blanks are dropped (`"a, b,,c"` → `["a","b","c"]`). */
export function envList() {
  return z.string().transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  );
}

/** URL environment variable restricted to the given schemes. */
export function envUrl(protocols: readonly string[]) {
  const pattern = new RegExp(`^(?:${protocols.join('|')})$`);
  return z.url({ protocol: pattern });
}

/** TCP port (0 lets the OS pick one, which tests use). */
const PortSchema = envInteger(0, 65_535);

/**
 * `SERVICE_NAME`: lowercase, digits and dashes. It is a NATS subject token
 * (`audit.v1.<service>`), a metrics label and the event `source`.
 */
export const ServiceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, {
  message: 'Expected lowercase letters, digits and dashes, e.g. "fleet"',
});

/** An unquoted PostgreSQL identifier (schema names). */
export const SqlIdentifierSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, {
  message: 'Expected a lowercase SQL identifier, e.g. "fleet"',
});

/** Comma separated `nats://`, `tls://` or `ws(s)://` server URLs. */
const NatsServersSchema = envList().pipe(
  z.array(envUrl(['nats', 'tls', 'ws', 'wss'])).min(1),
);

/** proxy-addr names accepted in `TRUSTED_PROXIES`. */
export const TRUSTED_PROXY_NAMES = ['loopback', 'linklocal', 'uniquelocal'] as const;

/** Default `TRUSTED_PROXIES`: proxies on loopback and private networks only. */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = [...TRUSTED_PROXY_NAMES];

function isProxyAddress(entry: string): boolean {
  if ((TRUSTED_PROXY_NAMES as readonly string[]).includes(entry)) return true;
  const [address = '', bits, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (family === 4 ? 32 : 128);
}

/**
 * Comma separated proxies whose `X-Forwarded-For` is trusted for the client
 * IP (per-IP throttles, audit `ip`): IPs, CIDRs and the names `loopback`,
 * `linklocal`, `uniquelocal`; `none` trusts no proxy. Parsed to the list
 * (empty = none).
 */
const TrustedProxiesSchema = envList()
  .refine(
    (entries) =>
      (entries.length === 1 && entries[0] === 'none') ||
      (entries.length > 0 && entries.every(isProxyAddress)),
    {
      message:
        'Expected "none" or comma separated IPs, CIDRs, loopback, linklocal, uniquelocal',
    },
  )
  .transform((entries) => (entries[0] === 'none' ? [] : entries));

/** Comma separated CORS origins (`*` is not allowed with credentials). */
const CorsOriginsSchema = envList().pipe(z.array(envUrl(['http', 'https'])));

/**
 * The environment variables every service reads (spec §4), with their
 * development defaults. Extend it with {@link defineConfig}; do not parse it
 * directly, the derived defaults and production rules live there.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  SERVICE_NAME: ServiceNameSchema,
  SERVICE_VERSION: z.string().min(1).default('0.0.0'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: PortSchema.default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Defaults to `true` when `NODE_ENV=development`. */
  LOG_PRETTY: envBoolean().optional(),
  /** Defaults to `postgres://<schema>_svc:<schema>_svc@localhost:5432/aisits` outside production. */
  DATABASE_URL: envUrl(['postgres', 'postgresql']).optional(),
  DATABASE_SCHEMA: SqlIdentifierSchema.optional(),
  DATABASE_POOL_MAX: envInteger(1, 1000).default(10),
  /** `statement_timeout` of pooled connections in ms; `0` disables it. */
  DATABASE_STATEMENT_TIMEOUT_MS: envInteger(0).default(30_000),
  DB_MIGRATE_ON_BOOT: envBoolean().default(true),
  NATS_URL: NatsServersSchema.default(['nats://localhost:4222']),
  /**
   * Prefix of every durable consumer name. Empty in deployments; test
   * suites that share one NATS server set a unique prefix per suite.
   */
  NATS_DURABLE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]{0,32}$/, {
      message: 'Expected up to 32 letters, digits, "-" or "_"',
    })
    .default(''),
  REDIS_URL: envUrl(['redis', 'rediss']).default('redis://localhost:6379'),
  AUTH_JWKS_URL: envUrl(['http', 'https']).default(
    'http://localhost:3001/.well-known/jwks.json',
  ),
  AUTH_ISSUER: z.string().min(1).default(DEFAULT_AUTH_ISSUER),
  AUTH_AUDIENCE: z.string().min(1).default(DEFAULT_AUTH_AUDIENCE),
  AUTH_INTERNAL_URL: envUrl(['http', 'https']).default('http://localhost:3001'),
  INTERNAL_TOKEN: z.string().min(1).default(DEV_INTERNAL_TOKEN),
  /** Default `loopback,linklocal,uniquelocal`; set the gateway's address/CIDR in production. */
  TRUSTED_PROXIES: TrustedProxiesSchema.default([...DEFAULT_TRUSTED_PROXIES]),
  CORS_ORIGINS: CorsOriginsSchema.default([
    'http://localhost:5173',
    'http://localhost:8000',
  ]),
  /** Tracing is enabled only when set, e.g. `http://localhost:4318`. */
  OTEL_EXPORTER_OTLP_ENDPOINT: envUrl(['http', 'https']).optional(),
  PUBLIC_BASE_URL: envUrl(['http', 'https']).default('http://localhost:8000'),
  /** Upper bound of a graceful shutdown before the process is killed, in ms. */
  SHUTDOWN_TIMEOUT_MS: envInteger(0).default(30_000),
});

/** Parsed {@link baseEnvSchema}, before the derived defaults. */
export type BaseEnv = z.output<typeof baseEnvSchema>;

/**
 * Validated base configuration as injected into the platform modules: the
 * derived defaults are applied (`LOG_PRETTY` is a boolean).
 */
export type BaseConfig = Omit<BaseEnv, 'LOG_PRETTY'> & {
  readonly LOG_PRETTY: boolean;
};
