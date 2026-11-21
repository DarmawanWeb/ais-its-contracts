import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestInfra, TEST_IMAGES } from '../src/testing/index.js';

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
