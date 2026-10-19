// A device's Boot tab (FR-143; docs/23 §5.2): the bootloader, entries and booted entry; profiles
// (create, rename, delete; kernel arguments are not supported and the form says so); "Try on next
// boot" behind a Hub-only approval, the pending trial with its countdown and Revert (which works
// with low-level boot off); "Make default" after a confirmed trial; network boot with the boot
// token shown once, rotated and revoked, and the images. Refusals read as plain words; a member
// sees the owner-only notice; the boot area's notification path opens the tab.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BootAttemptView, BootProfileView } from '@nova/shared';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { FakeEventSource } from './fakes.ts';
import { deviceView } from './fakes-m6-devices.ts';
import {
  bootDevice,
  bootWatchdog,
  firmwareDevice,
  renderWithFirmware,
  type FakeBootDevice,
  type M75FirmwareState,
} from './fakes-m75-firmware.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const ON = { 'devices.boot.allowLowLevel': true };
const stream = () => FakeEventSource.for('/api/v1/events/stream');
const NOW = () => new Date().toISOString();

function profile(over: Partial<BootProfileView> = {}): BootProfileView {
  return {
    id: 'bp1',
    deviceId: 'd1',
    name: 'Test image',
    entryId: 'nova-test.conf',
    createdAt: NOW(),
    updatedAt: NOW(),
    ...over,
  };
}

function attempt(over: Partial<BootAttemptView> = {}): BootAttemptView {
  return {
    id: 'ba1',
    deviceId: 'd1',
    profileId: 'bp1',
    requestId: 'br0',
    entryId: 'nova-test.conf',
    status: 'pending',
    reboot: true,
    watchdogSeconds: 600,
    deadline: new Date(Date.now() + 600_000).toISOString(),
    reason: null,
    detail: null,
    verified: null,
    committedAt: null,
    createdAt: NOW(),
    finishedAt: null,
    ...over,
  };
}

function openBoot(
  opts: {
    settings?: Record<string, unknown>;
    boot?: Partial<FakeBootDevice>;
    firmware?: Partial<M75FirmwareState>;
    member?: boolean;
    path?: string;
  } = {},
) {
  window.history.replaceState(null, '', opts.path ?? '/devices/d1?tab=boot');
  return renderWithFirmware(<DevicesView deviceId="d1" />, {
    devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC' })] },
    firmware: {
      firmware: { d1: firmwareDevice() },
      boot: { d1: bootDevice(opts.boot) },
      ...opts.firmware,
    },
    settings: opts.settings ?? ON,
    member: opts.member ?? false,
  });
}

const section = (name: string) =>
  screen.getByRole('heading', { name, level: 2 }).closest('section') as HTMLElement;

