// The browser bridge on a device's page (FR-096, docs/11 §4.3, docs/12 §15): collapsed to a summary
// unless a site waits; connected or not (browser, extension, user), the shared tabs, per-host
// grants (a pending one confirmed or refused, a host granted from the form, an active one
// revoked, each behind a dialog naming the computer and the site), "all sites" behind its own
// elevated confirmation (ticked acknowledgement) and off when the setting or policy says so, the
// switch's managed state, the Hub's own hosts refused on the form, the computer's recent activity
// (history searches among it), the Hub's refusals in plain words, live events, the setup steps, a
// member's owner-only notice, and nothing for a client without the calls.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { emitHub } from './fakes-m6-browser.ts';
import { deviceView } from './fakes-m6-devices.ts';
import {
  auditEntry,
  bridgeGrantView,
  bridgeTab,
  connectedBridge,
  renderM75Browser,
  type RenderM75Options,
} from './fakes-m75-browser.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

function openDevice(opts: RenderM75Options = {}) {
  window.history.replaceState(null, '', '/devices/d1');
  return renderM75Browser(<DevicesView deviceId="d1" />, {
    ...opts,
    devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC' })], ...opts.devices },
  });
}

async function section() {
  const heading = await screen.findByRole('heading', { name: 'Browser bridge', level: 2 });
  return within(heading.closest('section')!);
}

const showDetails = async (s: ReturnType<typeof within>) =>
  userEvent.click(s.getByRole('button', { name: /Show details/ }));

