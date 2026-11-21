import * as z from 'zod';

import { IsoDateTimeSchema } from '../../api/datetime.js';
import { MmsiSchema } from '../../domain/ais.js';
import { EwsStatusSchema } from '../../domain/ews.js';
import { UuidSchema } from '../../domain/id.js';
import { CollisionRiskSchema } from '../../domain/safety.js';
import { MethodIdSchema } from '../../references/ids.js';

/** The closest predicted encounter of a vessel with another vessel. */
export const ClosestEncounterSchema = z
  .object({
    otherMmsi: MmsiSchema.describe('The other vessel of the encounter'),
    cpaNm: z
      .number()
      .nonnegative()
      .describe('Distance at the closest point of approach (CPA), nm'),
    tcpaMin: z
      .number()
      .describe('Time to the closest point of approach (TCPA), minutes'),
  })
  .describe('Closest encounter with another vessel (CPA / TCPA)');

/** The closest predicted encounter of a vessel with another vessel. */
export type ClosestEncounter = z.infer<typeof ClosestEncounterSchema>;

/** Payload of `safety.vessel_state.updated.v1`: the safety state of a vessel. */
export const SafetyVesselStateV1Schema = z
  .object({
    mmsi: MmsiSchema,
    time: IsoDateTimeSchema.describe(
      'Time of the position the state was evaluated for',
    ),
    ewsStatus: EwsStatusSchema,
    pipelineDistanceM: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'Distance to the nearest active pipeline zone in meters; null when none is known',
      ),
    nearestPipelineZoneId: UuidSchema.nullable().describe(
      'Pipeline zone the distance refers to',
    ),
    collisionRisk: CollisionRiskSchema,
    closestEncounter: ClosestEncounterSchema.nullable(),
    methodIds: z
      .array(MethodIdSchema)
      .describe('Methodology catalog ids of the methods behind the state'),
  })
  .meta({
    title: 'SafetyVesselStateV1',
    description:
      'Latest navigational safety state of a vessel: pipeline EWS status and collision risk (stream SAFETY keeps one message per vessel). Published on every change and at most every SAFETY_STATE_HEARTBEAT_S otherwise.',
  });

/** Payload of `safety.vessel_state.updated.v1`. */
export type SafetyVesselStateV1 = z.infer<typeof SafetyVesselStateV1Schema>;
