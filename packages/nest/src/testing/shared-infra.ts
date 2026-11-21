import { randomBytes } from 'node:crypto';

import {
  startTestInfra,
  type TestInfraOptions,
  type TestServices,
} from './infra.js';

/**
 * Environment variable through which {@link testInfraGlobalSetup} hands the
 * endpoints to the test workers (they inherit the environment of the vitest
 * process, which runs the global setup before starting them).
 */
export const SHARED_TEST_INFRA_ENV = 'AISITS_TEST_INFRA';

/** Endpoints of the containers shared by every test file of a run. */
export type SharedTestInfra = Partial<TestServices>;

/**
 * Builds the `setup` of a vitest `globalSetup` module: starts the requested
 * containers once for the whole run (instead of once per test file) and
 * stops them at the end. Test files read the endpoints with
 * {@link testInfra}; give each file its own schema, subjects and durable
 * names ({@link uniqueName}, `NATS_DURABLE_PREFIX`) so that files running in
 * parallel never share state.
 *
 * @example
 * // test/global-setup.ts (vitest.int.config.ts: `globalSetup: ['test/global-setup.ts']`)
 * import { testInfraGlobalSetup } from '@darmawanweb/ais-its-nest/testing';
 * export const setup = testInfraGlobalSetup({ postgres: true, nats: true });
 */
export function testInfraGlobalSetup(
  options: TestInfraOptions,
): () => Promise<() => Promise<void>> {
  return async () => {
    const infra = await startTestInfra(options);
    const endpoints = Object.fromEntries(
      Object.entries(infra).filter(([name]) => name !== 'stop'),
    );
    process.env[SHARED_TEST_INFRA_ENV] = JSON.stringify(endpoints);
    return async () => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- restoring the environment
      delete process.env[SHARED_TEST_INFRA_ENV];
      await infra.stop();
    };
  };
}

/** Thrown by {@link testInfra} when a service was not started by the global setup. */
export class SharedTestInfraError extends Error {
  override readonly name = 'SharedTestInfraError';
}

/**
 * The endpoints started by {@link testInfraGlobalSetup}, narrowed to the
 * services a test file needs.
 *
 * @throws {SharedTestInfraError} when the global setup did not run or did
 *   not start one of `required`.
 * @example
 * const { postgres, nats } = testInfra('postgres', 'nats');
 */
export function testInfra<const Name extends keyof TestServices>(
  ...required: readonly Name[]
): Pick<TestServices, Name> & SharedTestInfra {
  const raw = process.env[SHARED_TEST_INFRA_ENV];
  if (raw === undefined || raw === '') {
    throw new SharedTestInfraError(
      `${SHARED_TEST_INFRA_ENV} is not set: add a globalSetup that exports testInfraGlobalSetup(...) to the vitest config`,
    );
  }
  // Written by testInfraGlobalSetup from the started endpoints.
  const infra = JSON.parse(raw) as SharedTestInfra;
  const missing = required.filter((name) => infra[name] === undefined);
  if (missing.length > 0) {
    throw new SharedTestInfraError(
      `The global setup did not start ${missing.join(', ')}: enable it in testInfraGlobalSetup(...)`,
    );
  }
  // Every required service was checked above.
  return infra as Pick<TestServices, Name> & SharedTestInfra;
}

/**
 * A unique lowercase identifier (`<prefix>_<8 hex>`) for schemas, durable
 * names, subjects and prefixes of one test file.
 */
export function uniqueName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}
