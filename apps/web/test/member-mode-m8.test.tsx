// Member mode in Tools & MCP and Notifications (ADR-097 D7; Channels is in channels-m8): a member
// sees the sections, their own servers, tool defaults, notification routes and devices, while the
// owner's parts (commands on the Hub, bundles, web search, notification kinds, push for every
// device) are hidden or said to be the owner's; what the Hub refuses comes from
// `GET /api/v1/team/me/access`, and anything not yet known counts as refused.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { SETTINGS_SECTIONS } from '../src/router.ts';
import { NotificationsPage } from '../src/settings/NotificationsPage.tsx';
import { ToolsPage } from '../src/settings/ToolsPage.tsx';
import { refusedRoute, useMemberAccess } from '../src/team/access.tsx';
import { MEMBER_MODE_TEXT } from '../src/team/format.ts';
import { visibleSettingsSections } from '../src/team/role.tsx';
import { accessView, renderW11 } from './fakes-m8-appauth.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

describe('the sections a member sees', () => {
  it('lists Tools & MCP, Notifications and Channels for a member now', () => {
    const shown = visibleSettingsSections([...SETTINGS_SECTIONS], 'member');
    expect(shown).toEqual(expect.arrayContaining(['tools', 'notifications', 'channels']));
    expect(shown).not.toContain('general');
    expect(shown).not.toContain('clients');
  });

  it('matches refused routes by method and pattern', () => {
    const view = {
      ...accessView(true),
      refused: [
        { method: '*', route: '/api/v1/everything', why: 'x' },
        { method: 'GET,POST', route: '/api/v1/two', why: 'x' },
      ],
    };
    expect(refusedRoute(view, 'delete', '/api/v1/everything')).toBe(true);
    expect(refusedRoute(view, 'post', '/api/v1/two')).toBe(true);
    expect(refusedRoute(view, 'PUT', '/api/v1/two')).toBe(false);
    expect(refusedRoute(view, 'GET', '/api/v1/other')).toBe(false);
  });
});

describe('Tools & MCP for a member', () => {
  it('shows their servers and tools; commands on the Hub, bundles and web search are not theirs', async () => {
    await renderW11(<ToolsPage />, { member: true });
    expect(await screen.findByText(MEMBER_MODE_TEXT.tools)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(MEMBER_MODE_TEXT.toolsAddresses)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Install a bundle/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Add server/ })).toBeTruthy();
    expect(screen.queryByLabelText('SearXNG address')).toBeNull();
    expect(screen.getByText(MEMBER_MODE_TEXT.webSearch)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Add server/ }));
    const dialog = within(screen.getByRole('dialog', { name: 'Add an MCP server' }));
    expect(dialog.queryByRole('radio', { name: 'Run a command on the Hub' })).toBeNull();
    expect(dialog.getByRole<HTMLInputElement>('radio', { name: 'Streamable HTTP' }).checked).toBe(
      true,
    );
    expect(dialog.getByText(MEMBER_MODE_TEXT.stdioOwner)).toBeTruthy();
    expect(dialog.getByLabelText('Server URL')).toBeTruthy();
  });

  it('keeps the owner’s view whole', async () => {
    const { api } = await renderW11(<ToolsPage />);
    expect(await screen.findByRole('button', { name: /Install a bundle/ })).toBeTruthy();
    expect(screen.getByLabelText('SearXNG address')).toBeTruthy();
    expect(screen.queryByText(MEMBER_MODE_TEXT.tools)).toBeNull();
    expect(api.getTeamAccess).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Add server/ }));
    expect(screen.getByRole('radio', { name: 'Run a command on the Hub' })).toBeTruthy();
  });

  it('fails closed when what the member may do cannot be read', async () => {
    await renderW11(<ToolsPage />, {
      member: true,
      fail: {
        getTeamAccess: new ApiError(500, { code: 'server_error', message: 'x', retryable: true }),
      },
    });
    expect(await screen.findByText(MEMBER_MODE_TEXT.accessUnknown)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install a bundle/ })).toBeNull();
    expect(screen.getByText(MEMBER_MODE_TEXT.webSearch)).toBeTruthy();
  });
});

describe('Notifications for a member', () => {
  it('keeps their routes and devices, and says the owner sets the kinds and push', async () => {
    await renderW11(<NotificationsPage />, { member: true });
    expect(await screen.findByText(MEMBER_MODE_TEXT.notifications)).toBeTruthy();
    expect(screen.getByText(MEMBER_MODE_TEXT.categories)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Approvals' })).toBeNull();
    expect(screen.getByText(MEMBER_MODE_TEXT.pushHub)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Send push notifications' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Where notifications go' })).toBeTruthy();
  });

  it('shows the owner the kinds and the push switches', async () => {
    await renderW11(<NotificationsPage />);
    expect(await screen.findByRole('switch', { name: 'Approvals' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Send push notifications' })).toBeTruthy();
    expect(screen.queryByText(MEMBER_MODE_TEXT.pushHub)).toBeNull();
  });
});

describe('the access hook', () => {
  function Probe() {
    const a = useMemberAccess();
    const may = (m: string, r: string) => String(a.may(m, r));
    return (
      <span data-testid="probe">
        {[
          String(a.member),
          may('POST', '/api/v1/mcp/bundles/install'),
          may('GET', '/api/v1/tools'),
          String(a.hubSettings),
        ].join(':')}
      </span>
    );
  }

  it('lets the owner do everything without asking the Hub', async () => {
    const { api } = await renderW11(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('false:true:true:true');
    expect(api.getTeamAccess).not.toHaveBeenCalled();
  });

  it('refuses a member everything until the Hub answers, then what it lists', async () => {
    const { api } = await renderW11(<Probe />, { member: true });
    expect(screen.getByTestId('probe').textContent).toBe('true:false:false:false');
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('true:false:true:false'),
    );
    expect(api.getTeamAccess).toHaveBeenCalledTimes(1);
  });
});
