// Hybrid logical clocks (ADR-010): fixed-width values sort in clock order, the clock never goes
// back (a wall clock stepping backwards, a restart from the persisted value), a remote clock ahead
// pulls it forward, and pushed clocks are checked for their node and their skew.
import { describe, expect, it } from 'vitest';
import {
  HLC_MAX_COUNTER,
  HybridClock,
  compareHlc,
  formatHlc,
  hlcProblem,
  maxHlc,
  parseHlc,
} from '../src/index.ts';

const T = Date.parse('2026-10-17T09:00:00.000Z');

describe('HLC values', () => {
  it('formats with fixed widths and parses back', () => {
    const v = formatHlc({ pt: T, c: 10, node: 'hub' });
    expect(v).toBe(`00${T}-000a-hub`);
    expect(parseHlc(v)).toEqual({ pt: T, c: 10, node: 'hub' });
    const dev = formatHlc({ pt: T, c: 0, node: '01920000-0000-7000-8000-0000000000d1' });
    expect(parseHlc(dev)?.node).toBe('01920000-0000-7000-8000-0000000000d1');
  });

  it('refuses malformed values', () => {
    for (const bad of [
      '',
      'x',
      `${T}-0000-hub`,
      `00${T}-000g-hub`,
      `00${T}-0000-`,
      `00${T}-0000-a b`,
    ])
      expect(parseHlc(bad)).toBeNull();
  });

  it('orders by physical time, then counter, then node', () => {
    const a = formatHlc({ pt: T, c: 0, node: 'zzz' });
    const b = formatHlc({ pt: T, c: 1, node: 'aaa' });
    const c = formatHlc({ pt: T + 1, c: 0, node: 'aaa' });
    const d = formatHlc({ pt: T + 1, c: 0, node: 'bbb' });
    expect([d, c, b, a].sort(compareHlc)).toEqual([a, b, c, d]);
    expect(compareHlc(a, a)).toBe(0);
    expect(compareHlc('', a)).toBeLessThan(0);
    expect(maxHlc(a, d)).toBe(d);
    expect(maxHlc(d, a)).toBe(d);
  });
});

describe('HybridClock', () => {
  it('ticks forward with the wall clock and counts within one millisecond', () => {
    let now = T;
    const clock = new HybridClock({ node: 'hub', now: () => now });
    const one = clock.tick();
    const two = clock.tick();
    expect(parseHlc(one)).toEqual({ pt: T, c: 0, node: 'hub' });
    expect(parseHlc(two)).toEqual({ pt: T, c: 1, node: 'hub' });
    now = T + 5;
    expect(parseHlc(clock.tick())).toEqual({ pt: T + 5, c: 0, node: 'hub' });
  });

  it('never goes back when the wall clock steps backwards', () => {
    let now = T;
    const clock = new HybridClock({ node: 'hub', now: () => now });
    const before = clock.tick();
    now = T - 60_000;
    const after = clock.tick();
    expect(compareHlc(after, before)).toBeGreaterThan(0);
    expect(parseHlc(after)).toEqual({ pt: T, c: 1, node: 'hub' });
  });

  it('continues after a restart from the persisted value even with an earlier wall clock', () => {
    const first = new HybridClock({ node: 'hub', now: () => T });
    first.tick();
    const persisted = first.tick();
    const second = new HybridClock({ node: 'hub', now: () => T - 3_600_000, initial: persisted });
    expect(second.last()).toBe(persisted);
    expect(compareHlc(second.tick(), persisted)).toBeGreaterThan(0);
  });

  it('moves past a remote clock that is ahead, and past its own when the remote is behind', () => {
    const clock = new HybridClock({ node: 'hub', now: () => T });
    const remote = formatHlc({ pt: T + 2_000, c: 7, node: 'dev' });
    const local = clock.receive(remote);
    expect(parseHlc(local)).toEqual({ pt: T + 2_000, c: 8, node: 'hub' });
    expect(compareHlc(clock.tick(), remote)).toBeGreaterThan(0);
    // Same physical time on both sides: the larger counter wins, plus one.
    const same = new HybridClock({
      node: 'hub',
      now: () => T,
      initial: formatHlc({ pt: T, c: 3, node: 'hub' }),
    });
    expect(parseHlc(same.receive(formatHlc({ pt: T, c: 9, node: 'dev' })))?.c).toBe(10);
    // A remote behind only bumps the counter.
    const ahead = new HybridClock({
      node: 'hub',
      now: () => T,
      initial: formatHlc({ pt: T + 50, c: 2, node: 'hub' }),
    });
    expect(parseHlc(ahead.receive(formatHlc({ pt: T, c: 0, node: 'dev' })))).toEqual({
      pt: T + 50,
      c: 3,
      node: 'hub',
    });
    // A remote and local both behind the wall clock: the wall clock wins.
    const wall = new HybridClock({ node: 'hub', now: () => T + 9_000 });
    expect(parseHlc(wall.receive(formatHlc({ pt: T, c: 4, node: 'dev' })))).toEqual({
      pt: T + 9_000,
      c: 0,
      node: 'hub',
    });
    // A malformed remote changes nothing.
    expect(wall.receive('nonsense')).toBe(wall.last());
  });

  it('moves the physical part on when the counter overflows', () => {
    const clock = new HybridClock({
      node: 'hub',
      now: () => T,
      initial: formatHlc({ pt: T, c: HLC_MAX_COUNTER, node: 'hub' }),
    });
    expect(parseHlc(clock.tick())).toEqual({ pt: T + 1, c: 0, node: 'hub' });
  });
});

describe('pushed clocks', () => {
  const node = '01920000-0000-7000-8000-0000000000d1';
  const opts = { node, nowMs: T, maxSkewMs: 300_000 };

  it('accepts a clock of the pushing device within the skew limit', () => {
    expect(hlcProblem(formatHlc({ pt: T + 299_000, c: 0, node }), opts)).toBeNull();
    expect(hlcProblem(formatHlc({ pt: T - 86_400_000, c: 0, node }), opts)).toBeNull();
  });

  it('refuses a device far in the future, another node, or garbage', () => {
    expect(hlcProblem(formatHlc({ pt: T + 301_000, c: 0, node }), opts)).toBe('clock_skew');
    expect(hlcProblem(formatHlc({ pt: T, c: 0, node: 'hub' }), opts)).toBe('hlc_device_mismatch');
    expect(hlcProblem('soon', opts)).toBe('invalid_hlc');
  });
});
