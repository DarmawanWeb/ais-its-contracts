import 'reflect-metadata';

import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ValidationFailedError } from '../errors/domain-error.js';
import { createFastifyAdapter } from './fastify-adapter.js';
import {
  IntParam,
  MmsiParam,
  parseIntParam,
  parseMmsiParam,
  parseUuidParam,
  UuidParam,
} from './path-params.js';
import { createValidationPipe } from './validation.js';

/** The field error of a rejected value. */
function fieldErrorOf(parse: () => unknown): unknown {
  try {
    parse();
  } catch (error) {
    if (error instanceof ValidationFailedError) return error.errors?.[0];
    throw error;
  }
  return undefined;
}

describe('path parameter parsers (CORE-4)', () => {
  it('accepts exactly nine digits forming an MMSI', () => {
    expect(parseMmsiParam('525005223')).toBe(525005223);
    for (const value of [
      '0525005223',
      '052500522',
      '0x1F4A1D67',
      ' 525005223',
      '525005223 ',
      '1e5',
      '-5',
      '+525005223',
      '525005223.0',
      '',
      undefined,
      525005223,
    ]) {
      expect(fieldErrorOf(() => parseMmsiParam(value))).toEqual({
        field: 'mmsi',
        message: 'mmsi must be a 9-digit MMSI',
        code: 'isMmsi',
      });
    }
    expect(fieldErrorOf(() => parseMmsiParam('1', 'relatedMmsi'))).toEqual(
      expect.objectContaining({ field: 'relatedMmsi', code: 'isMmsi' }),
    );
  });

  it('accepts decimal safe integers within the bounds', () => {
    expect(parseIntParam('-5', 'offset')).toBe(-5);
    expect(parseIntParam('2026', 'year', { min: 2000, max: 2100 })).toBe(2026);
    for (const value of [
      '1e5',
      '0x1F',
      ' 12',
      '12 ',
      '12.0',
      '+12',
      '9007199254740993',
      '',
    ]) {
      expect(fieldErrorOf(() => parseIntParam(value, 'year'))).toEqual(
        expect.objectContaining({ field: 'year', code: 'isInt' }),
      );
    }
    expect(
      fieldErrorOf(() => parseIntParam('1999', 'year', { min: 2000 })),
    ).toEqual(expect.objectContaining({ code: 'min' }));
    expect(
      fieldErrorOf(() => parseIntParam('2101', 'year', { max: 2100 })),
    ).toEqual(expect.objectContaining({ code: 'max' }));
  });

  it('accepts canonical UUIDs only', () => {
    const id = '0193a3c0-0000-7000-8000-0000000000e1';
    expect(parseUuidParam(id)).toBe(id);
    for (const value of [
      '0193a3c000007000800000000000000e1',
      `{${id}}`,
      ` ${id}`,
      'not-a-uuid',
      '1',
    ]) {
      expect(fieldErrorOf(() => parseUuidParam(value))).toEqual({
        field: 'id',
        message: 'id must be a UUID',
        code: 'isUuid',
      });
    }
  });
});

@Controller('vessels')
class VesselsController {
  @Get('by-mmsi/:mmsi')
  byMmsi(@MmsiParam() mmsi: number): { readonly mmsi: number } {
    return { mmsi };
  }

  @Get(':id/years/:year')
  year(
    @UuidParam() id: string,
    @IntParam('year', { min: 2000, max: 2100 }) year: number,
  ): { readonly id: string; readonly year: number } {
    return { id, year };
  }
}

describe('UuidParam / IntParam / MmsiParam decorators', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [VesselsController],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createFastifyAdapter(),
    );
    // The global pipe of every service: it must leave the raw values alone.
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('hands the parsed raw path segments to the handler', async () => {
    const mmsi = await app.inject({
      method: 'GET',
      url: '/vessels/by-mmsi/525005223',
    });
    expect(mmsi.json()).toEqual({ mmsi: 525005223 });
    const year = await app.inject({
      method: 'GET',
      url: '/vessels/0193a3c0-0000-7000-8000-0000000000e1/years/2026',
    });
    expect(year.json()).toEqual({
      id: '0193a3c0-0000-7000-8000-0000000000e1',
      year: 2026,
    });
  });

  it('documents the path parameters with their schema', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    expect(document.paths['/vessels/by-mmsi/{mmsi}']?.get?.parameters).toEqual([
      {
        name: 'mmsi',
        in: 'path',
        required: true,
        description: 'MMSI: exactly nine digits',
        schema: {
          type: 'string',
          pattern: '^[0-9]{9}$',
          example: '525005223',
        },
      },
    ]);
    const parameters =
      document.paths['/vessels/{id}/years/{year}']?.get?.parameters ?? [];
    expect(parameters).toHaveLength(2);
    expect(parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          in: 'path',
          schema: { type: 'string', format: 'uuid' },
        }),
        expect.objectContaining({
          name: 'year',
          in: 'path',
          schema: { type: 'integer', minimum: 2000, maximum: 2100 },
        }),
      ]),
    );
  });
});
