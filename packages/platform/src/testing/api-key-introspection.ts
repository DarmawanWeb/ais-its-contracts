import { randomInt } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  API_KEY_ID_LENGTH,
  API_KEY_INTROSPECTION_PATH,
  API_KEY_SECRET_LENGTH,
  type ApiKeyIntrospectionResult,
  type ApiKeyScope,
  BASE62_ALPHABET,
  formatApiKey,
  HTTP_HEADERS,
} from '@darmawanweb/seemp-contracts/auth';
import { createProblem, PROBLEM_CONTENT_TYPE } from '@darmawanweb/seemp-contracts/api';
import { newId } from '@darmawanweb/seemp-contracts/domain';

import type { ApiKeyIntrospector } from '../auth/api-key-verifier.js';
import { internalTokenMatches } from '../auth/internal-token.js';

/** A key known to the fake introspection. */
export interface FakeApiKey {
  /** Default a new UUID. */
  readonly keyId?: string | undefined;
  /** Default a new UUID. */
  readonly orgId?: string | undefined;
  readonly scopes: readonly ApiKeyScope[];
  /** Default `test key`. */
  readonly name?: string | undefined;
}

function randomBase62(length: number): string {
  let value = '';
  for (let index = 0; index < length; index += 1) value += BASE62_ALPHABET[randomInt(BASE62_ALPHABET.length)];
  return value;
}

/** A random, well-formed API key (`sk_<10>_<32>`). */
export function generateTestApiKey(): string {
  return formatApiKey({ id: randomBase62(API_KEY_ID_LENGTH), secret: randomBase62(API_KEY_SECRET_LENGTH) });
}

/** In-memory introspection: plug into `AuthModule.forRoot({ apiKeyIntrospector: { useValue } })`. */
export class FakeApiKeyIntrospector implements ApiKeyIntrospector {
  private readonly keys = new Map<string, Extract<ApiKeyIntrospectionResult, { active: true }>>();
  /** Keys looked up, in order (to assert caching). */
  readonly lookups: string[] = [];

  constructor(keys: Readonly<Record<string, FakeApiKey>> = {}) {
    for (const [key, info] of Object.entries(keys)) this.add(key, info);
  }

  /** Registers (or replaces) an active key and returns its introspection result. */
  add(key: string, info: FakeApiKey): Extract<ApiKeyIntrospectionResult, { active: true }> {
    const result = {
      active: true as const,
      keyId: info.keyId ?? newId(),
      orgId: info.orgId ?? newId(),
      scopes: [...info.scopes],
      name: info.name ?? 'test key',
    };
    this.keys.set(key, result);
    return result;
  }

  /** Revokes a key. */
  revoke(key: string): void {
    this.keys.delete(key);
  }

  /** @inheritdoc */
  introspect(key: string): Promise<ApiKeyIntrospectionResult> {
    this.lookups.push(key);
    return Promise.resolve(this.keys.get(key) ?? { active: false });
  }
}

/** A running fake `POST /internal/api-keys/introspect` endpoint. */
export interface FakeIntrospectionServer {
  /** Base URL (`AUTH_INTERNAL_URL`). */
  readonly url: string;
  readonly introspector: FakeApiKeyIntrospector;
  /** Requests received (including rejected ones). */
  readonly requests: () => number;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serves the auth service's introspection endpoint over HTTP (exercises the
 * real HTTP introspector with `X-Internal-Token`).
 *
 * @example
 * const fake = await startFakeApiKeyIntrospection({ internalToken: config.INTERNAL_TOKEN });
 * const key = generateTestApiKey();
 * fake.introspector.add(key, { scopes: ['ais:ingest'] });
 * // AUTH_INTERNAL_URL = fake.url
 */
export async function startFakeApiKeyIntrospection(options: {
  readonly internalToken: string;
  readonly keys?: Readonly<Record<string, FakeApiKey>> | undefined;
}): Promise<FakeIntrospectionServer> {
  const introspector = new FakeApiKeyIntrospector(options.keys);
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    void (async () => {
      if (request.method !== 'POST' || request.url !== API_KEY_INTROSPECTION_PATH) {
        response.writeHead(404, { 'content-type': PROBLEM_CONTENT_TYPE }).end(JSON.stringify(createProblem('NOT_FOUND')));
        return;
      }
      const token = request.headers[HTTP_HEADERS.INTERNAL_TOKEN.toLowerCase()];
      if (!internalTokenMatches(typeof token === 'string' ? token : undefined, options.internalToken)) {
        response.writeHead(401, { 'content-type': PROBLEM_CONTENT_TYPE }).end(JSON.stringify(createProblem('UNAUTHORIZED')));
        return;
      }
      let key: unknown;
      try {
        key = (JSON.parse(await readBody(request)) as { key?: unknown }).key;
      } catch {
        key = undefined;
      }
      if (typeof key !== 'string') {
        response.writeHead(400, { 'content-type': PROBLEM_CONTENT_TYPE }).end(JSON.stringify(createProblem('VALIDATION_FAILED')));
        return;
      }
      const result = await introspector.introspect(key);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    introspector,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
