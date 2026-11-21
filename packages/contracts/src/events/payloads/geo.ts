import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { GeoJsonGeometrySchema } from '../../domain/geojson.js';
import { UuidSchema } from '../../domain/id.js';
import { ZoneKindSchema } from '../../domain/zones.js';

/** Payload of `geo.zone.upserted.v1`: the full current state of a zone. */
export const ZoneSnapshotV1Schema = z
  .object({
    id: UuidSchema.describe('Zone id'),
    orgId: UuidSchema.nullable().describe(
      'Owning organization; null = global zone',
    ),
    code: z
      .string()
      .min(1)
      .describe('Stable code of the zone (seeds are idempotent by code)'),
    name: z.string().min(1),
    kind: ZoneKindSchema,
    geometry: GeoJsonGeometrySchema.describe('Zone geometry, GeoJSON in WGS84'),
    bufferM: z
      .number()
      .nonnegative()
      .describe(
        'Buffer around the geometry in meters, e.g. 1 750 for the pipeline',
      ),
    active: z.boolean().describe('Inactive zones are ignored by detectors'),
    alertOnEnter: z
      .boolean()
      .describe('Raise geofence alerts when a vessel enters the zone'),
    properties: z
      .record(z.string(), z.unknown())
      .describe('Kind specific properties, e.g. the KP names of a pipeline'),
    updatedAt: IsoDateTimeSchema,
  })
  .meta({
    title: 'ZoneSnapshotV1',
    description:
      'Latest full snapshot of a zone or geofence (stream GEO keeps one message per zone).',
  });

/** Payload of `geo.zone.upserted.v1`. */
export type ZoneSnapshotV1 = z.infer<typeof ZoneSnapshotV1Schema>;

/** Payload of `geo.zone.deleted.v1`. */
export const ZoneDeletedV1Schema = z
  .object({
    id: UuidSchema.describe('Zone id'),
    orgId: UuidSchema.nullable().describe(
      'Owning organization; null = global zone',
    ),
  })
  .meta({
    title: 'ZoneDeletedV1',
    description: 'A zone was deleted from the geo registry.',
  });

/** Payload of `geo.zone.deleted.v1`. */
export type ZoneDeletedV1 = z.infer<typeof ZoneDeletedV1Schema>;
