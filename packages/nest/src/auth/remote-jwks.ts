import {
  createLocalJWKSet,
  errors as joseErrors,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * Thrown by the key resolver of {@link createResilientRemoteJwks} when the
 * key set cannot be obtained (network error, timeout, non-200, redirect,
 * invalid JSON) and no usable cached keys exist. The access token verifier
 * maps it to `503 SERVICE_UNAVAILABLE`: the token may be valid, the keys
 * are just not reachable now.
 */
export class KeySetUnavailableError extends Error {
  override readonly name = 'KeySetUnavailableError';
}

/** Options of {@link createResilientRemoteJwks}. */
export interface ResilientRemoteJwksOptions {
  /** Age after which the keys are refreshed in the background, ms. Default 10 min. */
  readonly cacheMaxAgeMs?: number | undefined;
  /**
   * Age after which cached keys are no longer used when refreshing fails,
   * ms. Default 1 h: longer than an access token lives (15 min) plus the
   * signing key overlap, so an auth outage never rejects valid tokens.
   */
  readonly maxStaleMs?: number | undefined;
  /** Minimum time between two fetches (unknown `kid`, failed refreshes), ms. Default 30 s. */
  readonly cooldownMs?: number | undefined;
  /** Fetch timeout, ms. Default 5 s. */
  readonly timeoutMs?: number | undefined;
  /** Called when a refresh fails (logging, metrics); verification goes on with cached keys. */
  readonly onRefreshError?: ((error: KeySetUnavailableError) => void) | undefined;
  /** Clock (tests). */
  readonly now?: (() => number) | undefined;
  /** `fetch` implementation (tests). */
  readonly fetch?: typeof fetch | undefined;
}

/** A remote JWKS key resolver with stale-if-error caching. */
export interface ResilientRemoteJwks {
  /** The resolver to pass to `jwtVerify` / `createAccessTokenVerifier`. */
  readonly resolve: JWTVerifyGetKey;
  /** Fetches the key set now (single flight). */
  refresh(): Promise<void>;
  /** When the cached keys were fetched (epoch ms), if ever. */
  readonly fetchedAt: number | undefined;
}

function isKeySet(value: unknown): value is JSONWebKeySet {
  if (typeof value !== 'object' || value === null) return false;
  const keys: unknown = Reflect.get(value, 'keys');
  return (
    Array.isArray(keys) &&
    keys.every((key) => typeof key === 'object' && key !== null)
  );
}

/**
 * A key resolver backed by the auth service's JWKS (spec §8.2: verify
 * locally, no call to auth per request) that survives auth outages:
 *
 * - keys are fetched on first use, then refreshed in the background once
 *   older than `cacheMaxAgeMs` — verification never waits for a refresh;
 * - when a refresh fails the cached keys stay in use (stale-if-error) for
 *   up to `maxStaleMs`; failures are reported through `onRefreshError`;
 * - an unknown `kid` (key rotation) triggers one fetch per `cooldownMs`;
 * - only when no usable keys exist does resolution fail, with
 *   {@link KeySetUnavailableError} (→ `503`), never with a token error.
 *
 * Fetches do not follow redirects (like jose's own remote key set).
 */
export function createResilientRemoteJwks(
  jwksUrl: string | URL,
  options: ResilientRemoteJwksOptions = {},
): ResilientRemoteJwks {
  const url = new URL(jwksUrl);
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? 10 * 60_000;
  const maxStaleMs = Math.max(options.maxStaleMs ?? 60 * 60_000, cacheMaxAgeMs);
  const cooldownMs = options.cooldownMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;

  let local: JWTVerifyGetKey | undefined;
  let fetchedAt: number | undefined;
  let lastAttemptAt: number | undefined;
  let inflight: Promise<void> | undefined;

  async function load(): Promise<void> {
    lastAttemptAt = now();
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new KeySetUnavailableError(
        `Fetching the key set from ${url.origin} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new KeySetUnavailableError(
        `The key set endpoint ${url.origin}${url.pathname} answered ${response.status}`,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new KeySetUnavailableError(
        'The key set endpoint did not return JSON',
        { cause: error },
      );
    }
    if (!isKeySet(body))
      throw new KeySetUnavailableError('The key set has no "keys" array');
    local = createLocalJWKSet(body);
    fetchedAt = now();
  }

  function refresh(): Promise<void> {
    inflight ??= load().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  function coolingDown(): boolean {
    return lastAttemptAt !== undefined && now() - lastAttemptAt < cooldownMs;
  }

  function refreshInBackground(): void {
    if (inflight !== undefined || coolingDown()) return;
    refresh().catch((error: unknown) => {
      if (error instanceof KeySetUnavailableError) options.onRefreshError?.(error);
    });
  }

  async function usableKeys(): Promise<JWTVerifyGetKey> {
    const age = fetchedAt === undefined ? Infinity : now() - fetchedAt;
    if (local !== undefined && age <= maxStaleMs) {
      if (age > cacheMaxAgeMs) refreshInBackground();
      return local;
    }
    // No keys, or too old to trust: this request has to wait for a fetch.
    if (inflight === undefined && coolingDown() && local === undefined) {
      throw new KeySetUnavailableError(
        'The key set is unavailable (last fetch failed recently)',
      );
    }
    await refresh();
    if (local === undefined)
      throw new KeySetUnavailableError('The key set is unavailable');
    return local;
  }

  const resolve: JWTVerifyGetKey = async (header, token) => {
    const keys = await usableKeys();
    try {
      return await keys(header, token);
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
      // Unknown kid: maybe a freshly rotated key; refetch at most once per cooldown.
      if (coolingDown()) throw error;
      await refresh();
      return (local ?? keys)(header, token);
    }
  };

  return {
    resolve,
    refresh,
    get fetchedAt() {
      return fetchedAt;
    },
  };
}
