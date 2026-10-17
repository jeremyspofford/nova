// The auto-review circuit breaker (FR-085, docs/12 §6.1): 3 consecutive denials or 10 in the
// last 50 reviews trip it; a trip and a reset start the count over.
import { describe, expect, it } from 'vitest';
import {
  BREAKER_CONSECUTIVE,
  BREAKER_WINDOW,
  BREAKER_WINDOW_DENIALS,
  ReviewBreaker,
} from '../src/approvals/index.ts';

describe('ReviewBreaker', () => {
  it('trips on 3 consecutive denials and starts over', () => {
    expect([BREAKER_CONSECUTIVE, BREAKER_WINDOW, BREAKER_WINDOW_DENIALS]).toEqual([3, 50, 10]);
    const b = new ReviewBreaker();
    expect(b.record('run', true)).toBeNull();
    expect(b.record('run', true)).toBeNull();
    expect(b.record('run', true)).toEqual({ consecutiveDenials: 3, recentDenials: 3, window: 50 });
    expect(b.size).toBe(0);
    expect(b.record('run', true)).toBeNull();
  });

  it('resets the run of denials on an allow', () => {
    const b = new ReviewBreaker();
    b.record('run', true);
    b.record('run', true);
    expect(b.record('run', false)).toBeNull();
    expect(b.record('run', true)).toBeNull();
    expect(b.record('run', true)).toBeNull();
  });

  it('trips on 10 denials within the last 50 reviews', () => {
    const b = new ReviewBreaker();
    let trip = null;
    let i = 0;
    while (!trip && i < 100) {
      trip = b.record('run', i % 3 !== 2);
      i++;
    }
    expect(trip).toEqual({ consecutiveDenials: 2, recentDenials: 10, window: 50 });
    expect(i).toBe(14);
  });

  it('forgets denials older than the window', () => {
    const b = new ReviewBreaker();
    // 9 denials, then 50 allows push them out of the window.
    for (let i = 0; i < 9; i++) b.record('run', i % 2 === 0 || i === 8 ? true : false);
    for (let i = 0; i < 50; i++) b.record('run', false);
    for (let i = 0; i < 9; i++) expect(b.record('run', i % 2 === 0)).toBeNull();
  });

  it('keeps runs apart, resets on request and forgets the least recently reviewed', () => {
    const b = new ReviewBreaker();
    b.record('a', true);
    b.record('a', true);
    expect(b.record('b', true)).toBeNull();
    b.reset('a');
    expect(b.record('a', true)).toBeNull();
    for (let i = 0; i < 1000; i++) b.record(`k${i}`, false);
    expect(b.size).toBe(1000);
    // 'a' and 'b' were the least recently reviewed: forgotten, so they start over.
    expect(b.record('a', true)).toBeNull();
    expect(b.record('a', true)).toBeNull();
  });
});
