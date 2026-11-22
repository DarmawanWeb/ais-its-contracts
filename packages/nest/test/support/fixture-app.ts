import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsLatitude,
  IsLongitude,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  IntParam,
  IsOptionalNotNull,
  MmsiParam,
  pageOffsetOf,
  PageQueryDto,
  UuidParam,
} from '../../src/http/index.js';

import {
  AllowApiKey,
  CurrentPrincipal,
  Internal,
  type Principal,
  Public,
  RequirePermissions,
  RequirePlatformAdmin,
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

/** PATCH body: `name` may be omitted but not cleared with `null`. */
export class UpdateFixtureZoneDto {
  @IsOptionalNotNull()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptionalNotNull()
  @IsInt()
  bufferM?: number;
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
  me(@CurrentPrincipal() principal: Principal): {
    readonly kind: string;
    readonly id: string;
  } {
    return { kind: principal.kind, id: principal.id };
  }

  @RequirePermissions('vessel:write')
  @Post('vessels')
  @HttpCode(201)
  create(@Body() body: CreateVesselDto): {
    readonly mmsi: number;
    readonly positions: number;
    readonly dto: boolean;
  } {
    return {
      mmsi: body.mmsi,
      positions: body.positions.length,
      dto: body instanceof CreateVesselDto,
    };
  }

  @Public()
  @Get('vessels/:mmsi')
  find(@Param('mmsi', ParseIntPipe) mmsi: number): never {
    throw new NotFoundError(`No vessel with MMSI ${mmsi}`, {
      code: 'VESSEL_NOT_FOUND',
      extra: { mmsi },
    });
  }

  @Public()
  @Get('pages')
  pages(@Query() query: PageQueryDto): { readonly offset: number } {
    return { offset: pageOffsetOf(query) };
  }

  @Public()
  @Get('by-mmsi/:mmsi')
  byMmsi(@MmsiParam() mmsi: number): { readonly mmsi: number } {
    return { mmsi };
  }

  @Public()
  @Get('zones/:id/years/:year')
  zoneYear(
    @UuidParam() id: string,
    @IntParam('year', { min: 2000, max: 2100 }) year: number,
  ): { readonly id: string; readonly year: number } {
    return { id, year };
  }

  @Public()
  @Patch('zones/:id')
  updateZone(
    @UuidParam() id: string,
    @Body() body: UpdateFixtureZoneDto,
  ): { readonly id: string; readonly fields: string[] } {
    const fields = Object.entries(body)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    return { id, fields: fields.sort() };
  }

  @Public()
  @Post('alerts/:id/ack')
  @HttpCode(204)
  ack(@UuidParam() id: string): void {
    // Acknowledged; nothing to return (a bodiless POST).
    if (id === '') throw new Error('unreachable: the id was validated');
  }

  @Public()
  @Post('conflict')
  conflict(): never {
    throw new ConflictError('MMSI already registered', {
      code: 'MMSI_ALREADY_EXISTS',
    });
  }

  @Public()
  @Get('crash')
  crash(): never {
    throw new Error('database password is hunter2');
  }

  @RequirePlatformAdmin()
  @AllowApiKey('ais:ingest')
  @ApiOperation({
    summary: 'Republish',
    description: 'Re-sends every snapshot.',
  })
  @Post('republish')
  @HttpCode(202)
  republish(@CurrentPrincipal() principal: Principal): {
    readonly republishedBy: string;
  } {
    return { republishedBy: principal.id };
  }

  @AllowApiKey('ais:ingest')
  @RequirePermissions('telemetry:write')
  @Post('ingest')
  @HttpCode(202)
  ingest(@CurrentPrincipal() principal: Principal): {
    readonly kind: string;
    readonly orgId: string | null;
  } {
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
