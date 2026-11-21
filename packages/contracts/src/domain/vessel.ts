import * as z from 'zod';

import type { LocalizedText } from './locale.js';

/** Operational status of a vessel in the fleet registry. */
export const VESSEL_STATUSES = ['active', 'inactive', 'laid_up'] as const;

/** A vessel status. */
export type VesselStatus = (typeof VESSEL_STATUSES)[number];

/** Zod schema of {@link VesselStatus}. */
export const VesselStatusSchema = z
  .enum(VESSEL_STATUSES)
  .describe('Vessel status');

/** Labels of every vessel status. */
export const VESSEL_STATUS_LABELS: Readonly<
  Record<VesselStatus, LocalizedText>
> = {
  active: { en: 'Active', id: 'Aktif' },
  inactive: { en: 'Inactive', id: 'Tidak aktif' },
  laid_up: { en: 'Laid up', id: 'Tidak beroperasi (laid up)' },
};

/** Capacity units of the CII reference lines: deadweight or gross tonnage. */
export const CAPACITY_UNITS = ['DWT', 'GT'] as const;

/** A capacity unit. */
export type CapacityUnit = (typeof CAPACITY_UNITS)[number];

/** Zod schema of {@link CapacityUnit}. */
export const CapacityUnitSchema = z
  .enum(CAPACITY_UNITS)
  .describe('Capacity unit of the CII reference line');

/** Kinds of engines in the reference catalogue. */
export const ENGINE_KINDS = ['main', 'auxiliary'] as const;

/** An engine kind. */
export type EngineKind = (typeof ENGINE_KINDS)[number];

/** Zod schema of {@link EngineKind}. */
export const EngineKindSchema = z.enum(ENGINE_KINDS).describe('Engine kind');
