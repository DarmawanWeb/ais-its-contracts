import * as z from 'zod';

import type { ZoneKind } from './zones.js';

/**
 * Kind-specific `properties` of zones (spec 7.4 `ZoneSnapshotV1.properties`),
 * agreed between the geo service (which writes them) and the detectors
 * (which read them). Every key is optional and unknown keys are kept, so new
 * keys can be added in a minor release without breaking older readers.
 */

/** A named point along a line zone, e.g. a pipeline kilometre point. */
export const ZoneMarkerSchema = z
  .object({
    name: z.string().min(1).describe('Marker name, e.g. "KP 29.200"'),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  })
  .describe('Named point along the zone geometry');

/** A named point along a line zone. */
export type ZoneMarker = z.infer<typeof ZoneMarkerSchema>;

const provenance = {
  source: z
    .string()
    .min(1)
    .optional()
    .describe('Provenance of the geometry, e.g. "legacy data/pipeline.json"'),
  note: z.string().optional().describe('Free-text note shown to operators'),
};

/** `pipeline`: subsea pipeline corridors (EWS). */
export const PipelineZonePropertiesSchema = z.looseObject({
  ...provenance,
  operator: z.string().min(1).optional().describe('Pipeline operator'),
  markers: z
    .array(ZoneMarkerSchema)
    .optional()
    .describe(
      'Kilometre points (KP) along the line, legacy pipeline.json "Name"',
    ),
});

/** `shallow_water`: areas with a charted depth (grounding risk). */
export const ShallowWaterZonePropertiesSchema = z.looseObject({
  ...provenance,
  depthM: z
    .number()
    .nonnegative()
    .optional()
    .describe('Least charted depth in the area, meters'),
});

/** `tss_lane`: traffic separation scheme lanes. */
export const TssLaneZonePropertiesSchema = z.looseObject({
  ...provenance,
  directionDeg: z
    .number()
    .min(0)
    .lt(360)
    .optional()
    .describe('Prescribed direction of traffic, degrees true'),
  maxSpeedKn: z.number().positive().optional().describe('Speed limit, knots'),
});

/** `port` and `anchorage`: harbour areas (dark-vessel exclusions, anchor watch). */
export const HarbourZonePropertiesSchema = z.looseObject({
  ...provenance,
  unlocode: z
    .string()
    .regex(/^[A-Z]{2}[A-Z2-9]{3}$/)
    .optional()
    .describe('UN/LOCODE, e.g. "IDBTM"'),
  maxDraughtM: z
    .number()
    .positive()
    .optional()
    .describe('Largest permitted draught, meters'),
});

/** `fishing_ground`, `mpa`, `restricted`, `transhipment_area`, `custom`. */
export const AreaZonePropertiesSchema = z.looseObject({
  ...provenance,
  authority: z
    .string()
    .min(1)
    .optional()
    .describe('Authority that designated the area'),
  legalBasis: z
    .string()
    .min(1)
    .optional()
    .describe('Regulation designating the area'),
});

/** The property schema of every zone kind. */
export const ZONE_PROPERTY_SCHEMAS = {
  pipeline: PipelineZonePropertiesSchema,
  transhipment_area: AreaZonePropertiesSchema,
  fishing_ground: AreaZonePropertiesSchema,
  mpa: AreaZonePropertiesSchema,
  restricted: AreaZonePropertiesSchema,
  anchorage: HarbourZonePropertiesSchema,
  port: HarbourZonePropertiesSchema,
  tss_lane: TssLaneZonePropertiesSchema,
  shallow_water: ShallowWaterZonePropertiesSchema,
  custom: AreaZonePropertiesSchema,
} as const satisfies Record<ZoneKind, z.ZodType>;

/** Typed `properties` of a zone of kind `Kind`. */
export type ZoneProperties<Kind extends ZoneKind = ZoneKind> = z.output<
  (typeof ZONE_PROPERTY_SCHEMAS)[Kind]
>;

/**
 * Reads the `properties` of a zone with the schema of its kind. Lenient, as
 * detectors must keep working on data written by other versions: a known key
 * whose value is invalid is dropped (it reads as missing); unknown keys are
 * kept.
 *
 * @example
 * const { depthM } = zoneProperties(zone); // zone.kind === 'shallow_water'
 */
export function zoneProperties<Kind extends ZoneKind>(zone: {
  readonly kind: Kind;
  readonly properties: Readonly<Record<string, unknown>>;
}): ZoneProperties<Kind> {
  const schema: z.ZodType = ZONE_PROPERTY_SCHEMAS[zone.kind];
  const candidate: Record<string, unknown> = { ...zone.properties };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = schema.safeParse(candidate);
    // `schema` is the schema of `Kind`.
    if (result.success) return result.data as ZoneProperties<Kind>;
    for (const issue of result.error.issues) {
      const [key] = issue.path;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- dropping an invalid key
      if (typeof key === 'string') delete candidate[key];
    }
  }
  return {} as ZoneProperties<Kind>;
}
