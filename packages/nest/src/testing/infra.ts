import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import pg from 'pg';

import { retryUntilDeadline } from '../common/retry.js';

/** Container images of the test infrastructure (pre-pulled in CI and dev). */
export const TEST_IMAGES = {
  postgres: 'timescale/timescaledb-ha:pg17',
  nats: 'nats:2.11-alpine',
  redis: 'valkey/valkey:8-alpine',
  s3: 'rustfs/rustfs:latest',
  smtp: 'axllent/mailpit:latest',
} as const;

/** Database created in the test PostgreSQL (as in every environment). */
export const TEST_DATABASE = 'aisits';

/** Credentials of the test S3 (RustFS). */
export const TEST_S3_CREDENTIALS = {
  accessKey: 'aisits-test',
  secretKey: 'aisits-test-secret',
  region: 'us-east-1',
} as const;

/** PostgreSQL 17 + TimescaleDB + PostGIS, superuser `postgres`. */
export interface TestPostgres {
  /** Superuser URL of the `aisits` database (provision schemas with it). */
  readonly adminUrl: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

/** NATS with JetStream. */
export interface TestNats {
  /** `nats://host:port` (`NATS_URL`). */
  readonly url: string;
  /** HTTP monitoring endpoint (`/jsz`, `/connz`, …). */
  readonly monitorUrl: string;
}

/** Valkey. */
export interface TestRedis {
  /** `redis://host:port` (`REDIS_URL`). */
  readonly url: string;
}

/** S3-compatible object storage (RustFS); create buckets with your S3 client. */
export interface TestS3 {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

/** Mailpit SMTP sink. */
export interface TestSmtp {
  /** `smtp://host:port` (`SMTP_URL`). */
  readonly url: string;
  /** Mailpit HTTP API, e.g. `${apiUrl}/api/v1/messages`. */
  readonly apiUrl: string;
}

/** The endpoints of every test service. */
export interface TestServices {
  readonly postgres: TestPostgres;
  readonly nats: TestNats;
  readonly redis: TestRedis;
  readonly s3: TestS3;
  readonly smtp: TestSmtp;
}

/** Which services to start. */
export interface TestInfraOptions {
  readonly postgres?: boolean | undefined;
  readonly nats?: boolean | undefined;
  readonly redis?: boolean | undefined;
  readonly s3?: boolean | undefined;
  readonly smtp?: boolean | undefined;
  /** Startup timeout of each container, ms. Default 180 s. */
  readonly startupTimeoutMs?: number | undefined;
}

/** The started services (exactly those requested) and `stop()`. */
export type StartedTestInfra<Options extends TestInfraOptions> = {
  readonly [
    Name in keyof TestServices as Options[Name] extends true ? Name : never
  ]: TestServices[Name];
} & {
  /** Stops every container (idempotent). */
  stop(): Promise<void>;
};

async function waitForPostgres(url: string, timeoutMs: number): Promise<void> {
  await retryUntilDeadline(
    async () => {
      const client = new pg.Client({
        connectionString: url,
        connectionTimeoutMillis: 3000,
      });
      try {
        await client.connect();
        await client.query('SELECT 1');
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    { deadlineMs: timeoutMs, initialDelayMs: 200, maxDelayMs: 1000 },
  );
}

async function startPostgres(
  timeoutMs: number,
  track: (container: StartedTestContainer) => void,
): Promise<[StartedTestContainer, TestPostgres]> {
  const container = await new GenericContainer(TEST_IMAGES.postgres)
    .withEnvironment({
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: TEST_DATABASE,
    })
    // Durability is irrelevant for tests: trade it for speed.
    .withCommand([
      'postgres',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ])
    .withExposedPorts(5432)
    .withSharedMemorySize(256 * 1024 * 1024)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(timeoutMs)
    .start();
  track(container);
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminUrl = `postgres://postgres:postgres@${host}:${port}/${TEST_DATABASE}`;
  await waitForPostgres(adminUrl, timeoutMs);
  return [container, { adminUrl, host, port, database: TEST_DATABASE }];
}

async function startNats(
  timeoutMs: number,
  track: (container: StartedTestContainer) => void,
): Promise<[StartedTestContainer, TestNats]> {
  const container = await new GenericContainer(TEST_IMAGES.nats)
    .withCommand(['-js', '-m', '8222'])
    .withExposedPorts(4222, 8222)
    .withWaitStrategy(Wait.forLogMessage(/Server is ready/))
    .withStartupTimeout(timeoutMs)
    .start();
  track(container);
  const host = container.getHost();
  return [
    container,
    {
      url: `nats://${host}:${container.getMappedPort(4222)}`,
      monitorUrl: `http://${host}:${container.getMappedPort(8222)}`,
    },
  ];
}

async function startRedis(
  timeoutMs: number,
  track: (container: StartedTestContainer) => void,
): Promise<[StartedTestContainer, TestRedis]> {
  const container = await new GenericContainer(TEST_IMAGES.redis)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(timeoutMs)
    .start();
  track(container);
  return [
    container,
    { url: `redis://${container.getHost()}:${container.getMappedPort(6379)}` },
  ];
}

async function startS3(
  timeoutMs: number,
  track: (container: StartedTestContainer) => void,
): Promise<[StartedTestContainer, TestS3]> {
  const container = await new GenericContainer(TEST_IMAGES.s3)
    .withEnvironment({
      RUSTFS_ACCESS_KEY: TEST_S3_CREDENTIALS.accessKey,
      RUSTFS_SECRET_KEY: TEST_S3_CREDENTIALS.secretKey,
      RUSTFS_REGION: TEST_S3_CREDENTIALS.region,
      RUSTFS_ADDRESS: ':9000',
      RUSTFS_CONSOLE_ENABLE: 'false',
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(timeoutMs)
    .start();
  track(container);
  return [
    container,
    {
      endpoint: `http://${container.getHost()}:${container.getMappedPort(9000)}`,
      region: TEST_S3_CREDENTIALS.region,
      accessKey: TEST_S3_CREDENTIALS.accessKey,
      secretKey: TEST_S3_CREDENTIALS.secretKey,
    },
  ];
}

async function startSmtp(
  timeoutMs: number,
  track: (container: StartedTestContainer) => void,
): Promise<[StartedTestContainer, TestSmtp]> {
  const container = await new GenericContainer(TEST_IMAGES.smtp)
    .withEnvironment({
      MP_SMTP_AUTH_ACCEPT_ANY: 'true',
      MP_SMTP_AUTH_ALLOW_INSECURE: 'true',
    })
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/readyz', 8025))
    .withStartupTimeout(timeoutMs)
    .start();
  track(container);
  const host = container.getHost();
  return [
    container,
    {
      url: `smtp://${host}:${container.getMappedPort(1025)}`,
      apiUrl: `http://${host}:${container.getMappedPort(8025)}`,
    },
  ];
}

/**
 * Starts the requested infrastructure with testcontainers, in parallel, using
 * the platform's image tags ({@link TEST_IMAGES}). Set
 * `TESTCONTAINERS_RYUK_DISABLED=true` where the Ryuk image is unavailable,
 * and always call `stop()` (e.g. in `afterAll`).
 *
 * @example
 * const infra = await startTestInfra({ postgres: true, nats: true });
 * const databaseUrl = await provisionServiceSchema(infra.postgres.adminUrl, 'fleet');
 * // …
 * await infra.stop();
 */
export async function startTestInfra<const Options extends TestInfraOptions>(
  options: Options,
): Promise<StartedTestInfra<Options>> {
  const timeoutMs = options.startupTimeoutMs ?? 180_000;
  const starters: Partial<
    Record<
      keyof TestServices,
      (
        timeout: number,
        track: (container: StartedTestContainer) => void,
      ) => Promise<[StartedTestContainer, unknown]>
    >
  > = {
    ...(options.postgres === true ? { postgres: startPostgres } : {}),
    ...(options.nats === true ? { nats: startNats } : {}),
    ...(options.redis === true ? { redis: startRedis } : {}),
    ...(options.s3 === true ? { s3: startS3 } : {}),
    ...(options.smtp === true ? { smtp: startSmtp } : {}),
  };
  const containers: StartedTestContainer[] = [];
  const endpoints: Record<string, unknown> = {};
  const results = await Promise.allSettled(
    Object.entries(starters).map(async ([name, start]) => {
      // Tracked as soon as it runs: a failing readiness wait still stops it.
      const [, endpoint] = await start(timeoutMs, (container) => {
        containers.push(container);
      });
      endpoints[name] = endpoint;
    }),
  );
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= Promise.allSettled(
      containers.map((container) => container.stop({ timeout: 5_000 })),
    ).then(() => undefined);
    return stopped;
  };
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure !== undefined) {
    await stop();
    throw failure.reason;
  }
  // The keys of `endpoints` are exactly the requested services.
  return { ...endpoints, stop } as unknown as StartedTestInfra<Options>;
}
