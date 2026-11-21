import * as z from 'zod';

import { UuidSchema } from '../domain/id.js';
import { ACCESS_TOKEN_TYPE } from './constants.js';
import { parseRoles } from './roles.js';

/**
 * Zod schema of the access token (JWT) claims, spec 8.2. Signature, `iss`,
 * `aud` and `exp` are verified by the JWT library; this validates the shape.
 *
 * `roles` is forward compatible: unknown role names are dropped (granting
 * nothing) instead of rejecting the token.
 */
export const AccessTokenClaimsSchema = z
  .object({
    iss: z.string().min(1).describe('Issuer, "seemp-auth" by default'),
    aud: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .describe('Audience, "seemp-api" by default'),
    sub: UuidSchema.describe('User id'),
    sid: UuidSchema.describe('Session id (refresh token family)'),
    org: UuidSchema.nullable().describe('Active organization id'),
    roles: z
      .array(z.string())
      .transform((values) => parseRoles(values))
      .describe('Roles in the active organization plus platform roles'),
    email: z.string().min(3).max(320),
    name: z.string(),
    typ: z.literal(ACCESS_TOKEN_TYPE),
    iat: z.int().nonnegative().describe('Issued at, seconds since epoch'),
    exp: z.int().positive().describe('Expires at, seconds since epoch'),
  })
  .refine((claims) => claims.exp > claims.iat, {
    message: 'exp must be after iat',
    path: ['exp'],
  })
  .describe('Access token claims');

/** Validated access token claims. */
export type AccessTokenClaims = z.output<typeof AccessTokenClaimsSchema>;

/** Access token claims as signed by the auth service (before validation). */
export type AccessTokenClaimsInput = z.input<typeof AccessTokenClaimsSchema>;
