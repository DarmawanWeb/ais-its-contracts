import { connect as connectTcp, type Socket } from 'node:net';
import { hostname } from 'node:os';

import { connect, type NatsConnection } from '@nats-io/transport-node';
import { getContainerRuntimeClient } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  reapOrphanedTestContainers,
  startTestInfra,
  TEST_CONTAINER_LABELS,
  TEST_IMAGES,
  testInfra,
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

/** An MQTT 3.1.1 UTF-8 string: 2-byte length, then the bytes. */
function mqttString(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** An MQTT control packet: type byte, remaining length (varint), body. */
function mqttPacket(type: number, body: Buffer): Buffer {
  const length: number[] = [];
  let remaining = body.length;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    length.push(byte);
  } while (remaining > 0);
  return Buffer.concat([Buffer.from([type, ...length]), body]);
}

/** Opens a raw MQTT session and resolves the CONNACK bytes. */
async function mqttConnect(
  url: string,
): Promise<{ socket: Socket; connack: Buffer }> {
  const { hostname: host, port } = new URL(url);
  const socket = connectTcp({ host, port: Number(port) });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const connack = new Promise<Buffer>((resolve, reject) => {
    socket.once('data', resolve);
    socket.once('error', reject);
  });
  socket.write(
    mqttPacket(
      0x10,
      Buffer.concat([
        mqttString('MQTT'),
        Buffer.from([0x04, 0x02, 0x00, 0x3c]), // 3.1.1, clean session, 60 s
        mqttString('kit-infra-test'),
      ]),
    ),
  );
  return { socket, connack: await connack };
}

describe('test NATS configuration (CORE-15)', () => {
  const big = new Uint8Array(1.5 * 1024 * 1024);

  async function roundTrip(
    connection: NatsConnection,
    subject: string,
  ): Promise<number> {
    const subscription = connection.subscribe(subject, { max: 1 });
    const received = (async () => {
      for await (const message of subscription) return message.data.length;
      return 0;
    })();
    connection.publish(subject, big);
    await connection.flush();
    return received;
  }

  it('allows 4 MB messages by default, like infra/nats/nats.conf', async () => {
    const connection = await connect({ servers: testInfra('nats').nats.url });
    try {
      expect(connection.info?.max_payload).toBe(4 * 1024 * 1024);
      expect(await roundTrip(connection, 'kit.infra.big')).toBe(big.length);
    } finally {
      await connection.close();
    }
  });

  describe('with maxPayload 1MB and the MQTT gateway', () => {
    let infra: Awaited<
      ReturnType<
        typeof startTestInfra<{
          nats: { mqtt: true; maxPayload: '1MB' };
        }>
      >
    >;

    beforeAll(async () => {
      infra = await startTestInfra({
        nats: { mqtt: true, maxPayload: '1MB' },
      });
    }, 180_000);

    afterAll(async () => {
      await infra.stop();
    });

    it('rejects messages above max_payload', async () => {
      const connection = await connect({ servers: infra.nats.url });
      try {
        expect(connection.info?.max_payload).toBe(1024 * 1024);
        expect(() => {
          connection.publish('kit.infra.big', big);
        }).toThrow(/max_payload|MAX_PAYLOAD/i);
      } finally {
        await connection.close();
      }
    });

    it('accepts MQTT clients and turns aisits/telemetry/x into aisits.telemetry.x', async () => {
      expect(infra.nats.mqttUrl).toMatch(/^mqtt:\/\/.+:\d+$/);
      const connection = await connect({ servers: infra.nats.url });
      const { socket, connack } = await mqttConnect(infra.nats.mqttUrl ?? '');
      try {
        // CONNACK: type 2, remaining length 2, no session, accepted (0).
        expect([...connack.subarray(0, 4)]).toEqual([0x20, 0x02, 0x00, 0x00]);
        const subscription = connection.subscribe('aisits.telemetry.x', {
          max: 1,
        });
        await connection.flush();
        const received = (async () => {
          for await (const message of subscription) return message.string();
          return undefined;
        })();
        socket.write(
          mqttPacket(
            0x30, // PUBLISH, QoS 0
            Buffer.concat([
              mqttString('aisits/telemetry/x'),
              Buffer.from('{"fuel":1.5}'),
            ]),
          ),
        );
        expect(await received).toBe('{"fuel":1.5}');
      } finally {
        socket.destroy();
        await connection.close();
      }
    });
  });
});
