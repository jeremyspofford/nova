// secret-scan: fake-file (the BMC credentials below are made-up fixtures)
// Out-of-band management (FR-147; docs/23 §7; ADR-096 D6): off by default and turned on only
// through the consent dialog; adding a BMC (Redfish or IPMI, Intel AMT shown as not available)
// with refusals kept in the form; the first check reading the certificate without credentials and
// the owner confirming its fingerprint; power, next boot, sensors and BIOS with their Hub-only
// approval cards answered inline; the loud pin mismatch with re-pinning; the action log; the
// device page's Out-of-band tab and the failed-boot link that opens a power cycle; members and
// older clients.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import {
  actionErrorText,
  actionSummary,
  addressText,
  deviceOobPath,
  normalizePin,
  oobErrorMessage,
  parseOobLocation,
  pinMismatch,
  pinPairs,
  shortPin,
} from '../src/oob/format.ts';
import { endpointDraftErrors } from '../src/oob/EndpointForm.tsx';
import { FakeEventSource } from './fakes.ts';
import { deviceView } from './fakes-m6-devices.ts';
import { renderWithM75 } from './fakes-m75-devops.ts';
import { PIN_A, PIN_B, fakeBmc, oobAction, oobEndpoint } from './fakes-m75-oob.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

const DESK = deviceView({ id: 'd1', name: 'Desk PC' });
const RACK = () => oobEndpoint({ id: 'ep1', name: 'Rack BMC', deviceId: 'd1', tlsPin: PIN_A });
const OLD = () => oobEndpoint({ id: 'ep2', name: 'Old BMC', kind: 'ipmi', address: '10.0.0.21' });

function open(path: string, opts: Parameters<typeof renderWithM75>[1] = {}) {
  window.history.replaceState(null, '', path);
  const deviceId = path.split('?')[0]!.split('/')[2] ?? null;
  return renderWithM75(<DevicesView deviceId={deviceId} />, {
    devices: { devices: [DESK] },
    ...opts,
  });
}

const dialog = (name: string | RegExp) => screen.getByRole('dialog', { name });

