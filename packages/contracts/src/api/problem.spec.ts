import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  ERROR_CODE_PATTERN,
  ERROR_CODES,
  ERROR_DEFINITIONS,
  type ErrorCode,
  isErrorCode,
} from './error-codes.js';
import {
  createProblem,
  isProblemDetails,
  issuesToFieldErrors,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPE_BASE_URI,
  ProblemDetailsSchema,
  problemTypeUri,
} from './problem.js';

describe('error codes', () => {
  it('includes the codes every service relies on', () => {
    const required: ErrorCode[] = [
      'VALIDATION_FAILED',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'RATE_LIMITED',
      'INTERNAL_ERROR',
      'INVALID_CREDENTIALS',
      'MFA_REQUIRED',
      'CII_NOT_AVAILABLE',
      'VESSEL_NOT_FOUND',
    ];
    for (const code of required) {
      expect(ERROR_CODES[code]).toBe(code);
    }
    expect(ERROR_DEFINITIONS.VALIDATION_FAILED.status).toBe(400);
    expect(ERROR_DEFINITIONS.INTERNAL_ERROR.status).toBe(500);
    expect(ERROR_DEFINITIONS.CII_NOT_AVAILABLE.status).toBe(404);
    expect(ERROR_DEFINITIONS.RATE_LIMITED.status).toBe(429);
  });

  it('keeps every code UPPER_SNAKE_CASE with an HTTP error status', () => {
    for (const [code, definition] of Object.entries(ERROR_DEFINITIONS)) {
      expect(code).toMatch(ERROR_CODE_PATTERN);
      expect(definition.status).toBeGreaterThanOrEqual(400);
      expect(definition.status).toBeLessThan(600);
      expect(definition.title.length).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    expect(isErrorCode('VESSEL_NOT_FOUND')).toBe(true);
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode('vessel_not_found')).toBe(false);
  });
});

describe('problem details (RFC 9457)', () => {
  it('derives the problem type URI from the code', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
    expect(problemTypeUri('VESSEL_NOT_FOUND')).toBe(
      'https://seemp.dev/problems/vessel-not-found',
    );
    expect(
      problemTypeUri('INTERNAL_ERROR').startsWith(PROBLEM_TYPE_BASE_URI),
    ).toBe(true);
  });

  it('builds the example body of spec 5', () => {
    const problem = createProblem('VESSEL_NOT_FOUND', {
      detail: 'No vessel with MMSI 525005223',
      instance: '/api/v2/vessels/by-mmsi/525005223',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      errors: [{ field: 'mmsi', message: 'unknown' }],
    });
    expect(problem).toEqual({
      type: 'https://seemp.dev/problems/vessel-not-found',
      title: 'Vessel not found',
      status: 404,
      detail: 'No vessel with MMSI 525005223',
      instance: '/api/v2/vessels/by-mmsi/525005223',
      code: 'VESSEL_NOT_FOUND',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      errors: [{ field: 'mmsi', message: 'unknown' }],
    });
    expect(ProblemDetailsSchema.parse(problem)).toEqual(problem);
    expect(createProblem('FORBIDDEN')).toEqual({
      type: 'https://seemp.dev/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'FORBIDDEN',
    });
    expect(createProblem('CONFLICT', { title: 'MMSI taken' }).title).toBe(
      'MMSI taken',
    );
  });

  it('keeps extension members and rejects malformed bodies', () => {
    const withExtension = {
      ...createProblem('RATE_LIMITED'),
      retryAfterSeconds: 30,
    };
    expect(ProblemDetailsSchema.parse(withExtension)).toEqual(withExtension);
    expect(isProblemDetails(withExtension)).toBe(true);
    expect(isProblemDetails({ title: 'x', status: 404 })).toBe(false);
    expect(isProblemDetails({ ...withExtension, code: 'not-snake' })).toBe(
      false,
    );
    expect(isProblemDetails({ ...withExtension, status: 99 })).toBe(false);
  });

  it('converts zod issues into field errors', () => {
    const schema = z.object({
      positions: z.array(z.object({ lat: z.number().max(90) })),
      name: z.string(),
    });
    const result = schema.safeParse({ positions: [{ lat: 10 }, { lat: 91 }] });
    expect(result.success).toBe(false);
    const errors = issuesToFieldErrors(result.error?.issues ?? []);
    expect(errors.map((error) => error.field)).toEqual([
      'positions.1.lat',
      'name',
    ]);
    expect(errors[0]).toMatchObject({ code: 'too_big' });
    expect(
      issuesToFieldErrors([{ path: [], message: 'Invalid input' }]),
    ).toEqual([{ field: '', message: 'Invalid input' }]);
  });
});
