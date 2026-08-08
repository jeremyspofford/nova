/** The derivations behind the spend card, eval census, goal refund line and
 *  notification history. Each is a reading of a backend contract; the cases
 *  pin the honest-zero rules (a missing ceiling is not a spent one, a state
 *  at zero still gets a chip) that a quick inline rewrite would lose. */
import { describe, expect, it } from 'vitest';
import type { SpendTokensRow } from '../api';
import {
  ceilingPct, censusLine, firstSentence, fmtTokens, refundLine,
  rollupBySourceModel, stateCounts,
} from '../observability';

describe('ceilingPct', () => {
  it('reads spend as a share of the ceiling, clamped at 100', () => {
    expect(ceilingPct(1, 4)).toBe(25);
    expect(ceilingPct(9, 4)).toBe(100);
    expect(ceilingPct(0, 4)).toBe(0);
  });

  it('a missing or nonsensical ceiling is null, never full', () => {
    expect(ceilingPct(3, null)).toBeNull();
    expect(ceilingPct(3, undefined)).toBeNull();
    expect(ceilingPct(3, 0)).toBeNull();
    expect(ceilingPct(3, -1)).toBeNull();
  });
});

describe('firstSentence', () => {
  it('takes the opening sentence of a paragraph-length wall reason', () => {
    const wall = 'the model provider refused the last pass and retrying '
      + 'cannot fix that, so nothing starts for another 323 minute(s). This '
      + 'wall has now been hit 8 times in a row.';
    expect(firstSentence(wall)).toBe(
      'the model provider refused the last pass and retrying cannot fix '
      + 'that, so nothing starts for another 323 minute(s).');
  });

  it('caps a sentence that never ends instead of overflowing the row', () => {
    const s = firstSentence('x'.repeat(500), 160);
    expect(s.length).toBe(160);
    expect(s.endsWith('…')).toBe(true);
  });

  it('returns a short reason whole', () => {
    expect(firstSentence('no goal')).toBe('no goal');
  });
});

describe('refundLine', () => {
  const goal = {
    actions_used: 13, max_actions: 20, refunds: 8,
    last_refund_reason: 'provider billing refusal: API Error: 402 more credits needed',
  };

  it('states used, refunded, and the wall clause before the quoted error', () => {
    expect(refundLine(goal)).toBe('13/20 used — 8 refunded: provider billing refusal');
  });

  it('is null when nothing was refunded — the plain counter covers that goal', () => {
    expect(refundLine({ ...goal, refunds: 0 })).toBeNull();
  });

  it('stands without a recorded reason rather than printing null', () => {
    expect(refundLine({ ...goal, last_refund_reason: null }))
      .toBe('13/20 used — 8 refunded');
  });
});

describe('censusLine', () => {
  it('orders by lifecycle and states zeros — never absent', () => {
    expect(censusLine({ failed: 12, running: 0, error: 2, passed: 3 }))
      .toBe('0 running · 3 passed · 12 failed · 2 error');
  });

  it('appends a status the backend grows later instead of dropping it', () => {
    expect(censusLine({ passed: 1, cancelled: 4 })).toBe('1 passed · 4 cancelled');
  });
});

describe('rollupBySourceModel', () => {
  const row = (day: string, source: string, model: string,
    tokens: number, unmetered = 0): SpendTokensRow => ({
    day, source, model, calls: 1, unmetered_calls: unmetered,
    prompt_tokens: tokens, completion_tokens: 0, tokens,
  });

  it('collapses days into source×model, biggest spender first', () => {
    const out = rollupBySourceModel([
      row('2026-08-08', 'eval', 'a', 100),
      row('2026-08-07', 'eval', 'a', 50),
      row('2026-08-08', 'chat', 'b', 400),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ source: 'chat', model: 'b', tokens: 400 });
    expect(out[1]).toMatchObject({ source: 'eval', model: 'a', tokens: 150, calls: 2 });
  });

  it('carries the unmetered count through — the honesty flag sums too', () => {
    const out = rollupBySourceModel([
      row('2026-08-08', 'chat', 'b', 0, 3),
      row('2026-08-07', 'chat', 'b', 0, 2),
    ]);
    expect(out[0].unmetered_calls).toBe(5);
  });

  it('keeps the same model apart under two sources', () => {
    const out = rollupBySourceModel([
      row('2026-08-08', 'eval', 'm', 10),
      row('2026-08-08', 'chat', 'm', 10),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('stateCounts', () => {
  it('counts by state with every known state present at zero', () => {
    const counts = stateCounts([
      { state: 'failed' }, { state: 'failed' }, { state: 'opened' },
    ]);
    expect(counts).toEqual({ pending: 0, accepted: 0, opened: 1, failed: 2 });
  });

  it('still counts a state it does not know', () => {
    expect(stateCounts([{ state: 'bounced' }]).bounced).toBe(1);
  });
});

describe('fmtTokens', () => {
  it('is exact below 10k and compact above', () => {
    expect(fmtTokens(9_999)).toBe('9,999');
    expect(fmtTokens(676_415)).toBe('676.4k');
    expect(fmtTokens(2_500_000)).toBe('2.50M');
  });
});
