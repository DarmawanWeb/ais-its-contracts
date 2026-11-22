import { describe, expect, it } from 'vitest';

import { rowDate, rowDateOrNull } from './rows.js';

describe('rowDate / rowDateOrNull (CORE-17)', () => {
  it('parses the timestamptz text PostgreSQL sends with pg’s parser', () => {
    expect(rowDate('2026-11-22 11:15:44.123+00').toISOString()).toBe(
      '2026-11-22T11:15:44.123Z',
    );
    expect(rowDate('2026-11-22 18:15:44+07').toISOString()).toBe(
      '2026-11-22T11:15:44.000Z',
    );
    expect(rowDate('2026-11-22T11:15:44.5Z').toISOString()).toBe(
      '2026-11-22T11:15:44.500Z',
    );
  });

  it('passes Dates through and handles null', () => {
    const date = new Date('2026-01-01T00:00:00Z');
    expect(rowDate(date)).toBe(date);
    expect(rowDateOrNull(null)).toBeNull();
    expect(rowDateOrNull(undefined)).toBeNull();
    expect(rowDateOrNull('2026-01-01 00:00:00+00')?.getTime()).toBe(
      date.getTime(),
    );
  });

  it('rejects infinite and unparsable values', () => {
    expect(() => rowDate('infinity')).toThrow(RangeError);
    expect(() => rowDate('-infinity')).toThrow(RangeError);
    expect(() => rowDate('not a date')).toThrow(/not a finite timestamp/);
    expect(() => rowDate(new Date(Number.NaN))).toThrow(RangeError);
  });
});
