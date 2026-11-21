import * as z from 'zod';

/** Locales of user-facing texts: `id` (Bahasa Indonesia) and `en` (English). */
export const LOCALES = ['id', 'en'] as const;

/** A supported locale. */
export type Locale = (typeof LOCALES)[number];

/** Zod schema of {@link Locale}. */
export const LocaleSchema = z.enum(LOCALES).describe('Locale of user texts');

/** A label available in every supported locale. */
export type LocalizedText = Readonly<Record<Locale, string>>;

/** Returns `true` when `value` is a supported locale. */
export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((locale) => locale === value);
}

/** Zod schema of a {@link LocalizedText}: a non-empty text per supported locale. */
export const LocalizedTextSchema = z
  .object({
    id: z.string().min(1).describe('Bahasa Indonesia'),
    en: z.string().min(1).describe('English'),
  })
  .describe('Text in Bahasa Indonesia and English');
