import { describe, expect, it } from 'vitest';

import { CATALOG_METHODS, CATALOG_REFERENCES } from './__fixtures__/catalog.js';
import {
  CATALOG_ISSUE_CODES,
  createMethodologyIndex,
  type MethodologyCatalog,
  validateCatalog,
} from './catalog.js';
import { CATALOG_ID_PATTERN, isCatalogId, MethodIdSchema } from './ids.js';
import {
  getMethod,
  getReference,
  METHODS,
  methodsByDomain,
  REFERENCES,
  referencesOfMethod,
} from './lookup.js';
import {
  METHOD_DOMAINS,
  methodDomainLabel,
  methodStatusLabel,
  referenceTypeLabel,
  referenceVerificationLabel,
} from './schemas.js';

const valid = (): MethodologyCatalog => {
  const result = validateCatalog({
    references: CATALOG_REFERENCES,
    methods: CATALOG_METHODS,
  });
  if (!result.success) throw new Error(JSON.stringify(result.issues));
  return result.catalog;
};

const issuesOf = (references: unknown, methods: unknown) => {
  const result = validateCatalog({ references, methods });
  return result.success ? [] : result.issues;
};

describe('validateCatalog', () => {
  it('accepts a valid catalog and fills in the defaults', () => {
    const catalog = valid();
    expect(catalog.references.map((reference) => reference.id)).toEqual([
      'imo-mepc-353-78',
      'imo-mepc-338-76',
      'legacy-be-calculate-ews',
    ]);
    expect(catalog.references[1]).toMatchObject({
      url: null,
      license: null,
      accessed: null,
      notes: null,
    });
    expect(catalog.methods[2]).toMatchObject({
      formulaLatex: null,
      variables: [],
      constants: [],
      referenceIds: [],
      implementedBy: null,
      legacy: [],
      notes: null,
    });
    expect(catalog.methods[0]?.variables[1]?.unit).toBeNull();
    expect(catalog.methods[0]?.constants[0]?.needsCitation).toBe(false);
  });

  it('rejects dangling referenceIds of methods and of constants', () => {
    const methods = [
      {
        ...CATALOG_METHODS[0],
        referenceIds: ['imo-mepc-353-78', 'imo-mepc-999'],
      },
      {
        ...CATALOG_METHODS[1],
        constants: [
          {
            symbol: 'd',
            name: { id: 'Jarak', en: 'Distance' },
            value: 500,
            referenceIds: ['missing-source'],
          },
        ],
      },
    ];
    expect(issuesOf(CATALOG_REFERENCES, methods)).toEqual([
      {
        field: 'methods.0.referenceIds.1',
        message:
          'Unknown reference "imo-mepc-999" cited by method "cii.required"',
        code: CATALOG_ISSUE_CODES.UNKNOWN_REFERENCE,
      },
      {
        field: 'methods.1.constants.0.referenceIds.0',
        message:
          'Unknown reference "missing-source" cited by method "ews.status"',
        code: CATALOG_ISSUE_CODES.UNKNOWN_REFERENCE,
      },
    ]);
  });

  it('rejects duplicate ids', () => {
    const issues = issuesOf(
      [...CATALOG_REFERENCES, CATALOG_REFERENCES[0]],
      [...CATALOG_METHODS, CATALOG_METHODS[1]],
    );
    expect(issues.map((issue) => [issue.field, issue.code])).toEqual([
      ['references.3.id', 'duplicate_id'],
      ['methods.3.id', 'duplicate_id'],
    ]);
  });

  it('requires every method to cite a source or be marked needsCitation', () => {
    const issues = issuesOf(CATALOG_REFERENCES, [
      { ...CATALOG_METHODS[2], needsCitation: false },
    ]);
    expect(issues).toEqual([
      expect.objectContaining({
        field: 'methods.0.referenceIds',
        code: CATALOG_ISSUE_CODES.MISSING_REFERENCE,
      }),
    ]);
  });

  it('reports schema violations with their paths', () => {
    const issues = issuesOf(
      [{ ...CATALOG_REFERENCES[0], url: 'ftp://example.com', year: 'twenty' }],
      [
        { ...CATALOG_METHODS[0], id: 'CII Required' },
        { ...CATALOG_METHODS[1], name: { en: 'EWS' } },
        { ...CATALOG_METHODS[2], status: undefined },
      ],
    );
    expect(issues.map((issue) => issue.field).sort()).toEqual(
      [
        'references.0.url',
        'references.0.year',
        'methods.0.id',
        'methods.1.name.id',
        'methods.2.status',
      ].sort(),
    );
    expect(issuesOf('not an array', [])).toEqual([
      expect.objectContaining({ field: 'references' }),
    ]);
  });

  it('accepts future vocabulary values (open domains, types and statuses)', () => {
    const catalog = validateCatalog({
      references: [{ ...CATALOG_REFERENCES[0], type: 'conference_paper' }],
      methods: [
        { ...CATALOG_METHODS[2], domain: 'weather', status: 'experimental' },
      ],
    });
    expect(catalog.success).toBe(true);
    expect(
      validateCatalog({
        references: [{ ...CATALOG_REFERENCES[0], type: 'Conference Paper' }],
        methods: [],
      }).success,
    ).toBe(false);
  });

  it('validates the catalog shipped with this version', () => {
    expect(
      validateCatalog({ references: REFERENCES, methods: METHODS }),
    ).toEqual({
      success: true,
      catalog: { references: REFERENCES, methods: METHODS },
    });
  });
});

