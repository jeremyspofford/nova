import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ProviderAccountView, UsageSummary } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { activeGroups } from '../src/settings/AccountsPage.tsx';
import { profileChanges } from '../src/settings/ProfilePage.tsx';
import { fillDays, formatCost } from '../src/settings/UsageSection.tsx';
import { createHub } from './fakes.ts';
import { m4State } from './fakes-m4.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string, status = 500, code = 'x') =>
  new ApiError(status, { code, message, retryable: false });

const provider = (
  over: Partial<ProviderAccountView> & { active?: boolean },
): ProviderAccountView => ({
  id: 'pa-x',
  provider: 'openai',
  label: 'OpenAI',
  authKind: 'api_key',
  baseUrl: null,
  status: 'active',
  hasSecret: true,
  lastCheckAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  ...over,
});

const USAGE: UsageSummary = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-04T00:00:00.000Z',
  totals: { inputTokens: 12_000, outputTokens: 3_400, cachedTokens: 800, costUsd: 0.42, turns: 9 },
  byModel: [
    {
      provider: 'openai',
      model: 'gpt-x',
      inputTokens: 10_000,
      outputTokens: 3_000,
      costUsd: 0.4,
      turns: 7,
    },
    {
      provider: 'mock',
      model: 'mock-fast',
      inputTokens: 2_000,
      outputTokens: 400,
      costUsd: 0,
      turns: 2,
    },
  ],
  byProject: [
    { projectId: 'p1', name: 'Garden plan', inputTokens: 9_000, outputTokens: 2_000, costUsd: 0.3 },
    { projectId: null, name: null, inputTokens: 3_000, outputTokens: 1_400, costUsd: 0.12 },
  ],
  byDay: [
    { day: '2026-10-01', inputTokens: 2_000, outputTokens: 500, costUsd: 0.1 },
    { day: '2026-10-03', inputTokens: 10_000, outputTokens: 2_900, costUsd: 0.32 },
  ],
  activeDays: 2,
  streak: 1,
  longestTurn: { threadId: 't-long', turnId: 'turn-1', seconds: 95 },
};

describe('profile and usage helpers (FR-113, FR-114, FR-115)', () => {
  it('sends only changed profile fields and refuses a bad username', () => {
    const acct = { displayName: 'Sam', username: null };
    expect(profileChanges(acct, { displayName: 'Sam', username: '' })).toEqual({ body: null });
    expect(profileChanges(acct, { displayName: ' Robin ', username: 'robin_1' })).toEqual({
      body: { displayName: 'Robin', username: 'robin_1' },
    });
    expect(
      profileChanges({ displayName: 'Sam', username: 'sam' }, { displayName: '', username: '' }),
    ).toEqual({
      body: { displayName: null, username: null },
    });
    expect(profileChanges(acct, { displayName: 'Sam', username: 'Bad Name' })).toHaveProperty(
      'error',
    );
    expect(profileChanges(acct, { displayName: 'Sam', username: 'a' })).toHaveProperty('error');
  });

  it('fills idle days with zero and formats costs', () => {
    expect(fillDays(USAGE)).toEqual([
      { day: '2026-10-01', tokens: 2_500, costUsd: 0.1 },
      { day: '2026-10-02', tokens: 0, costUsd: 0 },
      { day: '2026-10-03', tokens: 12_900, costUsd: 0.32 },
      { day: '2026-10-04', tokens: 0, costUsd: 0 },
    ]);
    expect(fillDays({ from: 'bad', to: 'bad', byDay: [] })).toEqual([]);
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('under $0.01');
    expect(formatCost(12.345)).toBe('$12.35');
  });

  it('groups accounts by kind for the active choice', () => {
    const groups = activeGroups([
      provider({ id: 'a', active: true }),
      provider({ id: 'b' }),
      provider({ id: 'c', provider: 'mock', label: 'Mock' }),
    ]);
    expect(groups).toEqual([
      {
        provider: 'openai',
        accounts: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
        activeId: 'a',
      },
    ]);
    expect(activeGroups([provider({ id: 'a' }), provider({ id: 'b' })])[0]?.activeId).toBeNull();
  });
});

