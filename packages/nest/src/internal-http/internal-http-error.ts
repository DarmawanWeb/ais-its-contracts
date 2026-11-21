import type { ProblemDetails } from '@darmawanweb/ais-its-contracts/api';

/** Why an internal HTTP call failed. */
export type InternalHttpFailure =
  /** The server answered with a non-2xx status. */
  | 'http_status'
  /** No response within the timeout. */
  | 'timeout'
  /** Connection refused/reset, DNS failure, … */
  | 'network'
  /** 2xx response whose body is not the expected JSON. */
  | 'invalid_response';

/** Members of an {@link InternalHttpError}. */
export interface InternalHttpErrorInit {
  readonly failure: InternalHttpFailure;
  readonly method: string;
  readonly url: string;
  readonly status?: number | undefined;
  readonly problem?: ProblemDetails | undefined;
  readonly attempts: number;
  readonly cause?: unknown;
}

/**
 * Failure of an {@link InternalHttpClient} call. For non-2xx answers the
 * RFC 9457 body of the other service is parsed into `problem` (and `code`),
 * so callers can branch on stable error codes.
 */
export class InternalHttpError extends Error {
  override readonly name = 'InternalHttpError';
  readonly failure: InternalHttpFailure;
  readonly method: string;
  /** Requested URL (without credentials). */
  readonly url: string;
  /** HTTP status when the server answered. */
  readonly status: number | undefined;
  /** Problem details sent by the server, when it sent some. */
  readonly problem: ProblemDetails | undefined;
  /** Attempts made (1 + retries). */
  readonly attempts: number;

  constructor(init: InternalHttpErrorInit) {
    const reason =
      init.status === undefined
        ? init.failure
        : `HTTP ${init.status}${init.problem === undefined ? '' : ` ${init.problem.code}`}`;
    super(`${init.method} ${init.url} failed: ${reason}`, {
      cause: init.cause,
    });
    this.failure = init.failure;
    this.method = init.method;
    this.url = init.url;
    this.status = init.status;
    this.problem = init.problem;
    this.attempts = init.attempts;
  }

  /** Error code of the problem details, when the server sent some. */
  get code(): string | undefined {
    return this.problem?.code;
  }

  /** `true` for timeouts, network errors and 5xx answers. */
  get isTransient(): boolean {
    return (
      this.failure === 'timeout' ||
      this.failure === 'network' ||
      (this.status !== undefined && this.status >= 500)
    );
  }
}
