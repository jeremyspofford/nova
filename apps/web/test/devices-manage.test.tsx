// Device management (FR-140; docs/04 §9; docs/22 §4.2, §4.5, §7): one list for every kind of
// device with roles, status, what it runs, platform, last contact and reachability; requests to
// join waiting at the top; a device's scopes shown and edited; Wake through a Wake helper or by
// the Hub, and the refusal when neither reaches it; Revoke saying what it does (and that it signs
// out the device in use); live updates; and Settings → Devices for adding with a code.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { revokeText } from '../src/devices/DevicePage.tsx';
import { runsText, scopeChoices, scopesText, wakeSentText } from '../src/devices/format.ts';
import { pageNav } from '../src/join/store.ts';
import { FakeEventSource, createHub } from './fakes.ts';
import { deviceView } from './fakes-m6-devices.ts';
import { renderWithAllDevices, revealed, summaryView } from './fakes-m65-devices.ts';
import { renderApp, resetDom } from './render.tsx';

const realAssign = pageNav.assign;

afterEach(() => {
  pageNav.assign = realAssign;
  resetDom();
  vi.restoreAllMocks();
  window.localStorage.removeItem('nova.device.id');
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

const KINDS = {
  devices: [deviceView({ id: 'd1', name: 'Desk PC', status: 'unreachable' })],
};
const OTHERS = [
  summaryView({ id: 'b1', name: 'Sam phone', sessions: 2, scopes: ['offline-replica'] }),
  summaryView({
    id: 'c1',
    name: 'GPU box',
    kind: 'compute',
    addedAs: null,
    roles: ['compute'],
    platform: 'linux',
    sessions: 0,
  }),
  summaryView({
    id: 'n1',
    name: 'NAS',
    kind: 'wake-helper',
    addedAs: 'novad',
    roles: ['wake-helper'],
    status: 'pending',
    platform: 'linux',
    sessions: 0,
    lastSeenAt: null,
  }),
  summaryView({ id: 'r1', name: 'Lost tablet', status: 'revoked', sessions: 0 }),
];

function openPage(id: string, opts: Parameters<typeof renderWithAllDevices>[1] = {}) {
  window.history.replaceState(null, '', `/devices/${id}`);
  return renderWithAllDevices(<DevicesView deviceId={id} />, {
    devices: KINDS,
    added: { others: OTHERS },
    ...opts,
  });
}

describe('every device in one list (FR-140)', () => {
  it('shows browsers, novad devices and compute nodes with what each runs and how it is reached', async () => {
    await renderWithAllDevices(<DevicesView deviceId={null} />, {
      devices: KINDS,
      added: { others: OTHERS },
    });
    const list = await screen.findByRole('list', { name: 'Devices' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Desk PC',
      'Sam phone',
      'GPU box',
      'NAS',
      'Lost tablet',
    ]);
    const phone = rows[1]!;
    expect(within(phone).getByText('Online')).toBeTruthy();
    expect(within(phone).getByText('Web browser')).toBeTruthy();
    expect(within(phone).getByText('iOS')).toBeTruthy();
    expect(within(phone).getByText(/^last seen/)).toBeTruthy();
    expect(within(phone).getByText('Signed in (2 sessions)')).toBeTruthy();
    expect(within(phone).getByText('Scopes: Offline copy')).toBeTruthy();
    expect(within(rows[2]!).getByText('nova-compute')).toBeTruthy();
    expect(within(rows[2]!).getByText('Compute node')).toBeTruthy();
    const nas = rows[3]!;
    expect(within(nas).getByText('Waiting for first contact')).toBeTruthy();
    expect(within(nas).getByText('novad, version unknown')).toBeTruthy();
    expect(within(nas).getByText('not seen yet')).toBeTruthy();
    // The novad device keeps its details, and is offline: Wake.
    expect(within(rows[0]!).getByText('Offline')).toBeTruthy();
    expect(within(rows[0]!).getByText('Not reachable now')).toBeTruthy();
    expect(within(rows[0]!).getByRole('button', { name: 'Wake Desk PC' })).toBeTruthy();
    expect(within(rows[4]!).getByText('Revoked')).toBeTruthy();
    expect(within(rows[4]!).queryByText('Signed out')).toBeNull();
  });

  it('lists requests waiting for approval, and approves one there', async () => {
    const { api } = await renderWithAllDevices(<DevicesView deviceId={null} />, {
      added: {
        requests: [revealed({ id: 'rq1', name: 'Kitchen tablet', confirmation: '777111' })],
      },
    });
    const waiting = await screen.findByRole('list', { name: 'Waiting for approval' });
    const card = within(waiting).getByRole('region', { name: 'Kitchen tablet wants to join' });
    await userEvent.type(
      within(card).getByRole('textbox', { name: 'Code shown on the device' }),
      '777111',
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(api.approveAddRequest).toHaveBeenCalledWith('rq1', '777111');
    expect(await screen.findByText('Kitchen tablet is added.')).toBeTruthy();
    expect(await screen.findByRole('listitem', { name: 'Kitchen tablet' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Waiting for approval' })).toBeNull();
  });

  it('shows a request that arrives live, and what failed to load', async () => {
    const { addState, devices } = await renderWithAllDevices(<DevicesView deviceId={null} />, {
      added: { others: [summaryView({ id: 'b1', name: 'Sam phone' })] },
    });
    await screen.findByRole('listitem', { name: 'Sam phone' });
    addState.requests = [revealed({ id: 'rq1', name: 'New laptop' })];
    stream().emit('device.add.requested', { requestId: 'rq1', name: 'New laptop' });
    expect(await screen.findByRole('region', { name: 'New laptop wants to join' })).toBeTruthy();
    // Denied there.
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('New laptop was not added.')).toBeTruthy();

    devices.failNext.listNovadDevices = new ApiError(503, {
      code: 'unavailable',
      message: 'novad registry busy',
      retryable: true,
    });
    stream().emit('device.status.changed', { deviceId: 'b1', status: 'active' });
    expect((await screen.findByRole('alert')).textContent).toContain('novad registry busy');
    expect(screen.getByRole('listitem', { name: 'Sam phone' })).toBeTruthy();
  });
});

describe('a device’s page', () => {
  it('shows a browser’s sessions and scopes, and edits its scopes', async () => {
    const { api, addState } = await openPage('b1');
    expect(await screen.findByRole('heading', { name: 'Sam phone', level: 1 })).toBeTruthy();
    expect(screen.getByText('2 live sessions')).toBeTruthy();
    expect(screen.getByText('Web browser')).toBeTruthy();
    // A browser has no novad tabs.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    const scopes = screen.getByRole('list', { name: 'Scopes' });
    expect(within(scopes).getByText('Offline copy')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Edit scopes' }));
    const dialog = screen.getByRole('dialog', { name: 'Scopes of Sam phone' });
    expect(within(dialog).getByRole('checkbox', { name: 'Offline copy' })).toHaveProperty(
      'checked',
      true,
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Local models' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Offline copy' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(api.setDeviceScopes).toHaveBeenCalledWith('b1', ['local-runtime']);
    expect(await screen.findByText('Scopes of Sam phone saved.')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Scopes' })).getByText('Local models'),
    ).toBeTruthy();

    // Changed elsewhere: the page follows.
    addState.others = addState.others.map((x) => (x.id === 'b1' ? { ...x, scopes: [] } : x));
    stream().emit('device.scopes.changed', { deviceId: 'b1', scopes: [] });
    expect(await screen.findByText(/No extra scopes/)).toBeTruthy();
  });

  it('shows a refused scope change in the dialog', async () => {
    const { added } = await openPage('b1');
    await screen.findByRole('heading', { name: 'Sam phone', level: 1 });
    added.failNext.setDeviceScopes = new ApiError(409, {
      code: 'conflict',
      message: 'this device was revoked',
      retryable: false,
      details: { reason: 'revoked' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Edit scopes' }));
    const dialog = screen.getByRole('dialog', { name: 'Scopes of Sam phone' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This device was revoked.');
  });

  it('revokes a browser after saying what that does', async () => {
    const { api } = await openPage('b1');
    await screen.findByRole('heading', { name: 'Sam phone', level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Sam phone?' });
    expect(dialog.textContent).toContain('Its sessions end at once and its key is blocked.');
    expect(dialog.textContent).toContain('add it with a new code');
    expect(dialog.textContent).not.toContain('you are using');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeDevice).toHaveBeenCalledWith('b1');
    expect(await screen.findByText('Revoked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit scopes' })).toBeNull();
  });

  it('says when it is the device in use, and signs out after revoking it', async () => {
    window.localStorage.setItem('nova.device.id', 'b1');
    const assign = vi.fn<(path: string) => void>();
    pageNav.assign = assign;
    await openPage('b1');
    expect(await screen.findByText('This device')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Sam phone?' });
    expect(dialog.textContent).toContain(
      'This is the device you are using: you will be signed out here.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('links a compute node to its models, and says when a device is not on this Hub', async () => {
    await openPage('c1');
    expect(await screen.findByRole('heading', { name: 'GPU box', level: 1 })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings → Devices' }).getAttribute('href')).toBe(
      '/settings/devices',
    );
    resetDom();
    await openPage('zz');
    expect(await screen.findByText('This device is not on this Hub.')).toBeTruthy();
  });
});

describe('Wake through a Wake helper (FR-138)', () => {
  it('says which helper sent it, or that the Hub did, or why nothing could', async () => {
    const { api } = await openPage('d1', {
      added: { others: [summaryView({ id: 'h1', name: 'Garage NAS', roles: ['wake-helper'] })] },
    });
    await screen.findByRole('heading', { name: 'Desk PC', level: 1 });
    const base = {
      id: 'w1',
      deviceId: 'd1',
      mac: 'aa:bb:cc:dd:ee:ff',
      status: 'sent' as const,
      createdAt: '',
    };
    api.wakeDevice.mockResolvedValueOnce({ ...base, via: 'h1' });
    await userEvent.click(screen.getByRole('button', { name: 'Wake' }));
    expect(await screen.findByText('Wake signal sent to Desk PC through Garage NAS.')).toBeTruthy();
    api.wakeDevice.mockResolvedValueOnce({ ...base, via: 'hub' });
    await userEvent.click(screen.getByRole('button', { name: 'Wake' }));
    expect(await screen.findByText('Wake signal sent to Desk PC by the Hub.')).toBeTruthy();
    api.wakeDevice.mockRejectedValueOnce(
      new ApiError(409, {
        code: 'conflict',
        message: 'no Wake Helper',
        retryable: false,
        details: { reason: 'no_wake_helper' },
      }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Wake' }));
    expect(await screen.findByText(/Nothing on this device’s network can wake it/)).toBeTruthy();

    // The Power tab links to adding a Wake helper.
    await userEvent.click(screen.getByRole('tab', { name: 'Power' }));
    expect(screen.getByRole('link', { name: 'Add one' }).getAttribute('href')).toBe(
      '/devices/add?role=wake-helper',
    );
  });
});

describe('words', () => {
  it('names scopes, kinds, wakes and what revoking does', () => {
    expect(scopesText([])).toBe('No extra scopes');
    expect(scopesText(['files', 'custom:x'])).toBe('Files, custom:x');
    expect(scopeChoices(['wake-helper'], [])).toEqual([]);
    expect(scopeChoices(['compute'], ['offline-replica'])).toEqual(['exec', 'offline-replica']);
    expect(runsText(summaryView({ kind: 'hub', addedAs: null }), null)).toBe('This Hub');
    expect(runsText(summaryView({ addedAs: null, kind: 'client' }), null)).toBe('Unknown');
    expect(runsText(summaryView({ addedAs: 'novad', novadVersion: '0.8.0' }), null)).toBe(
      'novad 0.8.0',
    );
    expect(wakeSentText('Desk', { mac: 'm', via: 'x' })).toBe(
      'Wake signal sent to Desk through a Wake helper.',
    );
    expect(wakeSentText('Desk', { mac: 'm' })).toBe('Wake signal sent to Desk (m).');
    expect(revokeText({ novad: true, session: false, self: false })).toMatch(
      /^Its credential stops working at once.*every folder it shared is closed/,
    );
  });
});

describe('Settings → Devices: adding with a code (FR-132)', () => {
  it('turns adding off, sets how long a browser stays signed in, and adds a compute node', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/devices' });
    const adding = await screen.findByRole('switch', { name: 'Add devices with a code' });
    expect(adding.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(adding);
    expect(hub.api.setSetting).toHaveBeenCalledWith('devices.add.enabled', false);
    const days = screen.getByRole('spinbutton', {
      name: 'Days an added browser or app stays signed in',
    });
    await userEvent.clear(days);
    await userEvent.type(days, '400');
    expect(screen.getByText('Enter a whole number from 1 to 365.')).toBeTruthy();
    await userEvent.clear(days);
    await userEvent.type(days, '7{Enter}');
    expect(hub.api.setSetting).toHaveBeenCalledWith('devices.add.sessionDays', 7);
    await userEvent.click(screen.getByRole('button', { name: 'Add with a code' }));
    expect(window.location.pathname + window.location.search).toBe('/devices/add?role=compute');
  });
});
