// A device's Firmware tab (FR-146; docs/23 §6; docs/17 §M7.5 demo): support and platform facts,
// the allowlisted settings, fwupd's update list, the write-only BIOS password; with the toggle on,
// plan (the diff marks security-degrading rows), ask for approval on a Hub-only card answered in
// place, apply with the watchdog, the watchdog's outcome, and rollback behind its own approval.
// With the toggle off the tab explains it and links to the setting; every refusal keeps the form
// and reads as plain words; a member sees the owner-only notice.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { HUB_ONLY_TEXT } from '../src/firmware/HubOnlyApproval.tsx';
import { FakeEventSource } from './fakes.ts';
import { deviceView } from './fakes-m6-devices.ts';
import {
  bootDevice,
  firmwareDevice,
  firmwareWatchdog,
  renderWithFirmware,
  type FakeFirmwareDevice,
} from './fakes-m75-firmware.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const ON = { 'devices.firmware.allowChanges': true, 'devices.firmware.watchdogSeconds': 900 };
const stream = () => FakeEventSource.for('/api/v1/events/stream');

function openFirmware(
  opts: {
    settings?: Record<string, unknown>;
    device?: Partial<FakeFirmwareDevice>;
    member?: boolean;
    status?: 'active' | 'revoked' | 'unreachable';
    endpoint?: string;
    passwords?: string[];
  } = {},
) {
  window.history.replaceState(null, '', '/devices/d1?tab=firmware');
  return renderWithFirmware(<DevicesView deviceId="d1" />, {
    devices: {
      devices: [
        deviceView({
          id: 'd1',
          name: 'Desk PC',
          status: opts.status ?? 'active',
          ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        }),
      ],
    },
    firmware: {
      firmware: { d1: firmwareDevice(opts.device) },
      boot: { d1: bootDevice() },
      passwords: opts.passwords ?? [],
    },
    settings: opts.settings ?? ON,
    member: opts.member ?? false,
  });
}

const section = (name: string) =>
  screen.getByRole('heading', { name, level: 2 }).closest('section') as HTMLElement;

async function plan(choices: Record<string, string>) {
  for (const [label, value] of Object.entries(choices))
    await userEvent.selectOptions(screen.getByLabelText(label), value);
  await userEvent.click(screen.getByRole('button', { name: 'Plan the change' }));
}

