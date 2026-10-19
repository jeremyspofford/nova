// Member mode (decision 5 of ADR-095): the app starts with the Hub's settings for the owner and
// with a member's own preferences when the Hub refuses its settings (403 `owner_only`); a member's
// preference writes go to their own settings and Hub keys are refused; a member sees only their
// Settings sections, and a section or surface that is not theirs says "Only the owner of this Hub
// can change this" instead of failing. Team (/team) holds shared chats and team agents: tabs on
// desktop, a menu and full pages on phones. And the words: refusals, OIDC returns, chips.
/* eslint-disable @typescript-eslint/require-await */
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { SETTINGS_SECTIONS } from '../src/router.ts';
import {
  isOwnerOnly,
  oidcErrorText,
  oidcReturn,
  sharedThreadPath,
  taskChip,
  teamAgentPath,
  teamErrorMessage,
  teamPath,
  untilText,
} from '../src/team/format.ts';
import { LoadError } from '../src/team/parts.tsx';
import {
  MEMBER_SETTINGS_SECTIONS,
  MemberGate,
  MemberSettingsGate,
  loadHubSettings,
  memberSettingsApi,
  surfaceHiddenFor,
  useTeamRole,
  visibleSettingsSections,
} from '../src/team/role.tsx';
import { TeamSurface } from '../src/team/TeamSurface.tsx';
import { createTeamHub, renderWithTeam, sharedThread, teamAgent } from './fakes-m7-team.ts';
import { thread } from './fakes.ts';
import { clearViewport, resetDom, setViewport } from './render.tsx';

afterEach(() => {
  resetDom();
  clearViewport();
  window.history.replaceState(null, '', '/');
});

const ownerOnly = () =>
  new ApiError(403, {
    code: 'policy_denied',
    message: "only the owner of this Hub can change the Hub's settings",
    retryable: false,
    details: { reason: 'owner_only' },
  });

describe('loading settings', () => {
  it('uses the Hub’s settings for the owner', async () => {
    const team = createTeamHub();
    const settings = vi.fn(async () => ({ settings: [] }));
    const out = await loadHubSettings({ settings, getMemberSettings: team.api.getMemberSettings });
    expect(out.member).toBe(false);
    expect(team.api.getMemberSettings).not.toHaveBeenCalled();
  });

  it('uses a member’s own preferences when the Hub refuses its settings', async () => {
    const team = createTeamHub({
      me: 'acc-alex',
      memberSettings: { 'acc-alex': { 'appearance.theme': 'light' } },
    });
    const out = await loadHubSettings({
      settings: vi.fn(async () => Promise.reject(ownerOnly())),
      getMemberSettings: team.api.getMemberSettings,
    });
    expect(out.member).toBe(true);
    expect(out.settings).toHaveLength(Object.keys(SETTINGS).length);
    expect(out.settings.find((s) => s.key === 'appearance.theme')).toMatchObject({
      value: 'light',
      source: 'global',
    });
    expect(out.settings.find((s) => s.key === 'team.publicProfiles')).toMatchObject({
      value: false,
      source: 'default',
    });
  });

  it('passes any other failure on', async () => {
    const team = createTeamHub();
    await expect(
      loadHubSettings({
        settings: vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))),
        getMemberSettings: team.api.getMemberSettings,
      }),
    ).rejects.toThrow('Failed to fetch');
  });

  it('writes a member’s preference to their own settings and refuses a Hub key', async () => {
    const team = createTeamHub({ me: 'acc-alex' });
    const store = memberSettingsApi(team.api);
    const out = await store.setSetting('keyboard.bindings', {});
    expect(team.api.setMemberSetting).toHaveBeenCalledWith('keyboard.bindings', {});
    expect(out.settings.find((s) => s.key === 'keyboard.bindings')?.source).toBe('global');
    await expect(store.setSetting('general.enterToSend', 'enter')).rejects.toSatisfy(isOwnerOnly);
  });
});

