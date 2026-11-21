import { createMethodologyIndex, type MethodologyIndex } from './catalog.js';
import { METHODS } from './data/methods.js';
import { REFERENCES } from './data/references.js';
import type { Method, MethodDomain, Reference } from './schemas.js';

export { METHODS, REFERENCES };

let shippedIndex: MethodologyIndex | undefined;

/** Lookups of the catalog shipped with this version, built on first use. */
function shipped(): MethodologyIndex {
  shippedIndex ??= createMethodologyIndex({
    references: REFERENCES,
    methods: METHODS,
  });
  return shippedIndex;
}

/**
 * Reference of the shipped catalog.
 *
 * @returns the reference, or `undefined` for an unknown id.
 */
export function getReference(id: string): Reference | undefined {
  return shipped().getReference(id);
}

/**
 * Method of the shipped catalog.
 *
 * @returns the method, or `undefined` for an unknown id.
 *
 * @example getMethod('cii.attained')?.formulaLatex
 */
export function getMethod(id: string): Method | undefined {
  return shipped().getMethod(id);
}

/** Methods of the shipped catalog in a domain, in catalog order. */
export function methodsByDomain(domain: MethodDomain): readonly Method[] {
  return shipped().methodsByDomain(domain);
}

/**
 * References of the shipped catalog cited by a method and its constants, in
 * citation order without duplicates; empty for an unknown method.
 */
export function referencesOfMethod(methodId: string): readonly Reference[] {
  return shipped().referencesOfMethod(methodId);
}