describe('the Firmware tab', () => {
  it('runs the M7.5 demo: Wake-on-LAN and power after a power cut, approved, then rolled back', async () => {
    const { api, hub, state } = await openFirmware();
    expect(await screen.findByText('Supported')).toBeTruthy();
    expect(screen.getByText('Dell Inc. OptiPlex 7090')).toBeTruthy();
    expect(screen.getByText('Dell Inc. 1.21.0 (2025-04-11), UEFI')).toBeTruthy();
    expect(screen.getByText('Linux firmware attributes (dell-wmi-sysman)')).toBeTruthy();
    // The allowlist, with what is read-only and what weakens security.
    const settings = within(section('Settings')).getByRole('table');
    const fan = within(settings).getByRole('row', { name: /Fan profile/ });
    expect(within(fan).getByText('Read-only')).toBeTruthy();
    const sb = within(settings).getByRole('row', { name: /Secure Boot/ });
    expect(within(sb).getByText(/Weakens security when Disabled/)).toBeTruthy();
    expect(screen.getByText('System Firmware')).toBeTruthy();

    // Plan: a dry run with the diff.
    await plan({ 'Wake-on-LAN': 'LanOnly', 'After a power cut': 'On' });
    expect(api.planFirmware).toHaveBeenCalledWith('d1', [
      { key: 'wol', value: 'LanOnly' },
      { key: 'powerOnAfterPowerLoss', value: 'On' },
    ]);
    const current = await screen.findByRole('heading', { name: 'Current change', level: 2 });
    const card = current.closest('section') as HTMLElement;
    const diff = within(card).getByRole('table', { name: 'What changes on Desk PC' });
    expect(within(diff).getByRole('row', { name: 'Wake-on-LAN Disabled LanOnly' })).toBeTruthy();
    expect(within(diff).getByRole('row', { name: 'After a power cut Off On' })).toBeTruthy();
    expect(within(card).getByText('Planned')).toBeTruthy();
    expect(within(card).getByText('Takes effect after the device restarts.')).toBeTruthy();

    // Ask: a Hub-only card, answered here.
    await userEvent.click(within(card).getByRole('button', { name: 'Ask for approval' }));
    expect(api.requestFirmwareApproval).toHaveBeenCalledWith('d1', state.changes[0]!.id);
    const approval = await screen.findByRole('group', {
      name: 'Approve this firmware change on Desk PC',
    });
    expect(within(approval).getByText(HUB_ONLY_TEXT)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(approval).getByRole('heading', { name: 'Approve this firmware change on Desk PC' }),
      ),
    );
    const card0 = hub.state.m3.approvals[0]!;
    expect(card0.answerIn).toBe('hub');
    expect(card0.scope).toBe('device:d1');
    expect(card0.options).toEqual(['allow_once', 'deny_continue']);
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    expect(hub.api.decideApproval).toHaveBeenCalledWith({
      approvalId: card0.id,
      decision: 'allow_once',
    });

    // Apply, after a confirmation naming the device and listing every change.
    await userEvent.click(await screen.findByRole('button', { name: 'Apply…' }));
    const dialog = screen.getByRole('dialog', { name: 'Apply this firmware change to Desk PC?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    const list = within(dialog).getByRole('list', { name: 'Changes to apply' });
    expect(list.textContent).toContain('Wake-on-LAN: Disabled → LanOnly');
    const restart = within(dialog).getByRole('checkbox', {
      name: /Restart Desk PC now, with the watchdog/,
    });
    expect(dialog.textContent).toContain('does not come back within 15 minutes');
    expect((restart as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to Desk PC' }));
    expect(api.applyFirmwareChange).toHaveBeenCalledWith('d1', state.changes[0]!.id, {
      reboot: true,
    });
    expect(await screen.findByText(/Restarting with the watchdog armed/)).toBeTruthy();
    expect(state.firmware.d1!.settings.find((s) => s.key === 'wol')!.value).toBe('LanOnly');
    expect(screen.getByText(/\(1[45] min \d+ s left\)/)).toBeTruthy();

    // The device came back: the watchdog says so on the change.
    firmwareWatchdog(state, state.changes[0]!.id, 'ok');
    stream().emit('device.firmware.changed', {
      deviceId: 'd1',
      changeId: state.changes[0]!.id,
      status: 'applied',
      watchdog: 'ok',
    });
    expect(await screen.findByText(/came back after the restart and kept/)).toBeTruthy();

    // Roll back: its own plan and approval.
    await userEvent.click(screen.getByRole('button', { name: /Roll back the change applied/ }));
    const rb = screen.getByRole('dialog', { name: 'Roll back this firmware change on Desk PC?' });
    expect(within(rb).getByRole('list', { name: 'Settings to restore' }).textContent).toContain(
      'Wake-on-LAN: back to Disabled',
    );
    await userEvent.click(within(rb).getByRole('button', { name: 'Plan the rollback' }));
    expect(api.rollbackFirmwareSnapshot).toHaveBeenCalledWith('d1', state.snapshots[0]!.id);
    const rbApproval = await screen.findByRole('group', {
      name: 'Approve restoring the firmware settings of Desk PC',
    });
    await userEvent.click(within(rbApproval).getByRole('button', { name: 'Allow once' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply the rollback…' }));
    const confirm = screen.getByRole('dialog', {
      name: 'Roll back the firmware settings of Desk PC?',
    });
    expect(confirm.textContent).toContain('A rollback does not restart the device');
    expect(within(confirm).queryByRole('checkbox')).toBeNull();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Roll back Desk PC' }));
    expect(api.applyFirmwareChange).toHaveBeenLastCalledWith('d1', state.changes[0]!.id, {});
    await waitFor(() => expect(screen.getAllByText('Rolled back').length).toBeGreaterThan(0));
    expect(state.firmware.d1!.settings.find((s) => s.key === 'wol')!.value).toBe('Disabled');
    expect(state.firmware.d1!.settings.find((s) => s.key === 'powerOnAfterPowerLoss')!.value).toBe(
      'Off',
    );
    expect(state.changes.find((c) => c.kind === 'apply')!.status).toBe('rolled_back');
  });

  it('explains the toggle when it is off, links to it, and offers no plan', async () => {
    const { api } = await openFirmware({ settings: {} });
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('BIOS and firmware changes are off.');
    expect(note.textContent).toContain('off by default');
    const link = within(note).getByRole('link', { name: 'Turn it on in Settings → Devices' });
    expect(link.getAttribute('href')).toBe('/settings/devices');
    // Reading still works; planning is not offered.
    expect(await screen.findByText('Supported')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Plan the change' })).toBeNull();
    await userEvent.click(link);
    expect(window.location.pathname).toBe('/settings/devices');
    expect(api.planFirmware).not.toHaveBeenCalled();
  });

  it('still explains the toggle when the device cannot be read', async () => {
    await openFirmware({ settings: {}, device: { offline: true } });
    expect((await screen.findByRole('alert')).textContent).toContain('The device is offline.');
    expect(screen.getByRole('note').textContent).toContain('BIOS and firmware changes are off.');
    expect(screen.getByText('No firmware changes yet.')).toBeTruthy();
  });

  it('marks a security-degrading choice and diff row, and says plainly why it is refused', async () => {
    const { api } = await openFirmware();
    await screen.findByText('Supported');
    const select = screen.getByLabelText('Secure Boot');
    expect(
      within(select).getByRole('option', { name: 'Disabled (weakens security)' }),
    ).toBeTruthy();
    await userEvent.selectOptions(select, 'Disabled');
    expect(screen.getByText(/This weakens security:/).parentElement?.textContent).toContain(
      'it is off',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Plan the change' }));
    const diff = await screen.findByRole('table', { name: 'What changes on Desk PC' });
    const row = within(diff).getByRole('row', { name: /Secure Boot/ });
    expect(within(row).getByText('Weakens security')).toBeTruthy();
    expect(screen.getByText(/“Allow changes that weaken security” is off/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ask for approval' }));
    expect(api.requestFirmwareApproval).toHaveBeenCalled();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This change weakens security (Secure Boot), and changes like that are off. Turn on “Allow changes that weaken security” in Settings → Devices first.',
    );
    // The change stays planned and can be asked again later.
    expect(screen.getByRole('button', { name: 'Ask for approval' })).toBeTruthy();
  });

  it('reorders the boot order without adding or removing entries', async () => {
    const { api } = await openFirmware();
    await screen.findByText('Supported');
    const order = screen.getByRole('group', { name: 'Boot order' });
    await userEvent.click(within(order).getByRole('button', { name: 'Move UEFI HTTP up' }));
    expect(within(order).getByText('Changed.', { exact: false })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(order).getByRole('button', { name: 'Move UEFI HTTP up' }),
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Plan the change' }));
    expect(api.planFirmware).toHaveBeenCalledWith('d1', [
      { key: 'bootOrder', value: ['ubuntu', 'UEFI HTTP', 'Windows Boot Manager'] },
    ]);
  });

  it('keeps the form and says so when nothing is chosen or the device refuses', async () => {
    const { api, state } = await openFirmware();
    await screen.findByText('Supported');
    await userEvent.click(screen.getByRole('button', { name: 'Plan the change' }));
    expect(screen.getByRole('alert').textContent).toBe('Choose at least one new value.');
    expect(api.planFirmware).not.toHaveBeenCalled();
    state.firmware.d1!.offline = true;
    await plan({ 'Wake-on-LAN': 'LanWlan' });
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The device is offline. Try again when it reconnects.',
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Wake-on-LAN').value).toBe('LanWlan');
  });

  it('says why an unsupported machine cannot be changed, with the support matrix', async () => {
    const { api } = await openFirmware({
      device: {
        supported: false,
        reason: 'ASUS boards offer no interface to change firmware settings from Linux',
        platform: {
          vendor: 'ASUSTeK COMPUTER INC.',
          product: 'PRIME B550',
          biosVendor: 'American Megatrends',
          biosVersion: '3002',
          biosDate: '',
          uefi: true,
        },
      },
    });
    expect(await screen.findByText('Not supported')).toBeTruthy();
    expect(
      screen.getByText('ASUS boards offer no interface to change firmware settings from Linux.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Plan the change' })).toBeNull();
    await userEvent.click(screen.getByText('Hardware support matrix'));
    const matrix = await screen.findByRole('table', {
      name: 'Which machines Nova can change firmware settings on (Linux only)',
    });
    expect(api.getFirmwareSupport).toHaveBeenCalled();
    expect(within(matrix).getByRole('row', { name: /Lenovo Yes/ })).toBeTruthy();
    expect(within(matrix).getByRole('row', { name: /Supermicro No/ })).toBeTruthy();
  });

  it('refuses to apply without the BIOS password, stores it write-only, then applies', async () => {
    const { api, state } = await openFirmware({
      device: { adminPasswordSet: true },
      endpoint: 'https://10.0.0.7:7420',
    });
    expect(await screen.findByText('Not stored yet.')).toBeTruthy();
    await plan({ 'Wake-on-LAN': 'LanOnly' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for approval' }));
    const approval = await screen.findByRole('group', {
      name: 'Approve this firmware change on Desk PC',
    });
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply…' }));
    let dialog = screen.getByRole('dialog', { name: 'Apply this firmware change to Desk PC?' });
    // novad never keeps the password, so its watchdog cannot restore: no guarded restart.
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(dialog.textContent).toContain('Nova does not restart it');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to Desk PC' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This machine needs its BIOS admin password. Store it in the BIOS admin password section first.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    const pw = screen.getByLabelText('BIOS admin password', { selector: 'input' });
    expect(pw.getAttribute('type')).toBe('password');
    await userEvent.type(pw, 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Store' }));
    expect(api.setBiosPassword).toHaveBeenCalledWith('d1', 'hunter2');
    expect(await screen.findByText('Stored in the Hub’s vault.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Replace the BIOS admin password').value).toBe(
      '',
    );
    expect(document.body.textContent).not.toContain('hunter2');

    await userEvent.click(screen.getByRole('button', { name: 'Apply…' }));
    dialog = screen.getByRole('dialog', { name: 'Apply this firmware change to Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to Desk PC' }));
    expect(api.applyFirmwareChange).toHaveBeenLastCalledWith('d1', state.changes[0]!.id, {
      reboot: false,
    });
    await waitFor(() => expect(state.changes[0]!.status).toBe('applied'));

    // Remove: asks first, and the password is never shown.
    await userEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    const remove = screen.getByRole('dialog', {
      name: 'Remove the BIOS admin password of Desk PC?',
    });
    await userEvent.click(within(remove).getByRole('button', { name: 'Remove' }));
    expect(api.clearBiosPassword).toHaveBeenCalledWith('d1');
    expect(await screen.findByText('Not stored yet.')).toBeTruthy();
  });

  it('never sends the BIOS password over plain HTTP, and says so', async () => {
    await openFirmware({ device: { adminPasswordSet: true }, passwords: ['d1'] });
    expect(await screen.findByText('Stored in the Hub’s vault.')).toBeTruthy();
    await plan({ 'Wake-on-LAN': 'LanOnly' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for approval' }));
    const approval = await screen.findByRole('group', {
      name: 'Approve this firmware change on Desk PC',
    });
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply…' }));
    const dialog = screen.getByRole('dialog', { name: 'Apply this firmware change to Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to Desk PC' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This needs the device’s secure management channel (mutual TLS), and the device has no certificate for it yet. Switch the Hub to its local CA in Network → Trust, then add the device again so it gets one.',
    );
  });

  it('applies without the restart when the Hub refuses a guarded one', async () => {
    const { api, state } = await openFirmware({
      endpoint: 'https://10.0.0.7:7420',
      passwords: ['d1'],
    });
    await screen.findByText('Supported');
    await plan({ 'Wake-on-LAN': 'LanOnly' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for approval' }));
    const approval = await screen.findByRole('group', {
      name: 'Approve this firmware change on Desk PC',
    });
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    // An admin password was set on the machine after the page read it.
    state.firmware.d1!.adminPasswordSet = true;
    await userEvent.click(await screen.findByRole('button', { name: 'Apply…' }));
    const dialog = screen.getByRole('dialog', { name: 'Apply this firmware change to Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to Desk PC' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'Apply without the restart',
    );
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(dialog.textContent).toContain('Nova does not restart it');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to Desk PC' }));
    expect(api.applyFirmwareChange).toHaveBeenLastCalledWith('d1', state.changes[0]!.id, {
      reboot: false,
    });
    await waitFor(() => expect(state.changes[0]!.status).toBe('applied'));
  });

  it('shows a watchdog that could not revert, and offers the rollback', async () => {
    const { state } = await openFirmware();
    await screen.findByText('Supported');
    await plan({ 'After a power cut': 'Last' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for approval' }));
    const approval = await screen.findByRole('group', {
      name: 'Approve this firmware change on Desk PC',
    });
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply…' }));
    const dialog = screen.getByRole('dialog', { name: 'Apply this firmware change to Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to Desk PC' }));
    await screen.findByText(/Restarting with the watchdog armed/);
    const id = state.changes[0]!.id;
    firmwareWatchdog(state, id, 'revert_failed', 'deadline');
    stream().emit('device.firmware.changed', {
      deviceId: 'd1',
      changeId: id,
      status: 'revert_failed',
    });
    expect(await screen.findByText('Not reverted: check it')).toBeTruthy();
    expect(screen.getByText(/These settings may not be safe/)).toBeTruthy();
    // What the machine holds now, from its last read, next to the change.
    const diff = await screen.findByRole('table', { name: 'What changes on Desk PC' });
    await waitFor(() =>
      expect(
        within(diff).getByRole('row', { name: 'After a power cut Off Last Last' }),
      ).toBeTruthy(),
    );
    expect(
      screen.getByText(/was not back in time, and its watchdog could not restore the previous/),
    ).toBeTruthy();
    expect(screen.getByText(/needs its BIOS admin password, which novad never keeps/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Roll back the change applied/ })).toBeTruthy();
  });

  it('shows a denied approval, and a watchdog that reverted or never heard back', async () => {
    const { state, hub } = await openFirmware();
    await screen.findByText('Supported');
    await plan({ 'Wake-on-LAN': 'LanOnly' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for approval' }));
    const approval = await screen.findByRole('group', {
      name: 'Approve this firmware change on Desk PC',
    });
    await userEvent.click(within(approval).getByRole('button', { name: 'Deny' }));
    expect(hub.api.decideApproval).toHaveBeenCalledWith({
      approvalId: hub.state.m3.approvals[0]!.id,
      decision: 'deny_continue',
    });
    expect(await screen.findByText('Your last approval request was denied.')).toBeTruthy();

    // Ask again, allow, apply with the restart; the device never came back, then reverted.
    await userEvent.click(screen.getByRole('button', { name: 'Ask for approval' }));
    const again = await screen.findByRole('group', {
      name: 'Approve this firmware change on Desk PC',
    });
    await userEvent.click(within(again).getByRole('button', { name: 'Allow once' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply…' }));
    const dialog = screen.getByRole('dialog', { name: 'Apply this firmware change to Desk PC?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply to Desk PC' }));
    await screen.findByText(/Restarting with the watchdog armed/);
    const id = state.changes[0]!.id;
    firmwareWatchdog(state, id, 'missed');
    stream().emit('device.firmware.changed', { deviceId: 'd1', changeId: id, status: 'applied' });
    expect(await screen.findByText(/has not reported since the restart/)).toBeTruthy();
    // novad reverted it without a restart (J9.5): one honest line, nothing about coming back.
    firmwareWatchdog(state, id, 'reverted', 'not_restarted');
    stream().emit('device.firmware.changed', { deviceId: 'd1', changeId: id, status: 'reverted' });
    expect(await screen.findByText('Reverted by the watchdog')).toBeTruthy();
    expect(
      screen.getAllByText(/did not restart before the deadline: its watchdog restored/),
    ).toHaveLength(1);
    expect(screen.queryByText(/come back/)).toBeNull();
    expect(screen.queryByText(/did not restart by the deadline/)).toBeNull();
    // Another device's event changes nothing here.
    stream().emit('device.firmware.changed', { deviceId: 'd9', changeId: 'x', status: 'applied' });
  });

  it('answers an approval taken elsewhere quietly, and re-reads the device on demand', async () => {
    const { api, hub } = await openFirmware();
    await screen.findByText('Supported');
    await plan({ 'Wake-on-LAN': 'LanOnly' });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask for approval' }));
    const approval = await screen.findByRole('group', {
      name: 'Approve this firmware change on Desk PC',
    });
    // Answered on the Approvals page in another tab first.
    const a = hub.state.m3.approvals[0]!;
    hub.state.m3.approvals = [
      {
        ...a,
        status: 'decided',
        decision: 'allow_once',
        decidedBy: 'user',
        decidedAt: a.createdAt,
      },
    ];
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByRole('button', { name: 'Apply…' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Approved, ready to apply')).toBeTruthy();

    // Read again goes to the device, not the Hub's minute-long cache.
    await userEvent.click(screen.getByRole('button', { name: 'Read again' }));
    expect(api.readFirmware).toHaveBeenLastCalledWith('d1', { fresh: true });
  });
});

describe('the Firmware tab: who and what', () => {
  it('shows a member the owner-only notice instead of the tab', async () => {
    await openFirmware({ member: true });
    expect(await screen.findByText('Only the owner of this Hub can change this.')).toBeTruthy();
    expect(screen.getByText(/“Device firmware” belongs to the whole Hub/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Firmware', level: 2 })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Plan the change' })).toBeNull();
  });

  it('says a revoked device cannot be read', async () => {
    const { api } = await openFirmware({ status: 'revoked' });
    expect(
      await screen.findByText(/This device was revoked: its firmware cannot be read/),
    ).toBeTruthy();
    expect(api.readFirmware).not.toHaveBeenCalled();
  });

  it('links from Power to the Firmware tab', async () => {
    window.history.replaceState(null, '', '/devices/d1?tab=power');
    await renderWithFirmware(<DevicesView deviceId="d1" />, {
      devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC' })] },
      firmware: { firmware: { d1: firmwareDevice() } },
      settings: ON,
    });
    await userEvent.click(await screen.findByRole('link', { name: 'change them in Firmware' }));
    expect(window.location.search).toBe('?tab=firmware');
    expect(
      (await screen.findByRole('tab', { name: 'Firmware' })).getAttribute('aria-selected'),
    ).toBe('true');
  });
});
