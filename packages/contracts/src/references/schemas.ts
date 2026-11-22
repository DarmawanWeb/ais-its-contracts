import * as z from 'zod';

import {
  type Locale,
  type LocalizedText,
  LocalizedTextSchema,
} from '../domain/locale.js';
import {
  type OpenVocabulary,
  openVocabularySchema,
} from '../domain/vocabulary.js';
import { MethodIdSchema, ReferenceIdSchema } from './ids.js';

/** Narrows `value` to a key of `labels`. */
function hasLabel<Known extends string>(
  labels: Readonly<Record<Known, LocalizedText>>,
  value: string,
): value is Known {
  return Object.hasOwn(labels, value);
}

/** Label of a value of an open vocabulary; unknown values are shown as is. */
function vocabularyLabel<Known extends string>(
  labels: Readonly<Record<Known, LocalizedText>>,
  value: string,
  locale: Locale,
): string {
  return hasLabel(labels, value) ? labels[value][locale] : value;
}

/** Kinds of sources known to this version (the vocabulary is open). */
export const REFERENCE_TYPES = [
  'regulation',
  'guideline',
  'standard',
  'paper',
  'book',
  'thesis',
  'report',
  'dataset',
  'software',
  'website',
  'legacy_code',
] as const;

/** A kind of source known to this version. */
export type KnownReferenceType = (typeof REFERENCE_TYPES)[number];

/** A kind of source (open vocabulary). */
export type ReferenceType = OpenVocabulary<KnownReferenceType>;

/** Zod schema of {@link ReferenceType}. */
export const ReferenceTypeSchema = openVocabularySchema(
  REFERENCE_TYPES,
  'Kind of source, e.g. regulation, standard, paper, thesis',
);

/** Labels of the known kinds of sources. */
export const REFERENCE_TYPE_LABELS: Readonly<
  Record<KnownReferenceType, LocalizedText>
> = {
  regulation: { en: 'Regulation', id: 'Regulasi' },
  guideline: { en: 'Guideline', id: 'Pedoman' },
  standard: { en: 'Standard', id: 'Standar' },
  paper: { en: 'Scientific paper', id: 'Artikel ilmiah' },
  book: { en: 'Book', id: 'Buku' },
  thesis: { en: 'Thesis', id: 'Tesis / skripsi' },
  report: { en: 'Report', id: 'Laporan' },
  dataset: { en: 'Dataset', id: 'Dataset' },
  software: { en: 'Software', id: 'Perangkat lunak' },
  website: { en: 'Website', id: 'Situs web' },
  legacy_code: { en: 'Legacy code (MVP)', id: 'Kode lama (MVP)' },
};

/** Label of a kind of source; unknown kinds are shown by their id. */
export function referenceTypeLabel(
  type: ReferenceType,
  locale: Locale = 'en',
): string {
  return vocabularyLabel(REFERENCE_TYPE_LABELS, type, locale);
}

/** How far a reference was checked against the source (open vocabulary). */
export const REFERENCE_VERIFICATIONS = [
  'verified',
  'partially_verified',
  'unverified',
] as const;

/** A verification status known to this version. */
export type KnownReferenceVerification =
  (typeof REFERENCE_VERIFICATIONS)[number];

/** A verification status (open vocabulary). */
export type ReferenceVerification = OpenVocabulary<KnownReferenceVerification>;

/** Zod schema of {@link ReferenceVerification}. */
export const ReferenceVerificationSchema = openVocabularySchema(
  REFERENCE_VERIFICATIONS,
  'How far the reference was checked against the source, e.g. verified',
);

/** Labels of the known verification statuses. */
export const REFERENCE_VERIFICATION_LABELS: Readonly<
  Record<KnownReferenceVerification, LocalizedText>
> = {
  verified: { en: 'Verified against the source', id: 'Terverifikasi' },
  partially_verified: {
    en: 'Partially verified',
    id: 'Terverifikasi sebagian',
  },
  unverified: { en: 'Not verified', id: 'Belum terverifikasi' },
};

/** Label of a verification status; unknown statuses are shown by their id. */
export function referenceVerificationLabel(
  verification: ReferenceVerification,
  locale: Locale = 'en',
): string {
  return vocabularyLabel(REFERENCE_VERIFICATION_LABELS, verification, locale);
}

