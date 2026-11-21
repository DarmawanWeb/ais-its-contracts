import { hostname } from 'node:os';

import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  reapOrphanedTestContainers,
  startTestInfra,
  TEST_CONTAINER_LABELS,
  TEST_IMAGES,
} from '../src/testing/index.js';

/** The S3 and SMTP helpers (the shared global setup starts PostgreSQL, NATS and Valkey). */
describe('startTestInfra (S3 + SMTP)', () => {
  let infra: Awaited<
    ReturnType<typeof startTestInfra<{ s3: true; smtp: true }>>
  >;

  beforeAll(async () => {
    infra = await startTestInfra({ s3: true, smtp: true });
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  });

  it('starts the pre-pulled images and exposes their endpoints', async () => {
    expect(TEST_IMAGES).toMatchObject({
      s3: 'rustfs/rustfs:latest',
      smtp: 'axllent/mailpit:latest',
    });
    expect(infra.s3.endpoint).toMatch(/^http:\/\/.+:\d+$/);
    // Anonymous S3 requests are answered (and refused) by the S3 API.
    const s3 = await fetch(infra.s3.endpoint);
    expect(s3.status).toBeGreaterThanOrEqual(200);
    expect(s3.status).toBeLessThan(500);
    expect(infra.smtp.url).toMatch(/^smtp:\/\/.+:\d+$/);
    const messages = await fetch(`${infra.smtp.apiUrl}/api/v1/messages`);
    expect(messages.status).toBe(200);
    expect(await messages.json()).toMatchObject({ total: 0 });
  });
});

describe('reapOrphanedTestContainers', () => {
  it('removes test containers whose starting process is gone, and keeps the others', async () => {
    const { GenericContainer } = await import('testcontainers');
    const labels = (pid: number) => ({
      [TEST_CONTAINER_LABELS.marker]: 'true',
      [TEST_CONTAINER_LABELS.pid]: String(pid),
      [TEST_CONTAINER_LABELS.host]: hostname(),
    });
    // PID 2^22 + 1 is above Linux's pid_max: no such process.
    const orphan = await new GenericContainer(TEST_IMAGES.redis)
      .withLabels(labels(4_194_305))
      .start();
    const owned = await new GenericContainer(TEST_IMAGES.redis)
      .withLabels(labels(process.pid))
      .start();
    try {
      expect(await reapOrphanedTestContainers()).toBeGreaterThanOrEqual(1);
      const client = await getContainerRuntimeClient();
      const running = new Set(
        (await client.container.list()).map((info) => info.Id),
      );
      expect(running.has(orphan.getId())).toBe(false);
      expect(running.has(owned.getId())).toBe(true);
    } finally {
      await owned.stop({ timeout: 1_000 });
      await orphan.stop({ timeout: 1_000 }).catch(() => undefined);
    }
  });
});
