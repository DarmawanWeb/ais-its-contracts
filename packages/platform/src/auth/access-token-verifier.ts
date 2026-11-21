import {
  ACCESS_TOKEN_ALGORITHM,
  AccessTokenClaimsSchema,
} from '@darmawanweb/seemp-contracts/auth';
import { errors as joseErrors, createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';

import { ServiceUnavailableError, UnauthorizedError } from '../errors/domain-error.js';
import { UserPrincipal } from './principal.js';

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
  /** How long a fetched JWKS is used before refetching, ms. Default 10 min. */
  readonly cacheMaxAgeMs?: number | undefined;
  /** Minimum time between two fetches (unknown `kid`), ms. Default 30 s. */
  readonly cooldownMs?: number | undefined;
  /** Fetch timeout, ms. Default 5 s. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Key resolver backed by the auth service's JWKS (`AUTH_JWKS_URL`), cached
 * with a refetch cooldown. Nothing is fetched until the first verification.
 */
export function createRemoteKeyResolver(
  jwksUrl: string,
  options: RemoteKeyResolverOptions = {},
): AccessTokenKeyResolver {
  return createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: options.cacheMaxAgeMs ?? 10 * 60 * 1000,
    cooldownDuration: options.cooldownMs ?? 30 * 1000,
    timeoutDuration: options.timeoutMs ?? 5 * 1000,
  });
}

const invalidToken = (description: string, cause?: unknown): UnauthorizedError =>
  new UnauthorizedError(description, {
    challenge: `Bearer error="invalid_token", error_description="${description}"`,
    cause,
  });

/** Maps jose failures to 401 (token problem) or 503 (key fetching problem). */
function verificationError(error: unknown): Error {
  if (error instanceof joseErrors.JWTExpired) return invalidToken('The access token expired', error);
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return invalidToken(`The access token ${error.claim} claim is invalid`, error);
  }
  if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid) {
    return new ServiceUnavailableError('The token signing keys cannot be fetched', { cause: error });
  }
  if (error instanceof joseErrors.JOSEError) return invalidToken('The access token is invalid', error);
  // fetch() failures of the remote JWKS (connection refused, DNS, …).
  if (error instanceof TypeError) {
    return new ServiceUnavailableError('The token signing keys cannot be fetched', { cause: error });
  }
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
export function createAccessTokenVerifier(options: AccessTokenVerifierOptions): AccessTokenVerification {
  const audience = typeof options.audience === 'string' ? options.audience : [...options.audience];
  return {
    async verify(token: string): Promise<UserPrincipal> {
      if (token === '') throw invalidToken('The access token is missing');
      let payload: unknown;
      try {
        ({ payload } = await jwtVerify(token, options.keyResolver, {
          issuer: options.issuer,
          audience,
          algorithms: [ACCESS_TOKEN_ALGORITHM],
          clockTolerance: options.clockToleranceSeconds ?? ACCESS_TOKEN_CLOCK_TOLERANCE_SECONDS,
          ...(options.currentDate === undefined ? {} : { currentDate: options.currentDate() }),
        }));
      } catch (error) {
        throw verificationError(error);
      }
      const claims = AccessTokenClaimsSchema.safeParse(payload);
      if (!claims.success) throw invalidToken('The access token claims are invalid', claims.error);
      return UserPrincipal.fromClaims(claims.data);
    },
  };
}
