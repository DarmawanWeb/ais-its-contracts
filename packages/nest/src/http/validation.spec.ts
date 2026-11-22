import 'reflect-metadata';

import type { ArgumentMetadata } from '@nestjs/common';
import { IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { ValidationFailedError } from '../errors/domain-error.js';
import { createValidationPipe, IsOptionalNotNull } from './validation.js';

/** A PATCH body: `name` may be omitted but never cleared, `note` may be cleared. */
class UpdateZoneDto {
  @IsOptionalNotNull()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptionalNotNull()
  @IsInt()
  bufferM?: number;

  @IsOptional()
  @IsString()
  note?: string | null;
}

const pipe = createValidationPipe();
const body: ArgumentMetadata = { type: 'body', metatype: UpdateZoneDto };

async function fieldsOf(value: unknown): Promise<string[]> {
  try {
    await pipe.transform(value, body);
    return [];
  } catch (error) {
    if (!(error instanceof ValidationFailedError)) throw error;
    return (error.errors ?? [])
      .map((entry) => `${entry.field}:${entry.code}`)
      .sort();
  }
}

describe('IsOptionalNotNull (CORE-5)', () => {
  it('skips absent properties and validates present ones', async () => {
    expect(await fieldsOf({})).toEqual([]);
    expect(await fieldsOf({ name: 'Batam', bufferM: 50 })).toEqual([]);
    expect(await fieldsOf({ name: '' })).toEqual(['name:minLength']);
  });

  it('rejects null like any invalid value, unlike IsOptional', async () => {
    expect(await fieldsOf({ name: null })).toEqual([
      'name:isString',
      'name:minLength',
    ]);
    expect(await fieldsOf({ bufferM: null })).toEqual(['bufferM:isInt']);
    expect(await fieldsOf({ note: null })).toEqual([]);
  });

  it('keeps the property whitelisted', async () => {
    expect(await fieldsOf({ name: 'x', unknown: 1 })).toEqual([
      'unknown:whitelistValidation',
    ]);
  });
});
