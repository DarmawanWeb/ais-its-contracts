import { describe, expect, it } from 'vitest';

import {
  LEGACY_DD_VECTORS,
  LEGACY_GRADE_CASES,
} from './__fixtures__/legacy-golden.js';
import {
  assignCiiGrade,
  CII_GRADE_LABELS,
  CII_GRADES,
  ciiCapacity,
  ciiGradeBoundaries,
  ciiGradeLabel,
  DdVectorSchema,
} from './cii.js';

describe('assignCiiGrade (legacy assignGradeBasedOnDdVector parity)', () => {
  it('covers every legacy golden case', () => {
    expect(LEGACY_GRADE_CASES.length).toBeGreaterThan(100);
    const mismatches = LEGACY_GRADE_CASES.filter(
      ({ vector, rating, grade }) =>
        assignCiiGrade(rating, LEGACY_DD_VECTORS[vector]) !== grade,
    );
    expect(mismatches).toEqual([]);
  });

  it('grades the IMO bands of a bulk carrier', () => {
    const d = LEGACY_DD_VECTORS.bulkCarrier;
    expect(assignCiiGrade(0.8, d)).toBe('A');
    expect(assignCiiGrade(0.86, d)).toBe('B');
    expect(assignCiiGrade(1, d)).toBe('C');
    expect(assignCiiGrade(1.1044, d)).toBe('D');
    expect(assignCiiGrade(1.18, d)).toBe('E');
  });

  it('treats non-finite ratings like the legacy code', () => {
    const d = LEGACY_DD_VECTORS.tanker;
    expect(assignCiiGrade(Number.NaN, d)).toBe('E');
    expect(assignCiiGrade(Number.POSITIVE_INFINITY, d)).toBe('E');
    expect(assignCiiGrade(Number.NEGATIVE_INFINITY, d)).toBe('A');
  });
});

describe('CII grade helpers', () => {
  it('computes absolute boundaries as d × required', () => {
    expect(ciiGradeBoundaries(5, LEGACY_DD_VECTORS.bulkCarrier)).toEqual({
      d1: 0.86 * 5,
      d2: 0.94 * 5,
      d3: 1.06 * 5,
      d4: 1.18 * 5,
    });
  });

  it('labels every grade in both locales', () => {
    expect(Object.keys(CII_GRADE_LABELS)).toEqual([...CII_GRADES]);
    expect(ciiGradeLabel('A')).toBe('Major superior');
    expect(ciiGradeLabel('E', 'id')).toBe('Buruk');
  });

  it('validates d vectors', () => {
    expect(DdVectorSchema.safeParse(LEGACY_DD_VECTORS.gasCarrier).success).toBe(
      true,
    );
    expect(DdVectorSchema.safeParse({ d1: 0.8, d2: 0.9, d3: 1 }).success).toBe(
      false,
    );
  });
});

describe('ciiCapacity (spec 13.5)', () => {
  const vessel = { dimensions: { capacity: 312_000 } };

  it('uses the regulation-fixed capacity of the ship type when set', () => {
    expect(ciiCapacity({ ...vessel, type: { capacityFixed: 279_000 } })).toBe(
      279_000,
    );
  });

  it('falls back to the capacity of the vessel', () => {
    expect(ciiCapacity({ ...vessel, type: { capacityFixed: null } })).toBe(
      312_000,
    );
    expect(ciiCapacity({ ...vessel, type: {} })).toBe(312_000);
  });
});
