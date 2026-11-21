import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { MmsiSchema } from '../../domain/ais.js';
import { DdVectorSchema } from '../../domain/cii.js';
import { UuidSchema } from '../../domain/id.js';
import { CapacityUnitSchema, VesselStatusSchema } from '../../domain/vessel.js';

const nonNegative = (description: string) =>
  z.number().nonnegative().describe(description);

/** Principal dimensions and Holtrop coefficients of a vessel. */
export const VesselDimensionsSchema = z
  .object({
    capacity: z
      .number()
      .positive()
      .describe('CII capacity (DWT or GT per ship type)'),
    dwt: nonNegative('Deadweight tonnage').nullable(),
    gt: nonNegative('Gross tonnage').nullable(),
    cb: nonNegative('Block coefficient'),
    lwl: nonNegative('Length on waterline, m'),
    b: nonNegative('Breadth, m'),
    t: nonNegative('Draught, m'),
    cwp: nonNegative('Waterplane area coefficient'),
    loa: nonNegative('Length overall, m'),
    lpp: nonNegative('Length between perpendiculars, m'),
    cp: nonNegative('Prismatic coefficient'),
    cm: nonNegative('Midship section coefficient'),
    cbnsp: nonNegative('Block coefficient at service draught'),
    bulbousBow: z.boolean(),
    cstern: z.number().describe('Holtrop stern shape coefficient'),
    c1: z.number().describe('Holtrop coefficient c1'),
    c2: z.number().describe('Holtrop coefficient c2'),
    c3: z.number().describe('Holtrop coefficient c3'),
    c5: z.number().describe('Holtrop coefficient c5'),
    vs: nonNegative('Service speed, kn'),
  })
  .describe('Vessel dimensions and hull coefficients');

/** Vessel dimensions and hull coefficients. */
export type VesselDimensions = z.infer<typeof VesselDimensionsSchema>;

/** Ship type with its CII reference line (MEPC.353(78)) and rating vector. */
export const VesselTypeSnapshotSchema = z
  .object({
    id: UuidSchema,
    code: z.string().min(1),
    name: z.string().min(1),
    capacityUnit: CapacityUnitSchema,
    a: z.number().positive().describe('Reference line parameter a'),
    c: z.number().describe('Reference line parameter c'),
    capacityFixed: z
      .number()
      .positive()
      .nullable()
      .optional()
      .describe(
        'Regulation-fixed CII capacity of the size band, e.g. 279 000 for bulk carriers of 279 000 DWT and above (MEPC.353(78)); used instead of dimensions.capacity when set',
      ),
    d: DdVectorSchema,
  })
  .describe('Ship type');

/** Ship type snapshot. */
export type VesselTypeSnapshot = z.infer<typeof VesselTypeSnapshotSchema>;

/** Fuel with its carbon factor. */
export const FuelSnapshotSchema = z
  .object({
    id: UuidSchema,
    code: z.string().min(1),
    name: z.string().min(1),
    carbonContent: nonNegative('Carbon content (mass fraction)'),
    conversionFactor: z
      .number()
      .positive()
      .describe('Cf, t CO2 per t fuel (MEPC.364(79))'),
    density: z.number().positive().describe('Density, t/m³ (= kg/L)'),
  })
  .describe('Fuel');

/** Fuel snapshot. */
export type FuelSnapshot = z.infer<typeof FuelSnapshotSchema>;

/** Main engine fitted to the vessel. */
export const MainEngineSnapshotSchema = z
  .object({
    id: UuidSchema,
    name: z.string().min(1),
    rpm: nonNegative('Rated speed, rpm'),
    powerKw: nonNegative('Rated power, kW'),
    sfoc: nonNegative('Specific fuel oil consumption, g/kWh'),
    quantity: z.int().min(1).describe('Number of identical main engines'),
  })
  .describe('Main engine');

/** Main engine snapshot. */
export type MainEngineSnapshot = z.infer<typeof MainEngineSnapshotSchema>;

/** Auxiliary engine fitted to the vessel. */
export const AuxEngineSnapshotSchema = z
  .object({
    id: UuidSchema,
    name: z.string().min(1),
    rpm: nonNegative('Rated speed, rpm'),
    powerKw: nonNegative('Rated power, kW'),
    sfoc: nonNegative('Specific fuel oil consumption, g/kWh'),
  })
  .describe('Auxiliary engine');

/** Auxiliary engine snapshot. */
export type AuxEngineSnapshot = z.infer<typeof AuxEngineSnapshotSchema>;

/** First fuel formula: expressions of `speedKnot` per engine group. */
export const FirstFuelFormulaSnapshotSchema = z
  .object({
    id: UuidSchema,
    mainEngineFormula: z.string().min(1),
    auxiliaryEngineFormula: z.string().min(1),
  })
  .describe('First fuel formula (safe expressions of speedKnot)');

/** First fuel formula snapshot. */
export type FirstFuelFormulaSnapshot = z.infer<
  typeof FirstFuelFormulaSnapshotSchema
>;

/** Payload of `fleet.vessel.upserted.v1`: the full current state of a vessel. */
export const VesselSnapshotV1Schema = z
  .object({
    id: UuidSchema,
    orgId: UuidSchema.nullable().describe('Owning organization'),
    mmsi: MmsiSchema,
    imo: z.string().min(1).nullable(),
    name: z.string().min(1),
    flag: z.string().min(1).nullable(),
    builtYear: z.int().min(1800).max(2200).nullable(),
    status: VesselStatusSchema,
    annualVoyagePercentage: z
      .number()
      .min(0)
      .max(100)
      .describe('Share of the year at sea, percent'),
    dimensions: VesselDimensionsSchema,
    type: VesselTypeSnapshotSchema,
    fuel: FuelSnapshotSchema,
    mainEngine: MainEngineSnapshotSchema.nullable(),
    auxEngines: z.array(AuxEngineSnapshotSchema),
    auxEngineQuantity: z.int().nonnegative(),
    firstFuelFormula: FirstFuelFormulaSnapshotSchema.nullable(),
    portIds: z.array(UuidSchema),
    updatedAt: IsoDateTimeSchema,
  })
  .meta({
    title: 'VesselSnapshotV1',
    description:
      'Latest full snapshot of a vessel (stream FLEET keeps one message per vessel).',
  });

/** Payload of `fleet.vessel.upserted.v1`. */
export type VesselSnapshotV1 = z.infer<typeof VesselSnapshotV1Schema>;

/** Payload of `fleet.vessel.deleted.v1`. */
export const VesselDeletedV1Schema = z
  .object({
    id: UuidSchema,
    mmsi: MmsiSchema,
    orgId: UuidSchema.nullable(),
  })
  .meta({
    title: 'VesselDeletedV1',
    description: 'A vessel was deleted from the fleet registry.',
  });

/** Payload of `fleet.vessel.deleted.v1`. */
export type VesselDeletedV1 = z.infer<typeof VesselDeletedV1Schema>;
