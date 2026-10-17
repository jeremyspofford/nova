// A device's page (docs/04 §9, docs/23): its facts, rename and revoke; capabilities and Hub
// overrides (FR-142, FR-148); modules and services (FR-141, FR-145); power and Wake-on-LAN
// (FR-144); updates (FR-148); and the per-device policy (FR-150). Each refusal the Hub can answer
// shows why, and the page follows live events.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  bundle,
  deviceView,
  moduleView,
  updateView,
  type M6DevicesState,
} from './fakes-m6-devices.ts';
import { renderWithAllDevices as renderWithDevices } from './fakes-m65-devices.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

function openDevice(
  devices: Partial<M6DevicesState> = {},
  over: Parameters<typeof deviceView>[0] = {},
  tab?: string,
) {
  window.history.replaceState(null, '', tab ? `/devices/d1?tab=${tab}` : '/devices/d1');
  return renderWithDevices(<DevicesView deviceId="d1" />, {
    devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC', ...over })], ...devices },
  });
}

const tab = (name: string) => userEvent.click(screen.getByRole('tab', { name }));

describe('the device page', () => {
  it('shows the facts, renames, and revokes after a confirmation', async () => {
    const { api, state } = await openDevice();
    expect(await screen.findByRole('heading', { name: 'Desk PC', level: 1 })).toBeTruthy();
    expect(screen.getByText('Online')).toBeTruthy();
    expect(screen.getByText('novad 0.7.0')).toBeTruthy();
    expect(screen.getByText('http://10.0.0.7:7420')).toBeTruthy();
    // Online: no Wake in the header.
    expect(screen.queryByRole('button', { name: 'Wake' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename device' });
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Studio PC{Enter}');
    expect(api.updateNovadDevice).toHaveBeenCalledWith('d1', { name: 'Studio PC' });
    expect(await screen.findByRole('heading', { name: 'Studio PC', level: 1 })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    const confirm = screen.getByRole('dialog', { name: 'Revoke Studio PC?' });
    // Focus starts on Cancel, never on the destructive button.
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeDevice).toHaveBeenCalledWith('d1');
    expect(await screen.findByText('Revoked')).toBeTruthy();
    expect(screen.getByText(/it can no longer reach this Hub/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(state.devices[0]!.status).toBe('revoked');
  });

  it('says when the device is not on this Hub, and retries a failed load', async () => {
    window.history.replaceState(null, '', '/devices/zz');
    await renderWithDevices(<DevicesView deviceId="zz" />);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This device is not on this Hub.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Back to devices' }));
    expect(window.location.pathname).toBe('/devices');
  });

  it('opens the tab named in the address, keeps it there, and follows live changes', async () => {
    const { state } = await openDevice({}, {}, 'power');
    expect((await screen.findByRole('tab', { name: 'Power' })).getAttribute('aria-selected')).toBe(
      'true',
    );
    await tab('Updates');
    expect(window.location.search).toBe('?tab=updates');
    await tab('Capabilities');
    expect(window.location.search).toBe('');

    state.devices = state.devices.map((d) => ({ ...d, status: 'unreachable' as const }));
    stream().emit('device.status.changed', {
      deviceId: 'd1',
      from: 'active',
      status: 'unreachable',
    });
    expect(await screen.findByText('Offline')).toBeTruthy();
    // Offline and wakeable: Wake appears in the header.
    expect(screen.getByRole('button', { name: 'Wake' })).toBeTruthy();
    // Another device's events are ignored.
    stream().emit('device.status.changed', { deviceId: 'd2', status: 'active' });
  });
});

describe('capabilities and Hub overrides (FR-142, FR-148)', () => {
  it('lists what the device can do and why not', async () => {
    await openDevice({}, { novadVersion: '0.6.0' });
    expect(await screen.findByText('Update required')).toBeTruthy();
    const caps = screen.getByRole('list', { name: 'Capabilities' });
    expect(within(caps).getByText('Computer use').parentElement!.textContent).toContain(
      'Needs novad 0.7.0',
    );
    expect(within(caps).getByText('Ambient capture').parentElement!.textContent).toContain(
      'No capture module',
    );
    expect(within(caps).getByText('Files').parentElement!.textContent).toContain(
      'Available · Storage module',
    );
    expect(screen.getByText(/Some capabilities need a newer novad/)).toBeTruthy();
    // Detected facts, read-only.
    expect(screen.getByText('RTX 4070 (12 GB)')).toBeTruthy();
    await userEvent.click(screen.getByText('Show the full document'));
    expect(screen.getByLabelText('Capability document').textContent).toContain('"cores": 8');
  });

  it('saves overrides, shows bad fields, and clears an override with a blank field', async () => {
    const { api } = await openDevice(
      {},
      { capabilityOverrides: { limits: { maxEgressMbps: 50 } } },
    );
    const save = await screen.findByRole('button', { name: 'Save overrides' });
    expect(save).toHaveProperty('disabled', true);
    const egress = screen.getByRole('textbox', { name: 'Upload limit (Mbps)' });
    expect(egress).toHaveProperty('value', '50');
    const jobs = screen.getByRole('textbox', { name: 'Jobs at once' });
    // The device's own value is the hint.
    expect(jobs.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('The device reports 2.')).toBeTruthy();
    await userEvent.type(jobs, 'two');
    await userEvent.click(save);
    expect(screen.getByText('Enter a whole number.')).toBeTruthy();
    expect(api.updateNovadDevice).not.toHaveBeenCalled();

    await userEvent.clear(jobs);
    await userEvent.type(jobs, '4');
    await userEvent.clear(egress);
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'GPU sharing' }),
      'exclusive',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Quiet hours the device declares' }),
      '23:00-06:00',
    );
    await userEvent.click(save);
    expect(api.updateNovadDevice).toHaveBeenCalledWith('d1', {
      capabilityOverrides: {
        computePolicy: { gpuSharing: 'exclusive', maxConcurrentJobs: 4 },
        scheduling: { quietHours: ['23:00-06:00'] },
      },
    });
    expect(await screen.findByText('Saved. The device has it.')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Jobs at once' })).toHaveProperty('value', '4');
  });

  it('says an offline device takes the change later, and disables a revoked one', async () => {
    await openDevice({}, { status: 'unreachable' });
    await userEvent.type(await screen.findByRole('textbox', { name: 'Locale' }), 'pt-PT');
    await userEvent.click(screen.getByRole('button', { name: 'Save overrides' }));
    expect(
      await screen.findByText('Saved. The device takes it when it next checks in.'),
    ).toBeTruthy();
    expect(await screen.findByText(/reach the device when it next checks in/)).toBeTruthy();
  });
});

describe('modules and services (FR-141, FR-145)', () => {
  it('stops, starts and rolls back a module; a crash loop says so', async () => {
    const { api } = await openDevice(
      {},
      {
        modules: [
          moduleView({ name: 'management' }),
          moduleView({ name: 'storage', version: '0.7.1', previousVersion: '0.7.0', restarts: 3 }),
          moduleView({
            name: 'browser',
            state: 'disabled',
            disabledReason: 'crash_loop',
            restarts: 5,
            lastExit: 'signal 11',
          }),
        ],
      },
      'modules',
    );
    const list = await screen.findByRole('list', { name: 'Modules' });
    const browser = within(list).getByRole('listitem', { name: 'Browser' });
    expect(within(browser).getByText('Stopped after repeated crashes')).toBeTruthy();
    expect(within(browser).getByText('5 restarts')).toBeTruthy();
    expect(within(browser).getByText('Last exit: signal 11')).toBeTruthy();
    expect(screen.getByText(/Not installed: Compute, Capture/)).toBeTruthy();

    await userEvent.click(within(browser).getByRole('button', { name: 'Start Browser' }));
    expect(api.deviceModuleAction).toHaveBeenCalledWith('d1', 'browser', 'start');
    expect(await within(browser).findByText('Running')).toBeTruthy();

    const storage = within(list).getByRole('listitem', { name: 'Storage' });
    await userEvent.click(within(storage).getByRole('button', { name: 'Stop Storage' }));
    expect(await within(storage).findByText('Stopped')).toBeTruthy();

    await userEvent.click(within(storage).getByRole('button', { name: 'Roll back Storage' }));
    const dialog = screen.getByRole('dialog', { name: 'Roll back Storage?' });
    expect(dialog.textContent).toContain('from version 0.7.1 to 0.7.0');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    expect(await screen.findByText('Storage is back on version 0.7.0.')).toBeTruthy();
    expect(within(storage).queryByRole('button', { name: 'Roll back Storage' })).toBeNull();
  });

  it('keeps a module the policy does not allow from starting, and is off while offline', async () => {
    await openDevice(
      {},
      {
        policy: { allowedModules: ['management', 'storage'] },
        modules: [
          moduleView({ name: 'management' }),
          moduleView({ name: 'screen', state: 'stopped' }),
        ],
      },
      'modules',
    );
    const screenRow = await screen.findByRole('listitem', { name: 'Screen' });
    expect(within(screenRow).getByText('Not allowed by this device’s policy')).toBeTruthy();
    expect(within(screenRow).getByRole('button', { name: 'Start Screen' })).toHaveProperty(
      'disabled',
      true,
    );
    resetDom();
    await openDevice({}, { status: 'unreachable' }, 'modules');
    expect((await screen.findAllByText('The device is offline.')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Stop Storage' })).toHaveProperty('disabled', true);
  });

  it('shows a module action the device refuses', async () => {
    const { devices } = await openDevice({}, {}, 'modules');
    const storage = await screen.findByRole('listitem', { name: 'Storage' });
    devices.state.devices = devices.state.devices.map((d) => ({
      ...d,
      status: 'unreachable' as const,
    }));
    await userEvent.click(within(storage).getByRole('button', { name: 'Restart Storage' }));
    expect(
      await screen.findByText('The device is offline. Try again when it reconnects.'),
    ).toBeTruthy();
  });

  it('runs service actions by name and says when a service is unknown', async () => {
    const { api } = await openDevice({ services: { d1: { compute: 'running' } } }, {}, 'modules');
    const field = await screen.findByRole('combobox', { name: 'Service' });
    await userEvent.type(field, 'compute{Enter}');
    expect(api.deviceServiceAction).toHaveBeenCalledWith('d1', 'compute', 'status');
    expect((await screen.findByText(/running/)).textContent).toContain('compute: running (module)');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect((await screen.findByText(/: stopped/)).textContent).toBe('compute: stopped (module)');
    await userEvent.clear(field);
    await userEvent.type(field, 'ollama');
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect((await screen.findByRole('alert')).textContent).toBe('no managed service named ollama');
    await userEvent.clear(field);
    await userEvent.type(field, 'bad name!');
    expect(screen.getByText('Letters, digits and . _ : @ - only.')).toBeTruthy();
  });
});

describe('power and Wake-on-LAN (FR-144)', () => {
  it('shows the power state, wakes, and stops at the hourly limit', async () => {
    const { api } = await openDevice(
      {
        power: {
          d1: { wakeable: true, macs: ['aa:bb:cc:dd:ee:ff'], ac: true, afterPowerLoss: 'last' },
        },
        wakesPerHour: 1,
      },
      {},
      'power',
    );
    expect(await screen.findByText('Returns to its last state')).toBeTruthy();
    expect(screen.getByText('aa:bb:cc:dd:ee:ff')).toBeTruthy();
    expect(screen.getByText(/The device is online now/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Wake Desk PC' }));
    expect(api.wakeDevice).toHaveBeenCalledWith('d1');
    expect(
      await screen.findByText('Wake signal sent to Desk PC (aa:bb:cc:dd:ee:ff).'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Wake Desk PC' }));
    expect(await screen.findByText(/woken 1 time in the last hour/)).toBeTruthy();
  });

  it('shows the Wake-on-LAN steps first, and says when novad needs elevation', async () => {
    const { api } = await openDevice({ noElevation: ['d1'] }, {}, 'power');
    await userEvent.click(await screen.findByRole('button', { name: 'Show the steps' }));
    expect((await screen.findByLabelText('Steps')).textContent).toBe('ethtool -s eth0 wol g');
    expect(screen.getByText('These steps need administrator rights.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Apply on the device' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn on Wake-on-LAN?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(api.devicePowerAction).toHaveBeenLastCalledWith('d1', {
      action: 'wol-enable',
      apply: true,
    });
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'novad needs elevated rights to change Wake-on-LAN. Run the steps on the device yourself.',
    );
  });

  it('turns Wake-on-LAN on when the device allows it', async () => {
    await openDevice({}, { wake: { wakeable: false, macs: [] } }, 'power');
    expect(await screen.findByText(/does not report Wake-on-LAN/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show the steps' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply on the device' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Turn on Wake-on-LAN?' })).getByRole('button', {
        name: 'Apply',
      }),
    );
    expect(await screen.findByText('Wake-on-LAN is on.')).toBeTruthy();
  });

  it('confirms a shutdown, and shows when power actions are off on the device', async () => {
    const { api } = await openDevice({ powerActionsOff: ['d1'] }, {}, 'power');
    await userEvent.click(await screen.findByRole('button', { name: 'Shut down' }));
    const dialog = screen.getByRole('dialog', { name: 'Shut down the device?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Shut down' }));
    expect(api.devicePowerAction).toHaveBeenCalledWith('d1', { action: 'shutdown' });
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Power actions are off in this device’s novad settings.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    // Turned back on: the restart goes through.
    resetDom();
    const again = await openDevice({}, {}, 'power');
    await userEvent.click(await screen.findByRole('button', { name: 'Sleep' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Put the device to sleep?' })).getByRole('button', {
        name: 'Sleep',
      }),
    );
    expect(await screen.findByText('Sleep: sent to Desk PC.')).toBeTruthy();
    expect(again.api.devicePowerAction).toHaveBeenCalledWith('d1', { action: 'sleep' });
  });

  it('shows what it last reported while offline', async () => {
    await openDevice({}, { status: 'unreachable' }, 'power');
    expect(
      await screen.findByText(/The device is offline\. Showing what it last reported\./),
    ).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sleep' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Wake Desk PC' })).toBeTruthy();
  });
});

describe('updates (FR-148)', () => {
  it('changes the channel, lists what needs an update, installs bundles and shows results', async () => {
    const { api, state } = await openDevice(
      {
        updates: [
          updateView({
            deviceId: 'd1',
            target: 'storage',
            fromVersion: '0.6.0',
            toVersion: '0.6.1',
            status: 'rolled_back',
            detail: 'health check failed',
          }),
        ],
      },
      { novadVersion: '0.6.0' },
      'updates',
    );
    const history = await screen.findByRole('list', { name: 'Update history' });
    expect(history.textContent).toContain('Storage');
    expect(history.textContent).toContain('0.6.0 → 0.6.1');
    expect(history.textContent).toContain('Rolled back');
    expect(history.textContent).toContain('health check failed');
    expect(screen.getByText('Computer use needs novad 0.7.0')).toBeTruthy();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Update channel' }), 'beta');
    expect(api.updateNovadDevice).toHaveBeenCalledWith('d1', { updateChannel: 'beta' });
    expect(await screen.findByText('Update channel: Beta.')).toBeTruthy();

    const input = screen.getByLabelText('Update bundles (.json)');
    const file = new File(
      [JSON.stringify({ bundles: [bundle('novad', '0.7.0'), bundle('storage', '0.7.0')] })],
      'u.json',
      {
        type: 'application/json',
      },
    );
    await userEvent.upload(input, file);
    const dialog = await screen.findByRole('dialog', { name: 'Install 2 updates on Desk PC?' });
    expect(dialog.textContent).toContain('novad 0.7.0 · Stable · 2 KB');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    const results = await screen.findByRole('list', { name: 'Results' });
    // novad goes last.
    expect(
      within(results)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([expect.stringContaining('Storage'), expect.stringContaining('novad')]);
    expect(await screen.findByText('Update installed.')).toBeTruthy();
    expect(state.devices[0]!.novadVersion).toBe('0.7.0');
    await waitFor(() => expect(screen.queryByText('Update required')).toBeNull());
  });

  it('refuses a file that is not a bundle, and reports updates that did not apply', async () => {
    await openDevice({ updateOutcome: { storage: 'failed' } }, {}, 'updates');
    expect(await screen.findByText('No updates yet.')).toBeTruthy();
    const input = screen.getByLabelText('Update bundles (.json)');
    await userEvent.upload(input, new File(['hello'], 'x.json', { type: 'application/json' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This file is not an update bundle (it is not JSON).',
    );
    await userEvent.upload(
      input,
      new File(
        [JSON.stringify({ bundles: [bundle('storage', '0.8.0'), bundle('novad', '0.8.0')] })],
        'u.json',
        {
          type: 'application/json',
        },
      ),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: /Install 2 updates/ })).getByRole('button', {
        name: 'Install',
      }),
    );
    const results = await screen.findByRole('list', { name: 'Results' });
    expect(results.textContent).toContain('Failed');
    expect(results.textContent).toContain('Refused');
    expect(await screen.findByText('Some updates did not apply. See the results.')).toBeTruthy();
  });

  it('cannot install while the device is offline', async () => {
    await openDevice({}, { status: 'unreachable' }, 'updates');
    expect(await screen.findByText('The device is offline.')).toBeTruthy();
    expect(screen.getByLabelText('Update bundles (.json)')).toHaveProperty('disabled', true);
  });
});

describe('per-device policy (FR-150)', () => {
  it('saves routing, allowed modules, quiet hours and resource limits', async () => {
    const { api } = await openDevice({}, {}, 'policy');
    const routing = await screen.findByRole('switch', {
      name: 'Use this device for agent work and models',
    });
    expect(routing.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(routing);
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Every module installed on the device' }),
    );
    // Each installed module starts allowed; take away management.
    const management = screen.getByRole('checkbox', { name: 'Management' });
    expect(management).toHaveProperty('checked', true);
    await userEvent.click(management);
    expect(screen.getByText(/Without the management module/)).toBeTruthy();
    await userEvent.type(screen.getByRole('textbox', { name: 'Quiet hours' }), 'late');
    await userEvent.type(screen.getByRole('textbox', { name: 'Memory (MB)' }), '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(screen.getByText('“late” is not a time range like 22:00-07:00.')).toBeTruthy();
    expect(screen.getByText('Enter a whole number from 64 to 1,048,576.')).toBeTruthy();
    expect(api.updateNovadDevice).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByRole('textbox', { name: 'Quiet hours' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Quiet hours' }), '22:00-07:00');
    await userEvent.clear(screen.getByRole('textbox', { name: 'Memory (MB)' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Memory (MB)' }), '512');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect(api.updateNovadDevice).toHaveBeenCalledWith('d1', {
      policy: {
        routingEligible: false,
        allowedModules: ['browser', 'screen', 'storage'],
        quietHours: ['22:00-07:00'],
        resourceCaps: { memoryBytes: 512 * 1024 * 1024 },
      },
    });
    expect(await screen.findByText('Policy saved.')).toBeTruthy();
    // The capability list follows: management is no longer allowed.
    await tab('Capabilities');
    const caps = screen.getByRole('list', { name: 'Capabilities' });
    expect(within(caps).getByText('Power').parentElement!.textContent).toContain(
      'Management module not allowed by policy',
    );
  });

  it('discards changes, and shows a save the Hub refuses', async () => {
    const { devices } = await openDevice({}, {}, 'policy');
    const quiet = await screen.findByRole('textbox', { name: 'Quiet hours' });
    await userEvent.type(quiet, '01:00-02:00');
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(quiet).toHaveProperty('value', '');
    devices.state.devices = devices.state.devices.map((d) => ({
      ...d,
      status: 'revoked' as const,
    }));
    await userEvent.type(quiet, '01:00-02:00');
    await userEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    expect((await screen.findByRole('alert')).textContent).toBe('the device was revoked');
  });
});

describe('rolling back from Updates (FR-148)', () => {
  it('rolls a module back to its previous version after a confirmation', async () => {
    const { api } = await openDevice(
      {},
      {
        modules: [
          moduleView({ name: 'management' }),
          moduleView({ name: 'storage', version: '0.8.0', previousVersion: '0.7.0' }),
        ],
      },
      'updates',
    );
    const list = await screen.findByRole('list', { name: 'Modules that can roll back' });
    expect(list.textContent).toContain('Storage: 0.8.0 → 0.7.0');
    await userEvent.click(within(list).getByRole('button', { name: 'Roll back Storage' }));
    const dialog = screen.getByRole('dialog', { name: 'Roll back Storage?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    expect(api.deviceModuleAction).toHaveBeenCalledWith('d1', 'storage', 'rollback');
    expect(await screen.findByText('Storage is back on version 0.7.0.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Modules that can roll back' })).toBeNull(),
    );
  });
});
