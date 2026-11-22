import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEST_NATS_MAX_PAYLOAD, testNatsConfig } from './infra.js';
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
    expect(testInfra('nats').nats.mqttUrl).toBeUndefined();
    expect(() => testInfra('nats', 'postgres')).toThrow(
      /did not start postgres/,
    );
  });

  it('forwards the MQTT endpoint of a NATS started with options (CORE-15)', () => {
    process.env[SHARED_TEST_INFRA_ENV] = JSON.stringify({
      nats: {
        url: 'nats://127.0.0.1:4222',
        monitorUrl: 'http://127.0.0.1:8222',
        mqttUrl: 'mqtt://127.0.0.1:1883',
      },
    });
    expect(testInfra('nats').nats.mqttUrl).toBe('mqtt://127.0.0.1:1883');
  });
});

describe('testNatsConfig', () => {
  it('mirrors infra/nats/nats.conf: 4MB max_payload, JetStream, optional MQTT', () => {
    expect(DEFAULT_TEST_NATS_MAX_PAYLOAD).toBe('4MB');
    const config = testNatsConfig();
    expect(config).toContain('server_name: aisits-test-nats');
    expect(config).toContain('max_payload: 4MB');
    expect(config).toContain('jetstream {');
    expect(config).not.toContain('mqtt');
    const mqtt = testNatsConfig({ mqtt: true, maxPayload: '1MB' });
    expect(mqtt).toContain('max_payload: 1MB');
    expect(mqtt).toContain('mqtt { port: 1883 }');
    expect(testNatsConfig({ maxPayload: '1048576' })).toContain(
      'max_payload: 1048576',
    );
    for (const maxPayload of ['', '4 MB', '4MB\nmqtt {}', '-1', 'big'])
      expect(() => testNatsConfig({ maxPayload })).toThrow(RangeError);
  });
});

describe('uniqueName', () => {
  it('is a lowercase identifier with the prefix, unique per call', () => {
    const a = uniqueName('fleet');
    expect(a).toMatch(/^fleet_[0-9a-f]{8}$/);
    expect(uniqueName('fleet')).not.toBe(a);
  });
});