describe('turning it on (FR-147, ADR-043)', () => {
  it('is off by default and turns on only from the consent dialog, with {confirm: true}', async () => {
    const { api, oob } = await open('/devices/oob');
    expect(
      await screen.findByRole('heading', { name: 'Out-of-band management', level: 1 }),
    ).toBeTruthy();
    expect(await screen.findByText('Off')).toBeTruthy();
    expect(screen.getByText(/Off by default: a BMC controls the hardware/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add a BMC/ })).toHaveProperty('disabled', true);
    expect(screen.getByText('No BMCs yet')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Turn on…' }));
    const d = dialog('Turn on out-of-band management?');
    expect(within(d).getByText(/even when its operating system is down/)).toBeTruthy();
    expect(within(d).getByText(/cannot be answered from a channel/)).toBeTruthy();
    // Focus starts on Cancel: Enter alone never consents.
    expect(document.activeElement?.textContent).toBe('Cancel');
    await userEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    expect(api.enableOob).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Turn on…' }));
    await userEvent.click(
      within(dialog('Turn on out-of-band management?')).getByRole('button', {
        name: 'Turn on out-of-band management',
      }),
    );
    expect(api.enableOob).toHaveBeenCalledWith({ confirm: true });
    expect(await screen.findByText('On')).toBeTruthy();
    expect(oob.state.enabled).toBe(true);
    expect(screen.getByRole('button', { name: /Add a BMC/ })).toHaveProperty('disabled', false);
  });

  it('says plainly when managed policy refuses, and turns off after asking', async () => {
    const { api } = await open('/devices/oob', { oob: { managed: true } });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on…' }));
    const d = dialog('Turn on out-of-band management?');
    await userEvent.click(
      within(d).getByRole('button', { name: 'Turn on out-of-band management' }),
    );
    expect(await within(d).findByRole('alert')).toHaveProperty(
      'textContent',
      'Your organization’s policy sets out-of-band management; it cannot be changed here.',
    );
    await userEvent.click(within(d).getByRole('button', { name: 'Cancel' }));

    resetDom();
    const second = await open('/devices/oob', {
      oob: { enabled: true, endpoints: [RACK()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    const off = dialog('Turn off out-of-band management?');
    expect(within(off).getByText(/Approvals still waiting are withdrawn/)).toBeTruthy();
    await userEvent.click(within(off).getByRole('button', { name: 'Turn off' }));
    expect(second.api.disableOob).toHaveBeenCalled();
    expect(await screen.findByText('Off')).toBeTruthy();
    expect(api.disableOob).not.toHaveBeenCalled();
  });

  it('shows the managed lock instead of the buttons', async () => {
    await open('/devices/oob', { managed: { 'devices.oob.enabled': false } });
    expect(await screen.findByRole('button', { name: 'Turn on…' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Managed by your organization/)).toBeTruthy();
  });

  it('is reachable from the Devices list', async () => {
    await open('/devices', { oob: { enabled: true, endpoints: [RACK()] } });
    const section = await screen.findByRole('region', { name: 'Out-of-band management' });
    expect(await within(section).findByText(/On, 1 BMC\./)).toBeTruthy();
    await userEvent.click(
      within(section).getByRole('link', { name: 'Open out-of-band management' }),
    );
    expect(window.location.pathname).toBe('/devices/oob');
  });
});

describe('adding and editing a BMC', () => {
  it('checks the form, keeps a refusal in it, and opens the new BMC', async () => {
    const { api, oob } = await open('/devices/oob', { oob: { enabled: true } });
    await userEvent.click(await screen.findByRole('button', { name: /Add a BMC/ }));
    const d = dialog('Add a BMC');
    expect(within(d).getByRole('radio', { name: /Intel AMT/ })).toHaveProperty('disabled', true);
    expect(within(d).getByText('Not available in this version.')).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: 'Add BMC' }));
    expect(within(d).getByText('Enter a name.')).toBeTruthy();
    expect(within(d).getByText('Enter the BMC user name.')).toBeTruthy();
    expect(api.createOobEndpoint).not.toHaveBeenCalled();

    await userEvent.type(within(d).getByRole('textbox', { name: 'Name' }), 'Rack 2');
    await userEvent.type(within(d).getByRole('textbox', { name: 'Address' }), 'localhost');
    await userEvent.type(within(d).getByRole('textbox', { name: 'User name' }), 'root');
    await userEvent.type(within(d).getByLabelText('Password'), 's3cret-pass');
    await userEvent.selectOptions(within(d).getByRole('combobox', { name: 'Device' }), 'd1');
    await userEvent.click(within(d).getByRole('button', { name: 'Add BMC' }));
    expect(await within(d).findByRole('alert')).toHaveProperty(
      'textContent',
      'That is a loopback address (the Hub itself). Enter the BMC’s own address on the network.',
    );
    // The form kept everything.
    expect(within(d).getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Rack 2');

    const address = within(d).getByRole('textbox', { name: 'Address' });
    await userEvent.clear(address);
    await userEvent.type(address, '10.0.0.30');
    await userEvent.click(within(d).getByRole('button', { name: 'Add BMC' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/devices\/oob\/ep-/));
    expect(api.createOobEndpoint).toHaveBeenLastCalledWith({
      name: 'Rack 2',
      kind: 'redfish',
      address: '10.0.0.30',
      credentials: { username: 'root', password: 's3cret-pass' },
      deviceId: 'd1',
    });
    expect(await screen.findByRole('heading', { name: 'Rack 2', level: 1 })).toBeTruthy();
    expect(screen.getByText('Stored in the Hub’s vault (never shown)')).toBeTruthy();
    expect(document.body.textContent).not.toContain('s3cret-pass');
    expect(oob.state.endpoints[0]?.deviceId).toBe('d1');
  });

  it('adds an IPMI BMC without system id or fingerprint, and edits a BMC', async () => {
    const { api } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const d = dialog('Edit Rack BMC');
    expect(within(d).getByText(/Saving withdraws its approvals still waiting/)).toBeTruthy();
    // Credentials are kept unless asked.
    expect(within(d).queryByLabelText('Password')).toBeNull();
    const name = within(d).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Rack one');
    await userEvent.click(within(d).getByRole('button', { name: 'Save' }));
    expect(api.updateOobEndpoint).toHaveBeenCalledWith('ep1', { name: 'Rack one' });
    expect(await screen.findByRole('heading', { name: 'Rack one', level: 1 })).toBeTruthy();

    resetDom();
    await open('/devices/oob', { oob: { enabled: true } });
    await userEvent.click(await screen.findByRole('button', { name: /Add a BMC/ }));
    const add = dialog('Add a BMC');
    await userEvent.click(within(add).getByRole('radio', { name: /IPMI/ }));
    expect(within(add).queryByRole('textbox', { name: 'System id' })).toBeNull();
    expect(within(add).queryByRole('textbox', { name: /Certificate fingerprint/ })).toBeNull();
    expect(within(add).getByRole('textbox', { name: 'Port' }).getAttribute('placeholder')).toBe(
      '623',
    );
  });

  it('removes a BMC after asking, even while it is off', async () => {
    const { api, oob } = await open('/devices/oob/ep1', {
      oob: { enabled: false, endpoints: [RACK()] },
    });
    expect(
      await screen.findByText('Out-of-band management is off. Turn it on first.'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const d = dialog('Remove Rack BMC?');
    expect(within(d).getByText(/deletes its credentials from the vault/)).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: 'Remove' }));
    expect(api.deleteOobEndpoint).toHaveBeenCalledWith('ep1');
    await waitFor(() => expect(window.location.pathname).toBe('/devices/oob'));
    expect(oob.state.endpoints).toHaveLength(0);
  });
});

describe('the certificate (SSH-style pinning)', () => {
  it('reads it on the first check without credentials and asks the owner to confirm it', async () => {
    const { api, oob } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [oobEndpoint({ id: 'ep1', name: 'Rack BMC' })] },
    });
    expect(await screen.findByText('Not read yet: the first check reads it')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Power off…' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/Check the connection first, then confirm/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Check the connection' }));
    expect(api.oobAction).toHaveBeenCalledWith('ep1', 'check', {});
    const ask = await screen.findByText('Is this your BMC’s certificate?');
    const box = ask.closest('div')!;
    expect(within(box).getByText(pinPairs(PIN_A))).toBeTruthy();
    const log = screen.getByRole('list', { name: 'Action log' });
    expect(
      await within(log).findByText(/Its certificate waits for your confirmation; no credentials/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Power off…' })).toHaveProperty('disabled', true);

    await userEvent.click(within(box).getByRole('button', { name: 'Yes, it is my BMC’s…' }));
    const d = dialog('Is this the certificate of Rack BMC?');
    await userEvent.click(within(d).getByRole('button', { name: 'Confirm the fingerprint' }));
    expect(api.confirmOobPin).toHaveBeenCalledWith('ep1', PIN_A);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Power off…' })).toHaveProperty('disabled', false),
    );
    expect(screen.queryByText('Is this your BMC’s certificate?')).toBeNull();
    expect(oob.state.endpoints[0]?.tlsPinConfirmed).toBe(true);
  });

  it('refuses to confirm a fingerprint that changed in between', async () => {
    const { oob } = await open('/devices/oob/ep1', {
      oob: {
        enabled: true,
        endpoints: [
          oobEndpoint({ id: 'ep1', name: 'Rack BMC', tlsPin: PIN_A, tlsPinConfirmed: false }),
        ],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Yes, it is my BMC’s…' }));
    oob.state.endpoints = oob.state.endpoints.map((e) => ({ ...e, tlsPin: PIN_B }));
    const d = dialog('Is this the certificate of Rack BMC?');
    await userEvent.click(within(d).getByRole('button', { name: 'Confirm the fingerprint' }));
    expect((await within(d).findByRole('alert')).textContent).toBe(
      'The BMC now presents another certificate than the one shown. Check the connection again and compare the new fingerprint.',
    );
  });

  it('warns loudly on a mismatch and lets the owner pin the new certificate or clear the pin', async () => {
    const { api, oob } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()], bmc: { ep1: fakeBmc({ presentedPin: PIN_B }) } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Read the power state' }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toContain(
      'The BMC presented a different certificate than the one pinned, so nothing was sent to it.',
    );
    const warning = await screen.findByText('This BMC presented a different certificate');
    const box = warning.closest('[role="alert"]') as HTMLElement;
    expect(within(box).getByText(pinPairs(PIN_A))).toBeTruthy();
    expect(within(box).getByText(/Nova sent it nothing, not even the credentials/)).toBeTruthy();

    await userEvent.click(within(box).getByRole('button', { name: 'Pin the new certificate…' }));
    const d = dialog('Pin a new certificate for Rack BMC');
    const field = within(d).getByRole('textbox', { name: /New certificate fingerprint/ });
    await userEvent.type(field, 'not-a-pin');
    await userEvent.click(within(d).getByRole('button', { name: 'Pin this certificate' }));
    expect(within(d).getByText(/Enter the SHA-256 fingerprint/)).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.type(field, pinPairs(PIN_B));
    await userEvent.click(within(d).getByRole('button', { name: 'Pin this certificate' }));
    expect(api.updateOobEndpoint).toHaveBeenCalledWith('ep1', { tlsPin: PIN_B });
    await waitFor(() =>
      expect(screen.queryByText('This BMC presented a different certificate')).toBeNull(),
    );
    expect(oob.state.endpoints[0]).toMatchObject({ tlsPin: PIN_B, tlsPinConfirmed: true });
  });

  it('clears the pin after asking', async () => {
    const { api } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()], bmc: { ep1: fakeBmc({ presentedPin: PIN_B }) } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Read the sensors' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Clear the pin…' }));
    const d = dialog('Clear the pinned certificate of Rack BMC?');
    expect(within(d).getByText(/for you to confirm again/)).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: 'Clear the pin' }));
    expect(api.updateOobEndpoint).toHaveBeenCalledWith('ep1', { tlsPin: null });
    expect(await screen.findByText('Not read yet: the first check reads it')).toBeTruthy();
  });
});

