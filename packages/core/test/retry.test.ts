// Retry policy (docs/07 §9): transient classification, backoff with jitter, Retry-After cap,
// and thrown errors as normalized shapes.
import { describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import {
  DEFAULT_RETRY,
  abortableSleep,
  backoffMs,
  isTransient,
  retryDelay,
  toAgentError,
} from '../src/index.ts';

const e = (code: string, retryable: boolean, retryAfterMs?: number) =>
  ({
    code,
    message: code,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }) as never;

describe('retry policy', () => {
  it('classifies transient failures', () => {
    expect(isTransient(e('rate_limited', true))).toBe(true);
    expect(isTransient(e('timeout', false))).toBe(true);
    expect(isTransient(e('network', true))).toBe(true);
    expect(isTransient(e('provider_error', true))).toBe(true);
    expect(isTransient(e('provider_error', false))).toBe(false);
    for (const code of [
      'auth_expired',
      'auth_missing',
      'invalid_request',
      'context_length',
      'content_filter',
    ])
      expect(isTransient(e(code, true))).toBe(false);
  });

  it('backs off exponentially with jitter and honours Retry-After up to the cap', () => {
    expect(backoffMs(1, 500, () => 0)).toBe(500);
    expect(backoffMs(2, 500, () => 0)).toBe(1000);
    expect(backoffMs(1, 500, () => 0.5)).toBe(750);
    expect(retryDelay(1, e('rate_limited', true, 2_000), DEFAULT_RETRY, () => 0)).toBe(2_000);
    expect(retryDelay(2, e('rate_limited', true, 10), DEFAULT_RETRY, () => 0)).toBe(1_000);
    expect(retryDelay(1, e('rate_limited', true, 10_001), DEFAULT_RETRY, () => 0)).toBeNull();
    expect(retryDelay(1, e('network', true), DEFAULT_RETRY, () => 0)).toBe(500);
  });

  it('normalizes thrown errors', () => {
    expect(
      toAgentError(new NovaError('rate_limited', 'slow', { details: { retryAfterMs: 5 } })),
    ).toEqual({
      code: 'rate_limited',
      message: 'slow',
      retryable: true,
      retryAfterMs: 5,
    });
    expect(toAgentError(new NovaError('node_unavailable', 'gone'))).toMatchObject({
      code: 'network',
      retryable: true,
    });
    expect(toAgentError(new NovaError('server_error', 'x', { action: 'Retry' }))).toMatchObject({
      code: 'provider_error',
      action: 'Retry',
    });
    expect(toAgentError(new TypeError('fetch failed'))).toEqual({
      code: 'network',
      message: 'fetch failed',
      retryable: true,
    });
    expect(toAgentError('')).toMatchObject({ message: 'The connection failed' });
  });

  it('sleeps unless aborted', async () => {
    const ac = new AbortController();
    expect(await abortableSleep(0, ac.signal)).toBe(true);
    expect(await abortableSleep(1, ac.signal)).toBe(true);
    const p = abortableSleep(10_000, ac.signal);
    ac.abort();
    expect(await p).toBe(false);
    expect(await abortableSleep(5, ac.signal)).toBe(false);
  });
});
