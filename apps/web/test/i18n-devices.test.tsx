// The Devices views in the pseudo-locale (FR-016): the list with a request to join and the
// device certificates, a device's page with its facts, scopes, management channel and its
// rename, scopes, revoke and decommission dialogs, Add a device (the choice and the code), and
// the one-use command. Every word comes from messages; names, platforms, codes, commands and
// URLs are fixture data. The out-of-band entry and the tabs' panels are tested with their areas.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ADD_TEXT } from '../src/devices/AddDevice.tsx';
import { DECOMMISSION_TEXT } from '../src/devices/Decommission.tsx';
import { PAGE_TEXT } from '../src/devices/DevicePage.tsx';
import { DevicesView, LIST_TEXT } from '../src/devices/DevicesView.tsx';
import { ENROLL_TEXT } from '../src/devices/EnrollCommand.tsx';
import { TLS_TEXT } from '../src/devices/Tls.tsx';
import { deviceView } from './fakes-m6-devices.ts';
import { renderWithAllDevices, revealed, summaryView } from './fakes-m65-devices.ts';
import { renderWithM75 } from './fakes-m75-devops.ts';
import { renderM7, tlsView } from './fakes-m7-misc.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

/** Device names, platforms and the like: the fakes' data. */
const DATA = ['Desk PC', 'Old laptop', 'New box', 'Kitchen tablet', 'Phone', 'linux', 'iOS'];

/** The out-of-band entry belongs to the oob area's test. */
const OOB: string[] = [];

describe('the Devices views in en-XA', () => {
  it('shows the list, a request to join and the empty state localized', async () => {
    await activateTestLocale('en-XA');
    await renderWithAllDevices(<DevicesView deviceId={null} />, {
      devices: {
        devices: [
          deviceView({ id: 'd1', name: 'Desk PC', roles: ['client', 'compute'] }),
          deviceView({
            id: 'd2',
            name: 'Old laptop',
            novadVersion: '0.6.0',
            status: 'unreachable',
          }),
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
      added: {
        others: [summaryView({ id: 's1', name: 'Phone', scopes: ['offline-replica'] })],
        requests: [revealed({ id: 'rq1', name: 'Kitchen tablet', kind: 'native' })],
      },
    });
    const list = await screen.findByRole('list', { name: LIST_TEXT.title });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(4));
    await screen.findByRole('heading', { name: /Kitchen tablet/ });
    const page = list.closest('.devices-page')!;
    expectFullyLocalized(page, { data: DATA, skip: OOB });
  });

  it('shows the device certificates section and its dialog localized', async () => {
    await activateTestLocale('en-XA');
    const recent = new Date(Date.now() - 60_000).toISOString();
    await renderM7(<DevicesView deviceId={null} />, {
      devices: {
        devices: [
          deviceView({ id: 'd1', name: 'Desk PC' }),
          deviceView({ id: 'd2', name: 'Old laptop' }),
        ],
      },
      misc: {
        tls: [
          tlsView({
            deviceId: 'd1',
            name: 'Desk PC',
            certificate: 'verified',
            lastHttpsAt: recent,
          }),
          tlsView({
            deviceId: 'd2',
            name: 'Old laptop',
            certificate: 'refused',
            reason: 'certificate_revoked',
            serial: null,
            lastHttpsAt: recent,
          }),
          tlsView({ deviceId: 'd3', name: null, certificate: 'missing', lastHttpsAt: recent }),
        ],
      },
      settings: { 'devices.tls.allowWithoutCertificate': true },
    });
    const section = await screen.findByRole('region', { name: TLS_TEXT.title });
    await within(section).findByRole('list', { name: TLS_TEXT.seen });
    // The problems are the Hub's own sentences (English in M8, D9).
    expectFullyLocalized(section, { data: DATA, skip: ['.contrast-warning li'] });
    await userEvent.click(within(section).getByRole('switch', { name: TLS_TEXT.require }));
    const dialog = await screen.findByRole('dialog', { name: TLS_TEXT.confirmTitle });
    // A device without a name is named by its id.
    expectFullyLocalized(dialog, { data: [...DATA, 'd3'] });
  });

  it('shows a device’s page and its dialogs localized', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/devices/d1');
    await renderWithM75(<DevicesView deviceId="d1" />, {
      devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC', configPending: true })] },
    });
    await screen.findByRole('heading', { name: 'Desk PC', level: 1 });
    await screen.findByRole('tablist', { name: PAGE_TEXT.sections });
    const page = document.querySelector('.devices-page')!;
    // The tab panel is the open tab's area (tested with its panel); the header, facts and scopes
    // are the page's.
    expectFullyLocalized(page, { data: DATA, skip: ['[role="tabpanel"]', ...OOB] });

    await userEvent.click(screen.getByRole('button', { name: PAGE_TEXT.rename }));
    expectFullyLocalized(await screen.findByRole('dialog', { name: PAGE_TEXT.renameTitle }), {
      data: DATA,
    });
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: DECOMMISSION_TEXT.button }));
    expectFullyLocalized(
      await screen.findByRole('dialog', { name: DECOMMISSION_TEXT.title({ name: 'Desk PC' }) }),
      { data: DATA },
    );
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: PAGE_TEXT.revoke.confirm }));
    expectFullyLocalized(
      await screen.findByRole('dialog', { name: PAGE_TEXT.revoke.title({ name: 'Desk PC' }) }),
      { data: DATA },
    );
  });

  it('shows a browser’s page with its scopes dialog localized', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/devices/s1');
    await renderWithAllDevices(<DevicesView deviceId="s1" />, {
      added: { others: [summaryView({ id: 's1', name: 'Phone', scopes: ['offline-replica'] })] },
    });
    await screen.findByRole('heading', { name: 'Phone', level: 1 });
    expectFullyLocalized(document.querySelector('.devices-page')!, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: PAGE_TEXT.scopes.edit }));
    expectFullyLocalized(
      await screen.findByRole('dialog', { name: PAGE_TEXT.scopes.dialogTitle({ name: 'Phone' }) }),
      { data: DATA },
    );
  });

  it('shows Add a device, its code and the one-use command localized', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/devices/add');
    await renderWithAllDevices(<DevicesView deviceId="add" />, {
      settings: { 'relay.enabled': true },
    });
    await screen.findByRole('heading', { name: ADD_TEXT.title, level: 1 });
    const page = document.querySelector('.devices-page')!;
    expectFullyLocalized(page, { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: ADD_TEXT.create }));
    await screen.findByRole('img', { name: ADD_TEXT.qr });
    await userEvent.click(screen.getByText(ADD_TEXT.headlessQuestion));
    // The code, the join link and the install commands are data shown as they are.
    expectFullyLocalized(page, { data: DATA, skip: ['.devices-code', '.ws-command'] });

    resetDom();
    window.history.replaceState(null, '', '/devices/add?method=command');
    await renderWithAllDevices(<DevicesView deviceId="add" />);
    await screen.findByRole('heading', { name: ENROLL_TEXT.title, level: 1 });
    expectFullyLocalized(document.querySelector('.devices-page')!, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: ENROLL_TEXT.create }));
    await screen.findByRole('region', { name: ENROLL_TEXT.command });
    expectFullyLocalized(document.querySelector('.devices-page')!, {
      data: [...DATA, '<this-device>'],
    });
  });
});