describe('actions and their Hub-only approvals', () => {
  it('asks before a power cycle, files the card, runs it once allowed, and logs it', async () => {
    const { api, hub } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Power cycle…' }));
    const d = dialog('Power cycle Rack BMC?');
    expect(within(d).getByText(/turns the machine off and on again at once/)).toBeTruthy();
    expect(within(d).getByText(/This BMC manages Desk PC/)).toBeTruthy();
    expect(within(d).getByText(/runs only after you approve it/)).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: 'Ask to power cycle' }));
    expect(api.oobAction).toHaveBeenCalledWith('ep1', 'power.cycle', {});

    const waiting = await screen.findByRole('list', { name: 'Waiting for you' });
    expect(
      await within(waiting).findByText(
        /Only you can answer this, in Nova: here or on the Approvals page/,
      ),
    ).toBeTruthy();
    const card = hub.state.m3.approvals[0]!;
    expect(card).toMatchObject({ answerIn: 'hub', risk: 'high', tier: 'confirm_at_action' });
    expect(within(waiting).getByText(card.action)).toBeTruthy();
    expect(
      within(waiting).getByRole('link', { name: 'Open in Approvals' }).getAttribute('href'),
    ).toBe(`/approvals?focus=${card.id}`);
    // Only Allow once and Deny are offered.
    expect(within(waiting).queryByRole('button', { name: /Always allow/ })).toBeNull();
    await userEvent.click(within(waiting).getByRole('button', { name: 'Allow once' }));

    const log = await screen.findByRole('list', { name: 'Action log' });
    const row = await within(log).findByRole('listitem', { name: 'Power cycle' });
    expect(await within(row).findByText('Done')).toBeTruthy();
    expect(within(row).getByText('Power on → on.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Waiting for you' })).toBeNull();
  });

  it('records a denied action, and a power state read at once', async () => {
    await open('/devices/oob/ep1', { oob: { enabled: true, endpoints: [RACK()] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Read the power state' }));
    expect(await screen.findByText('On', { selector: 'strong' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Power off…' }));
    expect(
      within(dialog('Power off Rack BMC?')).getByText(/unsaved work on the machine is lost/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ask to power off' }));
    const waiting = await screen.findByRole('list', { name: 'Waiting for you' });
    // A Hub-only card offers a plain Deny: no run waits for a reason.
    await userEvent.click(await within(waiting).findByRole('button', { name: 'Deny' }));
    const log = screen.getByRole('list', { name: 'Action log' });
    const row = await within(log).findByRole('listitem', { name: 'Power off' });
    expect(await within(row).findByText('Denied')).toBeTruthy();
    expect(within(row).getByText('You denied it.')).toBeTruthy();
  });

  it('reads sensors and says why a BMC failed, in plain words', async () => {
    const { oob } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Read the sensors' }));
    const table = await screen.findByRole('table', { name: /Read/ });
    expect(within(table).getByText('CPU1 Temp')).toBeTruthy();
    expect(within(table).getByText('5400 RPM')).toBeTruthy();
    expect(within(table).getByText('Warning')).toBeTruthy();

    oob.state.bmc.ep1 = fakeBmc({ fail: 'bmc_unreachable' });
    await userEvent.click(screen.getByRole('button', { name: 'Read the sensors' }));
    expect(
      await screen.findByText(
        'The BMC did not answer. Check its address and that the Hub can reach it.',
        { selector: '[role="alert"]' },
      ),
    ).toBeTruthy();
    const log = screen.getByRole('list', { name: 'Action log' });
    expect((await within(log).findAllByText('Failed')).length).toBeGreaterThan(0);
  });

  it('sets the next boot after saying what changes; IPMI has no USB boot', async () => {
    const { api } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()] },
    });
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Boot from' }),
      'disk',
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Boot mode' }), 'uefi');
    await userEvent.click(screen.getByRole('button', { name: 'Set the next boot…' }));
    const d = dialog('Set the next boot of Rack BMC?');
    expect(
      within(d).getByText(/It starts from Hard disk once \(UEFI\) at its next start/),
    ).toBeTruthy();
    expect(within(d).getByText(/Nothing restarts now/)).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: 'Ask to set the next boot' }));
    expect(api.oobAction).toHaveBeenCalledWith('ep1', 'boot.next', {
      target: 'disk',
      mode: 'uefi',
    });
    expect(await screen.findByText('Next boot: Hard disk once (UEFI)')).toBeTruthy();

    resetDom();
    await open('/devices/oob/ep2', {
      oob: { enabled: true, endpoints: [OLD()] },
    });
    const usb = await screen.findByRole('option', { name: 'USB drive (not over IPMI)' });
    expect(usb).toHaveProperty('disabled', true);
    expect(screen.getByText(/BIOS settings are not available over IPMI/)).toBeTruthy();
  });

  it('refuses an action the Hub refuses, in plain words, keeping the dialog', async () => {
    const { oob } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Power on…' }));
    oob.state.enabled = false;
    const d = dialog('Power on Rack BMC?');
    await userEvent.click(within(d).getByRole('button', { name: 'Ask to power on' }));
    expect((await within(d).findByRole('alert')).textContent).toBe(
      'Out-of-band management is off. Turn it on first.',
    );
  });
});

