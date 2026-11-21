import {
  testInfra as sharedTestInfra,
  uniqueName,
} from '../../src/testing/index.js';

export { uniqueName };

/** Endpoints of the shared integration containers (see `global-setup.ts`). */
export function testInfra(): {
  readonly postgresAdminUrl: string;
  readonly natsUrl: string;
  readonly natsMonitorUrl: string;
  readonly redisUrl: string;
} {
  const { postgres, nats, redis } = sharedTestInfra(
    'postgres',
    'nats',
    'redis',
  );
  return {
    postgresAdminUrl: postgres.adminUrl,
    natsUrl: nats.url,
    natsMonitorUrl: nats.monitorUrl,
    redisUrl: redis.url,
  };
}
