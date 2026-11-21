/**
 * Matches a concrete NATS subject against a subject filter with NATS wildcard
 * semantics: `*` matches exactly one token, a final `>` one or more tokens.
 *
 * @example subjectMatchesFilter('ais.position.v1.3.525005223', 'ais.position.v1.3.>') // true
 */
export function subjectMatchesFilter(subject: string, filter: string): boolean {
  const subjectTokens = subject.split('.');
  const filterTokens = filter.split('.');

  for (const [index, filterToken] of filterTokens.entries()) {
    if (filterToken === '>') {
      return index === filterTokens.length - 1 && subjectTokens.length > index;
    }
    const subjectToken = subjectTokens[index];
    if (subjectToken === undefined) return false;
    if (filterToken !== '*' && filterToken !== subjectToken) return false;
  }
  return subjectTokens.length === filterTokens.length;
}
