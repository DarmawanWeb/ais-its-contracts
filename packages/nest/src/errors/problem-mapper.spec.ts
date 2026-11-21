import {
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationFailedError,
} from './domain-error.js';
import { errorCodeForStatus, toProblemResponse } from './problem-mapper.js';

const context = {
  instance: '/api/v2/vessels/1',
  requestId: 'req-1',
  exposeInternalErrors: false,
} as const;

describe('DomainError', () => {
  it('takes status and title of shared codes and requires them for custom codes', () => {
    const error = new DomainError('VESSEL_NOT_FOUND', {
      detail: 'No vessel with MMSI 525005223',
      extra: { mmsi: 525005223 },
    });
    expect(error).toMatchObject({
      status: 404,
      title: 'Vessel not found',
      code: 'VESSEL_NOT_FOUND',
    });
    expect(
      () => new DomainError('not_snake', { status: 400, title: 'Bad' }),
    ).toThrow(RangeError);
    expect(() => new DomainError('ZONE_GEOMETRY_INVALID' as never)).toThrow(
      /pass its status and title/,
    );
    expect(
      new DomainError('ZONE_GEOMETRY_INVALID', {
        status: 422,
        title: 'Invalid zone geometry',
      }).status,
    ).toBe(422);
    expect(
      () => new DomainError('TEAPOT', { status: 302, title: 'x' }),
    ).toThrow(/Invalid error status/);
  });

  it('provides the specific subclasses with their statuses and headers', () => {
    expect(new NotFoundError().status).toBe(404);
    expect(
      new ConflictError('dup', { code: 'MMSI_ALREADY_EXISTS' }),
    ).toMatchObject({ status: 409, code: 'MMSI_ALREADY_EXISTS' });
    expect(new ForbiddenError().status).toBe(403);
    expect(new UnauthorizedError().headers).toEqual({
      'WWW-Authenticate': 'Bearer',
    });
    expect(new RateLimitedError({ retryAfterSeconds: 1.2 }).headers).toEqual({
      'Retry-After': '2',
    });
    expect(
      new ValidationFailedError([{ field: 'mmsi', message: 'bad' }]).detail,
    ).toBe('The request has 1 invalid field');
  });
});

describe('toProblemResponse (RFC 9457)', () => {
  it('maps domain errors with their code, extensions, field errors and headers', () => {
    const problem = toProblemResponse(
      new DomainError('VESSEL_NOT_FOUND', {
        detail: 'No vessel with MMSI 525005223',
        extra: { mmsi: 525005223 },
      }),
      context,
    );
    expect(problem).toEqual({
      status: 404,
      headers: {},
      unexpected: false,
      body: {
        mmsi: 525005223,
        type: 'urn:ais-its:problem:vessel-not-found',
        title: 'Vessel not found',
        status: 404,
        code: 'VESSEL_NOT_FOUND',
        detail: 'No vessel with MMSI 525005223',
        instance: '/api/v2/vessels/1',
        traceId: 'req-1',
        requestId: 'req-1',
      },
    });
    const validation = toProblemResponse(
      new ValidationFailedError([{ field: 'lat', message: 'too big' }]),
      context,
    );
    expect(validation.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      errors: [{ field: 'lat', message: 'too big' }],
    });
    expect(
      toProblemResponse(
        new RateLimitedError({ retryAfterSeconds: 30 }),
        context,
      ).headers,
    ).toEqual({ 'Retry-After': '30' });
  });

  it('maps Nest HTTP exceptions by status', () => {
    expect(
      toProblemResponse(new NotFoundException(), context).body,
    ).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(
      toProblemResponse(
        new BadRequestException(
          'Validation failed (numeric string is expected)',
        ),
        context,
      ).body,
    ).toMatchObject({
      code: 'BAD_REQUEST',
      detail: 'Validation failed (numeric string is expected)',
    });
    expect(
      toProblemResponse(new HttpException('Gone', 410), context).body,
    ).toMatchObject({ code: 'GONE', status: 410 });
    expect(errorCodeForStatus(405)).toBe('METHOD_NOT_ALLOWED');
    expect(errorCodeForStatus(599)).toBe('INTERNAL_ERROR');
  });

  it('maps framework errors carrying a 4xx statusCode (Fastify)', () => {
    const tooLarge = Object.assign(new Error('Request body is too large'), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });
    expect(toProblemResponse(tooLarge, context)).toMatchObject({
      status: 413,
      unexpected: false,
      body: { code: 'PAYLOAD_TOO_LARGE', detail: 'Request body is too large' },
    });
  });

  it('hides unexpected errors in production and never sends stacks', () => {
    const crash = new Error('database password is hunter2');
    const hidden = toProblemResponse(crash, context);
    expect(hidden).toMatchObject({
      status: 500,
      unexpected: true,
      body: { code: 'INTERNAL_ERROR', detail: 'An unexpected error occurred' },
    });
    expect(JSON.stringify(hidden.body)).not.toContain('hunter2');
    const shown = toProblemResponse(crash, {
      ...context,
      exposeInternalErrors: true,
    });
    expect(shown.body.detail).toBe('database password is hunter2');
    expect(JSON.stringify(shown.body)).not.toContain('at ');
    expect(
      toProblemResponse(new HttpException('upstream exploded', 502), context)
        .body.detail,
    ).toBeUndefined();
  });
});
