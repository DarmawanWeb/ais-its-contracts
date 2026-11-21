import { Body, Controller, Get, HttpCode, Module, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsString, Max, Min, MinLength, ValidateNested } from 'class-validator';

import {
  AllowApiKey,
  CurrentPrincipal,
  Internal,
  type Principal,
  Public,
  RequirePermissions,
} from '../../src/auth/index.js';
import { ConflictError, NotFoundError } from '../../src/errors/index.js';

/** A position of the validation fixture. */
export class PositionDto {
  @IsLatitude()
  lat!: number;

  @IsLongitude()
  lon!: number;
}

/** Body of `POST /api/v2/fixtures/vessels`. */
export class CreateVesselDto {
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  mmsi!: number;

  @IsString()
  @MinLength(2)
  name!: string;

  @ValidateNested({ each: true })
  @Type(() => PositionDto)
  positions!: PositionDto[];
}

/** Routes exercising the platform's HTTP conventions. */
@ApiTags('fixtures')
@Controller('fixtures')
export class FixtureController {
  @Public()
  @Get('public')
  open(): { readonly ok: true } {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentPrincipal() principal: Principal): { readonly kind: string; readonly id: string } {
    return { kind: principal.kind, id: principal.id };
  }

  @RequirePermissions('vessel:write')
  @Post('vessels')
  @HttpCode(201)
  create(@Body() body: CreateVesselDto): { readonly mmsi: number; readonly positions: number; readonly dto: boolean } {
    return { mmsi: body.mmsi, positions: body.positions.length, dto: body instanceof CreateVesselDto };
  }

  @Public()
  @Get('vessels/:mmsi')
  find(@Param('mmsi', ParseIntPipe) mmsi: number): never {
    throw new NotFoundError(`No vessel with MMSI ${mmsi}`, { code: 'VESSEL_NOT_FOUND', extra: { mmsi } });
  }

  @Public()
  @Post('conflict')
  conflict(): never {
    throw new ConflictError('MMSI already registered', { code: 'MMSI_ALREADY_EXISTS' });
  }

  @Public()
  @Get('crash')
  crash(): never {
    throw new Error('database password is hunter2');
  }

  @AllowApiKey('ais:ingest')
  @RequirePermissions('telemetry:write')
  @Post('ingest')
  @HttpCode(202)
  ingest(@CurrentPrincipal() principal: Principal): { readonly kind: string; readonly orgId: string | null } {
    return { kind: principal.kind, orgId: principal.orgId };
  }
}

/** A service-to-service route (outside the global prefix). */
@Internal()
@Controller('internal/fixtures')
export class InternalFixtureController {
  @Get('ping')
  ping(): { readonly pong: true } {
    return { pong: true };
  }
}

/** The fixture application module. */
@Module({ controllers: [FixtureController, InternalFixtureController] })
export class FixtureModule {}
