import {
  type CursorPage,
  decodeCursor,
  DEFAULT_CURSOR_LIMIT,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_CURSOR_LIMIT,
  MAX_PAGE_SIZE,
  type Paginated,
  resolveTimeRange,
  type TimeRange,
  type TimeRangeOptions,
  toCursorPage,
  toPaginated,
} from '@darmawanweb/ais-its-contracts/api';
import { type BBox, parseBBox } from '@darmawanweb/ais-its-contracts/domain';
import { applyDecorators, type Type as ClassType } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import type * as z from 'zod';

import { ValidationFailedError } from '../errors/domain-error.js';

/**
 * Largest accepted `page` of page-based lists: 1 000 000 pages of up to 100
 * items keep `OFFSET` far inside PostgreSQL's `bigint`, while an unbounded
 * page (`page=99999999999999999999`) would overflow it and answer `500`.
 */
export const MAX_PAGE = 1_000_000;

/**
 * Query of page-based CRUD lists (spec §5): `page` 1–{@link MAX_PAGE}
 * (default 1), `pageSize` 1–100 (default 20). Extend it with the list's
 * filters.
 *
 * @example
 * class ListVesselsQuery extends PageQueryDto {
 *   @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
 * }
 * @Get() @ApiPageResponse(VesselDto)
 * list(@Query() query: ListVesselsQuery): Promise<Paginated<VesselDto>> { … }
 */
export class PageQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE,
    default: 1,
    type: 'integer',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  readonly page: number = 1;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
    type: 'integer',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  readonly pageSize: number = DEFAULT_PAGE_SIZE;
}

/** Longest accepted `cursor` query value (characters). */
export const MAX_CURSOR_LENGTH = 1024;

/**
 * Query of cursor-based, time-ordered lists (spec §5): opaque `cursor`
 * (from `page.nextCursor`) and `limit` 1–500 (default 100).
 */
export class CursorQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor from `page.nextCursor` of the previous page',
    maxLength: MAX_CURSOR_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_CURSOR_LENGTH)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: 'cursor must be a base64url string' })
  readonly cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_CURSOR_LIMIT,
    default: DEFAULT_CURSOR_LIMIT,
    type: 'integer',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CURSOR_LIMIT)
  readonly limit: number = DEFAULT_CURSOR_LIMIT;
}

const ISO_8601 = { strict: true, strictSeparator: true } as const;

/**
 * `from` / `to` (ISO-8601) of time-ranged queries (spec §5); resolve them
 * with {@link resolveQueryTimeRange} (missing `to` = now, missing `from` =
 * the endpoint default).
 */
export class TimeRangeQueryDto {
  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Start (ISO-8601); default: endpoint specific',
  })
  @IsOptional()
  @IsISO8601(ISO_8601)
  readonly from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'End (ISO-8601); default: now',
  })
  @IsOptional()
  @IsISO8601(ISO_8601)
  readonly to?: string;
}

/** Validates the `bbox` query format `minLon,minLat,maxLon,maxLat` (contracts `parseBBox`). */
export function IsBBox(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isBBox',
      target: target.constructor,
      propertyName: String(propertyName),
      ...(options === undefined ? {} : { options }),
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && parseBBox(value) !== null,
        defaultMessage: () =>
          '$property must be "minLon,minLat,maxLon,maxLat" in WGS 84 degrees',
      },
    });
  };
}

/** `bbox=minLon,minLat,maxLon,maxLat` of map queries; read it with {@link bboxOf}. */
export class BBoxQueryDto {
  @ApiPropertyOptional({
    description: 'minLon,minLat,maxLon,maxLat (WGS 84 degrees)',
    example: '95,-11,141,6',
  })
  @IsOptional()
  @IsBBox()
  readonly bbox?: string;
}

/** The parsed `bbox` of a validated {@link BBoxQueryDto}, or `undefined` when absent. */
export function bboxOf(query: {
  readonly bbox?: string | undefined;
}): BBox | undefined {
  if (query.bbox === undefined) return undefined;
  const bbox = parseBBox(query.bbox);
  if (bbox === null) {
    throw new ValidationFailedError([
      {
        field: 'bbox',
        message: 'bbox must be "minLon,minLat,maxLon,maxLat"',
        code: 'isBBox',
      },
    ]);
  }
  return bbox;
}

/**
 * Applies the time range convention to a validated {@link TimeRangeQueryDto}
 * (contracts `resolveTimeRange`).
 *
 * @throws {ValidationFailedError} `400` when `from > to` or the range is
 *   longer than `maxDurationMs`.
 */