describe('Settings → Profile & usage (FR-113)', () => {
  it('saves name and username, refusing an invalid username, and updates the top bar', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/profile' });
    const name = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Display name' });
    expect(name.value).toBe('Sam');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save profile' });
    expect(save.disabled).toBe(true);
    await userEvent.clear(name);
    await userEvent.type(name, 'Robin');
    await userEvent.type(screen.getByRole('textbox', { name: 'Username' }), 'Robin!');
    await userEvent.click(save);
    expect(screen.getByText(/Use 2 to 32 lowercase letters/)).toBeTruthy();
    expect(hub.api.updateProfile).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Username' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Username' }), 'robin');
    hub.state.failNext.updateProfile = fail('That username is taken', 409, 'conflict');
    await userEvent.click(save);
    expect(await screen.findByText('That username is taken')).toBeTruthy();
    await userEvent.click(save);
    await waitFor(() =>
      expect(hub.api.updateProfile).toHaveBeenLastCalledWith({
        displayName: 'Robin',
        username: 'robin',
      }),
    );
    expect(await screen.findByText('Profile saved.')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Account: Robin' })).toBeTruthy();
    expect(hub.state.m4.account).toMatchObject({ displayName: 'Robin', username: 'robin' });
  });

  it('uploads and removes an avatar, refusing other types and big images', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/profile' });
    await screen.findByRole('button', { name: 'Upload avatar' });
    const input = screen.getByLabelText('Avatar image');
    await userEvent.upload(input, new File(['GIF89a'], 'a.gif', { type: 'image/gif' }), {
      applyAccept: false,
    });
    expect(await screen.findByText('Choose a PNG, JPEG or WebP image.')).toBeTruthy();
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 });
    await userEvent.upload(input, big);
    expect(await screen.findByText(/the limit is 2 MB/)).toBeTruthy();
    expect(hub.api.updateProfile).not.toHaveBeenCalled();

    await userEvent.upload(input, new File(['png-bytes'], 'me.png', { type: 'image/png' }));
    await waitFor(() =>
      expect(hub.api.updateProfile).toHaveBeenCalledWith({
        avatar: { mime: 'image/png', data: btoa('png-bytes') },
      }),
    );
    expect(await screen.findByText('Avatar updated.')).toBeTruthy();
    const img = screen.getByRole<HTMLImageElement>('img', { name: 'Your avatar' });
    expect(img.getAttribute('src')).toMatch(/^\/api\/v1\/account\/avatar\?v=1$/);
    await userEvent.click(screen.getByRole('button', { name: 'Remove avatar' }));
    await waitFor(() => expect(hub.api.updateProfile).toHaveBeenLastCalledWith({ avatar: null }));
    expect(await screen.findByText('Avatar removed.')).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Your avatar' })).toBeNull();
    hub.state.failNext.updateProfile = fail('Image could not be decoded', 400, 'validation');
    await userEvent.upload(input, new File(['bad'], 'me.webp', { type: 'image/webp' }));
    expect(
      await screen.findByText('Could not update your avatar: Image could not be decoded'),
    ).toBeTruthy();
  });

  it('shows a profile load failure with retry', async () => {
    const hub = createHub();
    hub.state.failNext.getAccount = fail('Account unavailable');
    await renderApp({ hub, path: '/settings/profile' });
    expect(await screen.findByText('Account unavailable')).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Profile' });
    await userEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('textbox', { name: 'Display name' })).toBeTruthy();
  });
});

