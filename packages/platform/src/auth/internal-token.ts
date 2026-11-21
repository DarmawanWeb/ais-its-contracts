import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time comparison of a presented `X-Internal-Token` with the
 * configured one. Both values are hashed first, so neither their content nor
 * their length leaks through timing.
 */
export function internalTokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined || presented === '' || expected === '') return false;
  return timingSafeEqual(digest(presented), digest(expected));
}
