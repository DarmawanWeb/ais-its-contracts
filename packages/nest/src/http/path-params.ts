import { isUuid, isValidMmsi } from '@darmawanweb/ais-its-contracts/domain';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiParam, type ApiParamOptions } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import { ValidationFailedError } from '../errors/domain-error.js';

/** Options shared by the path parameter decorators. */
export interface PathParamOptions {
  /** OpenAPI description of the parameter. */
  readonly description?: string | undefined;
}

/** Options of {@link IntParam} and {@link parseIntParam}. */
export interface IntParamOptions extends PathParamOptions {
  /** Smallest accepted value (inclusive). */
  readonly min?: number | undefined;
  /** Largest accepted value (inclusive). */
  readonly max?: number | undefined;
}

/** An integer in a path: optional minus sign and decimal digits only. */
const INTEGER_PATTERN = /^-?\d+$/;

/** An MMSI in a path: exactly nine decimal digits. */
const MMSI_PATTERN = /^\d{9}$/;

function invalid(field: string, message: string, code: string): never {
  throw new ValidationFailedError([{ field, message, code }]);
}

/**
 * A path segment as a UUID (contracts `isUuid`: 8-4-4-4-12 hexadecimal
 * digits of an RFC 9562 UUID; no braces, no missing hyphens, no spaces).
 *
 * @throws {ValidationFailedError} `400 VALIDATION_FAILED` with
 *   `errors[{ field: name, code: 'isUuid' }]`.
 */
export function parseUuidParam(value: unknown, name = 'id'): string {
  if (typeof value !== 'string' || !isUuid(value))
    invalid(name, `${name} must be a UUID`, 'isUuid');
  return value;
}

/**
 * A path segment as a safe integer: `-?\d+` exactly (no `+`, spaces,
 * exponent, `0x` prefix or fraction), within `min`/`max` when given.
 *
 * @throws {ValidationFailedError} `400 VALIDATION_FAILED` with
 *   `errors[{ field: name, code }]`, `code` being `isInt`, `min` or `max`.
 */
export function parseIntParam(
  value: unknown,
  name: string,
  options: Pick<IntParamOptions, 'min' | 'max'> = {},
): number {
  const parsed =
    typeof value === 'string' && INTEGER_PATTERN.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed))
    invalid(name, `${name} must be an integer`, 'isInt');
  if (options.min !== undefined && parsed < options.min)
    invalid(name, `${name} must not be less than ${options.min}`, 'min');
  if (options.max !== undefined && parsed > options.max)
    invalid(name, `${name} must not be greater than ${options.max}`, 'max');
  return parsed;
}

/**
 * A path segment as an MMSI: exactly nine decimal digits forming a valid
 * MMSI (contracts `isValidMmsi`). `0525005223`, `052500522`, `-5`, `1e5`,
 * `0x1F4A1D67` and ` 525005223` are rejected.
 *
 * @throws {ValidationFailedError} `400 VALIDATION_FAILED` with
 *   `errors[{ field: name, code: 'isMmsi' }]`.
 */
export function parseMmsiParam(value: unknown, name = 'mmsi'): number {
  const mmsi =
    typeof value === 'string' && MMSI_PATTERN.test(value)
      ? Number(value)
      : Number.NaN;
  if (!isValidMmsi(mmsi))
    invalid(name, `${name} must be a 9-digit MMSI`, 'isMmsi');
  return mmsi;
}

/** The raw path segment `name` of the current request (before any pipe). */
function rawPathParam(context: ExecutionContext, name: string): unknown {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  const params = request.params as Readonly<Record<string, unknown>> | null;
  const value = params?.[name];
  if (value === undefined) {
    // A route without `:name` is a programming error, not a client error.
    throw new Error(`The route has no path parameter :${name}`);
  }
  return value;
}

/** Documents the parameter on the operation (a parameter decorator calls a method decorator). */
function documentParam(options: ApiParamOptions): ParameterDecorator {
  return (target, propertyKey) => {
    if (propertyKey === undefined) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
    if (descriptor !== undefined)
      ApiParam(options)(target, propertyKey, descriptor);
  };
}

/**
 * The path parameter `name` (default `id`) as a UUID ({@link parseUuidParam}),
 * documented in OpenAPI as `type: string, format: uuid`. A custom parameter
 * decorator reads the raw path segment: the global `ValidationPipe` does
 * not touch it, and a malformed value is `400 VALIDATION_FAILED` with the
 * field (spec §5) instead of `ParseUUIDPipe`'s bare `400 BAD_REQUEST`.
 *
 * @example
 * @Get(':id')
 * find(@UuidParam() id: string) {}
 */
export function UuidParam(
  name = 'id',
  options: PathParamOptions = {},
): ParameterDecorator {
  return createParamDecorator(
    (_data: unknown, context: ExecutionContext): string =>
      parseUuidParam(rawPathParam(context, name), name),
    [
      documentParam({
        name,
        required: true,
        description: options.description ?? 'UUID',
        schema: { type: 'string', format: 'uuid' },
      }),
    ],
  )();
}

/**
 * The path parameter `name` as a safe integer ({@link parseIntParam}) within
 * `min`/`max`, documented as `type: integer` with those bounds. Unlike
 * `ParseIntPipe` behind the global `ValidationPipe` (which converts
 * `number` parameters with `+value` first), ` 12`, `1e5`, `0x1F` and `12.0`
 * are rejected with `400 VALIDATION_FAILED`.
 *
 * @example
 * @Get(':year')
 * annual(@IntParam('year', { min: 2000, max: 2100 }) year: number) {}
 */
export function IntParam(
  name: string,
  options: IntParamOptions = {},
): ParameterDecorator {
  const bounds = { min: options.min, max: options.max };
  return createParamDecorator(
    (_data: unknown, context: ExecutionContext): number =>
      parseIntParam(rawPathParam(context, name), name, bounds),
    [
      documentParam({
        name,
        required: true,
        description: options.description ?? 'Integer',
        schema: {
          type: 'integer',
          ...(options.min === undefined ? {} : { minimum: options.min }),
          ...(options.max === undefined ? {} : { maximum: options.max }),
        },
      }),
    ],
  )();
}

/**
 * The path parameter `name` (default `mmsi`) as an MMSI
 * ({@link parseMmsiParam}), documented as `type: string, pattern:
 * ^[0-9]{9}$`. A custom decorator, because the global `ValidationPipe`
 * would turn `0525005223` into 525005223 before any parameter pipe runs.
 *
 * @example
 * @Get('by-mmsi/:mmsi')
 * findByMmsi(@MmsiParam() mmsi: number) {}
 */
export function MmsiParam(
  name = 'mmsi',
  options: PathParamOptions = {},
): ParameterDecorator {
  return createParamDecorator(
    (_data: unknown, context: ExecutionContext): number =>
      parseMmsiParam(rawPathParam(context, name), name),
    [
      documentParam({
        name,
        required: true,
        description: options.description ?? 'MMSI: exactly nine digits',
        schema: { type: 'string', pattern: '^[0-9]{9}$', example: '525005223' },
      }),
    ],
  )();
}
