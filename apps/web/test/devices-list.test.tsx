// The Devices list and Add a device (docs/04 §9; FR-141, FR-144, FR-148): every device with its
// role, status, version, heartbeat and capabilities; live updates; Wake with the rate limit; the
// enrollment command that waits for the device to register; and the Settings → Devices entry.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { FakeEventSource, createHub } from './fakes.ts';
import { deviceView, renderWithDevices } from './fakes-m6-devices.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

describe('the device list (docs/04 §9)', () => {
  it('shows each device with role, status, version, heartbeat and capabilities', async () => {
    await renderWithDevices(<DevicesView deviceId={null} />, {
      devices: {
        devices: [
          deviceView({ id: 'd1', name: 'Desk PC', roles: ['client', 'compute'] }),
          deviceView({
            id: 'd2',
            name: 'Old laptop',
            novadVersion: '0.6.0',
            status: 'unreachable',
          }),
          deviceView({ id: 'd3', name: 'Gone', status: 'revoked' }),
          deviceView({
            id: 'd4',
            name: 'New box',
            status: 'pending',
            novadVersion: null,
            lastSeenAt: null,
            policy: { routingEligible: false },
            configPending: true,
          }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Devices' });
    const rows = within(list).getAllByRole('listitem');
    // Revoked devices sort last.
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Desk PC',
      'Old laptop',
      'New box',
      'Gone',
    ]);
    const desk = rows[0]!;
    expect(within(desk).getByText('Online')).toBeTruthy();
    expect(within(desk).getByText('Client, Compute node')).toBeTruthy();
    expect(within(desk).getByText('novad 0.7.0')).toBeTruthy();
    expect(within(desk).getByText(/^last heartbeat/)).toBeTruthy();
    expect(within(desk).getByText(/^Files, Staged writes, Commands/)).toBeTruthy();
    expect(within(desk).getByRole('link', { name: 'Desk PC' }).getAttribute('href')).toBe(
      '/devices/d1',
    );
    const old = rows[1]!;
    expect(within(old).getByText('Offline')).toBeTruthy();
    expect(within(old).getByText('Update required')).toBeTruthy();
    expect(within(old).getByText(/2 need an update/)).toBeTruthy();
    const fresh = rows[2]!;
    expect(within(fresh).getByText('Waiting for first contact')).toBeTruthy();
    expect(within(fresh).getByText('Version unknown')).toBeTruthy();
    expect(within(fresh).getByText('no heartbeat yet')).toBeTruthy();
    expect(within(fresh).getByText('Kept out of agent work')).toBeTruthy();
    expect(within(fresh).getByText('Changes waiting for the device')).toBeTruthy();
    expect(within(rows[3]!).getByText('Revoked')).toBeTruthy();
    expect(within(rows[3]!).queryByText(/^Files/)).toBeNull();

    await userEvent.click(within(desk).getByRole('link', { name: 'Desk PC' }));
    expect(window.location.pathname).toBe('/devices/d1');
  });

  it('starts empty with a way to add one, and links compute nodes in Settings', async () => {
    await renderWithDevices(<DevicesView deviceId={null} />);
    expect(await screen.findByRole('heading', { name: 'No devices yet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings → Devices' }).getAttribute('href')).toBe(
      '/settings/devices',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(window.location.pathname).toBe('/devices/add');
  });

  it('shows an error with Retry, and follows live device events', async () => {
    const { devices, state } = await renderWithDevices(<DevicesView deviceId={null} />, {
      devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC' })] },
    });
    devices.failNext.listNovadDevices = new ApiError(503, {
      code: 'unavailable',
      message: 'The Hub is busy.',
      retryable: true,
    });
    await screen.findByRole('list', { name: 'Devices' });
    stream().emit('device.status.changed', {
      deviceId: 'd1',
      from: 'active',
      status: 'unreachable',
    });
    expect((await screen.findByRole('alert')).textContent).toContain('The Hub is busy.');
    state.devices = state.devices.map((d) => ({ ...d, status: 'unreachable' as const }));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('Offline')).toBeTruthy();

    // A new registration shows up live.
    state.devices = [...state.devices, deviceView({ id: 'd2', name: 'Laptop' })];
    stream().emit('device.registered', { deviceId: 'd2', name: 'Laptop', roles: ['client'] });
    expect(await screen.findByRole('listitem', { name: 'Laptop' })).toBeTruthy();
  });

  it('wakes an offline device, and says when the hourly limit is reached', async () => {
    const { api } = await renderWithDevices(<DevicesView deviceId={null} />, {
      devices: {
        devices: [
          deviceView({ id: 'd1', name: 'Desk PC', status: 'unreachable' }),
          deviceView({ id: 'd2', name: 'Online one' }),
          deviceView({
            id: 'd3',
            name: 'No WoL',
            status: 'unreachable',
            wake: { wakeable: false, macs: [] },
          }),
        ],
        wakesPerHour: 1,
      },
    });
    await screen.findByRole('list', { name: 'Devices' });
    // Only an offline device that reports Wake-on-LAN offers Wake.
    expect(screen.getAllByRole('button', { name: /^Wake / })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Wake Desk PC' }));
    expect(api.wakeDevice).toHaveBeenCalledWith('d1');
    expect(
      await screen.findByText('Wake signal sent to Desk PC (aa:bb:cc:dd:ee:ff).'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Wake Desk PC' }));
    expect(
      await screen.findByText(
        'This device was woken 1 time in the last hour, the most allowed. Try again later.',
      ),
    ).toBeTruthy();
  });
});

describe('Add a device (docs/04 §9 flow 1)', () => {
  it('chooses roles, shows the one-use command, and waits for the device to register', async () => {
    const { api, state } = await renderWithDevices(<DevicesView deviceId="add" />);
    expect(screen.getByRole('heading', { name: 'Add a device', level: 1 })).toBeTruthy();
    const client = screen.getByRole('checkbox', { name: 'Client' });
    expect(client).toHaveProperty('checked', true);
    await userEvent.click(client);
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one.');
    expect(screen.getByRole('button', { name: 'Create command' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Compute node' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Wake helper' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create command' }));
    expect(api.enrollNovadDevice).toHaveBeenCalledWith({ roles: ['compute', 'wake-helper'] });
    const command = await screen.findByText(/^novad enroll --hub/);
    expect(command.textContent).toContain('--role compute --role wake-helper');
    expect(screen.getByText(/Replace <this-device>/)).toBeTruthy();
    expect(screen.getByRole('timer').textContent).toMatch(/^1[45]:\d\d$/);
    expect(screen.getByText(/Waiting for the device to register/)).toBeTruthy();

    // Copy puts the command on the clipboard.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await userEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith(command.textContent);

    // The device registers: the Hub tells every client.
    state.devices = [deviceView({ id: 'd9', name: 'Lab box', roles: ['compute', 'wake-helper'] })];
    stream().emit('device.registered', { deviceId: 'd9', name: 'Lab box', roles: ['compute'] });
    expect(await screen.findByRole('heading', { name: 'Lab box is added' })).toBeTruthy();
    expect(screen.getByText(/Compute node, Wake helper\. novad 0\.7\.0\./)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Lab box' }));
    expect(window.location.pathname).toBe('/devices/d9');
  });

  it('finds the new device with Check now, and replaces an expired command', async () => {
    const { state, api } = await renderWithDevices(<DevicesView deviceId="add" />, {
      devices: { devices: [deviceView({ id: 'd1', name: 'Old one' })] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create command' }));
    await screen.findByText(/^novad enroll/);
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(screen.queryByRole('heading', { name: /is added/ })).toBeNull();
    expect(screen.getByTestId('announcer').textContent).toContain('Not registered yet.');

    state.devices = [...state.devices, deviceView({ id: 'd2', name: 'Fresh' })];
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('heading', { name: 'Fresh is added' })).toBeTruthy();

    // Another one, with an expired command.
    await userEvent.click(screen.getByRole('button', { name: 'Add another device' }));
    api.enrollNovadDevice.mockResolvedValueOnce({
      token: 'nvd_old',
      expiresAt: '2020-01-01T00:00:00.000Z',
      command: 'novad enroll --hub http://hub.test --token nvd_old --role client',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create command' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This command has expired.');
    expect(screen.getByRole('button', { name: 'Copy command' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Create a new command' }));
    await waitFor(() => expect(screen.getByRole('timer')).toBeTruthy());
  });

  it('shows why a command could not be made', async () => {
    const { devices } = await renderWithDevices(<DevicesView deviceId="add" />);
    devices.failNext.enrollNovadDevice = new ApiError(403, {
      code: 'policy_denied',
      message: 'Adding devices is turned off.',
      retryable: false,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create command' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Adding devices is turned off.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(window.location.pathname).toBe('/devices');
  });
});

describe('Settings → Devices', () => {
  it('links to Devices and keeps the rules for every device', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/devices' });
    expect(await screen.findByRole('heading', { name: 'Your devices' })).toBeTruthy();
    // The compute nodes of M2 stay on this page.
    expect(screen.getByRole('heading', { name: 'Compute nodes' })).toBeTruthy();

    const wakes = screen.getByRole('spinbutton', { name: 'Wakes per hour, per device' });
    expect(wakes).toHaveProperty('value', '6');
    await userEvent.clear(wakes);
    await userEvent.type(wakes, '99');
    expect(screen.getByText('Enter a whole number from 1 to 60.')).toBeTruthy();
    await userEvent.clear(wakes);
    await userEvent.type(wakes, '3{Enter}');
    expect(hub.api.setSetting).toHaveBeenCalledWith('devices.wakesPerHour', 3);

    await userEvent.click(screen.getByText('Minimum novad versions'));
    const cu = screen.getByRole('textbox', { name: 'Computer use' });
    await userEvent.type(cu, 'soon');
    expect(screen.getByText('Enter a version like 0.7.0.')).toBeTruthy();
    await userEvent.clear(cu);
    await userEvent.type(cu, '0.9.1{Enter}');
    expect(hub.api.setSetting).toHaveBeenCalledWith('devices.minNovadVersions', {
      computer_use: '0.9.1',
    });

    await userEvent.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(window.location.pathname).toBe('/devices/add');
  });
});
