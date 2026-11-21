import type { TestProject } from 'vitest/node';

import { startTestInfra } from '../../src/testing/infra.js';

/**
 * Starts PostgreSQL (TimescaleDB + PostGIS), NATS and Valkey once for every
 * integration test file and provides their endpoints (`inject('infra')`).
 */
export async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const infra = await startTestInfra({
    postgres: true,
    nats: true,
    redis: true,
  });
  project.provide('infra', {
    postgresAdminUrl: infra.postgres.adminUrl,
    natsUrl: infra.nats.url,
    natsMonitorUrl: infra.nats.monitorUrl,
    redisUrl: infra.redis.url,
  });
  return () => infra.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    infra: {
      postgresAdminUrl: string;
      natsUrl: string;
      natsMonitorUrl: string;
      redisUrl: string;
    };
  }
}