/**
 * Domains of the methods known to this version (open vocabulary):
 * `notification` covers the alert inbox, alert rules and deliveries,
 * `security` the authentication and authorization rules.
 */
export const METHOD_DOMAINS = [
  'ais',
  'emission',
  'seemp',
  'telemetry',
  'geo',
  'safety',
  'surveillance',
  'notification',
  'security',
] as const;

/** A method domain known to this version. */
export type KnownMethodDomain = (typeof METHOD_DOMAINS)[number];

/** A method domain (open vocabulary). */
export type MethodDomain = OpenVocabulary<KnownMethodDomain>;

/** Zod schema of {@link MethodDomain}. */
export const MethodDomainSchema = openVocabularySchema(
  METHOD_DOMAINS,
  'Domain of the method, e.g. emission, safety, surveillance, notification',
);

/** Labels of the known method domains. */
export const METHOD_DOMAIN_LABELS: Readonly<
  Record<KnownMethodDomain, LocalizedText>
> = {
  ais: { en: 'AIS processing', id: 'Pengolahan AIS' },
  emission: { en: 'Fuel, emission and CII', id: 'Bahan bakar, emisi dan CII' },
  seemp: { en: 'SEEMP', id: 'SEEMP' },
  telemetry: { en: 'Telemetry', id: 'Telemetri' },
  geo: { en: 'Geospatial', id: 'Geospasial' },
  safety: { en: 'Navigational safety', id: 'Keselamatan navigasi' },
  surveillance: { en: 'Surveillance', id: 'Pengawasan' },
  notification: { en: 'Notification', id: 'Notifikasi' },
  security: { en: 'Security', id: 'Keamanan' },
};

/** Label of a method domain; unknown domains are shown by their id. */
export function methodDomainLabel(
  domain: MethodDomain,
  locale: Locale = 'en',
): string {
  return vocabularyLabel(METHOD_DOMAIN_LABELS, domain, locale);
}

/**
 * Lifecycle statuses of methods known to this version (open vocabulary):
 * `implemented` (code carrying the method's `@method` tag exists),
 * `planned` (to be implemented by its owner), `not_implemented`
 * (deliberately not carried into the platform, e.g. a display-only rule of
 * the legacy MVP) and `deprecated` (superseded, kept for traceability).
 */
export const METHOD_STATUSES = [
  'implemented',
  'planned',
  'not_implemented',
  'deprecated',
] as const;

/** A method status known to this version. */
export type KnownMethodStatus = (typeof METHOD_STATUSES)[number];

/** A method status (open vocabulary). */
export type MethodStatus = OpenVocabulary<KnownMethodStatus>;

/** Zod schema of {@link MethodStatus}. */
export const MethodStatusSchema = openVocabularySchema(
  METHOD_STATUSES,
  'Lifecycle of the method, e.g. implemented, planned, not_implemented, deprecated',
);

/** Labels of the known method statuses. */
export const METHOD_STATUS_LABELS: Readonly<
  Record<KnownMethodStatus, LocalizedText>
> = {
  implemented: { en: 'Implemented', id: 'Diimplementasikan' },
  planned: { en: 'Planned', id: 'Direncanakan' },
  not_implemented: { en: 'Not implemented', id: 'Tidak diimplementasikan' },
  deprecated: { en: 'Deprecated', id: 'Tidak digunakan lagi' },
};

/** Label of a method status; unknown statuses are shown by their id. */
export function methodStatusLabel(
  status: MethodStatus,
  locale: Locale = 'en',
): string {
  return vocabularyLabel(METHOD_STATUS_LABELS, status, locale);
}

const optionalText = (description: string) =>
  z.string().min(1).nullable().default(null).describe(description);

/**
 * Zod schema of a reference of the methodology catalog
 * (`docs/references/references.json`, spec 17). Optional members default to
 * `null`.
 */
