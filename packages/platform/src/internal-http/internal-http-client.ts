import { setTimeout as sleep } from 'node:timers/promises';

import { HTTP_HEADERS } from '@darmawanweb/seemp-contracts/auth';
import {
  isProblemDetails,
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
} from '@darmawanweb/seemp-contracts/api';
import type * as z from 'zod';

import type { BaseConfig } from '../config/env-schema.js';
import { injectTraceContext } from '../telemetry/trace-context.js';
import { InternalHttpError } from './internal-http-error.js';

/** HTTP methods of {@link InternalHttpClient}. */
export type InternalHttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const IDEMPOTENT_METHODS: ReadonlySet<InternalHttpMethod> = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

/** Statuses worth retrying for idempotent requests. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/** Options of {@link InternalHttpClient}. */
export interface InternalHttpClientOptions {
  /** Base URL of the other service, e.g. `AUTH_INTERNAL_URL`. */
  readonly baseUrl: string;
  /** Sent as `X-Internal-Token` (required by `/internal/*` routes). */
  readonly internalToken?: string | undefined;
  /** Timeout of one attempt in ms. Default 5000. */
  readonly timeoutMs?: number | undefined;
  /** Additional attempts of idempotent requests. Default 2. */
  readonly retries?: number | undefined;
  /** Base of the exponential backoff with full jitter, in ms. Default 100. */
  readonly retryBaseDelayMs?: number | undefined;
  /** Upper bound of one backoff delay in ms. Default 2000. */
  readonly retryMaxDelayMs?: number | undefined;
  /** `User-Agent`, e.g. `fleet/0.1.0`. */
  readonly userAgent?: string | undefined;
  /** Headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** `fetch` implementation (tests). Default `globalThis.fetch`. */
  readonly fetch?: typeof fetch | undefined;
}