describe('createMethodologyIndex', () => {
  const index = createMethodologyIndex(valid());

  it('looks up methods and references by id', () => {
    expect(index.getMethod('ews.status')?.name.en).toBe('Pipeline EWS status');
    expect(index.getMethod('cii.unknown')).toBeUndefined();
    expect(index.getReference('imo-mepc-338-76')?.identifier).toBe(
      'Resolution MEPC.338(76)',
    );
    expect(index.getReference('nope')).toBeUndefined();
  });

  it('filters methods by domain in catalog order', () => {
    expect(index.methodsByDomain('safety').map((method) => method.id)).toEqual([
      'ews.status',
      'collision.cpa-tcpa',
    ]);
    expect(index.methodsByDomain('seemp')).toEqual([]);
  });

  it('resolves the references of a method and of its constants once', () => {
    expect(
      index.referencesOfMethod('cii.required').map((reference) => reference.id),
    ).toEqual(['imo-mepc-353-78', 'imo-mepc-338-76']);
    expect(index.referencesOfMethod('collision.cpa-tcpa')).toEqual([]);
    expect(index.referencesOfMethod('unknown')).toEqual([]);
  });
});

describe('shipped catalog lookups', () => {
  it('answers from REFERENCES and METHODS', () => {
    expect(Array.isArray(REFERENCES)).toBe(true);
    expect(Array.isArray(METHODS)).toBe(true);
    for (const method of METHODS) {
      expect(getMethod(method.id)).toBe(method);
      expect(methodsByDomain(method.domain)).toContain(method);
    }
    for (const reference of REFERENCES) {
      expect(getReference(reference.id)).toBe(reference);
    }
    expect(getMethod('no.such-method')).toBeUndefined();
    expect(getReference('no-such-reference')).toBeUndefined();
    expect(referencesOfMethod('no.such-method')).toEqual([]);
  });
});

describe('catalog ids and labels', () => {
  it('accepts dotted, dashed and underscored lowercase ids', () => {
    for (const id of [
      'cii.attained',
      'imo-mepc-353-78',
      'fuel.first_formula',
      'r2',
    ]) {
      expect(isCatalogId(id), id).toBe(true);
      expect(MethodIdSchema.safeParse(id).success).toBe(true);
    }
    for (const id of [
      'CII',
      'cii..attained',
      '.cii',
      'cii.',
      'cii attained',
      '',
    ]) {
      expect(CATALOG_ID_PATTERN.test(id), id).toBe(false);
    }
  });

  it('labels known vocabulary values and shows unknown ones as is', () => {
    expect(METHOD_DOMAINS).toContain('safety');
    expect(methodDomainLabel('safety', 'id')).toBe('Keselamatan navigasi');
    expect(methodDomainLabel('weather')).toBe('weather');
    expect(methodStatusLabel('planned', 'id')).toBe('Direncanakan');
    expect(referenceTypeLabel('regulation')).toBe('Regulation');
    expect(referenceTypeLabel('toString')).toBe('toString');
    expect(referenceVerificationLabel('unverified', 'id')).toBe(
      'Belum terverifikasi',
    );
  });
});
