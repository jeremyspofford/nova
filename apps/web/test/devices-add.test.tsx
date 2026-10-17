// Add a device, the owner's side (FR-132; docs/04 §9 flow 1; docs/22 §4): role and scopes, the
// QR code, short code, countdown, install commands and join link; the device's request arriving
// live or by the safety check; a wrong code refused and the right one approving; the success
// screen with role and scopes; deny; an expired code and a new one; no install command; adding
// turned off; and a request opened from its notification.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { REQUEST_CHECK_MS, plainHttpOnNetwork } from '../src/devices/AddDevice.tsx';
import type { AddDeviceStarted } from '../src/devices/api.ts';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { qrPath } from '../src/devices/Qr.tsx';
import { FakeEventSource } from './fakes.ts';
import { captureIntervals } from './fakes-workspace.ts';
import { arrive, renderWithAllDevices, revealed } from './fakes-m65-devices.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

function openAdd(path = '/devices/add', opts: Parameters<typeof renderWithAllDevices>[1] = {}) {
  window.history.replaceState(null, '', path);
  return renderWithAllDevices(<DevicesView deviceId="add" />, opts);
}

describe('Add a device with a code (FR-132)', () => {
  it('makes a code for a role and scopes, then approves the device with its six digits', async () => {
    const { api, addState } = await openAdd('/devices/add', {
      added: {
        nextCodes: ['ABCDEFGH'],
        bootstrap: {
          command: 'curl -fsSL http://hub.test/x | sh -s -- install --code ABCD-EFGH',
          why: null,
          powershell: 'iwr http://hub.test/x | iex',
        },
      },
    });
    expect(screen.getByRole('heading', { name: 'Add a device', level: 1 })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Client' })).toHaveProperty('checked', true);
    // A client's scopes; nothing is on until chosen.
    const offline = screen.getByRole('checkbox', { name: 'Offline copy' });
    expect(offline).toHaveProperty('checked', false);
    expect(screen.getByRole('checkbox', { name: 'Computer use' })).toBeTruthy();
    // No Relay on this Hub: no path to choose.
    expect(screen.queryByRole('radio', { name: 'Through the Relay' })).toBeNull();
    await userEvent.click(offline);
    await userEvent.type(screen.getByRole('textbox', { name: 'Name (optional)' }), 'Sam phone');
    await userEvent.click(screen.getByRole('button', { name: 'Create code' }));
    expect(api.startAddDevice).toHaveBeenCalledWith({
      role: 'client',
      scopes: ['offline-replica'],
      name: 'Sam phone',
    });

    // QR (made here from the payload), code, countdown, join link and install commands.
    const qr = await screen.findByRole('img', { name: 'QR code that adds a device to this Hub' });
    const started = await (api.startAddDevice.mock.results[0]!.value as Promise<AddDeviceStarted>);
    expect(qr.querySelector('path')?.getAttribute('d')).toBe(qrPath(started.qr).d);
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toMatch(/^[45]:\d\d$/);
    expect(screen.getByText(started.qr)).toBeTruthy();
    expect(started.qr).toMatch(/\/add-device\?p=.*#c=ABCD-EFGH$/);
    expect(screen.getByText('Client · Scopes: Offline copy')).toBeTruthy();
    await userEvent.click(screen.getByText('Adding a computer without a screen?'));
    expect(screen.getByText(/install --code ABCD-EFGH/)).toBeTruthy();
    expect(screen.getByText('iwr http://hub.test/x | iex')).toBeTruthy();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
    await userEvent.click(screen.getByRole('button', { name: 'Copy Windows command' }));
    expect(writeText).toHaveBeenCalledWith('iwr http://hub.test/x | iex');
    expect(
      screen.getByText('Waiting for the device to ask to join. You approve it here.'),
    ).toBeTruthy();

    // The device asks to join: the Hub tells every client.
    const req = arrive(addState, {
      pairingId: started.pairingId,
      name: 'Sam phone',
      scopes: ['offline-replica'],
      confirmation: '482913',
    });
    stream().emit('device.add.requested', {
      requestId: req.view.id,
      role: 'client',
      kind: 'browser',
      platform: 'iOS',
      name: 'Sam phone',
    });
    const card = await screen.findByRole('region', { name: 'Sam phone wants to join' });
    expect(within(card).getByText(/Web browser · iOS · as Client/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /QR code/ })).toBeNull();
    // Never filled in: reading the device's screen is the check.
    const field = within(card).getByRole('textbox', { name: 'Code shown on the device' });
    expect(field).toHaveProperty('value', '');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(within(card).getByText('Type the six digits the device shows.')).toBeTruthy();
    expect(api.approveAddRequest).not.toHaveBeenCalled();
    await userEvent.type(field, '482 914');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(
      await within(card).findByText(
        'That code does not match the one on the device. Compare the six digits on both screens.',
      ),
    ).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, '482 913');
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(api.approveAddRequest).toHaveBeenLastCalledWith(req.view.id, '482913');

    // The success screen shows its role and scopes and links to its page.
    const done = await screen.findByRole('heading', { name: 'Sam phone is added', level: 1 });
    await waitFor(() => expect(document.activeElement).toBe(done));
    expect(screen.getByText('Offline copy')).toBeTruthy();
    expect(screen.getByText('Web browser')).toBeTruthy();
    expect(screen.getByText(/It is signed in now/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Sam phone' }));
    expect(window.location.pathname).toMatch(/^\/devices\/dev-/);
  });

  it('finds the request with its safety check, and denies it', async () => {
    const intervals = captureIntervals(REQUEST_CHECK_MS);
    const { api, addState } = await openAdd();
    await userEvent.click(screen.getByRole('button', { name: 'Create code' }));
    await screen.findByRole('timer');
    const pairingId = addState.pairings[0]!.id;
    arrive(addState, { pairingId, name: 'Laptop', kind: 'native', platform: 'macOS' });
    // No event (the stream was down): the check every few seconds finds it.
    intervals.fire();
    const card = await screen.findByRole('region', { name: 'Laptop wants to join' });
    expect(within(card).getByText(/Nova app · macOS/)).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Deny' }));
    expect(api.denyAddRequest).toHaveBeenCalled();
    expect(await screen.findByText('Laptop was not added. Its code is used up.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(screen.getByRole('button', { name: 'Create code' })).toBeTruthy();
  });

  it('offers a new code when one expires, and shows why there is no install command', async () => {
    const { api, addState } = await openAdd('/devices/add?role=compute', {
      added: {
        bootstrap: {
          command: null,
          why: 'This Hub has no novad build to install yet.',
          powershell: null,
        },
      },
    });
    expect(screen.getByRole('radio', { name: 'Compute node' })).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: 'Commands' })).toBeTruthy();
    // Made five minutes ago: already expired.
    addState.now = () => Date.now() - 6 * 60_000;
    await userEvent.click(screen.getByRole('button', { name: 'Create code' }));
    expect(
      await screen.findByText('This code has expired. Make a new one to add the device.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy code' })).toHaveProperty('disabled', true);
    // A compute node is headless: the install section is open, and says why there is none.
    expect(screen.getByRole('heading', { name: 'On a computer without a screen' })).toBeTruthy();
    expect(screen.getByText('This Hub has no novad build to install yet.')).toBeTruthy();
    addState.now = () => Date.now();
    await userEvent.click(screen.getByRole('button', { name: 'New code' }));
    expect(await screen.findByRole('timer')).toBeTruthy();
    expect(api.startAddDevice).toHaveBeenCalledTimes(2);
    expect(api.startAddDevice).toHaveBeenLastCalledWith({ role: 'compute', scopes: [] });
  });

  it('says why a code cannot be made, and when adding is turned off', async () => {
    const { added } = await openAdd();
    added.failNext.startAddDevice = new ApiError(429, {
      code: 'rate_limited',
      message: 'too many',
      retryable: false,
      details: { reason: 'start_rate_limited', limit: 20 },
    });
    await userEvent.click(screen.getByRole('radio', { name: 'Wake helper' }));
    expect(screen.getByText(/A Wake helper only sends wake signals/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create code' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many codes were made in the last hour (at most 20). Try again later.',
    );
    resetDom();
    await openAdd('/devices/add', { settings: { 'devices.add.enabled': false } });
    expect(screen.getByText(/Adding devices with a code is turned off/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Turn it on in Settings → Devices' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create code' })).toHaveProperty('disabled', true);
  });

  it('offers the Relay when the Hub has one', async () => {
    const { api } = await openAdd('/devices/add', {
      settings: { 'relay.enabled': true },
      added: { relay: { relayUrl: 'wss://relay.test', relayPairingId: 'rp1' } },
    });
    await userEvent.click(screen.getByRole('radio', { name: 'Through the Relay' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create code' }));
    expect(api.startAddDevice).toHaveBeenCalledWith({
      role: 'client',
      scopes: [],
      transport: 'relay',
    });
    expect(
      await screen.findByText('Client · Scopes: No extra scopes · through the Relay'),
    ).toBeTruthy();
    // Through the Relay the page's own address does not matter: no plain-HTTP warning.
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('warns that a phone needs HTTPS when the Hub is on plain HTTP at a network address', async () => {
    await openAdd('/devices/add');
    await userEvent.click(screen.getByRole('button', { name: 'Create code' }));
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('only over a secure connection');
    expect(within(note).getByRole('link', { name: 'Network → Trust' }).getAttribute('href')).toBe(
      '/network/trust',
    );
    expect(plainHttpOnNetwork('http://192.168.1.20:7419/add-device?p=x')).toBe(true);
    expect(plainHttpOnNetwork('https://192.168.1.20:7419/add-device')).toBe(false);
    expect(plainHttpOnNetwork('http://localhost:7419/add-device')).toBe(false);
    expect(plainHttpOnNetwork('http://127.0.0.1:7419/add-device')).toBe(false);
    expect(plainHttpOnNetwork('http://[::1]:7419/add-device')).toBe(false);
    expect(plainHttpOnNetwork('not a url')).toBe(false);
  });
});

describe('a request opened from its notification', () => {
  it('shows a pending request, and says when one was decided or is unknown', async () => {
    const { api } = await openAdd('/devices/add?request=rq1', {
      added: { requests: [revealed({ id: 'rq1', name: 'Kitchen tablet', kind: 'native' })] },
    });
    const card = await screen.findByRole('region', { name: 'Kitchen tablet wants to join' });
    await userEvent.type(
      within(card).getByRole('textbox', { name: 'Code shown on the device' }),
      '123456',
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(api.approveAddRequest).toHaveBeenCalledWith('rq1', '123456');
    expect(await screen.findByRole('heading', { name: 'Kitchen tablet is added' })).toBeTruthy();
    expect(screen.getByText('Nova app')).toBeTruthy();

    resetDom();
    await openAdd('/devices/add?request=rq2', {
      added: { requests: [revealed({ id: 'rq2', name: 'Old phone', status: 'denied' })] },
    });
    expect(await screen.findByText('Old phone was not added. Its code is used up.')).toBeTruthy();

    resetDom();
    await openAdd('/devices/add?request=rq3', {
      added: { requests: [revealed({ id: 'rq3', name: 'Slow phone', status: 'expired' })] },
    });
    expect(
      await screen.findByText('The request from Slow phone expired before it was approved.'),
    ).toBeTruthy();

    resetDom();
    await openAdd('/devices/add?request=nope');
    expect(await screen.findByText('This request is not on this Hub any more.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(window.location.search).toBe('');
    expect(await screen.findByRole('button', { name: 'Create code' })).toBeTruthy();
  });

  it('follows a decision made elsewhere, and retries a failed load', async () => {
    const { addState } = await openAdd('/devices/add?request=rq1', {
      added: { requests: [revealed({ id: 'rq1', name: 'Tablet' })] },
    });
    await screen.findByRole('region', { name: 'Tablet wants to join' });
    // Approved in another window.
    const r = addState.requests[0]!;
    r.view = { ...r.view, status: 'approved', deviceId: 'dev-9' };
    stream().emit('device.add.decided', { requestId: 'rq1', decision: 'approved' });
    expect(await screen.findByRole('heading', { name: 'Tablet is added' })).toBeTruthy();

    resetDom();
    await openAdd('/devices/add?request=rq1', {
      added: { requests: [revealed({ id: 'rq1', name: 'Tablet' })] },
      fail: {
        listAddRequests: new ApiError(503, {
          code: 'unavailable',
          message: 'The Hub is busy.',
          retryable: true,
        }),
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('The Hub is busy.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Tablet wants to join' })).toBeTruthy();
  });

  it('says when the request was decided before Approve', async () => {
    const { addState } = await openAdd('/devices/add?request=rq1', {
      added: { requests: [revealed({ id: 'rq1', name: 'Tablet' })] },
    });
    const card = await screen.findByRole('region', { name: 'Tablet wants to join' });
    addState.requests[0]!.view = { ...addState.requests[0]!.view, status: 'denied' };
    await userEvent.type(
      within(card).getByRole('textbox', { name: 'Code shown on the device' }),
      '123456',
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Tablet was not added. Its code is used up.')).toBeTruthy();
  });
});
