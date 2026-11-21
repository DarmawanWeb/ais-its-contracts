import {
  ACCESS_TOKEN_ALGORITHM,
  AccessTokenClaimsSchema,
} from '@darmawanweb/ais-its-contracts/auth';
import { Logger } from '@nestjs/common';
import { errors as joseErrors, type JWTVerifyGetKey, jwtVerify } from 'jose';

import {
  ServiceUnavailableError,
  UnauthorizedError,
} from '../errors/domain-error.js';
import { UserPrincipal } from './principal.js';
import {
  createResilientRemoteJwks,
  KeySetUnavailableError,
} from './remote-jwks.js';

/**
 * Resolves the verification key of a token from its protected header (`kid`):
 * a remote JWKS in services, the local signing keys in the auth service, a
 * test issuer in tests.
 */
export type AccessTokenKeyResolver = JWTVerifyGetKey;

/** Clock skew tolerated on `exp`/`iat`, in seconds. */
export const ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/** Options of {@link createAccessTokenVerifier}. */
export interface AccessTokenVerifierOptions {
  /** Expected `iss` (`AUTH_ISSUER`). */
  readonly issuer: string;
  /** Expected `aud` (`AUTH_AUDIENCE`). */
  readonly audience: string | readonly string[];
  readonly keyResolver: AccessTokenKeyResolver;
  /** Default {@link ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS}. */
  readonly clockToleranceSeconds?: number | undefined;
  /** Clock used to check `exp` (tests). */
  readonly currentDate?: (() => Date) | undefined;
}

/** Verifies access tokens and returns their principal. */
export interface AccessTokenVerification {
  /**
   * Verifies signature (EdDSA), `iss`, `aud`, `exp` and the claim shape.
   *
   * @throws {UnauthorizedError} `401 UNAUTHORIZED` for invalid or expired tokens.
   * @throws {ServiceUnavailableError} `503` when the keys cannot be fetched.
   */
  verify(token: string): Promise<UserPrincipal>;
}

/** Options of {@link createRemoteKeyResolver}. */
export interface RemoteKeyResolverOptions {
  /** Age after which the keys are refreshed in the background, ms. Default 10 min. */
  readonly cacheMaxAgeMs?: number | undefined;
  /**
   * How long cached keys keep verifying tokens while the JWKS cannot be
   * fetched, ms. Default 1 h (stale-if-error).
   */
  readonly maxStaleMs?: number | undefined;
  /** Minimum time between two fetches (unknown `kid`, failed refreshes), ms. Default 30 s. */
  readonly cooldownMs?: number | undefined;
  /** Fetch timeout, ms. Default 5 s. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Key resolver backed by the auth service's JWKS (`AUTH_JWKS_URL`, spec
 * §8.2), cached with background refresh and stale-if-error: an auth
 * outage or restart never rejects valid tokens while cached keys are
 * younger than `maxStaleMs`; refresh failures are logged as warnings.
 * Nothing is fetched until the first verification. See
 * {@link createResilientRemoteJwks}.
 */
export function createRemoteKeyResolver(
  jwksUrl: string,
  options: RemoteKeyResolverOptions = {},
): AccessTokenKeyResolver {
  const logger = new Logger('Jwks');
  return createResilientRemoteJwks(jwksUrl, {
    ...options,
    onRefreshError: (error) => {
      logger.warn(`${error.message}; verifying with the cached keys`);
    },
  }).resolve;
}

const invalidToken = (
  description: string,
  cause?: unknown,
): UnauthorizedError =>
  new UnauthorizedError(description, {
    challenge: `Bearer error="invalid_token", error_description="${description}"`,
    cause,
  });

const keysUnavailable = (cause: unknown): ServiceUnavailableError =>
  new ServiceUnavailableError('The token signing keys cannot be fetched', {
    cause,
  });

/**
 * Maps verification failures to `401` (a problem of the token: format,
 * signature, claims, unknown key) or `503` (the keys cannot be obtained).
 */
function verificationError(error: unknown): Error {
  if (error instanceof KeySetUnavailableError) return keysUnavailable(error);
  if (error instanceof joseErrors.JWTExpired)
    return invalidToken('The access token expired', error);
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return invalidToken(
      `The access token ${error.claim} claim is invalid`,
      error,
    );
  }
  // Custom resolvers built on jose's own remote key set.
  if (
    error instanceof joseErrors.JWKSTimeout ||
    error instanceof joseErrors.JWKSInvalid
  )
    return keysUnavailable(error);
  if (error instanceof joseErrors.JOSEError)
    return invalidToken('The access token is invalid', error);
  // fetch() failures of a custom remote resolver (connection refused, DNS, …).
  if (error instanceof TypeError) return keysUnavailable(error);
  return invalidToken('The access token is invalid', error);
}

/**
 * Framework-independent access token verifier (spec §8.2): EdDSA signature,
 * `iss`/`aud`, `exp` with 30 s tolerance, then the contracts claim schema
 * (`typ: "access"`, UUID `sub`/`sid`, …). Usable from socket.io handshakes.
 *
 * @example
 * const verifier = createAccessTokenVerifier({ issuer, audience, keyResolver: createRemoteKeyResolver(jwksUrl) });
 * const principal = await verifier.verify(socket.handshake.auth.token);
 */
export function createAccessTokenVerifier(
  options: AccessTokenVerifierOptions,
): AccessTokenVerification {
  const audience =
    typeof options.audience === 'string'
      ? options.audience
      : [...options.audience];
  return {
    async verify(token: string): Promise<UserPrincipal> {
      if (token === '') throw invalidToken('The access token is missing');
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, options.keyResolver, {
          issuer: options.issuer,
          audience,
          algorithms: [ACCESS_TOKEN_ALGORITHM],
          clockTolerance:
            options.clockToleranceSeconds ??
            ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
          ...(options.currentDate === undefined
            ? {}
            : { currentDate: options.currentDate() }),
        }));
      } catch (error) {
        throw verificationError(error);
      }
      const claims = AccessTokenClaimsSchema.safeParse(payload);
      if (!claims.success)
        throw invalidToken('The access token claims are invalid', claims.error);
      return UserPrincipal.fromClaims(claims.data);
    },
  };
}

/**
 * Verifies one access token without Nest (socket.io handshakes, scripts):
 * shorthand of `createAccessTokenVerifier(options).verify(token)`. Reuse a
 * long-lived `keyResolver` (e.g. {@link createRemoteKeyResolver}) so the JWKS
 * cache is shared between calls.
 *
 * @example
 * const keys = createRemoteKeyResolver(config.AUTH_JWKS_URL);
 * io.use(async (socket, next) => {
 *   try {
 *     socket.data.principal = await verifyAccessToken(String(socket.handshake.auth.token), {
 *       issuer: config.AUTH_ISSUER, audience: config.AUTH_AUDIENCE, keyResolver: keys,
 *     });
 *     next();
 *   } catch {
 *     next(Object.assign(new Error('Unauthorized'), { data: { code: 'UNAUTHORIZED' } }));
 *   }
 * });
 *
 * @throws {UnauthorizedError} for invalid or expired tokens.
 * @throws {ServiceUnavailableError} when the keys cannot be fetched.
 */
export function verifyAccessToken(
  token: string,
  options: AccessTokenVerifierOptions,
): Promise<UserPrincipal> {
  return createAccessTokenVerifier(options).verify(token);
}
