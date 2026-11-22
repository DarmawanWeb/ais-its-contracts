import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  pino,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

import type { BaseConfig, LogLevel } from '../config/env-schema.js';
import { currentTraceId } from '../telemetry/trace-context.js';
import { REDACT_PATHS, REDACTED } from './redaction.js';

/** What a platform logger is built from. */
export interface LoggerSettings {
  /** `service` field of every line (`SERVICE_NAME`). */
  readonly service: string;
  /** `version` field of every line (`SERVICE_VERSION`). */
  readonly version?: string | undefined;
  readonly level?: LogLevel | undefined;
  /**
   * Human-readable output through `pino-pretty` (development), resolved from
   * the service's dependencies first ({@link resolvePinoPretty}); JSON with a
   * warning when it is not installed.
   */
  readonly pretty?: boolean | undefined;
}

/** The logger settings of a configuration object. */
export function loggerSettingsFromConfig(
  config: Pick<
    BaseConfig,
    'SERVICE_NAME' | 'SERVICE_VERSION' | 'LOG_LEVEL' | 'LOG_PRETTY'
  >,
): LoggerSettings {
  return {
    service: config.SERVICE_NAME,
    version: config.SERVICE_VERSION,
    level: config.LOG_LEVEL,
    pretty: config.LOG_PRETTY,
  };
}

/**
 * Absolute path of `pino-pretty` when it is installed: first as a
 * dependency of the service (resolved from `<cwd>/package.json`, usually a
 * devDependency), then from the kit's own location. pino-pretty is only
 * needed for development logging (`LOG_PRETTY`), so production images
 * (`pnpm install --prod`) need not contain it.
 *
 * @param cwd the service root. Default `process.cwd()`.
 */
export function resolvePinoPretty(
  cwd: string = process.cwd(),
): string | undefined {
  for (const base of [join(cwd, 'package.json'), import.meta.url]) {
    try {
      return createRequire(base).resolve('pino-pretty');
    } catch {
      // Not installed there: try the next location.
    }
  }
  return undefined;
}

/** Adds the active trace id to every line (spec §10). */
function traceMixin(): Record<string, string> {
  const traceId = currentTraceId();
  return traceId === undefined ? {} : { traceId };
}

/** Result of {@link buildLoggerOptions}. */
export interface PlatformLoggerOptions {
  readonly options: LoggerOptions;
  /** `true` when pretty output was asked for but `pino-pretty` is missing. */
  readonly prettyUnavailable: boolean;
}

/**
 * pino options shared by the HTTP logger (nestjs-pino) and
 * {@link createLogger}: JSON lines with `service`, `version`, ISO `time`,
 * `traceId`, the platform redaction list, and `pino-pretty` when asked for.
 */
export function buildLoggerOptions(
  settings: LoggerSettings,
): PlatformLoggerOptions {
  const prettyTarget =
    settings.pretty === true ? resolvePinoPretty() : undefined;
  const options: LoggerOptions = {
    level: settings.level ?? 'info',
    base: {
      service: settings.service,
      ...(settings.version === undefined ? {} : { version: settings.version }),
    },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin: traceMixin,
    ...(prettyTarget === undefined
      ? { formatters: { level: (label: string) => ({ level: label }) } }
      : {
          transport: {
            target: prettyTarget,
            options: {
              colorize: true,
              singleLine: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service,version',
            },
          },
        }),
  };
  return {
    options,
    prettyUnavailable: settings.pretty === true && prettyTarget === undefined,
  };
}

/**
 * A standalone pino logger with the platform conventions, for scripts and
 * CLIs (migrations, seeds) that run without Nest.
 *
 * @example
 * const logger = createLogger({ service: 'fleet-seed', level: 'info', pretty: true });
 * logger.info({ count }, 'seeded vessel types');
 */
export function createLogger(
  settings: LoggerSettings,
  destination?: DestinationStream,
): Logger {
  if (destination !== undefined) {
    // An explicit destination (tests, files) receives JSON lines.
    return pino(
      buildLoggerOptions({ ...settings, pretty: false }).options,
      destination,
    );
  }
  const { options, prettyUnavailable } = buildLoggerOptions(settings);
  const logger = pino(options);
  if (prettyUnavailable) {
    logger.warn(
      'LOG_PRETTY is enabled but pino-pretty is not installed: logging JSON',
    );
  }
  return logger;
}
