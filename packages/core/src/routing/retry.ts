// Retry policy for routed model calls (docs/07 §9): which failures are worth another try, how
// long to wait (exponential backoff with jitter, honouring Retry-After up to a cap), and how a
// thrown error becomes a normalized error shape.
import { PROVIDER_ERROR_CODES, isNovaError, type ProviderErrorCode } from '@nova/shared';
import type { AgentErrorShape } from '@nova/providers';

export interface RetryPolicy {
  /** Retries of the same target before moving to the next (default 2). */
  maxRetries: number;
  /** Backoff base (default 500 ms): base·2^(n-1) plus up to one base of jitter. */
  baseMs: number;
  /** A Retry-After longer than this is not waited out; the router moves on (default 10 s). */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseMs: 500, maxRetryAfterMs: 10_000 };

const PROVIDER_CODES: ReadonlySet<string> = new Set(PROVIDER_ERROR_CODES);

/** Transient failures: retry the same target, then fall back. Everything else ends the turn. */
export function isTransient(e: AgentErrorShape): boolean {
  if (e.code === 'rate_limited' || e.code === 'timeout' || e.code === 'network') return true;
  return e.code === 'provider_error' && e.retryable;
}

/** Backoff before retry `n` (1-based). */
export function backoffMs(n: number, baseMs: number, random: () => number): number {
  return Math.round(baseMs * 2 ** (n - 1) + random() * baseMs);
}

/** Delay before retry `n`, or null when the provider asked for a longer wait than allowed. */
export function retryDelay(
  n: number,
  error: AgentErrorShape,
  policy: RetryPolicy,
  random: () => number,
): number | null {
  const after = error.retryAfterMs;
  if (after !== undefined && after > policy.maxRetryAfterMs) return null;
  return Math.max(backoffMs(n, policy.baseMs, random), after ?? 0);
}

/** A thrown error as a normalized error. Unknown throws are treated as network failures. */
export function toAgentError(err: unknown): AgentErrorShape {
  if (isNovaError(err)) {
    const code: ProviderErrorCode = PROVIDER_CODES.has(err.code)
      ? (err.code as ProviderErrorCode)
      : err.code === 'node_unavailable'
        ? 'network'
        : 'provider_error';
    const e: AgentErrorShape = { code, message: err.message, retryable: err.retryable };
    if (err.action) e.action = err.action;
    const after = err.details?.retryAfterMs;
    if (typeof after === 'number') e.retryAfterMs = after;
    return e;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'network', message: message || 'The connection failed', retryable: true };
}

/** Resolves true after `ms`, or false as soon as the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