export function resolveQueryTimeRange(
  query: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  },
  options: TimeRangeOptions,
): TimeRange {
  try {
    return resolveTimeRange(query, options);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new ValidationFailedError([
      { field: 'from', message: error.message, code: 'timeRange' },
    ]);
  }
}

/** One page of a page-based list (contracts `toPaginated`). */
export function paginate<T>(
  data: T[],
  query: Pick<PageQueryDto, 'page' | 'pageSize'>,
  total: number,
): Paginated<T> {
  return toPaginated(data, query, total);
}

/**
 * Zero-based row offset of a page query (`(page - 1) * pageSize`).
 *
 * @throws {RangeError} when `page` or `pageSize` is not a positive safe
 *   integer or the offset is not a safe integer (a query that bypassed
 *   {@link PageQueryDto}'s validation).
 */
export function pageOffsetOf(
  query: Pick<PageQueryDto, 'page' | 'pageSize'>,
): number {
  const { page, pageSize } = query;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1
  ) {
    throw new RangeError(
      `Invalid page query (page ${page}, pageSize ${pageSize}): both must be positive integers`,
    );
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset))
    throw new RangeError(
      `The offset of page ${page} (pageSize ${pageSize}) is not a safe integer`,
    );
  return offset;
}

/**
 * Builds a cursor page from rows fetched with `limit + 1`: the extra row is
 * dropped and the position of the last returned row becomes `nextCursor`
 * (base64url JSON, contracts `encodeCursor`).
 *
 * @example
 * const rows = await repo.list({ after: decodeQueryCursor(query, PositionSchema), limit: query.limit + 1 });
 * return cursorPage(rows, query.limit, (row) => ({ time: row.time.toISOString(), id: row.id }));
 */
export function cursorPage<T>(
  rows: T[],
  limit: number,
  positionOf: (lastRow: T) => unknown,
): CursorPage<T> {
  return toCursorPage(rows, limit, (row) => encodeCursor(positionOf(row)));
}

/**
 * Decodes the `cursor` of a validated {@link CursorQueryDto} against the
 * schema of the list's cursor position.
 *
 * @returns `undefined` for the first page.
 * @throws {ValidationFailedError} `400` (`errors[0].field = 'cursor'`) when
 *   the cursor is malformed or not a position of this list.
 */
export function decodeQueryCursor<Schema extends z.ZodType>(
  query: { readonly cursor?: string | undefined },
  schema: Schema,
): z.output<Schema> | undefined {
  if (query.cursor === undefined) return undefined;
  const position = decodeCursor(query.cursor, schema);
  if (position === null) {
    throw new ValidationFailedError([
      {
        field: 'cursor',
        message: 'cursor is invalid or belongs to another list',
        code: 'isCursor',
      },
    ]);
  }
  return position;
}

/** OpenAPI model of `meta` in page-based lists. */
export class PageMetaDto {
  @ApiProperty({ minimum: 1, maximum: MAX_PAGE, type: 'integer' })
  readonly page!: number;

  @ApiProperty({ minimum: 1, maximum: MAX_PAGE_SIZE, type: 'integer' })
  readonly pageSize!: number;

  @ApiProperty({
    minimum: 0,
    type: 'integer',
    description: 'Number of items across all pages',
  })
  readonly total!: number;
}

/** OpenAPI model of `page` in cursor-based lists. */
export class CursorPageInfoDto {
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Opaque cursor of the next page; null on the last page',
  })
  readonly nextCursor!: string | null;

  @ApiProperty({ minimum: 1, maximum: MAX_CURSOR_LIMIT, type: 'integer' })
  readonly limit!: number;
}

/** Documents a `200` page-based list `{ data: Item[], meta }` (spec §5). */
export function ApiPageResponse(
  item: ClassType<unknown>,
  description = 'One page of the list',
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(item, PageMetaDto),
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(item) } },
          meta: { $ref: getSchemaPath(PageMetaDto) },
        },
      },
    }),
  );
}

/** Documents a `200` cursor-based list `{ data: Item[], page }` (spec §5). */
export function ApiCursorResponse(
  item: ClassType<unknown>,
  description = 'One page of the time-ordered list',
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(item, CursorPageInfoDto),
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        required: ['data', 'page'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(item) } },
          page: { $ref: getSchemaPath(CursorPageInfoDto) },
        },
      },
    }),
  );
}