describe('what a member sees', () => {
  it('lists only a member’s own Settings sections, all of them for the owner', () => {
    // The router lists Account and Members itself now (M7 wiring).
    const all = [...SETTINGS_SECTIONS];
    expect(visibleSettingsSections(all, 'member').sort()).toEqual(
      [...MEMBER_SETTINGS_SECTIONS].sort(),
    );
    expect(visibleSettingsSections(all, 'owner')).toEqual(all);
    expect(visibleSettingsSections(all, null)).toEqual(all);
    expect(surfaceHiddenFor('member', 'devices')).toBe(true);
    expect(surfaceHiddenFor('member', 'chat')).toBe(false);
    expect(surfaceHiddenFor('owner', 'devices')).toBe(false);
  });

  it('shows a member the owner-only notice on a Hub section, and the owner the section', async () => {
    await renderWithTeam(
      <>
        <MemberSettingsGate section="general" label="General settings">
          <p>Hub general</p>
        </MemberSettingsGate>
        <MemberSettingsGate section="appearance">
          <p>My appearance</p>
        </MemberSettingsGate>
      </>,
      { as: 'member', provider: true },
    );
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('Only the owner of this Hub can change this.');
    expect(note.textContent).toContain('“General settings” belongs to the whole Hub');
    expect(screen.queryByText('Hub general')).toBeNull();
    expect(screen.getByText('My appearance')).toBeTruthy();
    resetDom();
    await renderWithTeam(
      <MemberGate ownerOnly what="Devices">
        <p>Devices list</p>
      </MemberGate>,
      { provider: true },
    );
    expect(await screen.findByText('Devices list')).toBeTruthy();
  });

  it('reads the role without a provider, and turns an owner-only refusal into the notice', async () => {
    function Who() {
      const { role, isMember } = useTeamRole();
      return <span data-testid="who">{`${role ?? 'unknown'}:${String(isMember)}`}</span>;
    }
    await renderWithTeam(<Who />, { as: 'member' });
    await waitFor(() => expect(screen.getByTestId('who').textContent).toBe('member:true'));
    resetDom();
    render(<LoadError error={ownerOnly()} fallback="x" onRetry={() => undefined} what="Trust" />);
    expect(screen.getByRole('note').textContent).toContain('“Trust” belongs to the whole Hub');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('Team (/team)', () => {
  it('shows the sections as tabs on desktop and switches between them', async () => {
    setViewport(1300);
    await renderWithTeam(<TeamSurface section={null} />, {
      team: {
        threads: { 'st-1': sharedThread({ thread: thread({ id: 'st-1', title: 'Trip' }) }) },
      },
    });
    expect(screen.getByRole('heading', { name: 'Team', level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings → Members' })).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Team sections' });
    expect(
      within(tabs).getByRole('tab', { name: 'Shared chats' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(await screen.findByRole('link', { name: 'Trip' })).toBeTruthy();
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Team agents' }));
    await waitFor(() => expect(window.location.pathname).toBe('/team/agents'));
  });

  it('lists the sections on a phone, each a full page with a way back', async () => {
    setViewport(400);
    const r = await renderWithTeam(<TeamSurface section={null} />);
    const nav = screen.getByRole('navigation', { name: 'Team sections' });
    expect(
      within(nav)
        .getByRole('link', { name: /Shared chats/ })
        .getAttribute('href'),
    ).toBe('/team/shared');
    r.unmount();
    await renderWithTeam(<TeamSurface section="agents" />, {
      team: { agents: [teamAgent({ name: 'Desk' })] },
    });
    expect(screen.getByRole('heading', { name: 'Team agents', level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Team/ }).getAttribute('href')).toBe('/team');
    expect(await screen.findByRole('link', { name: 'Desk' })).toBeTruthy();
  });

  it('opens a shared chat, a team agent and the provisioning page by address', async () => {
    setViewport(1300);
    const r = await renderWithTeam(<TeamSurface section="shared" id="st-1" />, {
      team: {
        threads: { 'st-1': sharedThread({ thread: thread({ id: 'st-1', title: 'Trip' }) }) },
      },
    });
    expect(await screen.findByRole('heading', { name: 'Trip', level: 1 })).toBeTruthy();
    r.unmount();
    const r2 = await renderWithTeam(<TeamSurface section="agents" id="ta-1" />, {
      team: { agents: [teamAgent({ agentId: 'ta-1', name: 'Desk' })] },
    });
    expect(await screen.findByRole('heading', { name: 'Desk', level: 1 })).toBeTruthy();
    r2.unmount();
    await renderWithTeam(<TeamSurface section="agents" id="new" />);
    expect(screen.getByRole('heading', { name: 'Provision a team agent' })).toBeTruthy();
  });
});

describe('words', () => {
  it('explains each OIDC refusal and reads the return query', () => {
    expect(oidcErrorText('oidc_signature')).toContain('the signature did not verify');
    expect(oidcErrorText('oidc_audience')).toContain('meant for another app');
    expect(oidcErrorText('oidc_expired')).toContain('clocks');
    expect(oidcErrorText('oidc_token_exchange')).toContain('client id and secret');
    expect(oidcErrorText('provider_error')).toContain('did not sign you in');
    expect(oidcErrorText('provider_disabled')).toContain('turned off');
    expect(oidcErrorText('account_closed')).toContain('removed from the Hub');
    expect(oidcErrorText('invitation_invalid')).toContain('new link');
    expect(oidcErrorText('oidc_discovery')).toContain('could not reach');
    expect(oidcErrorText('something_new')).toBe(
      'The sign-in was refused. Try again, or sign in another way.',
    );
    expect(oidcReturn('?oidc_error=<b>x')).toEqual({ error: 'bx', linked: false });
    expect(oidcReturn('?oidc_error=%3C%3E')).toEqual({ error: 'refused', linked: false });
    expect(oidcReturn('?oidc=linked')).toEqual({ error: null, linked: true });
  });

  it('words refusals, paths, chips and times', () => {
    expect(teamErrorMessage(ownerOnly())).toBe('Only the owner of this Hub can change this.');
    expect(
      teamErrorMessage(
        new ApiError(400, {
          code: 'validation',
          message: 'request failed validation',
          retryable: false,
          details: { issues: [{ path: 'handle', message: 'too short' }] },
        }),
      ),
    ).toBe('Too short.');
    expect(
      teamErrorMessage(
        new ApiError(503, { code: 'capability_missing', message: 'x', retryable: true }),
      ),
    ).toContain('not running yet');
    expect(sharedThreadPath('a b')).toBe('/team/shared/a%20b');
    expect(teamAgentPath('ta-1', 'audit')).toBe('/team/agents/ta-1?tab=audit');
    expect(teamPath()).toBe('/team');
    expect(taskChip('running').icon).toBeNull();
    expect(taskChip('paused_by_someone').text).toBe('paused by someone');
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(untilText('2026-10-01T12:30:00Z', now)).toBe('in 30 min');
    expect(untilText('2026-10-02T00:00:00Z', now)).toBe('in 12 h');
    expect(untilText('2026-10-08T12:00:00Z', now)).toBe('in 7 days');
    expect(untilText('2026-09-01T12:00:00Z', now)).toBe('now');
  });
});