describe('BIOS settings over Redfish (the firmware toggles)', () => {
  it('reads them, and refuses plans while BIOS changes are off', async () => {
    await open('/devices/oob/ep1', { oob: { enabled: true, endpoints: [RACK()] } });
    expect(
      await screen.findByText(/BIOS and firmware changes are off, as they are by default/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Read the BIOS settings' }));
    const table = await screen.findByRole('table', { name: /Dell settings/ });
    expect(within(table).getByText('Wake-on-LAN')).toBeTruthy();
    expect(within(table).getByRole('combobox', { name: 'Change Wake-on-LAN to' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Plan the change' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('plans with a diff, needs the separate override to include a weakening change, then applies once approved', async () => {
    const { api, oob } = await open('/devices/oob/ep1', {
      oob: { enabled: true, endpoints: [RACK()] },
      settings: { 'devices.firmware.allowChanges': true },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Read the BIOS settings' }));
    await screen.findByRole('table', { name: /Dell settings/ });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Change Wake-on-LAN to' }),
      'Enabled',
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Change Secure Boot to' }),
      'Disabled',
    );
    expect(screen.getByText(/Secure Boot would weaken the machine’s security/)).toBeTruthy();
    expect(screen.getByText(/\(it is off\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Plan the change' }));
    expect(api.oobAction).toHaveBeenLastCalledWith('ep1', 'bios.plan', {
      changes: [
        { key: 'wol', value: 'Enabled' },
        { key: 'secureBoot', value: 'Disabled' },
      ],
    });
    // Without the override, the weakening change is left out of the plan.
    const waiting = await screen.findByRole('list', { name: 'Waiting for you' });
    const diff = within(waiting).getByRole('table', { name: /BIOS change \(Dell\)/ });
    expect(within(diff).getByText('Wake-on-LAN')).toBeTruthy();
    expect(within(diff).queryByText('Secure Boot')).toBeNull();
    expect(
      within(waiting).getByText(
        'Left out: Secure Boot (it weakens security and needs the separate override).',
      ),
    ).toBeTruthy();
    await userEvent.click(await within(waiting).findByRole('button', { name: 'Allow once' }));
    const apply = await screen.findByRole('button', { name: 'Apply at the next restart…' });
    await userEvent.click(apply);
    const d = dialog('Apply the BIOS change to Rack BMC?');
    expect(within(d).getByText(/take effect at the next restart of Desk PC/)).toBeTruthy();
    expect(within(d).getByRole('table')).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: 'Apply at the next restart' }));
    const planId = oob.state.actions.find((a) => a.action === 'bios.plan')!.id;
    expect(api.oobAction).toHaveBeenLastCalledWith('ep1', 'bios.apply', { planId });
    const log = await screen.findByRole('list', { name: 'Action log' });
    const row = await within(log).findByRole('listitem', { name: 'Apply a BIOS change' });
    expect(
      within(row).getByText('Pending for the next restart: Wake-on-LAN → Enabled.'),
    ).toBeTruthy();
    expect(within(row).getByText('From an approved plan')).toBeTruthy();
  });

  it('marks a plan that failed after its write so it is not applied again', async () => {
    const { oob } = await open('/devices/oob/ep1', {
      oob: {
        enabled: true,
        endpoints: [RACK()],
        bmc: { ep1: fakeBmc({ applyFails: 'after' }) },
        actions: [
          oobAction({
            id: 'plan1',
            endpointId: 'ep1',
            action: 'bios.plan',
            status: 'approved',
            approvalId: 'ap-x',
            expiresAt: '2026-10-02T10:00:00.000Z',
            result: {
              planId: 'plan1',
              vendor: 'Dell',
              snapshot: { takenAt: '2026-10-01T12:00:00.000Z', values: {}, sha256: 'e'.repeat(64) },
              diff: [
                {
                  key: 'wol',
                  vendorKey: 'WakeOnLan',
                  from: 'Disabled',
                  to: 'Enabled',
                  securityDegrading: false,
                },
              ],
              refused: [],
              requiresReboot: true,
              allowSecurityDegrading: false,
            },
          }),
        ],
      },
      settings: { 'devices.firmware.allowChanges': true },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Apply at the next restart…' }),
    );
    const d = dialog('Apply the BIOS change to Rack BMC?');
    await userEvent.click(within(d).getByRole('button', { name: 'Apply at the next restart' }));
    expect((await within(d).findByRole('alert')).textContent).toBe('The BMC reported an error.');
    await userEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    const log = screen.getByRole('list', { name: 'Action log' });
    const plan = await within(log).findByRole('listitem', { name: 'BIOS change plan' });
    expect(await within(plan).findByText(/The BMC may have taken part of the change/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply at the next restart…' })).toBeNull();
    expect(oob.state.actions.find((a) => a.id === 'plan1')?.status).toBe('failed');
  });
});

describe('a device’s Out-of-band tab and the failed-boot link', () => {
  it('shows the tab only when a BMC is linked, and opens the power cycle from the alert link', async () => {
    const { api } = await open(deviceOobPath('d1', 'ep1', 'power.cycle'), {
      oob: { enabled: true, endpoints: [RACK()] },
    });
    const tab = await screen.findByRole('tab', { name: 'Out-of-band' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    // The confirmation opens; nothing runs by itself.
    const d = await screen.findByRole('dialog', { name: 'Power cycle Rack BMC?' });
    expect(api.oobAction).not.toHaveBeenCalledWith('ep1', 'power.cycle', {});
    await userEvent.click(within(d).getByRole('button', { name: 'Ask to power cycle' }));
    expect(api.oobAction).toHaveBeenCalledWith('ep1', 'power.cycle', {});
    expect(await screen.findByRole('list', { name: 'Waiting for you' })).toBeTruthy();

    // Back to another tab and to the Out-of-band tab again.
    await userEvent.click(screen.getByRole('tab', { name: 'Power' }));
    expect(window.location.search).toBe('?tab=power');
    await userEvent.click(screen.getByRole('tab', { name: 'Out-of-band' }));
    expect(window.location.pathname).toBe('/devices/d1/oob');
    expect(await screen.findByRole('heading', { name: 'Rack BMC', level: 2 })).toBeTruthy();
  });

  it('has no Out-of-band tab without a linked BMC, and follows a new link live', async () => {
    const { oob } = await open('/devices/d1', { oob: { enabled: true, endpoints: [OLD()] } });
    expect(await screen.findByRole('tab', { name: 'Capabilities' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Out-of-band' })).toBeNull();
    oob.state.endpoints = oob.state.endpoints.map((e) => ({ ...e, deviceId: 'd1' }));
    stream().emit('device.oob.endpoint.changed', {
      endpointId: 'ep2',
      change: 'updated',
      kind: 'ipmi',
      deviceId: 'd1',
    });
    expect(await screen.findByRole('tab', { name: 'Out-of-band' })).toBeTruthy();
  });

  it('leaves the device page as it was for a client without these calls', async () => {
    await open('/devices/d1', {
      oob: { enabled: true, endpoints: [RACK()] },
      omit: ['getOobStatus'],
    });
    expect(await screen.findByRole('tab', { name: 'Capabilities' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Out-of-band' })).toBeNull();
    resetDom();
    await open('/devices/oob', { omit: ['getOobStatus'] });
    expect(await screen.findByText('This version of the app cannot manage BMCs.')).toBeTruthy();
  });
});

describe('members', () => {
  it('shows a member the owner-only notice instead of the page', async () => {
    const { api } = await open('/devices/oob', { as: 'member', oob: { enabled: true } });
    expect(await screen.findByText(/Only the owner of this Hub can change/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Out-of-band management', level: 1 })).toBeNull();
    // The Hub refuses a member anyway (the page may ask once before the role is known).
    await expect(api.listOobEndpoints()).rejects.toMatchObject({
      body: { details: { reason: 'owner_only' } },
    });
  });
});

describe('words and paths', () => {
  it('parses the out-of-band paths and builds them', () => {
    expect(parseOobLocation('/devices/oob')).toEqual({
      deviceId: null,
      endpointId: null,
      action: null,
    });
    expect(parseOobLocation('/devices/oob/ep1?action=power.off')).toEqual({
      deviceId: null,
      endpointId: 'ep1',
      action: 'power.off',
    });
    expect(parseOobLocation('/devices/d1/oob/ep1?action=power.cycle')).toEqual({
      deviceId: 'd1',
      endpointId: 'ep1',
      action: 'power.cycle',
    });
    expect(parseOobLocation('/devices/d1/oob?action=rm')).toEqual({
      deviceId: 'd1',
      endpointId: null,
      action: null,
    });
    expect(parseOobLocation('/devices/d1')).toBeNull();
    expect(parseOobLocation('/chat/oob')).toBeNull();
    expect(deviceOobPath('d 1', 'ep/1', 'power.cycle')).toBe(
      '/devices/d%201/oob/ep%2F1?action=power.cycle',
    );
  });

  it('reads fingerprints, addresses and results', () => {
    expect(normalizePin(pinPairs(PIN_A))).toBe(PIN_A);
    expect(normalizePin('abc')).toBeNull();
    expect(shortPin(PIN_A)).toBe('abab abab … abab abab');
    expect(addressText({ address: '10.0.0.20', port: null, kind: 'redfish' })).toBe(
      '10.0.0.20 (port 443)',
    );
    expect(addressText({ address: 'fe80::1', port: 623, kind: 'ipmi' })).toBe('[fe80::1]:623');
    expect(
      actionSummary(
        oobAction({ action: 'check', result: { protocol: 'ipmi', powerState: 'off' } }),
      ),
    ).toBe('IPMI answered; power off.');
    expect(
      actionSummary(
        oobAction({
          action: 'bios.read',
          result: {
            supported: false,
            reason: 'Supermicro: not mapped',
            vendor: null,
            settings: [],
          },
        }),
      ),
    ).toBe('Not supported: Supermicro: not mapped.');
    expect(actionErrorText({ code: 'server_error', reason: 'interrupted', message: '' })).toBe(
      'The Hub restarted during the action; it was not run again.',
    );
    expect(actionErrorText({ code: 'conflict', reason: null, message: 'odd failure' })).toBe(
      'Odd failure',
    );
  });

  it('says every refusal plainly', () => {
    const e = (code: string, details?: Record<string, unknown>, message = 'raw') =>
      new ApiError(400, { code, message, retryable: false, ...(details ? { details } : {}) });
    expect(
      oobErrorMessage(e('conflict', { reason: 'system_ambiguous', systems: ['1', '2'] })),
    ).toBe('This BMC manages several systems. Enter the system id to use (it lists 1, 2).');
    expect(
      oobErrorMessage(e('validation', { reason: 'address_not_allowed', kind: 'hub' })),
    ).toContain('one of the Hub’s own addresses');
    expect(oobErrorMessage(e('firmware_disabled'))).toContain('Allow BIOS/firmware changes');
    expect(
      oobErrorMessage(e('validation', undefined, 'the address and the port name different ports')),
    ).toBe('The address and the port name different ports.');
    expect(oobErrorMessage(e('conflict', { reason: 'apply_outcome_unknown' }))).toContain(
      'Read the BIOS settings',
    );
    expect(oobErrorMessage(new Error('Failed to fetch'))).toBe(
      'Cannot reach the Hub. Check your connection and try again.',
    );
  });

  it('finds a pin mismatch only until the pin changes or a later action gets through', () => {
    const ep = { tlsPin: PIN_A, tlsPinnedAt: '2026-10-01T12:00:00.000Z' };
    const bad = oobAction({
      status: 'failed',
      createdAt: '2026-10-02T12:00:00.000Z',
      error: { code: 'policy_denied', reason: 'tls_pin_mismatch', message: '' },
    });
    expect(pinMismatch(ep, [bad])).toBe(bad);
    expect(pinMismatch(ep, [oobAction({ status: 'done' }), bad])).toBeNull();
    expect(pinMismatch({ ...ep, tlsPinnedAt: '2026-10-03T00:00:00.000Z' }, [bad])).toBeNull();
    expect(pinMismatch({ tlsPin: null, tlsPinnedAt: null }, [bad])).toBeNull();
  });

  it('checks a BMC draft field by field', () => {
    const base = {
      name: 'x',
      kind: 'redfish' as const,
      address: '10.0.0.1',
      port: '',
      systemId: '',
      deviceId: '',
      username: 'root',
      password: 'pw',
      replaceCredentials: false,
      tlsPin: '',
    };
    expect(endpointDraftErrors(base, true)).toEqual({});
    expect(
      endpointDraftErrors(
        { ...base, port: '70000', systemId: 'a b', username: 'a:b', tlsPin: 'zz' },
        true,
      ),
    ).toEqual({
      port: 'Enter a port from 1 to 65535.',
      systemId: 'Letters, digits, dot, dash and underscore only.',
      username: 'At most 64 characters, with no colon.',
      tlsPin: 'Enter the SHA-256 fingerprint: 64 hexadecimal digits, colons allowed.',
    });
    expect(endpointDraftErrors({ ...base, address: 'root:pw@bmc', username: '' }, false)).toEqual({
      address: 'Put the user name and password in their own fields, never in the address.',
    });
  });
});
