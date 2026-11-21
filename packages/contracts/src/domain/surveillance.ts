import * as z from 'zod';

import type { LocalizedText } from './locale.js';

/**
 * Review lifecycle of a surveillance event (`surveillance.events.status`,
 * spec 13.8); reviewers with `surveillance:review` confirm or dismiss events.
 */
export const SURVEILLANCE_EVENT_STATUSES = [
  'open',
  'confirmed',
  'dismissed',
  'resolved',
] as const;

/** A surveillance event status. */
export type SurveillanceEventStatus =
  (typeof SURVEILLANCE_EVENT_STATUSES)[number];

/** Zod schema of {@link SurveillanceEventStatus}. */
export const SurveillanceEventStatusSchema = z
  .enum(SURVEILLANCE_EVENT_STATUSES)
  .describe('Surveillance event review status');

/** Labels of every surveillance event status. */
export const SURVEILLANCE_EVENT_STATUS_LABELS: Readonly<
  Record<SurveillanceEventStatus, LocalizedText>
> = {
  open: { en: 'Open', id: 'Terbuka' },
  confirmed: { en: 'Confirmed', id: 'Terkonfirmasi' },
  dismissed: { en: 'Dismissed', id: 'Diabaikan' },
  resolved: { en: 'Resolved', id: 'Selesai' },
};
