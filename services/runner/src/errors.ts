// The runner's errors, in the shape of contracts/rest-api.md §6:
// `{error: {code, message, retryable, details}, requestId}`.

export type RunnerErrorCode =
  | 'validation'
  | 'auth_missing'
  | 'auth_invalid'
  | 'not_found'
  | 'conflict'
  | 'quota_exceeded'
  | 'too_large'
  | 'rate_limited'
  | 'not_implemented'
  | 'sandbox_unavailable'
  | 'server_error';

const STATUS: Record<RunnerErrorCode, number> = {
  validation: 400,
  auth_missing: 401,
  auth_invalid: 401,
  not_found: 404,
  conflict: 409,
  quota_exceeded: 409,
  too_large: 413,
  rate_limited: 429,
  not_implemented: 501,
  sandbox_unavailable: 503,
  server_error: 500,
};

const RETRYABLE = new Set<RunnerErrorCode>(['rate_limited', 'sandbox_unavailable']);

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: RunnerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
    this.retryable = RETRYABLE.has(code);
  }
}

export function isRunnerError(e: unknown): e is RunnerError {
  return e instanceof RunnerError;
}
