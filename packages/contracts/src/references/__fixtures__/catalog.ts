import type { MethodInput, ReferenceInput } from '../schemas.js';

/** A small, realistic methodology catalog as written in `docs/references`. */
export const CATALOG_REFERENCES: readonly ReferenceInput[] = [
  {
    id: 'imo-mepc-353-78',
    type: 'regulation',
    title:
      '2022 Guidelines on the reference lines for use with operational carbon intensity indicators (CII reference lines guidelines, G2)',
    issuerOrAuthors: 'IMO Marine Environment Protection Committee',
    year: 2022,
    identifier: 'Resolution MEPC.353(78)',
    url: 'https://www.imo.org/en/OurWork/Environment/Pages/Air-Pollution.aspx',
    license: null,
    accessed: '2026-11-20',
    verification: 'verified',
    notes:
      'Table 1 (parameters a and c) and the capacity of bulk carriers >= 279 000 DWT.',
  },
  {
    id: 'imo-mepc-338-76',
    type: 'regulation',
    title:
      '2021 Guidelines on the operational carbon intensity reduction factors relative to reference lines (G3)',
    issuerOrAuthors: 'IMO Marine Environment Protection Committee',
    year: 2021,
    identifier: 'Resolution MEPC.338(76)',
    verification: 'verified',
  },
  {
    id: 'legacy-be-calculate-ews',
    type: 'legacy_code',
    title: 'checkShipStatus (pipeline EWS) of the MVP backend',
    issuerOrAuthors: 'ais-its-cii-seemp-be',
    identifier: 'src/utils/calculate-ews.ts',
    verification: 'verified',
  },
];

/** Methods citing {@link CATALOG_REFERENCES}. */
export const CATALOG_METHODS: readonly MethodInput[] = [
  {
    id: 'cii.required',
    domain: 'emission',
    name: { id: 'CII yang disyaratkan', en: 'Required CII' },
    summary: {
      id: 'Garis referensi jenis kapal dikurangi faktor reduksi Z tahun berjalan.',
      en: 'Reference line of the ship type reduced by the factor Z of the year.',
    },
    formulaLatex:
      '\\mathrm{CII}_{req} = \\left(1 - \\frac{Z}{100}\\right) a \\cdot \\mathrm{Capacity}^{-c}',
    variables: [
      {
        symbol: 'Z',
        name: { id: 'Faktor reduksi', en: 'Reduction factor' },
        unit: '%',
      },
      { symbol: 'a', name: { id: 'Parameter a', en: 'Parameter a' } },
    ],
    constants: [
      {
        symbol: 'Z_{2026}',
        name: { id: 'Faktor reduksi 2026', en: 'Reduction factor 2026' },
        value: 11,
        unit: '%',
        referenceIds: ['imo-mepc-338-76'],
      },
    ],
    referenceIds: ['imo-mepc-353-78', 'imo-mepc-338-76'],
    implementedBy: { service: 'emission', module: 'src/domain/cii.ts' },
    status: 'implemented',
  },
  {
    id: 'ews.status',
    domain: 'safety',
    name: { id: 'Status EWS pipa', en: 'Pipeline EWS status' },
    summary: {
      id: 'Kapal diprediksi berlabuh jangkar dekat pipa: bahaya < 500 m, peringatan < 1.750 m.',
      en: 'Vessel predicted at anchor near the pipeline: danger < 500 m, warning < 1 750 m.',
    },
    constants: [
      {
        symbol: 'd_{danger}',
        name: { id: 'Jarak bahaya', en: 'Danger distance' },
        value: 500,
        unit: 'm',
        needsCitation: true,
      },
    ],
    referenceIds: ['legacy-be-calculate-ews'],
    implementedBy: { service: 'safety', module: 'src/detectors/ews' },
    legacy: ['be-legacy/src/utils/calculate-ews.ts#checkShipStatus'],
    status: 'implemented',
    needsCitation: true,
    notes: {
      id: 'Ambang dari tesis; perlu sitasi eksternal.',
      en: 'Thresholds from the thesis; need an external citation.',
    },
  },
  {
    id: 'collision.cpa-tcpa',
    domain: 'safety',
    name: { id: 'Risiko tubrukan (CPA/TCPA)', en: 'Collision risk (CPA/TCPA)' },
    summary: {
      id: 'Pita risiko dari jarak dan waktu titik pendekatan terdekat.',
      en: 'Risk bands from the distance and time of the closest point of approach.',
    },
    status: 'planned',
    needsCitation: true,
  },
];
