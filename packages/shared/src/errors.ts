// Error taxonomy shared by the Hub API (contracts/hub-api.md §6), providers (docs/07 §14) and
// server APIs (contracts/rest-api.md §6). Every error is a value with a stable code.

export const HUB_ERROR_CODES = [
  'auth_missing',
  'auth_expired',
  'token_required',
  'origin_rejected',
  'policy_denied',
  'approval_required',
  'rate_limited',
  'over_budget',
  'budget_exhausted',
  'goal_blocked',
  'capability_missing',
  'node_unavailable',
  'firmware_disabled',
  'oob_disabled',
  'sandbox_unavailable',
  'hook_untrusted',
  'request_expired',
  'validation',
  'conflict',
  'not_found',
  'server_error',
] as const;
export type HubErrorCode = (typeof HUB_ERROR_CODES)[number];

export const PROVIDER_ERROR_CODES = [
  'auth_missing',
  'auth_expired',
  'rate_limited',
  'over_budget',
  'context_length',
  'content_filter',
  'timeout',
  'network',
  'invalid_request',
  'provider_error',
  'cancelled',
  'unsupported',
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export type ErrorCode = HubErrorCode | ProviderErrorCode;

/** HTTP status for each Hub error code (contracts/rest-api.md §6 mapping). */
export const HTTP_STATUS: Record<HubErrorCode, number> = {
  auth_missing: 401,
  auth_expired: 401,
  token_required: 401,
  origin_rejected: 403,
  policy_denied: 403,
  approval_required: 403,
  rate_limited: 429,
  over_budget: 402,
  budget_exhausted: 402,
  goal_blocked: 409,
  capability_missing: 422,
  node_unavailable: 503,
  firmware_disabled: 403,
  oob_disabled: 403,
  sandbox_unavailable: 409,
  hook_untrusted: 403,
  request_expired: 410,
  validation: 400,
  conflict: 409,
  not_found: 404,
  server_error: 500,
};

const RETRYABLE = new Set<ErrorCode>(['rate_limited', 'timeout', 'network', 'node_unavailable']);

export interface NovaErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  /** A short, user-safe suggested action, e.g. "Reconnect account". */
  action?: string;
  cause?: unknown;
}

export class NovaError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly action: string | undefined;

  constructor(code: ErrorCode, message: string, opts: NovaErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'NovaError';
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.details = opts.details;
    this.action = opts.action;
  }

  /** The wire shape (contracts/README.md "Errors"). */
  toJSON(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details) body.details = this.details;
    if (this.action) body.action = this.action;
    return body;
  }
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  action?: string;
}

export function isNovaError(value: unknown): value is NovaError {
  return value instanceof NovaError;
}

export function httpStatusFor(code: ErrorCode): number {
  return (HTTP_STATUS as Record<string, number>)[code] ?? 500;
}
