// Circuit breaker states (docs/07 §9): closed → open after 3 failures → one half-open probe
// after 30 s → closed on success or open again on failure.
import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../src/index.ts';

describe('CircuitBreaker', () => {
  it('opens after three consecutive failures and admits one probe after the cooldown', () => {
    let now = 0;
    const b = new CircuitBreaker({ now: () => now });
    expect(b.state('k')).toBe('closed');
    b.failure('k');
    b.failure('k');
    expect(b.tryAcquire('k')).toBe(true);
    b.failure('k');
    expect(b.state('k')).toBe('open');
    expect(b.tryAcquire('k')).toBe(false);
    now = 29_999;
    expect(b.tryAcquire('k')).toBe(false);
    now = 30_000;
    expect(b.state('k')).toBe('half_open');
    expect(b.tryAcquire('k')).toBe(true);
    expect(b.tryAcquire('k')).toBe(false); // one probe at a time
    b.success('k');
    expect(b.state('k')).toBe('closed');
    expect(b.tryAcquire('other')).toBe(true);
  });

  it('reopens for a full cooldown when the probe fails, and frees the slot on release', () => {
    let now = 0;
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 100, now: () => now });
    b.failure('k');
    now = 100;
    expect(b.tryAcquire('k')).toBe(true);
    b.failure('k');
    expect(b.state('k')).toBe('open');
    now = 150;
    expect(b.tryAcquire('k')).toBe(false);
    now = 200;
    expect(b.tryAcquire('k')).toBe(true);
    b.release('k');
    expect(b.tryAcquire('k')).toBe(true);
    b.release('missing');
  });

  it('resets the failure count on success', () => {
    const b = new CircuitBreaker();
    b.failure('k');
    b.failure('k');
    b.success('k');
    b.failure('k');
    b.failure('k');
    expect(b.state('k')).toBe('closed');
  });
});
