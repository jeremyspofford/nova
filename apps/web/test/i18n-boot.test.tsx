// The Boot tab in the pseudo-locale (FR-016): bootloader facts, entries, trials and profiles with
// the Make default, Try, Rename and Delete dialogs, a request on its Hub-only card, network boot
// with a token made (shown once), rotated and revoked; low-level boot off with a pending trial,
// its countdown and Revert; a device whose boot status cannot be read, and an unsupported
// bootloader. Entry titles, profile names, the device's reasons and the Hub's approval actions are
// data.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { BootAttemptView, BootProfileView } from '@nova/shared';
import { BOOT_PANEL_TEXT as B, BootPanel } from '../src/boot/BootPanel.tsx';
import { PARTS_TEXT } from '../src/devices/parts.tsx';
import { FIRMWARE_TEXT } from '../src/firmware/format.ts';
import { deviceView } from './fakes-m6-devices.ts';
import {
  bootDevice,
  firmwareDevice,
  renderWithFirmware,
  type FakeBootDevice,
  type M75FirmwareState,
} from './fakes-m75-firmware.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const NOW = () => new Date().toISOString();
const DATA = ['Desk PC', 'Ubuntu 24.04', 'Nova test image', 'Test image'];

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

async function openBoot(
  opts: {
    settings?: Record<string, unknown>;
    boot?: Partial<FakeBootDevice>;
    firmware?: Partial<M75FirmwareState>;
  } = {},
) {
  await activateTestLocale('en-XA');
  const device = deviceView({ id: 'd1', name: 'Desk PC' });
  return renderWithFirmware(
    <BootPanel device={device} onDevice={() => undefined} reload={() => undefined} />,
    {
      devices: { devices: [device] },
      firmware: {
        firmware: { d1: firmwareDevice() },
        boot: { d1: bootDevice(opts.boot) },
        ...opts.firmware,
      },
      settings: opts.settings ?? { 'devices.boot.allowLowLevel': true },
    },
  );
}

const cancel = async (dialog: HTMLElement) =>
  userEvent.click(within(dialog).getByRole('button', { name: PARTS_TEXT.cancel }));

describe('the Boot tab in a pseudo-locale', () => {
  it('shows entries, trials, profiles, a request and network boot, with their dialogs', async () => {
    const ended = attempt({
      status: 'ok',
      verified: false,
      finishedAt: NOW(),
    });
    const { container, hub, api, state } = await openBoot({
      settings: { 'devices.boot.allowLowLevel': true, 'devices.pxe.enabled': true },
      boot: {
        profiles: [profile()],
        attempts: [ended],
        status: {
          ...bootDevice().status!,
          last: { profileId: 'bp1', entryId: 'nova-test.conf', result: 'ok', at: NOW() },
        },
      },
      firmware: {
        images: [{ name: 'nova-netboot.efi', size: 2 * 1024 * 1024, modifiedAt: NOW() }],
      },
    });
    await screen.findByRole('heading', { name: B.profiles, level: 2 });
    await screen.findByRole('list', { name: B.bootImages });
    expect(screen.getByText(B.on)).toBeTruthy();
    expectFullyLocalized(container, { data: DATA });

    // Make default: an unverified trial asks the owner to check first.
    await userEvent.click(screen.getByRole('button', { name: B.makeDefaultMore }));
    const commit = screen.getByRole('dialog', {
      name: B.commitTitle({ entry: 'Nova test image', device: 'Desk PC' }),
    });
    expect(within(commit).getByRole('checkbox')).toBeTruthy();
    expectFullyLocalized(commit, { data: DATA });
    await cancel(commit);

    // Rename and delete ask first.
    await userEvent.click(
      screen.getByRole('button', { name: B.renameNamed({ name: 'Test image' }) }),
    );
    const rename = screen.getByRole('dialog', { name: B.renameNamed({ name: 'Test image' }) });
    expectFullyLocalized(rename, { data: DATA });
    await cancel(rename);
    await userEvent.click(
      screen.getByRole('button', { name: B.deleteNamed({ name: 'Test image' }) }),
    );
    const del = screen.getByRole('dialog', { name: B.deleteTitle({ name: 'Test image' }) });
    expectFullyLocalized(del, { data: DATA });
    await cancel(del);

    // Try once: the dialog, then the request on its Hub-only card with the diff.
    await userEvent.click(
      screen.getByRole('button', { name: B.tryOnNextBoot({ name: 'Test image' }) }),
    );
    const tryDialog = screen.getByRole('dialog', {
      name: B.tryTitle({ profile: 'Test image', device: 'Desk PC' }),
    });
    expect(within(tryDialog).getByLabelText(B.watchdog)).toBeTruthy();
    expectFullyLocalized(tryDialog, { data: DATA });
    await userEvent.click(
      within(tryDialog).getByRole('button', { name: FIRMWARE_TEXT.askForApproval }),
    );
    await screen.findByRole('group', {
      name: B.approveTry({ device: 'Desk PC', entry: 'Nova test image' }),
    });
    expect(api.tryBootProfile).toHaveBeenCalled();
    expectFullyLocalized(container, { data: [...DATA, hub.state.m3.approvals[0]!.action] });

    // Network boot: a token made, shown once, then the rotate and revoke dialogs.
    await userEvent.click(screen.getByRole('button', { name: B.makeToken }));
    const once = await screen.findByRole('region', { name: B.newToken });
    expect(once.textContent).toContain(state.lastToken!);
    expectFullyLocalized(once);
    await userEvent.click(within(once).getByRole('button', { name: B.done }));
    await userEvent.click(screen.getByRole('button', { name: B.newTokenMore }));
    const rotate = screen.getByRole('dialog', { name: B.rotateTitle({ device: 'Desk PC' }) });
    expectFullyLocalized(rotate, { data: DATA });
    await cancel(rotate);
    await userEvent.click(screen.getByRole('button', { name: B.revokeMore }));
    const revoke = screen.getByRole('dialog', { name: B.revokeTitle({ device: 'Desk PC' }) });
    expectFullyLocalized(revoke, { data: DATA });
    await cancel(revoke);
    expectFullyLocalized(container, { data: [...DATA, hub.state.m3.approvals[0]!.action] });
  });

  it('explains low-level boot and network boot when off, with a pending trial and Revert', async () => {
    const pending = attempt();
    const { container } = await openBoot({
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
    await screen.findByRole('heading', { name: B.pendingTitle, level: 2 });
    await screen.findByText('/var/lib/nova/boot-images');
    expect(screen.getAllByRole('note')).toHaveLength(2);
    expectFullyLocalized(container, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: B.revertMore }));
    const revert = screen.getByRole('dialog', { name: B.revertTitle({ device: 'Desk PC' }) });
    expectFullyLocalized(revert, { data: DATA });
  });

  it('says when the boot status cannot be read, and when the bootloader is not supported', async () => {
    const offline = await openBoot({ boot: { offline: true } });
    await screen.findByText(B.statusUnreadable, { exact: false });
    expect(screen.getByLabelText(B.entryId)).toBeTruthy();
    expectFullyLocalized(offline.container, { data: DATA });
    resetDom();

    const reason = 'no supported bootloader found';
    const { container } = await openBoot({
      boot: {
        status: {
          ...bootDevice().status!,
          supported: false,
          reason,
          bootloader: 'none',
          entries: [],
        },
      },
    });
    await waitFor(() => expect(screen.getByText(B.unmanagedBecause({ reason }))).toBeTruthy());
    expectFullyLocalized(container, { data: [...DATA, reason] });
  });
});
