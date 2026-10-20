// The firmware area in the pseudo-locale (FR-016): the Firmware tab with a change planned, asked
// for, applied and rolled back (each dialog on the way), the toggle-off note, the BIOS password,
// an unsupported machine with the support matrix, the "Firmware and boot" settings with a consent
// dialog, and a Hub-only approval card, loading, pending and answered. Fixture names, the
// device's values and the Hub's own words (approval actions, the support matrix) are data.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { FIRMWARE_SUPPORT_MATRIX, type ApprovalView } from '@nova/shared';
import { PARTS_TEXT } from '../src/devices/parts.tsx';
import { FIRMWARE_CHANGE_TEXT as C } from '../src/firmware/FirmwareChange.tsx';
import { FIRMWARE_PANEL_TEXT as P, FirmwarePanel } from '../src/firmware/FirmwarePanel.tsx';
import { FIRMWARE_TEXT, hubOnlyText, keyLabel } from '../src/firmware/format.ts';
import { HUB_ONLY_APPROVAL_TEXT as H, HubOnlyApproval } from '../src/firmware/HubOnlyApproval.tsx';
import { FIRMWARE_SETTINGS_TEXT as T, FirmwareBootSettings } from '../src/firmware/Settings.tsx';
import { formatWhen } from '../src/settings/common.ts';
import { deviceView } from './fakes-m6-devices.ts';
import {
  firmwareDevice,
  renderWithFirmware,
  type FakeFirmwareDevice,
} from './fakes-m75-firmware.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const ON = { 'devices.firmware.allowChanges': true, 'devices.firmware.watchdogSeconds': 900 };

/** What the device and the Hub report, shown as they are. */
const DATA = [
  'Desk PC',
  'Dell Inc.',
  'OptiPlex 7090',
  // Vendor keys and values of the Dell-shaped settings.
  'WakeOnLan',
  'AcPwrRcvry',
  'BootOrder',
  'Virtualization',
  'SecureBoot',
  'TpmSecurity',
  'ThermalManagement',
  'Disabled',
  'LanOnly',
  'LanWlan',
  'Enabled',
  'Optimized',
  'Cool',
  'Quiet',
  'Last',
  'Off',
  'On',
  'ubuntu',
  'Windows Boot Manager',
  'UEFI HTTP',
  // fwupd's list.
  'System Firmware',
  'Security fixes',
  // The Hub's hardware support matrix, in its own words (D9).
  ...FIRMWARE_SUPPORT_MATRIX.flatMap((e) => [e.label, e.notes, e.driver ?? '', e.reason ?? '']),
];

async function openPanel(
  opts: {
    settings?: Record<string, unknown>;
    device?: Partial<FakeFirmwareDevice>;
    passwords?: string[];
  } = {},
) {
  await activateTestLocale('en-XA');
  const device = deviceView({ id: 'd1', name: 'Desk PC' });
  return renderWithFirmware(
    <FirmwarePanel device={device} onDevice={() => undefined} reload={() => undefined} />,
    {
      devices: { devices: [device] },
      firmware: { firmware: { d1: firmwareDevice(opts.device) }, passwords: opts.passwords ?? [] },
      settings: opts.settings ?? ON,
    },
  );
}

