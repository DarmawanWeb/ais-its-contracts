import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_TTL_SECONDS,
  ACCESS_TOKEN_TYPE,
  DEFAULT_AUTH_AUDIENCE,
  DEFAULT_AUTH_ISSUER,
  JWKS_PATH,
  type Role,
} from '@darmawanweb/ais-its-contracts/auth';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
  type JWTPayload,
  SignJWT,
} from 'jose';

import type { AccessTokenKeyResolver } from '../auth/access-token-verifier.js';
import { UserPrincipal } from '../auth/principal.js';

/** The principal and token details of a test access token. */
export interface TestTokenClaims {
  /** `sub`; default a new UUID. */
  readonly userId?: string | undefined;
  /** `sid`; default a new UUID. */
  readonly sessionId?: string | undefined;
  /** `org`; default `null`. */
  readonly orgId?: string | null | undefined;
  /** Default `['viewer']`. */
  readonly roles?: readonly Role[] | undefined;
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  /** Lifetime, s. Default 900. Negative values produce expired tokens. */
  readonly expiresInSeconds?: number | undefined;
  /** `iat`; default now. */
  readonly issuedAt?: Date | undefined;
  /** Overrides the issuer's `iss`. */
  readonly issuer?: string | undefined;
  /** Overrides the issuer's `aud`. */
  readonly audience?: string | readonly string[] | undefined;
}

/** A signed test token with the principal a verifier must produce for it. */
export interface IssuedTestToken {
  readonly token: string;
  readonly principal: UserPrincipal;
}

/** A local JWKS endpoint. */
export interface TestJwksServer {
  /** `http://127.0.0.1:<port>/.well-known/jwks.json` (`AUTH_JWKS_URL`). */
  readonly url: string;
  /** Requests served so far. */
  readonly requests: () => number;
  close(): Promise<void>;
}

/** An Ed25519 access token issuer for tests. */
export interface TestJwtIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly kid: string;
  /** Public keys. */
  readonly jwks: JSONWebKeySet;
  /** Plug into `AuthModule.forRoot({ keyResolver: { useValue: issuer.keyResolver } })`. */
  readonly keyResolver: AccessTokenKeyResolver;
  /** Signs an access token for a principal (permissions follow from the roles). */
  issue(claims?: TestTokenClaims): Promise<IssuedTestToken>;
  /** Shorthand of `issue(claims).token`. */
  sign(claims?: TestTokenClaims): Promise<string>;
  /** Signs arbitrary claims with the issuer's key (negative tests). */
  signRaw(payload: JWTPayload): Promise<string>;
  /** Serves the JWKS over HTTP (exercises the remote JWKS resolver). */
  serveJwks(): Promise<TestJwksServer>;
}

/** Options of {@link createTestJwtIssuer}. */
export interface TestJwtIssuerOptions {
  /** Default `ais-its-auth`. */
  readonly issuer?: string | undefined;
  /** Default `ais-its-api`. */
  readonly audience?: string | undefined;
  /** Key id; default random. */
  readonly kid?: string | undefined;
}

/**
 * Generates an Ed25519 key pair and signs access tokens with the claims of
 * spec §8.2, so tests can authenticate any principal without the auth
 * service.
 *
 * @example
 * const jwt = await createTestJwtIssuer();
 * const app = await buildTestApp(AppModule, {
 *   config,
 *   overrides: [{ provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: jwt.keyResolver }],
 * });
 * const token = await jwt.sign({ roles: ['fleet_manager'], orgId });
 */
export async function createTestJwtIssuer(
  options: TestJwtIssuerOptions = {},
): Promise<TestJwtIssuer> {
  const issuer = options.issuer ?? DEFAULT_AUTH_ISSUER;
  const audience = options.audience ?? DEFAULT_AUTH_AUDIENCE;
  const kid = options.kid ?? `test-${newId()}`;
  const { publicKey, privateKey } = await generateKeyPair(
    ACCESS_TOKEN_ALGORITHM,
    { crv: 'Ed25519', extractable: true },
  );
  const jwk = await exportJWK(publicKey);
  const jwks: JSONWebKeySet = {
    keys: [{ ...jwk, kid, alg: ACCESS_TOKEN_ALGORITHM, use: 'sig' }],
  };
  const keyResolver = createLocalJWKSet(jwks);

  const signRaw = (payload: JWTPayload): Promise<string> =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, kid, typ: 'JWT' })
      .sign(privateKey);

  const issue = async (
    claims: TestTokenClaims = {},
  ): Promise<IssuedTestToken> => {
    const principal = new UserPrincipal({
      id: claims.userId ?? newId(),
      sessionId: claims.sessionId ?? newId(),
      orgId: claims.orgId ?? null,
      roles: claims.roles ?? ['viewer'],
      email: claims.email ?? 'user@ais-its.test',
      name: claims.name ?? 'Test User',
    });
    const iat = Math.floor((claims.issuedAt ?? new Date()).getTime() / 1000);
    const tokenAudience = claims.audience ?? audience;
    const token = await signRaw({
      iss: claims.issuer ?? issuer,
      aud:
        typeof tokenAudience === 'string' ? tokenAudience : [...tokenAudience],
      sub: principal.id,
      sid: principal.sessionId,
      org: principal.orgId,
      roles: [...principal.roles],
      email: principal.email,
      name: principal.name,
      typ: ACCESS_TOKEN_TYPE,
      iat,
      exp: iat + (claims.expiresInSeconds ?? ACCESS_TOKEN_TTL_SECONDS),
    });
    return { token, principal };
  };

  const serveJwks = async (): Promise<TestJwksServer> => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      if (request.method === 'GET' && request.url === JWKS_PATH) {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(jwks));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}${JWKS_PATH}`,
      requests: () => requests,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
    };
  };

  return {
    issuer,
    audience,
    kid,
    jwks,
    keyResolver,
    issue,
    sign: async (claims) => (await issue(claims)).token,
    signRaw,
    serveJwks,
  };
}
