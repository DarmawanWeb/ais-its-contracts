import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
} from '@darmawanweb/ais-its-contracts/api';
import {
  HTTP_HEADERS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_PATH,
} from '@darmawanweb/ais-its-contracts/auth';
import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  type SecuritySchemeObject,
  SwaggerModule,
} from '@nestjs/swagger';
import * as z from 'zod';

import { DOCS_PATH, OPENAPI_JSON_PATH } from './global-prefix.js';
import {
  PLATFORM_ADMIN_DESCRIPTION,
  PLATFORM_ADMIN_ROLES_EXTENSION,
  SECURITY_SCHEMES,
} from './openapi-security.js';

/** A tag of the OpenAPI document. */
export interface OpenApiTag {
  readonly name: string;
  readonly description?: string | undefined;
}

/** Metadata of a service's OpenAPI document. */
export interface OpenApiOptions {
  readonly title: string;
  readonly description?: string | undefined;
  /** API version (usually the package version). */
  readonly version: string;
  readonly tags?: readonly (string | OpenApiTag)[] | undefined;
  /** `servers[].url`; default: none (same origin). */
  readonly servers?: readonly string[] | undefined;
  /**
   * Security schemes beyond the platform's `bearer`, `apiKey` and
   * `internalToken` (`components.securitySchemes`), by name, e.g.
   * `{ refreshCookie: REFRESH_COOKIE_SECURITY_SCHEME }` for operations
   * decorated with `@ApiCookieAuth('refreshCookie')`. Every scheme an
   * operation references must be declared (see {@link OpenApiSecurityError}).
   */
  readonly securitySchemes?:
    Readonly<Record<string, SecuritySchemeObject>> | undefined;
}

/**
 * The refresh token cookie of the auth service as an OpenAPI security scheme
 * (`apiKey` in the HttpOnly cookie `aisits_rt`, path `/api/v2/auth`).
 *
 * @example
 * openapi: { title, version, securitySchemes: { refreshCookie: REFRESH_COOKIE_SECURITY_SCHEME } }
 * // on the refresh and logout operations:
 * @Public() @ApiCookieAuth('refreshCookie') @Post('refresh') refresh() {}
 */
export const REFRESH_COOKIE_SECURITY_SCHEME: Readonly<SecuritySchemeObject> =
  Object.freeze({
    type: 'apiKey',
    in: 'cookie',
    name: REFRESH_TOKEN_COOKIE,
    description: `Refresh token (HttpOnly cookie ${REFRESH_TOKEN_COOKIE}, path ${REFRESH_TOKEN_COOKIE_PATH})`,
  });

/**
 * The document is invalid: operations reference security schemes that are
 * not declared (e.g. `@ApiCookieAuth('x')` without `securitySchemes.x`), or
 * `securitySchemes` redefines a platform scheme.
 */
export class OpenApiSecurityError extends Error {
  override readonly name = 'OpenApiSecurityError';

  /**
   * @param problems one line per undeclared reference or invalid
   *   declaration, e.g. `POST /api/v2/auth/refresh references undeclared scheme "x"`.
   */
  constructor(readonly problems: readonly string[]) {
    super(
      `Invalid OpenAPI security: ${problems.join('; ')}. ` +
        'Declare the schemes in OpenApiOptions.securitySchemes.',
    );
  }
}

/** Name of the shared problem details schema in `components.schemas`. */
export const PROBLEM_DETAILS_SCHEMA_NAME = 'ProblemDetails';

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

type SchemaObject = NonNullable<
  NonNullable<OpenAPIObject['components']>['schemas']
>[string];

/** The contracts `ProblemDetailsSchema` as an OpenAPI 3.0 schema object. */
function problemDetailsSchema(): SchemaObject {
  return z.toJSONSchema(ProblemDetailsSchema, {
    target: 'openapi-3.0',
  }) as SchemaObject;
}

/**
 * Declares the problem details schema and adds a `default` response
 * (`application/problem+json`) to every operation that has none, so that
 * generated clients know the error shape of spec §5.
 */
export function addProblemResponses(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas[PROBLEM_DETAILS_SCHEMA_NAME] ??=
    problemDetailsSchema();
  for (const pathItem of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) continue;
      operation.responses.default ??= {
        description: 'Problem details (RFC 9457)',
        content: {
          [PROBLEM_CONTENT_TYPE]: {
            schema: {
              $ref: `#/components/schemas/${PROBLEM_DETAILS_SCHEMA_NAME}`,
            },
          },
        },
      };
    }
  }
  return document;
}

/**
 * Adds {@link PLATFORM_ADMIN_DESCRIPTION} to the description of every
 * operation that requires a platform administrator (`@RequirePlatformAdmin`,
 * `x-required-roles: ["super_admin"]`), keeping its own description first.
 */