describe('Settings → Profile & usage: usage (FR-114)', () => {
  it('shows totals, day charts with tables, and breakdowns for a chosen range', async () => {
    const hub = createHub({ m4: m4State({ usage: USAGE }) });
    await renderApp({ hub, path: '/settings/profile' });
    expect(await screen.findByText('12,000')).toBeTruthy();
    expect(screen.getByText('3,400')).toBeTruthy();
    expect(screen.getByText('$0.42')).toBeTruthy();
    expect(screen.getByText('1 day')).toBeTruthy();
    const chart = screen.getByRole('img', {
      name: /^Tokens by day\. Total 15,400 tokens\. Highest on Oct 3: 12,900 tokens\.$/,
    });
    expect(chart.querySelectorAll('rect')).toHaveLength(4);
    expect(chart.querySelector('rect title')?.textContent).toBe('Oct 1: 2,500 tokens');
    expect(screen.getByRole('img', { name: /^Cost by day\. Total \$0\.42\./ })).toBeTruthy();
    const tokensTable = screen.getByRole('table', { name: 'Tokens by day' });
    expect(within(tokensTable).getAllByRole('row')).toHaveLength(5);
    expect(within(tokensTable).getByRole('row', { name: 'Oct 2 0 tokens' })).toBeTruthy();
    const models = screen.getByRole('table', { name: 'By model' });
    expect(
      within(models).getByRole('row', { name: /gpt-x \(openai\) 10,000 3,000 \$0\.40 7/ }),
    ).toBeTruthy();
    const projects = screen.getByRole('table', { name: 'By project' });
    expect(within(projects).getByRole('rowheader', { name: 'Garden plan' })).toBeTruthy();
    expect(within(projects).getByRole('rowheader', { name: 'No project' })).toBeTruthy();

    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T00:00:00.000Z'));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Range' }), '7');
    await waitFor(() =>
      expect(hub.api.usage).toHaveBeenLastCalledWith({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-08T00:00:00.000Z',
      }),
    );
    await userEvent.click(screen.getByRole('link', { name: '1 min 35 s' }));
    await waitFor(() => expect(window.location.pathname).toBe('/chat/t-long'));
  });

  it('says when there is no usage and retries a failed load', async () => {
    const hub = createHub();
    hub.state.failNext.usage = fail('Usage unavailable');
    await renderApp({ hub, path: '/settings/profile' });
    expect(await screen.findByText('Usage unavailable')).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Usage' });
    await userEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No usage in this range yet.')).toBeTruthy();
    expect(screen.getByText('none yet')).toBeTruthy();
    expect(screen.getAllByText('None in this range.')).toHaveLength(2);
  });
});

describe('Settings → Accounts: active account per provider (FR-115)', () => {
  it('switches the active account of a kind and reports a failure', async () => {
    const hub = createHub({
      providers: [
        provider({ id: 'pa-a', label: 'Work key', active: true }),
        provider({ id: 'pa-b', label: 'Home key' }),
        provider({ id: 'pa-m', provider: 'mock', label: 'Mock' }),
      ],
    });
    await renderApp({ hub, path: '/settings/accounts' });
    const group = await screen.findByRole('group', { name: 'Active OpenAI account' });
    expect(within(group).getByRole<HTMLInputElement>('radio', { name: 'Work key' }).checked).toBe(
      true,
    );
    expect(screen.queryByRole('group', { name: 'Active Mock account' })).toBeNull();
    expect(screen.getAllByText('Active', { selector: '.ws-badge' })).toHaveLength(1);

    hub.state.failNext.setActiveProvider = fail('Hub busy');
    await userEvent.click(within(group).getByRole('radio', { name: 'Home key' }));
    expect(await screen.findByText('Could not switch accounts: Hub busy')).toBeTruthy();
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('group', { name: 'Active OpenAI account' }),
        ).getByRole<HTMLInputElement>('radio', { name: 'Work key' }).checked,
      ).toBe(true),
    );

    await userEvent.click(
      within(screen.getByRole('group', { name: 'Active OpenAI account' })).getByRole('radio', {
        name: 'Home key',
      }),
    );
    expect(await screen.findByText('Home key is now the active OpenAI account.')).toBeTruthy();
    expect(hub.api.setActiveProvider).toHaveBeenLastCalledWith('pa-b');
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('group', { name: 'Active OpenAI account' }),
        ).getByRole<HTMLInputElement>('radio', { name: 'Home key' }).checked,
      ).toBe(true),
    );
    expect(
      (hub.state.providers as (ProviderAccountView & { active?: boolean })[]).map((p) => [
        p.id,
        p.active,
      ]),
    ).toEqual([
      ['pa-a', false],
      ['pa-b', true],
      ['pa-m', undefined],
    ]);
  });

  it('points to Profile for the name and to Tools for servers', async () => {
    await renderApp({ path: '/settings/accounts' });
    const note = await screen.findByText(/Your name, username and avatar are in/);
    await userEvent.click(within(note).getByRole('link', { name: 'Profile & usage' }));
    expect(window.location.pathname).toBe('/settings/profile');
    expect(await screen.findByRole('textbox', { name: 'Display name' })).toBeTruthy();
  });
});