/** Options of one request. */
export interface InternalRequestOptions<T> {
  /** Query string parameters (`undefined` values are skipped). */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
  /** JSON body. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Validates (and types) the JSON response. */
  readonly schema?: z.ZodType<T> | undefined;
  /**
   * Allows retries of a non-idempotent method (e.g. a read-only POST such as
   * the API key introspection). GET, HEAD, PUT and DELETE are retried anyway.
   */
  readonly idempotent?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  /** Propagated as `X-Request-Id`. */
  readonly requestId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Full jitter: a random delay in `[0, min(max, base * 2^attempt))`. */
export function backoffWithJitter(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Client for service-to-service calls: base URL, `X-Internal-Token`, JSON in
 * and out, a timeout per attempt, limited retries with jittered exponential
 * backoff for idempotent requests (network errors, timeouts, 502/503/504),
 * W3C trace context propagation and problem-details aware errors
 * ({@link InternalHttpError}).
 *
 * @example
 * const auth = new InternalHttpClient({ baseUrl: config.AUTH_INTERNAL_URL, internalToken: config.INTERNAL_TOKEN });
 * const result = await auth.post('/internal/api-keys/introspect', { key }, {
 *   schema: ApiKeyIntrospectionResultSchema, idempotent: true,
 * });
 */
export class InternalHttpClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: InternalHttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * A client for another platform service with this service's credentials:
   * `X-Internal-Token: INTERNAL_TOKEN` and `User-Agent: SERVICE_NAME/SERVICE_VERSION`.
   *
   * @example
   * const fleet = InternalHttpClient.forService(config, 'http://fleet:3002');
   */
  static forService(
    config: Pick<BaseConfig, 'INTERNAL_TOKEN' | 'SERVICE_NAME' | 'SERVICE_VERSION'>,
    baseUrl: string,
    options: Omit<InternalHttpClientOptions, 'baseUrl'> = {},
  ): InternalHttpClient {
    return new InternalHttpClient({
      internalToken: config.INTERNAL_TOKEN,
      userAgent: `${config.SERVICE_NAME}/${config.SERVICE_VERSION}`,
      ...options,
      baseUrl,
    });
  }

  /** `GET path`. */
  get<T = unknown>(path: string, options: InternalRequestOptions<T> = {}): Promise<T> {
    return this.request('GET', path, options);
  }

  /** `POST path` with a JSON body. */
  post<T = unknown>(path: string, body?: unknown, options: InternalRequestOptions<T> = {}): Promise<T> {
    return this.request('POST', path, { ...options, body });
  }

  /** `PUT path` with a JSON body. */
  put<T = unknown>(path: string, body?: unknown, options: InternalRequestOptions<T> = {}): Promise<T> {
    return this.request('PUT', path, { ...options, body });
  }

  /** `PATCH path` with a JSON body. */
  patch<T = unknown>(path: string, body?: unknown, options: InternalRequestOptions<T> = {}): Promise<T> {
    return this.request('PATCH', path, { ...options, body });
  }

  /** `DELETE path`. */
  delete<T = unknown>(path: string, options: InternalRequestOptions<T> = {}): Promise<T> {
    return this.request('DELETE', path, options);
  }

  /**
   * Sends a request and returns the JSON response (`undefined` for empty
   * bodies), validated with `options.schema` when given.
   *
   * @throws {InternalHttpError} on non-2xx answers, timeouts, network errors
   * and invalid responses (after the retries).
   */
  async request<T = unknown>(
    method: InternalHttpMethod,
    path: string,
    options: InternalRequestOptions<T> = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const retryable = IDEMPOTENT_METHODS.has(method) || options.idempotent === true;
    const maxAttempts = 1 + (retryable ? Math.max(0, this.options.retries ?? 2) : 0);

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(method, url, options, attempt);
      } catch (error) {
        const transient =
          error instanceof InternalHttpError &&
          (error.failure === 'network' ||
            error.failure === 'timeout' ||
            (error.status !== undefined && RETRYABLE_STATUSES.has(error.status)));
        if (!transient || attempt >= maxAttempts || options.signal?.aborted === true) throw error;
        await sleep(
          backoffWithJitter(
            attempt - 1,
            this.options.retryBaseDelayMs ?? 100,
            this.options.retryMaxDelayMs ?? 2000,
          ),
        );
      }
    }
  }

  private buildUrl(
    path: string,
    query: InternalRequestOptions<unknown>['query'],
  ): URL {
    const url = new URL(path.replace(/^\/+/, ''), this.baseUrl);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return url;
  }

  private buildHeaders(options: InternalRequestOptions<unknown>): Headers {
    const headers = new Headers(this.options.headers);
    headers.set('accept', `application/json, ${PROBLEM_CONTENT_TYPE}`);
    if (this.options.userAgent !== undefined) headers.set('user-agent', this.options.userAgent);
    if (this.options.internalToken !== undefined) {
      headers.set(HTTP_HEADERS.INTERNAL_TOKEN, this.options.internalToken);
    }
    if (options.requestId !== undefined) headers.set(HTTP_HEADERS.REQUEST_ID, options.requestId);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    injectTraceContext(headers);
    return headers;
  }

  private async attempt<T>(
    method: InternalHttpMethod,
    url: URL,
    options: InternalRequestOptions<T>,
    attempt: number,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.options.timeoutMs ?? 5000);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
    const target = `${url.origin}${url.pathname}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.buildHeaders(options),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
      });
    } catch (error) {
      throw new InternalHttpError({
        failure: isAbortError(error) ? 'timeout' : 'network',
        method,
        url: target,
        attempts: attempt,
        cause: error,
      });
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      throw new InternalHttpError({
        failure: 'http_status',
        method,
        url: target,
        status: response.status,
        problem: parseProblem(text),
        attempts: attempt,
      });
    }
    if (text === '') {
      if (options.schema === undefined) return undefined as T;
      return this.validate(options.schema, undefined, method, target, attempt);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new InternalHttpError({
        failure: 'invalid_response',
        method,
        url: target,
        status: response.status,
        attempts: attempt,
        cause: error,
      });
    }
    if (options.schema === undefined) return json as T;
    return this.validate(options.schema, json, method, target, attempt);
  }

  private validate<T>(
    schema: z.ZodType<T>,
    value: unknown,
    method: InternalHttpMethod,
    url: string,
    attempt: number,
  ): T {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw new InternalHttpError({
      failure: 'invalid_response',
      method,
      url,
      attempts: attempt,
      cause: result.error,
    });
  }
}

function parseProblem(text: string): ProblemDetails | undefined {
  if (text === '') return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isProblemDetails(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
