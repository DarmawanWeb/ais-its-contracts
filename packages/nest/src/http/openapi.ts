import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
} from '@darmawanweb/ais-its-contracts/api';
import { HTTP_HEADERS } from '@darmawanweb/ais-its-contracts/auth';
import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import * as z from 'zod';

import { DOCS_PATH, OPENAPI_JSON_PATH } from './global-prefix.js';
import { SECURITY_SCHEMES } from './openapi-security.js';

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
 * Builds the OpenAPI document of an application that is created but not
 * necessarily initialized (no connection is needed): metadata, the bearer,
 * `X-API-Key` and `X-Internal-Token` security schemes (bearer is the default
 * requirement), tags and problem responses.
 */
export function buildOpenApiDocument(
  app: INestApplication,
  options: OpenApiOptions,
): OpenAPIObject {
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
  if (options.description !== undefined)
    builder.setDescription(options.description);
  for (const server of options.servers ?? []) builder.addServer(server);
  for (const tag of options.tags ?? []) {
    if (typeof tag === 'string') builder.addTag(tag);
    else builder.addTag(tag.name, tag.description);
  }
  return addProblemResponses(
    SwaggerModule.createDocument(app, builder.build()),
  );
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
