import {
  ALERT_DOMAINS,
  type AlertDomain,
} from '@darmawanweb/ais-its-contracts/domain';
import { applyDecorators } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  getSchemaPath,
} from '@nestjs/swagger';

import type { DetectorDescription } from './detector-registry.js';

/**
 * OpenAPI model of one entry of `GET /<service>/detectors` (spec §13.7,
 * §13.8): a {@link DetectorDescription} as returned by
 * `DetectorRegistry.describe()`.
 */
export class DetectorDescriptionDto implements DetectorDescription {
  @ApiProperty({
    example: 'ews',
    description: 'Detector id (`DETECTORS` entry)',
  })
  readonly id: string;

  @ApiProperty({ enum: ALERT_DOMAINS })
  readonly domain: AlertDomain;

  @ApiProperty({
    type: [String],
    example: ['ews.pipeline_distance_status'],
    description: 'Methodology catalog ids (spec §17)',
  })
  readonly methodIds: readonly string[];

  @ApiProperty({
    type: [String],
    nullable: true,
    example: ['ews'],
    description: 'Alert types the detector raises; null when undeclared',
  })
  readonly alertTypes: readonly string[] | null;

  @ApiProperty({ description: 'Enabled by `DETECTORS` in this instance' })
  readonly enabled: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    example: { DANGER_M: 500, WARNING_M: 1750 },
    description:
      'Active `<ID>_*` configuration (thresholds); null when disabled',
  })
  readonly config: unknown;

  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'Tick interval of `onTick`, ms; null without ticks',
  })
  readonly tickIntervalMs: number | null;

  constructor(description: DetectorDescription) {
    this.id = description.id;
    this.domain = description.domain;
    this.methodIds = [...description.methodIds];
    this.alertTypes =
      description.alertTypes === null ? null : [...description.alertTypes];
    this.enabled = description.enabled;
    this.config = description.config;
    this.tickIntervalMs = description.tickIntervalMs;
  }
}

/**
 * Documents a `200` array of {@link DetectorDescriptionDto} (the detectors
 * endpoint of safety and surveillance).
 *
 * @example
 * @Get('detectors') @ApiDetectorsResponse()
 * detectors(): DetectorDescriptionDto[] { return this.registry.describe().map((d) => new DetectorDescriptionDto(d)); }
 */
export function ApiDetectorsResponse(
  description = 'The detectors of this service with their method ids and active thresholds',
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExtraModels(DetectorDescriptionDto),
    ApiOkResponse({
      description,
      schema: {
        type: 'array',
        items: { $ref: getSchemaPath(DetectorDescriptionDto) },
      },
    }),
  );
}
