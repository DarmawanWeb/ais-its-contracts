import * as z from 'zod';

/** Transactional e-mail templates rendered by the notification service. */
export const EMAIL_TEMPLATES = [
  'password_reset',
  'account_invite',
  'alert',
  'test',
] as const;

/** An e-mail template name. */
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/** Zod schema of {@link EmailTemplate}. */
export const EmailTemplateSchema = z
  .enum(EMAIL_TEMPLATES)
  .describe('E-mail template');

/** Delivery channels of alert rules. */
export const NOTIFICATION_CHANNELS = ['email', 'telegram', 'webhook'] as const;

/** An alert delivery channel. */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Zod schema of {@link NotificationChannel}. */
export const NotificationChannelSchema = z
  .enum(NOTIFICATION_CHANNELS)
  .describe('Alert delivery channel');