describe('the Boot tab', () => {
  it('creates a profile, tries it once after approval, counts down and reverts', async () => {
    const { api, hub, state } = await openBoot();
    expect(await screen.findByText('systemd-boot')).toBeTruthy();
    const entries = screen.getByRole('table', { name: 'Entries the device lists' });
    expect(
      within(entries).getByRole('row', { name: 'Ubuntu 24.04 ubuntu.conf Default, Booted now' }),
    ).toBeTruthy();
    expect(screen.getByText('No boot profiles yet.')).toBeTruthy();

    const form = screen.getByRole('form', { name: 'New boot profile' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Test image');
    await userEvent.selectOptions(within(form).getByLabelText('Entry'), 'nova-test.conf');
    await userEvent.click(within(form).getByRole('button', { name: 'Create profile' }));
    expect(api.createBootProfile).toHaveBeenCalledWith('d1', {
      name: 'Test image',
      entryId: 'nova-test.conf',
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Try Test image on next boot' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Try “Test image” on Desk PC?' });
    expect(dialog.textContent).toContain('boots “Nova test image” once');
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Watchdog').value).toBe('600');
    await userEvent.selectOptions(within(dialog).getByLabelText('Watchdog'), '300');
    expect(
      within(dialog).getByRole<HTMLInputElement>('checkbox', { name: /Restart Desk PC/ }).checked,
    ).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(api.tryBootProfile).toHaveBeenCalledWith('d1', state.boot.d1!.profiles[0]!.id, {
      watchdogSeconds: 300,
      reboot: true,
    });

    const approval = await screen.findByRole('group', {
      name: 'Approve booting Desk PC once into “Nova test image”',
    });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain('Approve booting Desk PC once'),
    );
    expect(
      within(approval).getByRole('row', { name: 'Next boot Ubuntu 24.04 Nova test image, once' }),
    ).toBeTruthy();
    expect(hub.state.m3.approvals[0]!.answerIn).toBe('hub');
    // One request at a time: Try is off while this one waits.
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Try Test image on next boot' })
        .disabled,
    ).toBe(true);
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));

    const pending = await screen.findByRole('heading', { name: 'Pending trial', level: 2 });
    const pendingSection = pending.closest('section') as HTMLElement;
    expect(pendingSection.textContent).toContain('Desk PC boots “Nova test image” once');
    expect(within(pendingSection).getByText(/\d+ min \d+ s left/)).toBeTruthy();
    expect(screen.getByText('Sent to the device')).toBeTruthy();
    expect(screen.getByText('Trying')).toBeTruthy();

    await userEvent.click(within(pendingSection).getByRole('button', { name: 'Revert…' }));
    const revert = screen.getByRole('dialog', { name: 'Clear the one-shot boot of Desk PC?' });
    expect(revert.textContent).toContain('(“Ubuntu 24.04”)');
    await userEvent.click(within(revert).getByRole('button', { name: 'Revert' }));
    expect(api.revertBoot).toHaveBeenCalledWith('d1');
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Pending trial' })).toBeNull(),
    );
    expect(screen.getByText('Back on the default')).toBeTruthy();
    expect(screen.getByText('You cleared the one-shot boot.')).toBeTruthy();
  });

  it("words a device's revert from its reason: never restarted is not 'did not come up'", async () => {
    const { state } = await openBoot({
      boot: { profiles: [profile()], attempts: [attempt()] },
    });
    await screen.findByText('Trying');
    bootWatchdog(state, 'd1', 'reverted', null, true, 'not_restarted');
    stream().emit('device.boot.changed', { deviceId: 'd1', kind: 'attempt', status: 'reverted' });
    expect(
      await screen.findByText(
        'It did not restart before the watchdog deadline, so the one-shot boot was cleared and it stays on its default entry.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/come up/)).toBeNull();
  });

  it('makes a confirmed trial the default after its own approval', async () => {
    const { api, state } = await openBoot({
      boot: { profiles: [profile()], attempts: [attempt()] },
    });
    expect(await screen.findByText('Trying')).toBeTruthy();
    bootWatchdog(state, 'd1', 'ok');
    stream().emit('device.boot.changed', { deviceId: 'd1', kind: 'attempt', status: 'ok' });
    expect(await screen.findByText('Came back')).toBeTruthy();
    expect(screen.getByText(/Last trial: Test image on “Nova test image”: came back/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Make default…' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Make “Nova test image” the default of Desk PC?',
    });
    expect(dialog.textContent).toContain('instead of “Ubuntu 24.04”');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(api.commitBootAttempt).toHaveBeenCalledWith('d1', 'ba1', {});
    const approval = await screen.findByRole('group', {
      name: 'Approve making “Nova test image” the default of Desk PC',
    });
    expect(
      within(approval).getByRole('row', { name: 'Default entry Ubuntu 24.04 Nova test image' }),
    ).toBeTruthy();
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByText(/The default entry since/)).toBeTruthy();
    expect(state.boot.d1!.status!.entries.find((e) => e.isDefault)!.id).toBe('nova-test.conf');
  });

  it('asks the owner to check an unverified trial before making it the default', async () => {
    const { api, state } = await openBoot({
      boot: { profiles: [profile()], attempts: [attempt()] },
    });
    await screen.findByText('Trying');
    bootWatchdog(state, 'd1', 'ok', null, false);
    stream().emit('device.boot.changed', { deviceId: 'd1', kind: 'attempt', status: 'ok' });
    expect(await screen.findByText(/Not verified: the device could not tell/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Make default…' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Make “Nova test image” the default of Desk PC?',
    });
    expect(dialog.textContent).toContain('This trial was not verified');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'First check that Desk PC booted “Nova test image”, then tick the box.',
    );
    expect(api.commitBootAttempt).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /I checked that Desk PC booted/ }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(api.commitBootAttempt).toHaveBeenCalledWith('d1', 'ba1', { confirmUnverified: true });
    expect(
      await screen.findByRole('group', {
        name: 'Approve making “Nova test image” the default of Desk PC',
      }),
    ).toBeTruthy();
    // Without the confirmation the Hub refuses it, in plain words.
    await expect(api.commitBootAttempt('d1', 'ba1')).rejects.toMatchObject({
      body: { details: { reason: 'unverified_trial' } },
    });
  });

  it('explains low-level boot when it is off: no trials, but Revert still works', async () => {
    const pending = attempt();
    const { api } = await openBoot({
      settings: {},
      boot: {
        profiles: [profile()],
        attempts: [pending],
        status: {
          ...bootDevice().status!,
          pending: { profileId: 'bp1', entryId: 'nova-test.conf', deadline: pending.deadline },
        },
      },
    });
    await screen.findByRole('heading', { name: 'Boot profiles' });
    const note = within(section('Boot')).getByRole('note');
    expect(note.textContent).toContain('Low-level boot changes are off.');
    expect(note.textContent).toContain('Clearing a pending one-shot always works.');
    expect(
      within(note).getByRole('link', { name: 'Turn it on in Settings → Devices' }),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Try Test image on next boot' })
        .disabled,
    ).toBe(true);
    expect(
      within(section('Boot profiles')).getByText('Needs low-level boot changes on.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Revert…' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Clear the one-shot boot of Desk PC?' })).getByRole(
        'button',
        { name: 'Revert' },
      ),
    );
    expect(api.revertBoot).toHaveBeenCalledWith('d1');
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Pending trial' })).toBeNull(),
    );
  });

  it('says kernel arguments are not supported when typed, and keeps the form on a refusal', async () => {
    const { api } = await openBoot({ boot: { profiles: [profile()] } });
    const form = await screen.findByRole('form', { name: 'New boot profile' });
    await userEvent.type(within(form).getByLabelText('Name'), 'Test image');
    await userEvent.type(within(form).getByLabelText('Kernel arguments'), 'quiet splash');
    expect(within(form).getByRole('alert').textContent).toContain(
      'Kernel arguments are not supported yet',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Create profile' }));
    expect(api.createBootProfile).not.toHaveBeenCalled();
    await userEvent.clear(within(form).getByLabelText('Kernel arguments'));
    expect(within(form).queryByRole('alert')).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Create profile' }));
    expect(api.createBootProfile).toHaveBeenCalled();
    expect((await within(form).findByRole('alert')).textContent).toBe(
      'This device already has a boot profile with that name.',
    );
    expect(within(form).getByLabelText<HTMLInputElement>('Name').value).toBe('Test image');
  });

  it('renames and deletes a profile, each asking first', async () => {
    const { api, state } = await openBoot({ boot: { profiles: [profile()] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Test image' }));
    const rename = screen.getByRole('dialog', { name: 'Rename Test image' });
    const field = within(rename).getByLabelText('Name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Nightly');
    await userEvent.click(within(rename).getByRole('button', { name: 'Save' }));
    expect(api.updateBootProfile).toHaveBeenCalledWith('d1', 'bp1', { name: 'Nightly' });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Nightly' }));
    const del = screen.getByRole('dialog', { name: 'Delete the boot profile Nightly?' });
    expect(document.activeElement).toBe(within(del).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(del).getByRole('button', { name: 'Delete' }));
    expect(api.deleteBootProfile).toHaveBeenCalledWith('d1', 'bp1');
    expect(await screen.findByText('No boot profiles yet.')).toBeTruthy();
    expect(state.boot.d1!.profiles).toHaveLength(0);
  });

  it('shows why a request was not made, in plain words', async () => {
    await openBoot({
      boot: {
        profiles: [profile()],
        failSend: { code: 'policy_denied', reason: 'tls_required', message: 'raw tls_required' },
      },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Try Test image on next boot' }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Ask for approval' }),
    );
    const approval = await screen.findByRole('group', { name: /Approve booting Desk PC once/ });
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByText('Not made')).toBeTruthy();
    expect(
      screen.getByText(
        'This needs the device’s secure management channel (mutual TLS), and the device has no certificate for it yet. Switch the Hub to its local CA in Network → Trust, then add the device again so it gets one.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Pending trial' })).toBeNull();
  });

  it('says GRUB needs GRUB_DEFAULT=saved when the device refuses a new default', async () => {
    const { state } = await openBoot({
      boot: { profiles: [profile()], attempts: [attempt({ status: 'ok', verified: true })] },
    });
    state.boot.d1!.failSend = {
      code: 'conflict',
      reason: 'grub_default_not_saved',
      message: 'raw grub_default_not_saved',
    };
    await userEvent.click(await screen.findByRole('button', { name: 'Make default…' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Ask for approval' }),
    );
    const approval = await screen.findByRole('group', { name: /Approve making/ });
    await userEvent.click(within(approval).getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByText('Not made')).toBeTruthy();
    expect(
      screen.getByText(/GRUB keeps a chosen default only with GRUB_DEFAULT=saved/),
    ).toBeTruthy();
  });

  it('keeps the dialog open with the reason when a trial is refused', async () => {
    const { api, state } = await openBoot({ boot: { profiles: [profile()] } });
    await screen.findByRole('button', { name: 'Try Test image on next boot' });
    // A trial started elsewhere after the page loaded.
    state.boot.d1!.attempts = [attempt({ id: 'ba9' })];
    await userEvent.click(screen.getByRole('button', { name: 'Try Test image on next boot' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ask for approval' }));
    expect(api.tryBootProfile).toHaveBeenCalled();
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'A boot trial is already running on this device. Wait for it to finish, or revert it.',
    );
  });

  it('says when the device cannot be read or its bootloader is not supported', async () => {
    await openBoot({ boot: { offline: true } });
    expect(await screen.findByText(/boot status could not be read/)).toBeTruthy();
    expect(screen.getByText(/The device is offline/)).toBeTruthy();
    // Without the device's list, the entry is typed.
    expect(screen.getByLabelText('Entry id')).toBeTruthy();
    resetDom();
    await openBoot({
      boot: {
        status: {
          ...bootDevice().status!,
          supported: false,
          reason: 'no supported bootloader found',
          bootloader: 'none',
          entries: [],
        },
      },
    });
    expect(
      await screen.findByText(
        /Boot cannot be managed on this device: no supported bootloader found/,
      ),
    ).toBeTruthy();
  });

  it('opens from the boot area’s notification path', async () => {
    await openBoot({ path: '/devices/d1/boot' });
    expect((await screen.findByRole('tab', { name: 'Boot' })).getAttribute('aria-selected')).toBe(
      'true',
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Firmware' }));
    expect(window.location.pathname + window.location.search).toBe('/devices/d1?tab=firmware');
  });

  it('shows a member the owner-only notice', async () => {
    await openBoot({ member: true });
    expect(await screen.findByText(/“Device boot” belongs to the whole Hub/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Boot profiles' })).toBeNull();
  });
});

describe('network boot', () => {
  it('shows the boot token once, rotates and revokes it, and lists the images', async () => {
    const { api, state } = await openBoot({
      settings: { ...ON, 'devices.pxe.enabled': true },
      firmware: {
        images: [{ name: 'nova-netboot.efi', size: 2 * 1024 * 1024, modifiedAt: NOW() }],
      },
    });
    const pxe = await screen.findByRole('heading', { name: 'Network boot (PXE)', level: 2 });
    const sec = pxe.closest('section') as HTMLElement;
    expect(within(sec).getByText('On')).toBeTruthy();
    expect(await within(sec).findByText('nova-netboot.efi')).toBeTruthy();
    expect(within(sec).getByText(/2 MB/)).toBeTruthy();
    expect(within(sec).getByText('This device has no boot token.')).toBeTruthy();

    await userEvent.click(within(sec).getByRole('button', { name: 'Make a boot token' }));
    const once = await within(sec).findByRole('region', { name: 'New boot token' });
    const token = state.lastToken!;
    expect(once.textContent).toContain(token);
    expect(once.textContent).toContain(`http://hub.test/boot/ipxe/${token}`);
    expect(once.textContent).toContain('it is shown only once');
    expect(within(sec).getByText(/A boot token is active/)).toBeTruthy();
    await userEvent.click(within(once).getByRole('button', { name: 'Done' }));
    expect(document.body.textContent).not.toContain(token);

    await userEvent.click(within(sec).getByRole('button', { name: 'Make a new token…' }));
    const rotate = screen.getByRole('dialog', { name: 'Make a new boot token for Desk PC?' });
    expect(rotate.textContent).toContain('stops working at once');
    await userEvent.click(within(rotate).getByRole('button', { name: 'Make a new token' }));
    expect(api.createPxeToken).toHaveBeenCalledTimes(2);
    expect(
      (await within(sec).findByRole('region', { name: 'New boot token' })).textContent,
    ).toContain(state.lastToken!);

    await userEvent.click(within(sec).getByRole('button', { name: 'Revoke…' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Revoke the boot token of Desk PC?' })).getByRole(
        'button',
        { name: 'Revoke' },
      ),
    );
    expect(api.revokePxeToken).toHaveBeenCalledWith('d1');
    expect(await within(sec).findByText('This device has no boot token.')).toBeTruthy();
    expect(within(sec).queryByRole('region', { name: 'New boot token' })).toBeNull();
  });

  it('explains network boot when it is off, and where images go', async () => {
    await openBoot();
    const pxe = await screen.findByRole('heading', { name: 'Network boot (PXE)', level: 2 });
    const sec = pxe.closest('section') as HTMLElement;
    expect(within(sec).getByRole('note').textContent).toContain('Network boot is off.');
    expect(within(sec).getByText(/Nova runs no DHCP or TFTP server/)).toBeTruthy();
    expect(await within(sec).findByText('/var/lib/nova/boot-images')).toBeTruthy();
  });
});
