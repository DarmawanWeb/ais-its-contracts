import { randomBytes } from 'node:crypto';

import { inject } from 'vitest';

/** Endpoints of the shared integration containers (see `global-setup.ts`). */
export function testInfra(): ReturnType<typeof inject<'infra'>> {
  return inject('infra');
}

/** A unique lowercase identifier for schemas, durable names and subjects. */
export function uniqueName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}
