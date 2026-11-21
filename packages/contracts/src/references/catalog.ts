import * as z from 'zod';

import { type FieldError, issuesToFieldErrors } from '../api/problem.js';
import {
  type Method,
  type MethodDomain,
  MethodSchema,
  type Reference,
  ReferenceSchema,
} from './schemas.js';

/** The methodology catalog: every reference and every method (spec 17). */
export interface MethodologyCatalog {
  readonly references: readonly Reference[];
  readonly methods: readonly Method[];
}

/** Raw catalog content, e.g. the parsed `references.json` and `methods.json`. */
export interface MethodologyCatalogInput {
  readonly references: unknown;
  readonly methods: unknown;
}

/** Machine readable codes of the catalog consistency problems. */
export const CATALOG_ISSUE_CODES = {
  /** Two references or two methods share an id. */
  DUPLICATE_ID: 'duplicate_id',
  /** A `referenceIds` entry names no reference of the catalog. */
  UNKNOWN_REFERENCE: 'unknown_reference',
  /** A method cites no reference and is not marked `needsCitation`. */
  MISSING_REFERENCE: 'missing_reference',
} as const;

/** Result of {@link validateCatalog}. */
export type CatalogValidationResult =
  | { readonly success: true; readonly catalog: MethodologyCatalog }
  | { readonly success: false; readonly issues: readonly FieldError[] };

const prefixedIssues = (
  prefix: string,
  error: z.ZodError | undefined,
): FieldError[] =>
  issuesToFieldErrors(
    (error?.issues ?? []).map((issue) => ({
      ...issue,
      path: [prefix, ...issue.path],
    })),
  );

function duplicateIdIssues(
  collection: 'references' | 'methods',
  entries: readonly { readonly id: string }[],
): FieldError[] {
  const seen = new Set<string>();
  const issues: FieldError[] = [];
  for (const [index, { id }] of entries.entries()) {
    if (seen.has(id)) {
      issues.push({
        field: `${collection}.${index}.id`,
        message: `Duplicate id "${id}"`,
        code: CATALOG_ISSUE_CODES.DUPLICATE_ID,
      });
    }
    seen.add(id);
  }
  return issues;
}

function citationIssues(
  methods: readonly Method[],
  referenceIds: ReadonlySet<string>,
): FieldError[] {
  const issues: FieldError[] = [];
  const unknown = (field: string, id: string, method: Method): void => {
    if (!referenceIds.has(id)) {
      issues.push({
        field,
        message: `Unknown reference "${id}" cited by method "${method.id}"`,
        code: CATALOG_ISSUE_CODES.UNKNOWN_REFERENCE,
      });
    }
  };
  for (const [index, method] of methods.entries()) {
    const path = `methods.${index}`;
    for (const [position, id] of method.referenceIds.entries()) {
      unknown(`${path}.referenceIds.${position}`, id, method);
    }
    for (const [
      constant,
      { referenceIds: ids },
    ] of method.constants.entries()) {
      for (const [position, id] of ids.entries()) {
        unknown(
          `${path}.constants.${constant}.referenceIds.${position}`,
          id,
          method,
        );
      }
    }
    if (method.referenceIds.length === 0 && !method.needsCitation) {
      issues.push({
        field: `${path}.referenceIds`,
        message: `Method "${method.id}" cites no reference; cite one or set needsCitation`,
        code: CATALOG_ISSUE_CODES.MISSING_REFERENCE,
      });
    }
  }
  return issues;
}

/**
 * Validates a methodology catalog: the shape of every reference and method
 * (optional members get their defaults), unique ids, no dangling
 * `referenceIds` (of methods and of their constants) and traceability — every
 * method cites a reference or is marked `needsCitation` (spec 17).
 *
 * @returns the normalized catalog, or every problem with its path (e.g.
 * `methods.3.referenceIds.0`).
 */
export function validateCatalog(
  input: MethodologyCatalogInput,
): CatalogValidationResult {
  const references = z.array(ReferenceSchema).safeParse(input.references);
  const methods = z.array(MethodSchema).safeParse(input.methods);
  if (!references.success || !methods.success) {
    return {
      success: false,
      issues: [
        ...prefixedIssues('references', references.error),
        ...prefixedIssues('methods', methods.error),
      ],
    };
  }
  const issues = [
    ...duplicateIdIssues('references', references.data),
    ...duplicateIdIssues('methods', methods.data),
    ...citationIssues(
      methods.data,
      new Set(references.data.map((reference) => reference.id)),
    ),
  ];
  return issues.length > 0
    ? { success: false, issues }
    : {
        success: true,
        catalog: { references: references.data, methods: methods.data },
      };
}

/** Lookups over a methodology catalog. */
export interface MethodologyIndex extends MethodologyCatalog {
  /** The reference with `id`, or `undefined`. */
  getReference(id: string): Reference | undefined;
  /** The method with `id`, or `undefined`. */
  getMethod(id: string): Method | undefined;
  /** Methods of a domain, in catalog order. */
  methodsByDomain(domain: MethodDomain): readonly Method[];
  /**
   * References cited by a method and by its constants, in citation order
   * without duplicates; empty for an unknown method.
   */
  referencesOfMethod(methodId: string): readonly Reference[];
}

/** Builds the lookups of a catalog (ids are indexed once). */
export function createMethodologyIndex(
  catalog: MethodologyCatalog,
): MethodologyIndex {
  const referencesById = new Map(
    catalog.references.map((reference) => [reference.id, reference]),
  );
  const methodsById = new Map(
    catalog.methods.map((method) => [method.id, method]),
  );
  return {
    references: catalog.references,
    methods: catalog.methods,
    getReference: (id) => referencesById.get(id),
    getMethod: (id) => methodsById.get(id),
    methodsByDomain: (domain) =>
      catalog.methods.filter((method) => method.domain === domain),
    referencesOfMethod: (methodId) => {
      const method = methodsById.get(methodId);
      if (method === undefined) return [];
      const ids = new Set([
        ...method.referenceIds,
        ...method.constants.flatMap((constant) => constant.referenceIds),
      ]);
      return [...ids].flatMap((id) => {
        const reference = referencesById.get(id);
        return reference === undefined ? [] : [reference];
      });
    },
  };
}
