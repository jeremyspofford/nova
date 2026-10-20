// secret-scan: fake-file (the BMC credentials in the fakes are made-up fixtures)
// Out-of-band management in the pseudo-locale (FR-016): the out-of-band page (off with its
// consent dialog, on with its BMC list, the Turn off dialog and the Add a BMC form with its
// errors), the Devices list's entry, one BMC's page (facts, power, next boot, sensors, BIOS
// settings, the action log, the waiting list with its Hub-only approval, and the power, boot,
// edit and remove dialogs), the certificate to confirm and the pin mismatch with their dialogs, a
// BIOS plan with its diff and the apply dialog, and a device's Out-of-band tab. Every word comes
// from messages; BMC and device names, sensor names and units, BIOS vendors and values are
// fixture data. The approval card itself (`.approval`) belongs to the chat area's test.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { ENDPOINT_TEXT } from '../src/oob/Endpoint.tsx';
import { ENDPOINT_FORM_TEXT } from '../src/oob/EndpointForm.tsx';
import { ACTION_LABEL, OOB_TEXT } from '../src/oob/format.ts';
import { HUB_APPROVAL_TEXT } from '../src/oob/HubApproval.tsx';
import { OOB_PAGE_TEXT, OobEntry, OobPage } from '../src/oob/OobPage.tsx';
import { OOB_PARTS_TEXT } from '../src/oob/parts.tsx';
import { PARTS_TEXT } from '../src/devices/parts.tsx';
import { deviceView } from './fakes-m6-devices.ts';
import { renderWithM75 } from './fakes-m75-devops.ts';
import { PIN_A, PIN_B, fakeBmc, oobAction, oobEndpoint } from './fakes-m75-oob.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

/** Names and values the fakes return: BMCs, devices, sensors, BIOS vendors and values. */
const DATA = [
  'Rack BMC',
  'Old BMC',
  'Spare BMC',
  'Office AMT',
  'New BMC',
  'Desk PC',
  'CPU1 Temp',
  'Fan 1',
  'Cel',
  'RPM',
  'Dell',
  'Enabled',
  'Disabled',
];
/** The approval card is the chat area's (src/chat/ApprovalCard.tsx). */
const CHAT = ['.approval'];

const DESK = deviceView({ id: 'd1', name: 'Desk PC' });
const RECENT = () => new Date(Date.now() - 120_000).toISOString();
const RACK = () =>
  oobEndpoint({
    id: 'ep1',
    name: 'Rack BMC',
    deviceId: 'd1',
    tlsPin: PIN_A,
    lastCheckAt: RECENT(),
    lastCheckOk: true,
  });

function open(path: string, opts: Parameters<typeof renderWithM75>[1] = {}) {
  window.history.replaceState(null, '', path);
  return renderWithM75(<OobPage />, { devices: { devices: [DESK] }, ...opts });
}

const dialog = (name: string) => screen.getByRole('dialog', { name });

