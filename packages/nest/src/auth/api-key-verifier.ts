import { createHash } from 'node:crypto';

import {
  API_KEY_INTROSPECTION_CACHE_TTL_MS,
  API_KEY_INTROSPECTION_PATH,
  type ApiKeyIntrospectionResult,
  ApiKeyIntrospectionResultSchema,
  isApiKey,
} from '@darmawanweb/ais-its-contracts/auth';
import { LRUCache } from 'lru-cache';

import {
  ServiceUnavailableError,
  UnauthorizedError,
} from '../errors/domain-error.js';
import type { InternalHttpClient } from '../internal-http/internal-http-client.js';
import { ApiKeyPrincipal } from './principal.js';

/** How long an unknown/revoked key is remembered, in ms (spec: 10 s). */
export const API_KEY_NEGATIVE_CACHE_TTL_MS = 10_000;

/** Looks up an API key: the auth service, or a fake in tests. */
export interface ApiKeyIntrospector {
  /** Resolves the key's tenant and scopes, `{ active: false }` when unknown or revoked. */
  introspect(key: string): Promise<ApiKeyIntrospectionResult>;
}

/**
 * Introspects keys with `POST {AUTH_INTERNAL_URL}/internal/api-keys/introspect`
 * (`X-Internal-Token`), retried on transient failures.
 */
export class HttpApiKeyIntrospector implements ApiKeyIntrospector {
  constructor(private readonly client: InternalHttpClient) {}

  /** @inheritdoc */
  introspect(key: string): Promise<ApiKeyIntrospectionResult> {
    return this.client.post(
      API_KEY_INTROSPECTION_PATH,
      { key },
      {
        schema: ApiKeyIntrospectionResultSchema,
        idempotent: true,
      },
    );
  }
}

/** Options of {@link ApiKeyVerifier}. */
export interface ApiKeyVerifierOptions {
  /** TTL of active keys, ms. Default 60 s (spec §8.6). */
  readonly positiveTtlMs?: number | undefined;
  /** TTL of inactive keys, ms. Default 10 s. */
  readonly negativeTtlMs?: number | undefined;
  /** Cached keys. Default 10 000. */
  readonly maxEntries?: number | undefined;
}

type CachedResult = ApiKeyPrincipal | false;

const invalidKey = (): UnauthorizedError =>
  new UnauthorizedError('The API key is invalid or revoked', {
    code: 'INVALID_API_KEY',
    challenge: 'ApiKey',
  });

/**
 * Verifies `X-API-Key` values: format check without network, then the
 * introspector, with an LRU cache (60 s for active keys, 10 s for inactive
 * ones) keyed by the SHA-256 of the key, and one in-flight lookup per key.
 */
export class ApiKeyVerifier {
  private readonly cache: LRUCache<string, { readonly result: CachedResult }>;
  private readonly inFlight = new Map<string, Promise<CachedResult>>();
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;

  constructor(
    private readonly introspector: ApiKeyIntrospector,
    options: ApiKeyVerifierOptions = {},
  ) {
    this.positiveTtlMs =
      options.positiveTtlMs ?? API_KEY_INTROSPECTION_CACHE_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? API_KEY_NEGATIVE_CACHE_TTL_MS;
    this.cache = new LRUCache({
      max: options.maxEntries ?? 10_000,
      ttlAutopurge: false,
    });
  }

  /**
   * Returns the principal of an active key.
   *
   * @throws {UnauthorizedError} `401 INVALID_API_KEY` for malformed, unknown or revoked keys.
   * @throws {ServiceUnavailableError} `503` when the introspection fails.
   */
  async verify(key: string): Promise<ApiKeyPrincipal> {
    if (!isApiKey(key)) throw invalidKey();
    const hash = createHash('sha256').update(key).digest('hex');
    const cached = this.cache.get(hash);
    const result =
      cached === undefined ? await this.lookup(hash, key) : cached.result;
    if (result === false) throw invalidKey();
    return result;
  }

  /** Forgets every cached key (e.g. after a revocation in tests). */
  clear(): void {
    this.cache.clear();
  }

  private lookup(hash: string, key: string): Promise<CachedResult> {
    const pending = this.inFlight.get(hash);
    if (pending !== undefined) return pending;
    const lookup = this.introspect(key)
      .then((result) => {
        this.cache.set(
          hash,
          { result },
          {
            ttl: result === false ? this.negativeTtlMs : this.positiveTtlMs,
          },
        );
        return result;
      })
      .finally(() => this.inFlight.delete(hash));
    this.inFlight.set(hash, lookup);
    return lookup;
  }

  private async introspect(key: string): Promise<CachedResult> {
    let result: ApiKeyIntrospectionResult;
    try {
      result = await this.introspector.introspect(key);
    } catch (error) {
      throw new ServiceUnavailableError(
        'API keys cannot be verified right now',
        { cause: error },
      );
    }
    return result.active ? ApiKeyPrincipal.fromIntrospection(result) : false;
  }
}
