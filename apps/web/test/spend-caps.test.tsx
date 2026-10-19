// Spend caps and provider limits (FR-116, FR-115; docs/14 §6): caps per cloud provider on Profile &
// usage (period, warning threshold, hard stop; set, change, remove after asking; refusals in
// words; `?cap=` opens one; members manage their own), "clear usage data", each account's limits
// and spend on Accounts, and the cap-reached error in a chat linking to the cap.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import {
  capPath,
  capReachedProvider,
  dataErrorMessage,
  formatSize,
  formatUsd,
  parseCapDraft,
  retentionOptions,
  secretGroups,
  sweepCounts,
} from '../src/datactl/format.ts';
import { ProviderLimitsSection } from '../src/datactl/ProviderLimits.tsx';
import { ProfilePage } from '../src/settings/ProfilePage.tsx';
import { FakeEventSource, createHub, message, thread } from './fakes.ts';
import { cap, renderWithDatactl } from './fakes-m8-datactl.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const caps = () => screen.getByRole('region', { name: 'Spend caps' });
const row = (name: string) => within(caps()).getByRole('group', { name });

describe('spend caps on Profile & usage', () => {
  it('sets a cap for a cloud provider (never a local one) with its period, warning and hard stop', async () => {
    const { api } = await renderWithDatactl(<ProfilePage />);
    await within(await screen.findByRole('region', { name: 'Spend caps' })).findByText('Anthropic');
    expect(within(caps()).queryByText('Ollama')).toBeNull();
    expect(within(row('Anthropic')).getByText('No cap')).toBeTruthy();
    await userEvent.click(within(row('Anthropic')).getByRole('button', { name: 'Set a cap' }));
    const form = within(caps()).getByRole('form', { name: 'Spend cap for Anthropic' });
    expect(document.activeElement).toBe(within(form).getByLabelText('Cap (US dollars)'));

    await userEvent.type(within(form).getByLabelText('Cap (US dollars)'), '0');
    await userEvent.click(within(form).getByRole('button', { name: 'Save cap' }));
    expect(within(form).getByText('Enter an amount above $0 and up to $1,000,000.')).toBeTruthy();
    await userEvent.clear(within(form).getByLabelText('Cap (US dollars)'));
    await userEvent.type(within(form).getByLabelText('Cap (US dollars)'), '$1,250.50');
    await userEvent.clear(within(form).getByLabelText('Warn at (% of the cap)'));
    await userEvent.type(within(form).getByLabelText('Warn at (% of the cap)'), '2');
    await userEvent.click(within(form).getByRole('button', { name: 'Save cap' }));
    expect(within(form).getByText('Warn at a share from 5% to 99%.')).toBeTruthy();
    expect(api.setSpendCap).not.toHaveBeenCalled();

    await userEvent.clear(within(form).getByLabelText('Warn at (% of the cap)'));
    await userEvent.type(within(form).getByLabelText('Warn at (% of the cap)'), '90');
    await userEvent.selectOptions(within(form).getByLabelText('Period'), 'day');
    await userEvent.click(within(form).getByRole('switch', { name: 'Stop at the cap' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Save cap' }));
    expect(api.setSpendCap).toHaveBeenCalledWith('anthropic', {
      limitUsd: 1250.5,
      period: 'day',
      warnAt: 0.9,
      hardStop: false,
    });
    const r = await within(caps()).findByRole('group', { name: 'Anthropic' });
    // Focus returns to the row's button.
    expect(document.activeElement).toBe(within(r).getByRole('button', { name: 'Change' }));
    expect(within(r).getByText('Under the cap')).toBeTruthy();
    expect(within(r).getByText('$0.00 of $1,250.50 today')).toBeTruthy();
    expect(
      within(r).getByText(/warns at 90%; only warns at the cap\. Resets Oct 16, 2026\./),
    ).toBeTruthy();
    expect(within(r).getByRole('meter', { name: 'Anthropic spend against its cap' })).toBeTruthy();
  });

  it('shows a reached cap, changes it, and removes it after asking', async () => {
    const { api, state } = await renderWithDatactl(<ProfilePage />, {
      datactl: { caps: [cap('anthropic', 10, 12)], spent: { anthropic: 12 } },
    });
    const r = await within(await screen.findByRole('region', { name: 'Spend caps' })).findByRole(
      'group',
      {
        name: 'Anthropic',
      },
    );
    expect(within(r).getByText('Cap reached: calls stopped')).toBeTruthy();
    expect(within(r).getByText('$12.00 of $10.00 this month')).toBeTruthy();
    await userEvent.click(within(r).getByRole('button', { name: 'Change' }));
    const form = within(caps()).getByRole('form');
    expect(within(form).getByLabelText<HTMLInputElement>('Cap (US dollars)').value).toBe('10');
    await userEvent.clear(within(form).getByLabelText('Cap (US dollars)'));
    await userEvent.type(within(form).getByLabelText('Cap (US dollars)'), '20');
    await userEvent.click(within(form).getByRole('button', { name: 'Save cap' }));
    expect(api.setSpendCap).toHaveBeenLastCalledWith('anthropic', {
      limitUsd: 20,
      period: 'month',
      warnAt: 0.8,
      hardStop: true,
    });
    expect(await within(row('Anthropic')).findByText('Under the cap')).toBeTruthy();
    expect(within(row('Anthropic')).getByText('$12.00 of $20.00 this month')).toBeTruthy();

    await userEvent.click(within(row('Anthropic')).getByRole('button', { name: 'Remove…' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this spend cap?' });
    expect(dialog.textContent).toContain('Calls to Anthropic are no longer stopped');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove cap' }));
    expect(api.removeSpendCap).toHaveBeenCalledWith('anthropic');
    await waitFor(() => expect(within(row('Anthropic')).getByText('No cap')).toBeTruthy());
    expect(state.caps).toEqual([]);
  });

  it("keeps the Hub's refusals in words", async () => {
    const { api } = await renderWithDatactl(<ProfilePage />, {
      datactl: { caps: [cap('anthropic', 10, 1)] },
      prepare: (m) => {
        m.setSpendCap.mockRejectedValueOnce(
          new ApiError(400, {
            code: 'validation',
            message: 'request failed validation',
            retryable: false,
          }),
        );
        m.removeSpendCap.mockRejectedValueOnce(
          new ApiError(404, { code: 'not_found', message: 'no spend cap', retryable: false }),
        );
      },
    });
    await within(await screen.findByRole('region', { name: 'Spend caps' })).findByRole('group', {
      name: 'Anthropic',
    });
    await userEvent.click(within(row('Anthropic')).getByRole('button', { name: 'Change' }));
    await userEvent.click(within(caps()).getByRole('button', { name: 'Save cap' }));
    expect((await within(caps()).findByRole('alert')).textContent).toBe(
      'The Hub did not accept these values. Check them and try again.',
    );
    await userEvent.click(within(caps()).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(row('Anthropic')).getByRole('button', { name: 'Remove…' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove cap' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'It is no longer there. Reload the page and try again.',
    );
    expect(api.removeSpendCap).toHaveBeenCalledTimes(1);
  });

  it('opens the cap the chat link names, for a member too', async () => {
    window.history.replaceState(null, '', capPath('anthropic'));
    const { api } = await renderWithDatactl(<ProfilePage />, { as: 'member' });
    const form = await within(await screen.findByRole('region', { name: 'Spend caps' })).findByRole(
      'form',
      { name: 'Spend cap for Anthropic' },
    );
    await userEvent.type(within(form).getByLabelText('Cap (US dollars)'), '30');
    await userEvent.click(within(form).getByRole('button', { name: 'Save cap' }));
    expect(api.setSpendCap).toHaveBeenCalledWith(
      'anthropic',
      expect.objectContaining({ limitUsd: 30 }),
    );
  });

  it('reloads when a cap warns or is reached', async () => {
    const { api, state } = await renderWithDatactl(<ProfilePage />, {
      datactl: { caps: [cap('anthropic', 10, 1)] },
    });
    await within(await screen.findByRole('region', { name: 'Spend caps' })).findByText(
      'Under the cap',
    );
    state.caps = [cap('anthropic', 10, 9)];
    const before = api.listSpendCaps.mock.calls.length;
    FakeEventSource.for('/api/v1/events/stream').emit('spend.cap.warning', {
      provider: 'anthropic',
    });
    expect(await within(caps()).findByText('Near the cap')).toBeTruthy();
    expect(api.listSpendCaps.mock.calls.length).toBeGreaterThan(before);
  });

  it('clears usage data after asking, and the insights load again', async () => {
    const { api, hub } = await renderWithDatactl(<ProfilePage />);
    const section = await screen.findByRole('region', { name: 'Usage records' });
    const usageCalls = hub.api.usage.mock.calls.length;
    await userEvent.click(within(section).getByRole('button', { name: 'Clear usage data…' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear your usage data?' });
    expect(dialog.textContent).toContain('each spend cap keeps this period’s spend');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Clear usage data' }));
    expect(api.clearUsage).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('25 usage records cleared.')).toBeTruthy();
    await waitFor(() => expect(hub.api.usage.mock.calls.length).toBeGreaterThan(usageCalls));
  });

  it('stays hidden on a client without the calls', async () => {
    const hub = createHub();
    // An older Hub client: the data-control calls are missing.
    delete (hub.api as Partial<typeof hub.api>).listProviderLimits;
    const { render } = await import('@testing-library/react');
    const { ServicesProvider } = await import('../src/services.tsx');
    const { fakeEventSource, testRegistry } = await import('./fakes.ts');
    const { ToastProvider } = await import('@nova/ui');
    render(
      <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
        <ToastProvider>
          <ProviderLimitsSection />
        </ToastProvider>
      </ServicesProvider>,
    );
    expect(screen.queryByRole('region', { name: 'Limits and spend' })).toBeNull();
  });
});

describe('provider limits on Accounts', () => {
  it("shows each account's plan, limits, spend and cap, with a link to the cap", async () => {
    await renderWithDatactl(<ProviderLimitsSection />, {
      datactl: {
        limits: [
          {
            providerAccountId: 'pa1',
            provider: 'anthropic',
            label: 'Work Anthropic',
            active: true,
            local: false,
            entitlements: {
              plan: 'Team',
              limit: 1000,
              used: 250,
              resetAt: '2026-11-01T00:00:00.000Z',
            },
            lastReported: {
              code: 'rate_limited',
              message: 'slow down',
              at: '2026-10-15T11:00:00.000Z',
              retryAfterMs: 30_000,
            },
            spentThisMonthUsd: 12.5,
          },
          {
            providerAccountId: 'pa3',
            provider: 'openai',
            label: 'Personal OpenAI',
            active: true,
            local: false,
            entitlements: null,
            lastReported: null,
            spentThisMonthUsd: 0,
          },
          {
            providerAccountId: 'pa2',
            provider: 'ollama',
            label: 'Desk Ollama',
            active: true,
            local: true,
            entitlements: null,
            lastReported: null,
            spentThisMonthUsd: 0,
          },
        ],
        caps: [cap('openai', 50, 45)],
      },
    });
    const section = await screen.findByRole('region', { name: 'Limits and spend' });
    const work = (await within(section).findByText('Work Anthropic')).closest('li')!;
    expect(work.textContent).toContain('$12.50 this month.');
    expect(work.textContent).toContain('Plan: Team. 250 of 1,000 used. Resets Nov 1, 2026.');
    expect(work.textContent).toContain('Rate limited by the provider; it asked to wait 30 s.');
    expect(within(work).getByRole('link', { name: 'Set a cap' }).getAttribute('href')).toBe(
      '/settings/profile?cap=anthropic#spend-caps',
    );
    const personal = within(section).getByText('Personal OpenAI').closest('li')!;
    expect(within(personal).getByText('Near the cap')).toBeTruthy();
    expect(personal.textContent).toContain('$45.00 of $50.00 this month');
    expect(within(personal).getByRole('link', { name: 'Change the cap' })).toBeTruthy();
    expect(personal.textContent).toContain('No plan or limits reported.');
    const desk = within(section).getByText('Desk Ollama').closest('li')!;
    expect(desk.textContent).toContain('Local: no cost and no cap.');
  });
});

describe('the cap-reached error in a chat', () => {
  it('links a reply a spend cap stopped to that cap, and leaves other errors alone', async () => {
    const t = thread({ title: 'Costs' });
    const hub = createHub({ threads: [t] });
    hub.state.messages.set(t.id, [
      message(t.id, { role: 'user', parts: [{ type: 'text', text: 'Hi' }] }),
      message(t.id, {
        role: 'assistant',
        status: 'error',
        parts: [
          {
            type: 'error',
            code: 'over_budget',
            message:
              'The anthropic spend cap of $10.00 a month is reached ($12.00 spent): calls to anthropic stop until 2026-11-01 or until you raise the cap.',
          },
        ],
      }),
      message(t.id, {
        role: 'assistant',
        status: 'error',
        parts: [
          {
            type: 'error',
            code: 'over_budget',
            message: 'the provider account has a billing problem',
          },
        ],
      }),
    ]);
    await renderApp({ hub, path: `/chat/${t.id}` });
    expect(await screen.findByText(/spend cap of \$10\.00 a month is reached/)).toBeTruthy();
    const links = screen.getAllByRole('link', { name: 'Raise the cap' });
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('/settings/profile?cap=anthropic#spend-caps');
    expect(screen.getByText(/billing problem/)).toBeTruthy();
  });
});

describe('data-controls words', () => {
  it('recognizes the cap-reached error and its provider', () => {
    expect(
      capReachedProvider(
        'over_budget',
        'The openai spend cap of $5.00 a day is reached ($5.01 spent): …',
      ),
    ).toBe('openai');
    expect(capReachedProvider('over_budget', 'A spend cap stopped this call.')).toBeNull();
    expect(
      capReachedProvider('over_budget', 'the provider account has a billing problem'),
    ).toBeUndefined();
    expect(capReachedProvider('rate_limited', 'The openai spend cap of')).toBeUndefined();
    expect(capPath(null)).toBe('/settings/profile#spend-caps');
  });

  it('parses the cap form, sizes, money, retention choices, secrets and sweeps', () => {
    expect(
      parseCapDraft({ limit: '12', period: 'month', warnPercent: '80%', hardStop: true }),
    ).toEqual({
      body: { limitUsd: 12, period: 'month', warnAt: 0.8, hardStop: true },
    });
    expect(
      parseCapDraft({ limit: '2000000', period: 'month', warnPercent: '80', hardStop: true }),
    ).toMatchObject({
      field: 'limit',
    });
    expect(
      parseCapDraft({ limit: '5', period: 'day', warnPercent: '', hardStop: true }),
    ).toMatchObject({
      field: 'warn',
    });
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatUsd(0.004)).toBe('under $0.01');
    expect(retentionOptions(1, 45).map((o) => o.value)).toEqual([
      'forever',
      '7',
      '30',
      '45',
      '90',
      '180',
      '365',
      '730',
      '1825',
    ]);
    expect(
      secretGroups(['secret://provider/a/k', 'secret://channel/b', 'secret://weird/c', 'odd']),
    ).toEqual([
      { label: 'Other stored secrets', count: 2 },
      { label: 'Channel credentials', count: 1 },
      { label: 'Model provider API keys', count: 1 },
    ]);
    expect(sweepCounts({})).toBeNull();
    expect(sweepCounts({ runs: 2, audit: 0 })).toBe('Work runs: 2');
  });

  it('never shows a raw reason code', () => {
    const refusal = (status: number, reason: string) =>
      new ApiError(status, {
        code: 'validation',
        message: 'raw',
        retryable: false,
        details: { reason },
      });
    for (const reason of [
      'owner_only',
      'busy',
      'confirmation_mismatch',
      'too_large',
      'empty',
      'content_type',
      'passphrase_required',
      'wrong_passphrase',
      'archive_damaged',
      'unsupported_format',
      'newer_schema',
      'checksum_mismatch',
      'hub_not_empty',
      'ticket_expired',
      'crash_reports_off',
      'no_endpoint',
      'send_failed',
      'managed',
    ])
      expect(dataErrorMessage(refusal(400, reason))).not.toMatch(/_|raw/);
    expect(
      dataErrorMessage(
        new ApiError(403, { code: 'policy_denied', message: 'raw', retryable: false }),
      ),
    ).toBe("You can't do this here.");
    expect(dataErrorMessage(new TypeError('Failed to fetch'))).toBe(
      'Cannot reach the Hub. Check your connection and try again.',
    );
  });
});
