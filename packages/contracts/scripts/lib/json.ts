/** A JSON object (e.g. a JSON Schema). */
export type JsonObject = Record<string, unknown>;

/** Narrows `value` to a plain JSON object or throws with `context`. */
export function asJsonObject(value: unknown, context: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${context}: expected a JSON object`);
  }
  return value as JsonObject;
}

/** Narrows `value` to a string array or throws with `context`. */
export function asStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${context}: expected a string array`);
  }
  return value as string[];
}