describe('the browser bridge on a device', () => {
  it('starts collapsed when nothing waits, and shows the setup steps while not connected', async () => {
    const { api } = await openDevice();
    const s = await section();
    await waitFor(() => expect(s.getByText('Not connected')).toBeTruthy());
    expect(api.getBridgeStatus).toHaveBeenCalledWith('d1');
    expect(s.getByText(/Now: 0 shared tabs, 0 sites granted\./)).toBeTruthy();
    expect(s.queryByRole('heading', { name: 'Shared tabs' })).toBeNull();
    await showDetails(s);
    expect(s.getByRole('button', { name: /Hide details/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(s.getByText(/Not connected\. The extension connects/)).toBeTruthy();
    // The setup steps are open while the bridge is not connected.
    expect(s.getByText('apps/extension/dist')).toBeTruthy();
    expect(s.getByText('novad bridge enable')).toBeTruthy();
    expect(s.getByText('localRuntime.users')).toBeTruthy();
    const toggle = s.getByRole('button', { name: /How to set up the bridge on Desk PC/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(toggle);
    expect(s.queryByText('novad bridge enable')).toBeNull();
    expect(s.getByText('No site is granted.')).toBeTruthy();
  });

  it('shows the connection and the shared tabs, and confirms a site the browser allowed', async () => {
    const { api, state } = await openDevice({
      m75: {
        bridges: {
          d1: connectedBridge({
            tabs: [
              bridgeTab({ tabId: 7, host: 'github.com', title: 'Pull requests' }),
              bridgeTab({ tabId: 8, host: 'docs.example', title: '', origin: 'agent' }),
              bridgeTab({ tabId: 9, host: 'mail.example', title: 'Mail', user: 'alex' }),
            ],
          }),
        },
        grants: [bridgeGrantView({ id: 'g1', host: 'github.com', state: 'pending' })],
      },
    });
    const s = await section();
    // A site waiting for the owner opens the section by itself.
    expect(await s.findByRole('list', { name: 'Sites waiting for you' })).toBeTruthy();
    expect(s.getByText('Connected')).toBeTruthy();
    expect(s.getByText('Chromium 140')).toBeTruthy();
    expect(s.getByText('Nova 0.7.5')).toBeTruthy();
    expect(s.getByText('sam')).toBeTruthy();
    const tabs = within(s.getByRole('list', { name: 'Shared tabs' }));
    expect(tabs.getByText('Pull requests')).toBeTruthy();
    expect(tabs.getAllByText('You shared it')).toHaveLength(2);
    expect(tabs.getByText('Untitled tab')).toBeTruthy();
    expect(tabs.getByText('Opened by the agent in the Nova tab group')).toBeTruthy();
    // A tab of another OS user says whose browser it is in.
    expect(tabs.getByText('In alex’s browser')).toBeTruthy();
    expect(tabs.getAllByText(/’s browser/)).toHaveLength(1);
    // Connected: the setup steps start closed.
    expect(s.queryByText('novad bridge enable')).toBeNull();

    await userEvent.click(s.getByRole('button', { name: 'Confirm github.com' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm github.com on Desk PC?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.textContent).toContain('signed in as you');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm github.com' }));
    expect(api.confirmBridgeGrant).toHaveBeenCalledWith('d1', 'g1', { confirm: true });
    expect((await screen.findAllByText('github.com granted on Desk PC.')).length).toBeGreaterThan(
      0,
    );
    const granted = within(await s.findByRole('list', { name: 'Granted sites' }));
    expect(granted.getByText('Granted')).toBeTruthy();
    expect(state.grants[0]!.state).toBe('active');
  });

  it('grants a host from the form, after checking it is a host name', async () => {
    const { api } = await openDevice({ m75: { bridges: { d1: connectedBridge() } } });
    const s = await section();
    await showDetails(s);
    const field = s.getByLabelText('Site to grant');
    await userEvent.type(field, 'https://github.com/x');
    await userEvent.click(s.getByRole('button', { name: 'Grant' }));
    expect(s.getByText('Enter a host name such as github.com')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.clear(field);
    await userEvent.type(field, 'Example.COM{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Grant example.com on Desk PC?' });
    expect(dialog.textContent).toContain('cookies and passwords never leave the browser');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Grant example.com' }));
    expect(api.createBridgeGrant).toHaveBeenCalledWith('d1', {
      kind: 'host',
      host: 'example.com',
      confirm: true,
    });
    const granted = within(await s.findByRole('list', { name: 'Granted sites' }));
    expect(granted.getByText('example.com')).toBeTruthy();
    // The browser has not allowed it yet: sharing a tab there asks.
    expect(granted.getByText(/Your browser has not allowed it yet/)).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('refuses one of the Hub’s own hosts on the form, keeping what was typed', async () => {
    const { api, state } = await openDevice({ m75: { bridges: { d1: connectedBridge() } } });
    const s = await section();
    await showDetails(s);
    const field = s.getByLabelText('Site to grant');
    // The form says so before anything is typed.
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    expect(s.getByText(/This Hub’s own addresses are never granted/)).toBeTruthy();
    await userEvent.type(field, 'api.hub.example{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Grant api.hub.example on Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Grant api.hub.example' }));
    expect(api.createBridgeGrant).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const error = await s.findByText(/one of this Hub’s own addresses/);
    expect(error.getAttribute('role')).toBe('alert');
    expect(field).toHaveProperty('value', 'api.hub.example');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(state.grants).toHaveLength(0);
    // Typing again clears it.
    await userEvent.type(field, 'x');
    expect(s.queryByText(/one of this Hub’s own addresses/)).toBeNull();
  });

  it('lists this computer’s recent bridge activity in words', async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 2, 9, m, 0)).toISOString();
    await openDevice({
      m75: { bridges: { d1: connectedBridge() } },
      audit: [
        auditEntry({
          id: 'a1',
          action: 'browser.bridge.history.search',
          resource: 'device:d1',
          createdAt: at(5),
        }),
        auditEntry({
          id: 'a2',
          action: 'browser.bridge.replaced',
          resource: 'd1',
          createdAt: at(4),
        }),
        auditEntry({
          id: 'a3',
          action: 'browser.fallback.orphan_closed',
          resource: 'd1',
          createdAt: at(3),
        }),
        auditEntry({
          id: 'a4',
          action: 'browser.bridge.connected',
          resource: 'd1',
          createdAt: at(2),
        }),
        // Another computer's search and an entry that is not the device's own stay out.
        auditEntry({ id: 'a5', action: 'browser.bridge.history.search', resource: 'device:d2' }),
        auditEntry({ id: 'a6', action: 'browser.bridge.grant.created', resource: 'github.com' }),
      ],
    });
    const s = await section();
    await showDetails(s);
    const list = within(await s.findByRole('list', { name: 'Recent bridge activity' }));
    const rows = list.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain(
      'An agent asked to search your history (your browser asked you first)',
    );
    expect(rows[1]).toContain('A new browser connection replaced the previous one');
    expect(rows[2]).toContain(
      'The Hub closed a browser session on this computer that it no longer ran',
    );
    expect(rows[3]).toContain('The extension connected');
    expect(s.getByText(/History searches have no standing access/)).toBeTruthy();
  });

  it('says when there is no activity yet', async () => {
    await openDevice({ m75: { bridges: { d1: connectedBridge() } } });
    const s = await section();
    await showDetails(s);
    expect(await s.findByText(/Nothing yet\. Connections, history searches/)).toBeTruthy();
  });

  it('keeps a refusal in the dialog in plain words', async () => {
    const { failNext } = await openDevice({ m75: { bridges: { d1: connectedBridge() } } });
    const s = await section();
    await showDetails(s);
    await userEvent.type(s.getByLabelText('Site to grant'), 'github.com{Enter}');
    failNext.createBridgeGrant = new ApiError(403, {
      code: 'policy_denied',
      message: 'the extension bridge is turned off',
      retryable: false,
      details: { reason: 'bridge_disabled' },
    });
    const dialog = screen.getByRole('dialog', { name: 'Grant github.com on Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Grant github.com' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The browser bridge is turned off in Settings → Browser, so nothing can be granted.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says when a pending grant was revoked in the meantime', async () => {
    const { state } = await openDevice({
      m75: {
        bridges: { d1: connectedBridge() },
        grants: [bridgeGrantView({ id: 'g1', host: 'github.com', state: 'pending' })],
      },
    });
    const s = await section();
    await userEvent.click(await s.findByRole('button', { name: 'Confirm github.com' }));
    state.grants = state.grants.map((g) => ({ ...g, state: 'revoked' as const }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm github.com on Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm github.com' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'revoked in the meantime',
    );
  });

  it('refuses a pending site and revokes a granted one, each after asking', async () => {
    const { api, state } = await openDevice({
      m75: {
        bridges: { d1: connectedBridge() },
        grants: [
          bridgeGrantView({ id: 'g1', host: 'ads.example', state: 'pending' }),
          bridgeGrantView({ id: 'g2', host: 'github.com', state: 'active' }),
        ],
      },
    });
    const s = await section();
    await userEvent.click(await s.findByRole('button', { name: 'Refuse ads.example' }));
    let dialog = screen.getByRole('dialog', { name: 'Refuse ads.example on Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Refuse' }));
    expect(api.revokeBridgeGrant).toHaveBeenCalledWith('d1', 'g1');
    expect((await screen.findAllByText('ads.example refused on Desk PC.')).length).toBeGreaterThan(
      0,
    );

    // With nothing pending, the section stays open because the owner is using it.
    await userEvent.click(await s.findByRole('button', { name: 'Revoke github.com' }));
    dialog = screen.getByRole('dialog', { name: 'Revoke github.com on Desk PC?' });
    expect(dialog.textContent).toContain('at once');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeBridgeGrant).toHaveBeenCalledWith('d1', 'g2');
    await waitFor(() => expect(s.queryByRole('list', { name: 'Granted sites' })).toBeNull());
    expect(state.grants.every((g) => g.state === 'revoked')).toBe(true);

    await userEvent.click(s.getByRole('button', { name: 'Show revoked grants' }));
    const revoked = within(await s.findByRole('list', { name: 'Revoked grants' }));
    expect(revoked.getByText('github.com')).toBeTruthy();
    expect(revoked.getByText('ads.example')).toBeTruthy();
    expect(api.listBridgeGrants).toHaveBeenLastCalledWith('d1', true);
  });

  it('grants all sites only after its own acknowledgement', async () => {
    const { api } = await openDevice({ m75: { bridges: { d1: connectedBridge() } } });
    const s = await section();
    await showDetails(s);
    expect(s.getByText('Elevated risk')).toBeTruthy();
    await userEvent.click(s.getByRole('button', { name: 'Grant all sites…' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant all sites on Desk PC?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.textContent).toContain('off by default');
    const confirm = within(dialog).getByRole('button', { name: 'Grant all sites' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'I understand that agents can then act on any site in tabs I share on Desk PC.',
      }),
    );
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirm);
    expect(api.createBridgeGrant).toHaveBeenCalledWith('d1', {
      kind: 'all_sites',
      confirm: true,
      acknowledgeElevatedRisk: true,
    });
    const grant = within(await s.findByRole('list', { name: 'All sites grant' }));
    expect(grant.getByText('All sites')).toBeTruthy();
    expect(grant.getByRole('button', { name: 'Revoke All sites' })).toBeTruthy();
    expect(s.queryByRole('button', { name: 'Grant all sites…' })).toBeNull();
  });

  it('confirms an all-sites permission the browser reported with the acknowledgement', async () => {
    const { api } = await openDevice({
      m75: {
        bridges: { d1: connectedBridge() },
        grants: [bridgeGrantView({ id: 'g9', host: '*', state: 'pending' })],
      },
    });
    const s = await section();
    await userEvent.click(await s.findByRole('button', { name: 'Confirm All sites' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant all sites on Desk PC?' });
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Grant all sites' }));
    expect(api.confirmBridgeGrant).toHaveBeenCalledWith('d1', 'g9', {
      confirm: true,
      acknowledgeElevatedRisk: true,
    });
    expect((await screen.findAllByText('All sites granted on Desk PC.')).length).toBeGreaterThan(0);
  });

  it('turns all sites off with its setting, and says an existing grant is not in use', async () => {
    await openDevice({
      settings: { 'browser.extensionBridgeAllSites': false },
      m75: { bridges: { d1: connectedBridge() } },
    });
    let s = await section();
    await showDetails(s);
    expect(s.queryByRole('button', { name: 'Grant all sites…' })).toBeNull();
    expect(s.getByText(/Allow the “all sites” grant/)).toBeTruthy();
    resetDom();
    await openDevice({
      managed: { 'browser.extensionBridgeAllSites': false },
      m75: {
        bridges: { d1: connectedBridge() },
        grants: [bridgeGrantView({ host: '*', state: 'active' })],
      },
    });
    s = await section();
    await showDetails(s);
    expect(s.getByText(/Not in use: turned off by your organization\./)).toBeTruthy();
  });

  it('says when the bridge is off, by the setting or by policy, and stops granting', async () => {
    await openDevice({
      settings: { 'browser.extensionBridge': false },
      m75: { grants: [bridgeGrantView({ host: 'github.com' })] },
    });
    let s = await section();
    await waitFor(() => expect(s.getByText('Turned off')).toBeTruthy());
    await showDetails(s);
    expect(s.getByText(/Turned off in Settings → Browser/)).toBeTruthy();
    expect(s.getByLabelText('Site to grant')).toHaveProperty('disabled', true);
    expect(s.getByRole('button', { name: 'Grant' })).toHaveProperty('disabled', true);
    expect(s.getByText('Not available while the bridge is turned off.')).toBeTruthy();
    // The grants stay listed.
    expect(s.getByRole('list', { name: 'Granted sites' })).toBeTruthy();
    resetDom();
    await openDevice({ managed: { 'browser.extensionBridge': false } });
    s = await section();
    await showDetails(s);
    expect(s.getByText(/Turned off by your organization/)).toBeTruthy();
  });

  it('follows the bridge events of this device', async () => {
    const { state } = await openDevice();
    const s = await section();
    await waitFor(() => expect(s.getByText('Not connected')).toBeTruthy());
    state.bridges.d1 = connectedBridge({ tabs: [bridgeTab({ title: 'Inbox' })] });
    // Another device's event changes nothing.
    act(() => {
      emitHub('browser.bridge.changed', { deviceId: 'd2', connected: true, tabs: 1 });
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(s.getByText('Not connected')).toBeTruthy();
    act(() => {
      emitHub('browser.bridge.changed', { deviceId: 'd1', connected: true, tabs: 1 });
    });
    await waitFor(() => expect(s.getByText('Connected')).toBeTruthy());
    expect(s.getByText(/Now: 1 shared tab, 0 sites granted\./)).toBeTruthy();
    state.grants = [bridgeGrantView({ id: 'g1', host: 'mail.example', state: 'pending' })];
    act(() => {
      emitHub('browser.bridge.grant.changed', {
        deviceId: 'd1',
        grantId: 'g1',
        host: 'mail.example',
        state: 'pending',
      });
    });
    expect(await s.findByRole('button', { name: 'Confirm mail.example' })).toBeTruthy();
    expect(s.getByText(/1 waiting for you/)).toBeTruthy();
  });

  it('shows a load failure with Retry', async () => {
    await openDevice({
      fail: {
        getBridgeStatus: new ApiError(404, {
          code: 'not_found',
          message: 'device not found',
          retryable: false,
        }),
      },
    });
    const s = await section();
    expect((await s.findByRole('alert')).textContent).toContain('This device is not on this Hub.');
    await userEvent.click(s.getByRole('button', { name: 'Retry the browser bridge' }));
    await waitFor(() => expect(s.queryByRole('alert')).toBeNull());
    expect(s.getByText('Not connected')).toBeTruthy();
  });

  it('gives a member the owner-only notice', async () => {
    await openDevice({ m75: { member: true } });
    const s = await section();
    expect(await s.findByText('Only the owner of this Hub can change this.')).toBeTruthy();
    expect(s.queryByRole('button', { name: /Show details/ })).toBeNull();
  });

  it('leaves the section out for a client without the calls', async () => {
    await openDevice({ without: true });
    expect(await screen.findByRole('heading', { name: 'Desk PC', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Browser bridge' })).toBeNull();
  });
});