export function addPlatformAdminDescriptions(
  document: OpenAPIObject,
): OpenAPIObject {
  for (const pathItem of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) continue;
      const roles: unknown = (operation as unknown as Record<string, unknown>)[
        PLATFORM_ADMIN_ROLES_EXTENSION
      ];
      if (!Array.isArray(roles) || !roles.includes('super_admin')) continue;
      const own = operation.description ?? '';
      if (own.includes(PLATFORM_ADMIN_DESCRIPTION)) continue;
      operation.description =
        own === ''
          ? PLATFORM_ADMIN_DESCRIPTION
          : `${own}\n\n${PLATFORM_ADMIN_DESCRIPTION}`;
    }
  }
  return document;
}

/** Names of the security schemes referenced by the document and its operations, with where. */
function securityReferences(
  document: OpenAPIObject,
): { readonly scheme: string; readonly where: string }[] {
  const references: { scheme: string; where: string }[] = [];
  for (const requirement of document.security ?? [])
    for (const scheme of Object.keys(requirement))
      references.push({ scheme, where: 'the document' });
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      for (const requirement of operation?.security ?? [])
        for (const scheme of Object.keys(requirement))
          references.push({
            scheme,
            where: `${method.toUpperCase()} ${path}`,
          });
    }
  }
  return references;
}

/**
 * Checks that every security scheme the document references is declared
 * in `components.securitySchemes` (OpenAPI 3: an undeclared name makes the
 * document invalid, and generated clients drop the requirement).
 *
 * @throws {OpenApiSecurityError} listing each undeclared reference.
 */
export function assertSecuritySchemesDeclared(document: OpenAPIObject): void {
  const declared = new Set(
    Object.keys(document.components?.securitySchemes ?? {}),
  );
  const problems = [
    ...new Set(
      securityReferences(document)
        .filter(({ scheme }) => !declared.has(scheme))
        .map(
          ({ scheme, where }) =>
            `${where} references undeclared scheme "${scheme}"`,
        ),
    ),
  ];
  if (problems.length > 0) throw new OpenApiSecurityError(problems);
}

const PLATFORM_SCHEME_NAMES: ReadonlySet<string> = new Set(
  Object.values(SECURITY_SCHEMES),
);

/**
 * Builds the OpenAPI document of an application that is created but not
 * necessarily initialized (no connection is needed): metadata, the bearer,
 * `X-API-Key` and `X-Internal-Token` security schemes (bearer is the default
 * requirement) plus `options.securitySchemes`, tags, problem responses and
 * the platform-administrator note of `@RequirePlatformAdmin` operations.
 *
 * @throws {OpenApiSecurityError} when an operation references an undeclared
 *   security scheme, or `securitySchemes` redefines a platform scheme.
 */
export function buildOpenApiDocument(
  app: INestApplication,
  options: OpenApiOptions,
): OpenAPIObject {
  const redefined = Object.keys(options.securitySchemes ?? {}).filter((name) =>
    PLATFORM_SCHEME_NAMES.has(name),
  );
  if (redefined.length > 0) {
    throw new OpenApiSecurityError(
      redefined.map(
        (name) =>
          `securitySchemes.${name} redefines a platform scheme (bearer, apiKey and internalToken are fixed)`,
      ),
    );
  }
  const builder = new DocumentBuilder()
    .setTitle(options.title)
    .setVersion(options.version)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token (EdDSA JWT)',
      },
      SECURITY_SCHEMES.BEARER,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: HTTP_HEADERS.API_KEY,
        description: 'API key sk_<id>_<secret>',
      },
      SECURITY_SCHEMES.API_KEY,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: HTTP_HEADERS.INTERNAL_TOKEN,
        description: 'Service-to-service token',
      },
      SECURITY_SCHEMES.INTERNAL_TOKEN,
    )
    .addSecurityRequirements(SECURITY_SCHEMES.BEARER);
  for (const [name, scheme] of Object.entries(options.securitySchemes ?? {}))
    builder.addSecurity(name, { ...scheme });
  if (options.description !== undefined)
    builder.setDescription(options.description);
  for (const server of options.servers ?? []) builder.addServer(server);
  for (const tag of options.tags ?? []) {
    if (typeof tag === 'string') builder.addTag(tag);
    else builder.addTag(tag.name, tag.description);
  }
  const document = addPlatformAdminDescriptions(
    addProblemResponses(SwaggerModule.createDocument(app, builder.build())),
  );
  assertSecuritySchemesDeclared(document);
  return document;
}

/** Serves Swagger UI at `/docs` and the document at `/openapi.json` (outside the prefix). */
export function setupSwagger(
  app: INestApplication,
  document: OpenAPIObject,
  title: string,
): void {
  SwaggerModule.setup(DOCS_PATH, app, document, {
    useGlobalPrefix: false,
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    raw: ['json'],
    customSiteTitle: title,
  });
}

/** Writes a document as pretty JSON (with a trailing newline, for commits). */
export async function writeOpenApiDocument(
  document: OpenAPIObject,
  outFile: string,
): Promise<void> {
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, serializeOpenApiDocument(document), 'utf8');
}

/** The committed form of a document: 2-space JSON with a final newline. */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