export const ReferenceSchema = z
  .object({
    id: ReferenceIdSchema,
    type: ReferenceTypeSchema,
    title: z.string().min(1),
    issuerOrAuthors: z
      .string()
      .min(1)
      .describe('Issuing body or authors, e.g. "IMO MEPC"'),
    year: z
      .int()
      .min(1000)
      .max(9999)
      .nullable()
      .default(null)
      .describe('Year of publication or adoption'),
    identifier: optionalText(
      'DOI, ISBN, resolution or standard number, e.g. "MEPC.353(78)"',
    ),
    url: z
      .url()
      .regex(/^https?:\/\//, { message: 'Expected an http(s) URL' })
      .nullable()
      .default(null)
      .describe('Where the source can be consulted'),
    license: optionalText('License or terms of use, e.g. "CC BY 4.0"'),
    accessed: z.iso
      .date()
      .nullable()
      .default(null)
      .describe('When the URL was last accessed (YYYY-MM-DD)'),
    verification: ReferenceVerificationSchema,
    notes: optionalText('Remarks, e.g. which section is used'),
  })
  .meta({
    title: 'Reference',
    description:
      'A source (regulation, standard, paper, …) cited by the methods of the methodology catalog.',
  });

/** A reference of the methodology catalog. */
export type Reference = z.output<typeof ReferenceSchema>;

/** A reference as written in `references.json` (optional members may be omitted). */
export type ReferenceInput = z.input<typeof ReferenceSchema>;

const unit = () =>
  z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .describe('Unit, e.g. "nm" or "g/kWh"; null when dimensionless');

/** Zod schema of a variable of a method. */
export const MethodVariableSchema = z
  .object({
    symbol: z.string().min(1).describe('Symbol as written in formulaLatex'),
    name: LocalizedTextSchema,
    unit: unit(),
  })
  .describe('Variable of a method');

/** A variable of a method. */
export type MethodVariable = z.output<typeof MethodVariableSchema>;

/** Zod schema of a constant, coefficient or threshold of a method. */
export const MethodConstantSchema = z
  .object({
    symbol: z.string().min(1).describe('Symbol as written in formulaLatex'),
    name: LocalizedTextSchema,
    value: z
      .union([z.number(), z.string().min(1)])
      .describe('Value; text for tables, vectors or expressions'),
    unit: unit(),
    referenceIds: z
      .array(ReferenceIdSchema)
      .default([])
      .describe('Sources of the value'),
    needsCitation: z
      .boolean()
      .default(false)
      .describe('The value has no verified external source yet'),
  })
  .describe('Constant, coefficient or threshold of a method');

/** A constant, coefficient or threshold of a method. */
export type MethodConstant = z.output<typeof MethodConstantSchema>;

/** Zod schema of where a method is implemented. */
export const MethodImplementationSchema = z
  .object({
    service: z
      .string()
      .min(1)
      .describe('Service or package, e.g. "emission" or "contracts"'),
    module: z
      .string()
      .min(1)
      .describe('Module or symbol, e.g. "src/domain/cii.ts#attainedCii"'),
  })
  .describe('Implementation of the method');

/** Where a method is implemented. */
export type MethodImplementation = z.output<typeof MethodImplementationSchema>;

/**
 * Zod schema of a method of the methodology catalog
 * (`docs/references/methods.json`, spec 17): a formula, empirical constant,
 * threshold or rule with its sources. Optional members default to `null`,
 * `[]` or `false`.
 */
export const MethodSchema = z
  .object({
    id: MethodIdSchema,
    domain: MethodDomainSchema,
    name: LocalizedTextSchema,
    summary: LocalizedTextSchema,
    formulaLatex: optionalText(
      'Equation in LaTeX (rendered with KaTeX); null for rules without one',
    ),
    variables: z.array(MethodVariableSchema).default([]),
    constants: z.array(MethodConstantSchema).default([]),
    referenceIds: z
      .array(ReferenceIdSchema)
      .default([])
      .describe('Sources of the method'),
    implementedBy: MethodImplementationSchema.nullable().default(null),
    legacy: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Legacy MVP implementations kept in parity, e.g. "be-legacy/src/utils/calculate-ews.ts#checkShipStatus"',
      ),
    status: MethodStatusSchema,
    needsCitation: z
      .boolean()
      .default(false)
      .describe(
        'Values come from the thesis without a verified external source',
      ),
    notes: LocalizedTextSchema.nullable().default(null),
  })
  .meta({
    title: 'Method',
    description:
      'A formula, empirical constant, threshold or rule of the platform with its sources (methodology catalog).',
  });

/** A method of the methodology catalog. */
export type Method = z.output<typeof MethodSchema>;

/** A method as written in `methods.json` (optional members may be omitted). */
export type MethodInput = z.input<typeof MethodSchema>;
