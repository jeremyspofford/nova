/** time.ts self-seeds from settings and tracks the live setting-changed
 *  event. The seam under test is the FLIP: an operator switching 12h/24h in
 *  Settings must change output without a reload. Asserted through AM/PM
 *  presence rather than exact strings, because toLocaleTimeString's exact
 *  shape belongs to the host locale, not to this code. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  getSettings: vi.fn().mockResolvedValue([
    { key: 'nova.time_format', value: '12h' },
  ]),
}));

describe('fmtTime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to 12h — the backend default it mirrors', async () => {
    const { fmtTime } = await import('../time');
    expect(fmtTime('2026-08-07T15:30:00Z')).toMatch(/AM|PM/i);
  });

  it('flips to 24h on the shared setting-changed event, no reload', async () => {
    const { fmtTime } = await import('../time');
    fmtTime('2026-08-07T15:30:00Z'); // first use seeds the listener
    window.dispatchEvent(new CustomEvent('nova:setting-changed', {
      detail: { key: 'nova.time_format', value: '24h' },
    }));
    expect(fmtTime('2026-08-07T15:30:00Z')).not.toMatch(/AM|PM/i);
  });

  it('ignores unrelated setting changes', async () => {
    const { fmtTime } = await import('../time');
    fmtTime('2026-08-07T15:30:00Z');
    window.dispatchEvent(new CustomEvent('nova:setting-changed', {
      detail: { key: 'nova.assistant_name', value: 'Iris' },
    }));
    expect(fmtTime('2026-08-07T15:30:00Z')).toMatch(/AM|PM/i);
  });
});

describe('fmtDateTime', () => {
  it('renders a full date and time from an ISO stamp', async () => {
    const { fmtDateTime } = await import('../time');
    const out = fmtDateTime('2026-08-07T15:30:00Z');
    expect(out).toContain('2026');
    expect(out).toMatch(/\d:\d\d/);
  });
});
