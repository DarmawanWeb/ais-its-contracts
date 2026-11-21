import 'reflect-metadata';

import type { ArgumentMetadata } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Controller, Get, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { ValidationFailedError } from '../errors/domain-error.js';
import { createFastifyAdapter } from './fastify-adapter.js';
import {
  ApiCursorResponse,
  ApiPageResponse,
  BBoxQueryDto,
  bboxOf,
  cursorPage,
  CursorQueryDto,
  decodeQueryCursor,
  pageOffsetOf,
  PageQueryDto,
  paginate,
  resolveQueryTimeRange,
  TimeRangeQueryDto,
} from './pagination.js';
import { createValidationPipe } from './validation.js';

const pipe = createValidationPipe();
const query = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({
  type: 'query',
  metatype,
});

async function rejection(
  promise: Promise<unknown>,
): Promise<ValidationFailedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ValidationFailedError) return error;
    throw error;
  }
  throw new Error('expected a ValidationFailedError');
}

describe('PageQueryDto', () => {
  it('applies the defaults and coerces query strings', async () => {
    const defaults = (await pipe.transform(
      {},
      query(PageQueryDto),
    )) as PageQueryDto;
    expect(defaults).toMatchObject({ page: 1, pageSize: 20 });
    const parsed = (await pipe.transform(
      { page: '3', pageSize: '50' },
      query(PageQueryDto),
    )) as PageQueryDto;
    expect(parsed).toMatchObject({ page: 3, pageSize: 50 });
    expect(pageOffsetOf(parsed)).toBe(100);
    expect(paginate(['a'], parsed, 101)).toEqual({
      data: ['a'],
      meta: { page: 3, pageSize: 50, total: 101 },
    });
  });

  it('rejects page < 1, pageSize > 100 and non-integers with field errors', async () => {
    const error = await rejection(
      pipe.transform({ page: '0', pageSize: '101' }, query(PageQueryDto)),
    );
    expect(error.errors?.map((e) => e.field).sort()).toEqual([
      'page',
      'pageSize',
    ]);
    await rejection(pipe.transform({ page: '1.5' }, query(PageQueryDto)));
  });
});

describe('CursorQueryDto and cursor pages', () => {
  const Position = z.object({ time: z.iso.datetime(), id: z.string() });

  it('defaults limit to 100, caps it at 500 and validates the cursor alphabet', async () => {
    const parsed = (await pipe.transform(
      {},
      query(CursorQueryDto),
    )) as CursorQueryDto;
    expect(parsed.limit).toBe(100);
    expect(parsed.cursor).toBeUndefined();
    const error = await rejection(
      pipe.transform(
        { limit: '501', cursor: 'not a cursor!' },
        query(CursorQueryDto),
      ),
    );
    expect(error.errors?.map((e) => e.field).sort()).toEqual([
      'cursor',
      'limit',
    ]);
  });

  it('round-trips the position of the last row and stops on the last page', () => {
    const rows = [
      { id: 'a', time: '2026-01-01T00:00:00.000Z' },
      { id: 'b', time: '2026-01-01T00:01:00.000Z' },
      { id: 'c', time: '2026-01-01T00:02:00.000Z' },
    ];
    const first = cursorPage(rows, 2, (row) => ({
      time: row.time,
      id: row.id,
    }));
    expect(first.data.map((row) => row.id)).toEqual(['a', 'b']);
    expect(first.page.limit).toBe(2);
    const next = first.page.nextCursor;
    expect(next).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeQueryCursor({ cursor: next ?? undefined }, Position)).toEqual({
      time: rows[1]?.time,
      id: 'b',
    });
    expect(
      cursorPage(rows.slice(2), 2, (row) => row.id).page.nextCursor,
    ).toBeNull();
    expect(decodeQueryCursor({}, Position)).toBeUndefined();
  });

  it('answers 400 for a cursor of another list', () => {
    expect(() => decodeQueryCursor({ cursor: 'eyJ4IjoxfQ' }, Position)).toThrow(
      ValidationFailedError,
    );
  });
});

describe('TimeRangeQueryDto', () => {
  it('accepts ISO-8601 bounds only and resolves the convention', async () => {
    await rejection(
      pipe.transform({ from: 'yesterday' }, query(TimeRangeQueryDto)),
    );
    const parsed = (await pipe.transform(
      { from: '2026-01-01T00:00:00Z' },
      query(TimeRangeQueryDto),
    )) as TimeRangeQueryDto;
    const now = new Date('2026-01-02T00:00:00Z');
    expect(
      resolveQueryTimeRange(parsed, { defaultDurationMs: 3_600_000, now }),
    ).toEqual({ from: new Date('2026-01-01T00:00:00Z'), to: now });
    expect(
      resolveQueryTimeRange({}, { defaultDurationMs: 3_600_000, now }).from,
    ).toEqual(new Date('2026-01-01T23:00:00Z'));
  });

  it('answers 400 when from > to or the range is too long', () => {
    expect(() =>
      resolveQueryTimeRange(
        { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
        { defaultDurationMs: 1 },
      ),
    ).toThrow(ValidationFailedError);
    expect(() =>
      resolveQueryTimeRange(
        { from: '2026-01-01T00:00:00Z', to: '2026-01-09T00:00:00Z' },
        { defaultDurationMs: 1, maxDurationMs: 7 * 86_400_000 },
      ),
    ).toThrow(ValidationFailedError);
  });
});

describe('BBoxQueryDto', () => {
  it('validates minLon,minLat,maxLon,maxLat and parses it', async () => {
    const parsed = (await pipe.transform(
      { bbox: '95,-11,141,6' },
      query(BBoxQueryDto),
    )) as BBoxQueryDto;
    expect(bboxOf(parsed)).toEqual([95, -11, 141, 6]);
    expect(bboxOf({})).toBeUndefined();
    const error = await rejection(
      pipe.transform({ bbox: '95,-11,141' }, query(BBoxQueryDto)),
    );
    expect(error.errors).toMatchObject([{ field: 'bbox', code: 'isBBox' }]);
  });
});

class ItemDto {
  readonly id!: string;
}

@Controller('items')
class ItemsController {
  @Get()
  @ApiPageResponse(ItemDto)
  list(@Query() _query: PageQueryDto): undefined {
    return undefined;
  }

  @Get('events')
  @ApiCursorResponse(ItemDto)
  events(@Query() _query: CursorQueryDto): undefined {
    return undefined;
  }
}

describe('ApiPageResponse / ApiCursorResponse', () => {
  it('documents the list envelopes and the query parameters', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ItemsController],
    }).compile();
    const app = moduleRef.createNestApplication(createFastifyAdapter());
    await app.init();
    try {
      const document = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().build(),
      );
      const list = document.paths['/items']?.get;
      expect(list?.responses['200']).toMatchObject({
        content: {
          'application/json': {
            schema: {
              properties: {
                data: { items: { $ref: '#/components/schemas/ItemDto' } },
                meta: { $ref: '#/components/schemas/PageMetaDto' },
              },
            },
          },
        },
      });
      expect(list?.parameters?.map((p) => ('name' in p ? p.name : ''))).toEqual(
        ['page', 'pageSize'],
      );
      expect(
        document.paths['/items/events']?.get?.responses['200'],
      ).toMatchObject({
        content: {
          'application/json': {
            schema: {
              properties: {
                page: { $ref: '#/components/schemas/CursorPageInfoDto' },
              },
            },
          },
        },
      });
      expect(document.components?.schemas).toHaveProperty('PageMetaDto');
    } finally {
      await app.close();
    }
  });
});
