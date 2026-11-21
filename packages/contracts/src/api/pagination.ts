import * as z from 'zod';

import { decodeBase64Url, encodeBase64Url } from './base64url.js';

/** Default `pageSize` of page-based lists. */
export const DEFAULT_PAGE_SIZE = 20;

/** Largest accepted `pageSize` of page-based lists. */
export const MAX_PAGE_SIZE = 100;

/** Default `limit` of cursor-based lists. */
export const DEFAULT_CURSOR_LIMIT = 100;

/** Largest accepted `limit` of cursor-based lists. */
export const MAX_CURSOR_LIMIT = 500;

/**
 * Zod schema of page-based query parameters; coerces query strings and applies
 * the defaults (`page = 1`, `pageSize = 20`).
 */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

/** Parsed page-based query parameters. */
export type PageQuery = z.output<typeof PageQuerySchema>;

/** Zod schema of the `meta` member of a page-based list. */
export const PageMetaSchema = z
  .object({
    page: z.int().min(1),
    pageSize: z.int().min(1).max(MAX_PAGE_SIZE),
    total: z.int().min(0).describe('Number of items across all pages'),
  })
  .describe('Pagination metadata');

/** Pagination metadata of a page-based list. */
export type PageMeta = z.infer<typeof PageMetaSchema>;

/** A page-based list: `{ data, meta: { page, pageSize, total } }`. */
export interface Paginated<T> {
  readonly data: T[];
  readonly meta: PageMeta;
}

/** Zod schema factory of a {@link Paginated} list of `item`. */
export function paginatedSchema<TItem extends z.ZodType>(item: TItem) {
  return z.object({ data: z.array(item), meta: PageMetaSchema });
}

/**
 * Zod schema of cursor-based query parameters; coerces query strings and
 * applies the default `limit` of 100.
 */
export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_CURSOR_LIMIT)
    .default(DEFAULT_CURSOR_LIMIT),
});

/** Parsed cursor-based query parameters. */
export type CursorQuery = z.output<typeof CursorQuerySchema>;

/** Zod schema of the `page` member of a cursor-based list. */
export const CursorPageInfoSchema = z
  .object({
    nextCursor: z
      .string()
      .min(1)
      .nullable()
      .describe('Opaque cursor of the next page; null on the last page'),
    limit: z.int().min(1).max(MAX_CURSOR_LIMIT),
  })
  .describe('Cursor pagination metadata');

/** Cursor pagination metadata. */
export type CursorPageInfo = z.infer<typeof CursorPageInfoSchema>;

/** A cursor-based list: `{ data, page: { nextCursor, limit } }`. */
export interface CursorPage<T> {
  readonly data: T[];
  readonly page: CursorPageInfo;
}

/** Zod schema factory of a {@link CursorPage} of `item`. */
export function cursorPageSchema<TItem extends z.ZodType>(item: TItem) {
  return z.object({ data: z.array(item), page: CursorPageInfoSchema });
}

/** Zero-based row offset of a page (`(page - 1) * pageSize`). */
export function pageOffset(query: PageQuery): number {
  return (query.page - 1) * query.pageSize;
}

/** Wraps one page of rows into a {@link Paginated} response. */
export function toPaginated<T>(
  data: T[],
  query: PageQuery,
  total: number,
): Paginated<T> {
  return { data, meta: { page: query.page, pageSize: query.pageSize, total } };
}

/** Number of pages of a list (`0` for an empty list). */
export function pageCount(meta: PageMeta): number {
  return Math.ceil(meta.total / meta.pageSize);
}

/**
 * Wraps rows fetched with `limit + 1` into a {@link CursorPage}: when an extra
 * row exists it is dropped and `cursorOf(lastReturnedRow)` becomes the next cursor.
 */
export function toCursorPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (lastRow: T) => string,
): CursorPage<T> {
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? cursorOf(last) : null;
  return { data, page: { nextCursor, limit } };
}

/** Encodes a JSON-serializable cursor position as an opaque base64url string. */
export function encodeCursor(position: unknown): string {
  return encodeBase64Url(JSON.stringify(position));
}

/**
 * Decodes a cursor produced by {@link encodeCursor} and validates it.
 *
 * @returns the position, or `null` when the cursor is malformed or invalid.
 */
export function decodeCursor<TSchema extends z.ZodType>(
  cursor: string,
  schema: TSchema,
): z.output<TSchema> | null {
  const json = decodeBase64Url(cursor);
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}
