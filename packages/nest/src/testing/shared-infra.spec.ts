import { afterEach, describe, expect, it } from 'vitest';

import {
  SHARED_TEST_INFRA_ENV,
  SharedTestInfraError,
  testInfra,
  uniqueName,
} from './shared-infra.js';

describe('testInfra (shared global setup endpoints)', () => {
  const previous = process.env[SHARED_TEST_INFRA_ENV];
  afterEach(() => {
    if (previous === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- restoring the environment
      delete process.env[SHARED_TEST_INFRA_ENV];
    } else process.env[SHARED_TEST_INFRA_ENV] = previous;
  });

  it('explains how to enable the global setup when it did not run', () => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- simulating a missing setup
    delete process.env[SHARED_TEST_INFRA_ENV];
    expect(() => testInfra('postgres')).toThrow(SharedTestInfraError);
    expect(() => testInfra('postgres')).toThrow(/testInfraGlobalSetup/);
  });

  it('returns the started endpoints and refuses services that were not started', () => {
    process.env[SHARED_TEST_INFRA_ENV] = JSON.stringify({
      nats: {
        url: 'nats://127.0.0.1:4222',
        monitorUrl: 'http://127.0.0.1:8222',
      },
    });
    expect(testInfra('nats').nats.url).toBe('nats://127.0.0.1:4222');
    expect(() => testInfra('nats', 'postgres')).toThrow(
      /did not start postgres/,
    );
  });
});

describe('uniqueName', () => {
  it('is a lowercase identifier with the prefix, unique per call', () => {
    const a = uniqueName('fleet');
    expect(a).toMatch(/^fleet_[0-9a-f]{8}$/);
    expect(uniqueName('fleet')).not.toBe(a);
  });
});
