import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { decodeBase64Url, encodeBase64Url } from './base64url.js';
import {
  IsoDateTimeCodec,
  isIsoDateTime,
  parseIsoDateTime,
  resolveTimeRange,
  toIsoDateTime,
} from './datetime.js';
import {
  CursorQuerySchema,
  cursorPageSchema,
  decodeCursor,
  encodeCursor,
  MAX_CURSOR_LIMIT,
  MAX_PAGE_SIZE,
  pageCount,
  pageOffset,
  PageQuerySchema,
  paginatedSchema,
  toCursorPage,
  toPaginated,
} from './pagination.js';

describe('page-based lists', () => {
  it('coerces query strings and applies defaults', () => {
    expect(PageQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(PageQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
    for (const invalid of [
      { page: '0' },
      { pageSize: '101' },
      { page: '1.5' },
      { page: 'x' },
    ]) {
      expect(PageQuerySchema.safeParse(invalid).success).toBe(false);
    }
    expect(MAX_PAGE_SIZE).toBe(100);
  });

  it('wraps a page with its metadata', () => {
    const query = PageQuerySchema.parse({ page: '2', pageSize: '20' });
    expect(pageOffset(query)).toBe(20);
    const page = toPaginated(['a', 'b'], query, 22);
    expect(page).toEqual({
      data: ['a', 'b'],
      meta: { page: 2, pageSize: 20, total: 22 },
    });
    expect(pageCount(page.meta)).toBe(2);
    expect(paginatedSchema(z.string()).parse(page)).toEqual(page);
    expect(
      paginatedSchema(z.string()).safeParse({ data: [1], meta: page.meta })
        .success,
    ).toBe(false);
  });
});

describe('cursor-based lists', () => {
  it('coerces limits up to 500', () => {
    expect(CursorQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(CursorQuerySchema.parse({ cursor: 'abc', limit: '500' })).toEqual({
      cursor: 'abc',
      limit: 500,
    });
    expect(
      CursorQuerySchema.safeParse({ limit: String(MAX_CURSOR_LIMIT + 1) })
        .success,
    ).toBe(false);
  });

  it('derives the next cursor from a limit + 1 fetch', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(toCursorPage(rows, 2, (row) => `after-${row.id}`)).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      page: { nextCursor: 'after-2', limit: 2 },
    });
    expect(toCursorPage(rows, 3, (row) => `after-${row.id}`)).toEqual({
      data: rows,
      page: { nextCursor: null, limit: 3 },
    });
    expect(
      cursorPageSchema(z.object({ id: z.number() })).parse({
        data: rows,
        page: { nextCursor: null, limit: 3 },
      }),
    ).toEqual({ data: rows, page: { nextCursor: null, limit: 3 } });
  });

  it('encodes opaque cursors and validates them on decode', () => {
    const Position = z.object({ time: z.iso.datetime(), id: z.uuid() });
    const position = {
      time: '2026-11-20T08:30:00.000Z',
      id: '01a1f8c2-54d8-71c4-95cf-ab5eb8908e00',
    };
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, Position)).toEqual(position);
    expect(
      decodeCursor(encodeCursor({ time: 'yesterday' }), Position),
    ).toBeNull();
    expect(decodeCursor('%%%', Position)).toBeNull();
    expect(decodeCursor(encodeBase64Url('{not json'), Position)).toBeNull();
  });
});

describe('base64url', () => {
  it.each([
    '',
    'f',
    'fo',
    'foo',
    'foob',
    'fooba',
    'foobar',
    'Kapal 🚢 berlabuh — ü',
  ])('round-trips %j and matches the RFC 4648 alphabet', (text) => {
    const encoded = encodeBase64Url(text);
    expect(decodeBase64Url(encoded)).toBe(text);
    const reference = btoa(
      String.fromCodePoint(...new TextEncoder().encode(text)),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    expect(encoded).toBe(reference);
  });

  it('rejects invalid input', () => {
    expect(decodeBase64Url('a')).toBeNull();
    expect(decodeBase64Url('ab+c')).toBeNull();
    expect(decodeBase64Url('_w')).toBeNull();
  });
});

describe('ISO-8601 timestamps', () => {
  it('formats and parses UTC timestamps', () => {
    const date = new Date('2026-11-20T08:30:00.123Z');
    expect(toIsoDateTime(date)).toBe('2026-11-20T08:30:00.123Z');
    expect(toIsoDateTime(date.getTime())).toBe('2026-11-20T08:30:00.123Z');
    expect(parseIsoDateTime('2026-11-20T08:30:00Z')).toEqual(
      new Date('2026-11-20T08:30:00Z'),
    );
    expect(isIsoDateTime('2026-11-20T08:30:00.000Z')).toBe(true);
    expect(isIsoDateTime('2026-11-20T15:30:00+07:00')).toBe(false);
    expect(isIsoDateTime('2026-11-20')).toBe(false);
    expect(() => parseIsoDateTime('20 Nov 2026')).toThrow(RangeError);
    expect(() => toIsoDateTime(new Date('nope'))).toThrow(RangeError);
  });

  it('decodes and encodes with the codec', () => {
    const date = z.decode(IsoDateTimeCodec, '2026-11-20T08:30:00.000Z');
    expect(date).toEqual(new Date('2026-11-20T08:30:00.000Z'));
    expect(z.encode(IsoDateTimeCodec, date)).toBe('2026-11-20T08:30:00.000Z');
  });

  it('resolves time ranges with defaults and limits', () => {
    const now = new Date('2026-11-20T12:00:00.000Z');
    const day = 24 * 3600 * 1000;
    expect(resolveTimeRange({}, { defaultDurationMs: day, now })).toEqual({
      from: new Date('2026-11-19T12:00:00.000Z'),
      to: now,
    });
    expect(
      resolveTimeRange(
        { from: '2026-11-20T00:00:00Z', to: null },
        { defaultDurationMs: day, now },
      ),
    ).toEqual({ from: new Date('2026-11-20T00:00:00Z'), to: now });
    expect(() =>
      resolveTimeRange(
        { from: '2026-11-21T00:00:00Z', to: '2026-11-20T00:00:00Z' },
        { defaultDurationMs: day },
      ),
    ).toThrow(RangeError);
    expect(() =>
      resolveTimeRange(
        { from: '2026-11-01T00:00:00Z', to: '2026-11-20T00:00:00Z' },
        { defaultDurationMs: day, maxDurationMs: 7 * day },
      ),
    ).toThrow(/must not exceed/);
    expect(() =>
      resolveTimeRange({ from: 'yesterday' }, { defaultDurationMs: day }),
    ).toThrow(RangeError);
  });
});
