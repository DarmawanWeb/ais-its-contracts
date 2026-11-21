import type { FieldError } from '@darmawanweb/seemp-contracts/api';
import { type ValidationError, ValidationPipe } from '@nestjs/common';

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
    const field = parentPath === '' ? error.property : `${parentPath}.${error.property}`;
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