describe('the Firmware tab in a pseudo-locale', () => {
  it('plans, asks, applies and rolls back a change, every word localized', async () => {
    const { container, hub, state } = await openPanel();
    await screen.findByText(P.supported);

    // The support matrix, a security-degrading choice and a reordered boot order.
    await userEvent.click(screen.getByText(P.matrix));
    await screen.findByRole('table', { name: P.matrixCaption });
    await userEvent.selectOptions(screen.getByLabelText(keyLabel('secureBoot')), 'Disabled');
    await userEvent.selectOptions(screen.getByLabelText(keyLabel('wol')), 'LanOnly');
    const order = screen.getByRole('group', { name: keyLabel('bootOrder') });
    await userEvent.click(
      within(order).getByRole('button', { name: P.moveUp({ entry: 'UEFI HTTP' }) }),
    );
    expect(screen.getByText(P.weakensLead)).toBeTruthy();
    expectFullyLocalized(container, { data: DATA });

    // Plan without the security-degrading choice and the new order, then ask for approval.
    await userEvent.selectOptions(screen.getByLabelText(keyLabel('secureBoot')), '');
    await userEvent.click(within(order).getByRole('button', { name: P.keepOrder }));
    await userEvent.click(screen.getByRole('button', { name: P.planChange }));
    await screen.findByRole('heading', { name: P.currentChange, level: 2 });
    expectFullyLocalized(container, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: FIRMWARE_TEXT.askForApproval }));
    const approval = await screen.findByRole('group', {
      name: C.approveChange({ device: 'Desk PC' }),
    });
    expect(within(approval).getByText(hubOnlyText())).toBeTruthy();
    const action = hub.state.m3.approvals[0]!.action;
    expectFullyLocalized(container, { data: [...DATA, action] });

    // Allow, then the Apply dialog with the watchdog restart.
    await userEvent.click(within(approval).getByRole('button', { name: H.allowOnce }));
    await userEvent.click(await screen.findByRole('button', { name: C.apply }));
    const apply = screen.getByRole('dialog', { name: C.applyTitle({ device: 'Desk PC' }) });
    expect(within(apply).getByRole('checkbox')).toBeTruthy();
    expectFullyLocalized(apply, { data: DATA });
    await userEvent.click(
      within(apply).getByRole('button', { name: C.applyConfirm({ device: 'Desk PC' }) }),
    );
    await waitFor(() => expect(state.changes[0]!.status).toBe('applied'));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: P.currentChange })).toBeNull(),
    );
    expectFullyLocalized(container, { data: [...DATA, action] });

    // Roll back from the history: its own dialog.
    const change = state.changes[0]!;
    await userEvent.click(
      await screen.findByRole('button', {
        name: C.rollBackAt({ when: formatWhen(change.appliedAt) }),
      }),
    );
    const rollback = screen.getByRole('dialog', {
      name: P.rollbackTitle({ device: 'Desk PC' }),
    });
    expect(within(rollback).getByRole('list', { name: P.toRestore })).toBeTruthy();
    expectFullyLocalized(rollback, { data: DATA });
  });

  it('explains the toggle when it is off, and removes a stored BIOS password', async () => {
    const { container } = await openPanel({
      settings: {},
      device: { adminPasswordSet: true },
      passwords: ['d1'],
    });
    await screen.findByText(P.supported);
    expect(screen.getByRole('note').textContent).toContain(P.offTitle);
    expect(screen.getByText(P.inVault)).toBeTruthy();
    expectFullyLocalized(container, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: P.removeMore }));
    const remove = screen.getByRole('dialog', { name: P.removeTitle({ device: 'Desk PC' }) });
    expect(within(remove).getByRole('button', { name: PARTS_TEXT.cancel })).toBeTruthy();
    expectFullyLocalized(remove, { data: DATA });
  });

  it('says why an unsupported machine cannot be changed', async () => {
    const reason = 'ASUS boards offer no interface to change firmware settings from Linux';
    const { container } = await openPanel({
      device: {
        supported: false,
        reason,
        platform: {
          vendor: 'ASUSTeK COMPUTER INC.',
          product: 'PRIME B550',
          biosVendor: 'American Megatrends',
          biosVersion: '3002',
          biosDate: '',
          uefi: false,
        },
      },
    });
    await screen.findByText(P.notSupported);
    expectFullyLocalized(container, {
      data: [...DATA, reason, 'ASUSTeK COMPUTER INC.', 'PRIME B550', 'American Megatrends'],
    });
  });
});

describe('the Firmware and boot settings in a pseudo-locale', () => {
  it('shows the switches, the watchdogs and a consent dialog localized', async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderWithFirmware(<FirmwareBootSettings />);
    await screen.findByRole('switch', { name: T.labels.allowChanges });
    expect(screen.getByLabelText(T.firmwareWatchdog)).toBeTruthy();
    expectFullyLocalized(container);
    await userEvent.click(screen.getByRole('switch', { name: T.labels.pxe }));
    const dialog = screen.getByRole('dialog', { name: T.consent.pxe.title });
    expect(within(dialog).getByRole('button', { name: T.consent.pxe.confirm })).toBeTruthy();
    expectFullyLocalized(dialog);
  });
});

function approval(over: Partial<ApprovalView> = {}): ApprovalView {
  return {
    id: 'appr-1',
    threadId: null,
    turnId: null,
    callId: null,
    action: 'Change BIOS/firmware settings on Desk PC: wol Disabled -> LanOnly',
    tool: 'device.firmware.apply',
    argsPreview: JSON.stringify({ device: 'Desk PC', deviceId: 'd1' }),
    reason: 'Requested by the owner',
    tier: 'confirm_at_action',
    risk: 'high',
    userAsked: true,
    ruleId: null,
    options: ['allow_once', 'deny_continue'],
    alwaysScopes: [],
    status: 'pending',
    decision: null,
    decidedBy: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    decidedAt: null,
    runId: null,
    codeSessionId: null,
    threadTitle: null,
    answerIn: 'hub',
    scope: 'device:d1',
    ...over,
  };
}

describe('a Hub-only approval card in a pseudo-locale', () => {
  it('reads localized when it cannot load, while it waits, and once answered here', async () => {
    await activateTestLocale('en-XA');
    const a = approval();
    const title = C.approveChange({ device: 'Desk PC' });
    const { container, hub } = await renderWithFirmware(
      <HubOnlyApproval approvalId={a.id} title={title} />,
    );
    // Not on the Hub yet: the Hub's own "Not found" next to Retry and the Approvals link.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expectFullyLocalized(container, { data: ['Not found'] });

    hub.state.m3.approvals = [a];
    await userEvent.click(screen.getByRole('button', { name: H.retry }));
    const card = await screen.findByRole('group', { name: title });
    expect(within(card).getByText(hubOnlyText())).toBeTruthy();
    expectFullyLocalized(container, { data: ['Desk PC', a.action] });

    await userEvent.click(within(card).getByRole('button', { name: H.allowOnce }));
    expect(await screen.findByText(H.answeredHere)).toBeTruthy();
    expect(
      screen.getByRole('heading', {
        name: H.answeredTitle({ outcome: H.outcome.allow_once }),
      }),
    ).toBeTruthy();
    expectFullyLocalized(container);
  });
});
