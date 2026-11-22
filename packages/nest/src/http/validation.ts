import type { FieldError } from '@darmawanweb/ais-its-contracts/api';
import { type ValidationError, ValidationPipe } from '@nestjs/common';
import { ValidateIf, type ValidationOptions } from 'class-validator';

import { ValidationFailedError } from '../errors/domain-error.js';

/**
 * Flattens class-validator errors into problem-details `errors[]`: one entry
 * per violated constraint, with dot paths (`positions.1.lat`) and the
 * constraint name as `code` (`isLatitude`, `whitelistValidation`, …).
 */
export function validationErrorsToFieldErrors(
  errors: readonly ValidationError[],
  parentPath = '',
): FieldError[] {
  const fieldErrors: FieldError[] = [];
  for (const error of errors) {
    const field =
      parentPath === '' ? error.property : `${parentPath}.${error.property}`;
    for (const [code, message] of Object.entries(error.constraints ?? {})) {
      fieldErrors.push({ field, message, code });
    }
    if (error.children !== undefined && error.children.length > 0) {
      fieldErrors.push(...validationErrorsToFieldErrors(error.children, field));
    }
  }
  return fieldErrors;
}

/**
 * The global validation pipe (spec §2): strips unknown properties and rejects
 * them (`whitelist`, `forbidNonWhitelisted`), transforms payloads into DTO
 * instances, and reports failures as `400 VALIDATION_FAILED` with `errors[]`.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new ValidationFailedError(validationErrorsToFieldErrors(errors)),
  });
}

/**
 * "Optional but not null" (PATCH bodies): an absent property (`undefined`)
 * skips its other validators, while `null` is validated like any value and
 * fails the type validators (`400 VALIDATION_FAILED`), so it never reaches a
 * `NOT NULL` column. class-validator's `@IsOptional()` lets `null` through.
 * Use `@IsOptional()` only for properties that may be cleared with `null`.
 *
 * @example
 * class UpdateZoneDto {
 *   @ApiPropertyOptional() @IsOptionalNotNull() @IsString() @MinLength(1) name?: string;
 *   @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() description?: string | null;
 * }
 */
export function IsOptionalNotNull(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return ValidateIf(
    (_object: object, value: unknown) => value !== undefined,
    validationOptions,
  );
}
