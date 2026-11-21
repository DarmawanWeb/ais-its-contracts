import * as z from 'zod';

import { LocaleSchema } from '../../domain/locale.js';
import { EmailTemplateSchema } from '../../domain/notification.js';

/** Payload of `notify.email.requested.v1`: a transactional e-mail to send. */
export const EmailRequestedV1Schema = z
  .object({
    to: z.email().describe('Recipient address'),
    template: EmailTemplateSchema,
    locale: LocaleSchema,
    data: z
      .record(z.string(), z.unknown())
      .describe('Template variables, e.g. { link } for password_reset'),
  })
  .meta({
    title: 'EmailRequestedV1',
    description: 'Request to render and send a transactional e-mail.',
  });

/** Payload of `notify.email.requested.v1`. */
export type EmailRequestedV1 = z.infer<typeof EmailRequestedV1Schema>;