describe('out-of-band management in en-XA', () => {
  it('shows the page while off, with its consent dialog, localized', async () => {
    await activateTestLocale('en-XA');
    await open('/devices/oob', { oob: { enabled: false } });
    const h1 = await screen.findByRole('heading', { name: OOB_TEXT.title, level: 1 });
    await screen.findByText(OOB_PAGE_TEXT.empty);
    await screen.findByText(OOB_PARTS_TEXT.offHelp);
    expectFullyLocalized(h1.closest('.oob-page')!, { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: OOB_PARTS_TEXT.turnOn }));
    expectFullyLocalized(dialog(OOB_PARTS_TEXT.enable.title));
  });

  it('shows the BMC list, the entry, Turn off and the Add a BMC form localized', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/devices/oob');
    await renderWithM75(
      <>
        <OobEntry />
        <OobPage />
      </>,
      {
        devices: { devices: [DESK] },
        oob: {
          enabled: true,
          endpoints: [
            RACK(),
            oobEndpoint({
              id: 'ep2',
              name: 'Old BMC',
              kind: 'ipmi',
              address: '10.0.0.21',
              port: 623,
              hasCredentials: false,
              lastCheckAt: RECENT(),
              lastCheckOk: false,
              lastError: 'the BMC failed: bmc_timeout',
            }),
            oobEndpoint({
              id: 'ep3',
              name: 'Spare BMC',
              deviceId: 'gone',
              tlsPin: PIN_B,
              tlsPinConfirmed: false,
            }),
            oobEndpoint({ id: 'ep4', name: 'New BMC' }),
            oobEndpoint({ id: 'ep5', name: 'Office AMT', kind: 'amt' }),
          ],
        },
      },
    );
    const list = await screen.findByRole('list', { name: OOB_PAGE_TEXT.bmcs });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(5));
    await within(list).findByText(OOB_PAGE_TEXT.manages({ device: 'Desk PC' }));
    const page = screen
      .getByRole('heading', { name: OOB_TEXT.title, level: 1 })
      .closest('.oob-page')!;
    expectFullyLocalized(page, { data: DATA });

    const entry = screen.getByRole('region', { name: OOB_TEXT.title });
    await within(entry).findByText(new RegExp(escape(OOB_PAGE_TEXT.stateOn({ n: 5 }))));
    expectFullyLocalized(entry);

    await userEvent.click(screen.getByRole('button', { name: OOB_PARTS_TEXT.turnOff }));
    expectFullyLocalized(dialog(OOB_PARTS_TEXT.disable.title));
    await userEvent.click(
      within(dialog(OOB_PARTS_TEXT.disable.title)).getByRole('button', {
        name: PARTS_TEXT.cancel,
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: OOB_PAGE_TEXT.add }));
    const add = dialog(ENDPOINT_FORM_TEXT.addTitle);
    await within(add).findByRole('combobox', { name: ENDPOINT_FORM_TEXT.device });
    expectFullyLocalized(add, { data: DATA });
    // Its errors, then IPMI's fields.
    await userEvent.type(within(add).getByRole('textbox', { name: ENDPOINT_FORM_TEXT.port }), '0');
    await userEvent.click(within(add).getByRole('button', { name: ENDPOINT_FORM_TEXT.add }));
    expect(within(add).getByText(ENDPOINT_FORM_TEXT.errors.name)).toBeTruthy();
    expect(within(add).getByText(ENDPOINT_FORM_TEXT.errors.port)).toBeTruthy();
    expect(within(add).getByText(ENDPOINT_FORM_TEXT.errors.password)).toBeTruthy();
    expectFullyLocalized(add, { data: DATA });
    await userEvent.click(
      within(add).getByRole('radio', { name: new RegExp(escape(OOB_TEXT.kinds.ipmi)) }),
    );
    expectFullyLocalized(add, { data: DATA });
  });

  it('says plainly when the app cannot manage BMCs', async () => {
    await activateTestLocale('en-XA');
    await open('/devices/oob', { omit: ['getOobStatus'] });
    const note = await screen.findByText(OOB_PAGE_TEXT.noClient);
    expectFullyLocalized(note.closest('.oob-page')!);
  });

  it("shows a BMC's page, its reads, the waiting approval and its dialogs localized", async () => {
    await activateTestLocale('en-XA');
    await open('/devices/oob/ep1', { oob: { enabled: true, endpoints: [RACK()] } });
    const h1 = await screen.findByRole('heading', { name: 'Rack BMC', level: 1 });
    const page = h1.closest('.oob-page')!;
    await screen.findByText(ENDPOINT_TEXT.logEmpty);
    await userEvent.click(screen.getByRole('button', { name: ENDPOINT_TEXT.readPower }));
    await screen.findByText(OOB_TEXT.powerStates.on, { selector: 'strong' });
    await userEvent.click(screen.getByRole('button', { name: ACTION_LABEL.sensors }));
    await screen.findByText('CPU1 Temp');
    await userEvent.click(screen.getByRole('button', { name: ACTION_LABEL['bios.read'] }));
    await screen.findByRole('form', { name: ENDPOINT_TEXT.bios.form });
    // The BIOS values the BMC allows ("On", "Off", "Last") are its own.
    expectFullyLocalized(page, { data: [...DATA, 'On', 'Off', 'Last'] });

    // A power action's confirmation, then its waiting approval.
    await userEvent.click(screen.getByRole('button', { name: `${ACTION_LABEL['power.cycle']}…` }));
    const cycle = dialog(ENDPOINT_TEXT.powerAsk.title.cycle({ name: 'Rack BMC' }));
    expectFullyLocalized(cycle, { data: DATA });
    await userEvent.click(
      within(cycle).getByRole('button', { name: ENDPOINT_TEXT.powerAsk.confirm.cycle }),
    );
    const waiting = await screen.findByRole('list', { name: ENDPOINT_TEXT.waiting });
    await within(waiting).findByRole('link', { name: HUB_APPROVAL_TEXT.open });
    expectFullyLocalized(waiting, { data: DATA, skip: CHAT });

    // The next boot.
    await userEvent.click(screen.getByRole('button', { name: ENDPOINT_TEXT.boot.set }));
    const boot = dialog(ENDPOINT_TEXT.boot.title({ name: 'Rack BMC' }));
    expectFullyLocalized(boot, { data: DATA });
    await userEvent.click(within(boot).getByRole('button', { name: PARTS_TEXT.cancel }));

    // Edit and Remove.
    await userEvent.click(screen.getByRole('button', { name: ENDPOINT_TEXT.edit }));
    const edit = dialog(ENDPOINT_FORM_TEXT.editTitle({ name: 'Rack BMC' }));
    await userEvent.click(within(edit).getByRole('checkbox', { name: /./ }));
    expectFullyLocalized(edit, { data: DATA });
    await userEvent.click(within(edit).getByRole('button', { name: PARTS_TEXT.cancel }));
    await userEvent.click(screen.getByRole('button', { name: ENDPOINT_TEXT.remove }));
    expectFullyLocalized(dialog(ENDPOINT_TEXT.removeAsk.title({ name: 'Rack BMC' })), {
      data: DATA,
    });
  });

  it('shows an IPMI BMC with a failed check localized', async () => {
    await activateTestLocale('en-XA');
    await open('/devices/oob/ep2', {
      oob: {
        enabled: true,
        endpoints: [
          oobEndpoint({
            id: 'ep2',
            name: 'Old BMC',
            kind: 'ipmi',
            address: '10.0.0.21',
            lastCheckAt: RECENT(),
            lastCheckOk: false,
            // The Hub's own words (English until M9).
            lastError: 'the BMC failed: bmc_timeout',
          }),
        ],
      },
    });
    const h1 = await screen.findByRole('heading', { name: 'Old BMC', level: 1 });
    await screen.findByText(ENDPOINT_TEXT.logEmpty);
    expectFullyLocalized(h1.closest('.oob-page')!, {
      data: [...DATA, 'the BMC failed: bmc_timeout'],
    });
  });

  it('shows the certificate to confirm and the pin mismatch with their dialogs localized', async () => {
    await activateTestLocale('en-XA');
    await open('/devices/oob/ep1', {
      oob: {
        enabled: true,
        endpoints: [
          oobEndpoint({ id: 'ep1', name: 'Rack BMC', tlsPin: PIN_A, tlsPinConfirmed: false }),
        ],
      },
    });
    const question = await screen.findByText(ENDPOINT_TEXT.confirm.question);
    expectFullyLocalized(question.closest('.oob-confirm')!);
    await userEvent.click(screen.getByRole('button', { name: ENDPOINT_TEXT.confirm.yes }));
    expectFullyLocalized(dialog(ENDPOINT_TEXT.confirmPin.title({ name: 'Rack BMC' })), {
      data: DATA,
    });

    resetDom();
    await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()], bmc: { ep1: fakeBmc({ presentedPin: PIN_B }) } },
    });
    await userEvent.click(await screen.findByRole('button', { name: ENDPOINT_TEXT.readPower }));
    const headline = await screen.findByText(ENDPOINT_TEXT.mismatch.headline);
    const page = headline.closest('.oob-page')!;
    expectFullyLocalized(page, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: ENDPOINT_TEXT.mismatch.unpin }));
    const unpin = dialog(ENDPOINT_TEXT.unpin.title({ name: 'Rack BMC' }));
    expectFullyLocalized(unpin, { data: DATA });
    await userEvent.click(within(unpin).getByRole('button', { name: PARTS_TEXT.cancel }));
    await userEvent.click(screen.getByRole('button', { name: ENDPOINT_TEXT.mismatch.repin }));
    const repin = dialog(ENDPOINT_FORM_TEXT.repin.title({ name: 'Rack BMC' }));
    await userEvent.click(
      within(repin).getByRole('button', { name: ENDPOINT_FORM_TEXT.repin.save }),
    );
    expect(within(repin).getByText(ENDPOINT_FORM_TEXT.errors.pin)).toBeTruthy();
    expectFullyLocalized(repin, { data: DATA });
  });

  it('shows a BIOS plan with its weakening note, its diff and the apply dialog localized', async () => {
    await activateTestLocale('en-XA');
    await open('/devices/oob/ep1', {
      oob: {
        enabled: true,
        endpoints: [RACK()],
        actions: [
          oobAction({
            id: 'plan1',
            endpointId: 'ep1',
            action: 'bios.plan',
            status: 'approved',
            approvalId: 'ap-x',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            result: {
              planId: 'plan1',
              vendor: 'Dell',
              snapshot: { takenAt: RECENT(), values: {}, sha256: 'e'.repeat(64) },
              diff: [
                {
                  key: 'secureBoot',
                  vendorKey: 'SecureBoot',
                  from: 'Enabled',
                  to: 'Disabled',
                  securityDegrading: true,
                },
                {
                  key: 'tpm',
                  vendorKey: 'Tpm',
                  from: null,
                  to: 'Enabled',
                  securityDegrading: false,
                },
              ],
              refused: [{ key: 'bootOrder', reason: 'read_only' }],
              requiresReboot: true,
              allowSecurityDegrading: true,
            },
          }),
        ],
      },
      settings: { 'devices.firmware.allowChanges': true },
    });
    const waiting = await screen.findByRole('list', { name: ENDPOINT_TEXT.waiting });
    expectFullyLocalized(waiting, { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: ACTION_LABEL['bios.read'] }));
    const form = await screen.findByRole('form', { name: ENDPOINT_TEXT.bios.form });
    await userEvent.selectOptions(
      within(form).getByRole('combobox', {
        name: ENDPOINT_TEXT.bios.changeSetting({ setting: OOB_TEXT.biosKeys.secureBoot }),
      }),
      'Disabled',
    );
    await within(form).findByText(ENDPOINT_TEXT.bios.include);
    expectFullyLocalized(form, { data: [...DATA, 'On', 'Off', 'Last'] });

    await userEvent.click(within(waiting).getByRole('button', { name: ENDPOINT_TEXT.apply.open }));
    expectFullyLocalized(dialog(ENDPOINT_TEXT.apply.title({ name: 'Rack BMC' })), {
      data: DATA,
    });
  });

  it("shows a device's Out-of-band tab localized", async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/devices/d1/oob');
    await renderWithM75(<DevicesView deviceId="d1" />, {
      devices: { devices: [DESK] },
      oob: {
        enabled: true,
        endpoints: [
          RACK(),
          oobEndpoint({ id: 'ep2', name: 'Old BMC', kind: 'ipmi', deviceId: 'd1' }),
        ],
      },
    });
    const tab = await screen.findByRole('tab', { name: OOB_PAGE_TEXT.tab });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const nav = await screen.findByRole('navigation', { name: OOB_PAGE_TEXT.ofDevice });
    const panel = nav.closest('[role="tabpanel"]')!;
    await within(panel as HTMLElement).findByRole('heading', { name: 'Rack BMC', level: 2 });
    expectFullyLocalized(panel, { data: DATA });
  });
});

/** A message as a literal pattern (pseudo text has brackets). */
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
