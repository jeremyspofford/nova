// Device certificates (FR-126, docs/22 §5, §9): each computer and compute node in the Devices list
// shows what the Hub saw of its certificate over HTTPS; the "Device certificates" section lists
// them with the Hub's problems and the reason for a refusal in plain words, follows
// `device.tls.changed`, and turns on "Require a device certificate" only after naming the
// devices it would refuse (managed policy locks it); a device's page shows its own state; an
// older client without the call shows none of it; a load failure offers Retry.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { tlsReasonText } from '../src/devices/Tls.tsx';
import { FakeEventSource } from './fakes.ts';
import { deviceView } from './fakes-m6-devices.ts';
import { renderWithAllDevices } from './fakes-m65-devices.ts';
import { renderM7, tlsView } from './fakes-m7-misc.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const recent = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const DEVICES = [
  deviceView({ id: 'd1', name: 'Desk PC' }),
  deviceView({ id: 'd2', name: 'Old laptop' }),
  deviceView({ id: 'd3', name: 'Garage NUC' }),
];
const TLS = [
  tlsView({ deviceId: 'd1', name: 'Desk PC', certificate: 'verified', lastHttpsAt: recent(1) }),
  tlsView({
    deviceId: 'd2',
    name: 'Old laptop',
    certificate: 'missing',
    serial: null,
    lastHttpsAt: recent(5),
  }),
  tlsView({
    deviceId: 'd3',
    name: 'Garage NUC',
    certificate: 'refused',
    reason: 'certificate_revoked',
    serial: null,
    lastHttpsAt: recent(9),
  }),
];

describe('device certificates in the Devices list (FR-126)', () => {
  it('shows a chip per device and the section with each device and the Hub’s problems', async () => {
    await renderM7(<DevicesView deviceId={null} />, {
      devices: { devices: DEVICES },
      misc: { tls: TLS },
    });
    const list = await screen.findByRole('list', { name: 'Devices' });
    await waitFor(() =>
      expect(within(list).getByRole('listitem', { name: 'Desk PC' }).textContent).toContain(
        'Certificate verified',
      ),
    );
    expect(within(list).getByRole('listitem', { name: 'Old laptop' }).textContent).toContain(
      'No certificate',
    );
    expect(within(list).getByRole('listitem', { name: 'Garage NUC' }).textContent).toContain(
      'Certificate refused',
    );
    const section = screen.getByRole('region', { name: 'Device certificates' });
    const seen = within(section).getByRole('list', { name: 'Devices seen over HTTPS' });
    expect(
      within(seen)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['Desk PC', 'Old laptop', 'Garage NUC']);
    expect(within(seen).getByText('Refused: its certificate was revoked.')).toBeTruthy();
    expect(within(seen).getByText('3a4f9c0d11e2b7a8')).toBeTruthy();
    const problems = within(section).getByRole('status', { name: 'Certificate problems' });
    expect(problems.textContent).toContain('without a device certificate (Old laptop)');
    expect(problems.textContent).toContain('Garage NUC (certificate_revoked)');
    await userEvent.click(within(seen).getByRole('link', { name: 'Garage NUC' }));
    expect(window.location.pathname).toBe('/devices/d3');
  });

  it('requires certificates only after naming the devices it would refuse', async () => {
    const { hub } = await renderM7(<DevicesView deviceId={null} />, {
      devices: { devices: DEVICES },
      misc: { tls: TLS },
    });
    const section = await screen.findByRole('region', { name: 'Device certificates' });
    const toggle = within(section).getByRole('switch', {
      name: 'Require a device certificate over HTTPS',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await within(section).findByRole('list', { name: 'Devices seen over HTTPS' });
    await userEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Require a device certificate?' });
    expect(dialog.textContent).toContain('This device reaches the Hub over HTTPS without one');
    expect(dialog.textContent).toContain('Old laptop');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(hub.state.settings['devices.tls.allowWithoutCertificate']).toBeUndefined();
    await userEvent.click(toggle);
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Require certificates' }),
    );
    await waitFor(() =>
      expect(hub.state.settings['devices.tls.allowWithoutCertificate']).toBe(false),
    );
    expect(await screen.findByText('Devices now need a certificate over HTTPS.')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    // Turning it off again needs no question.
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(hub.state.settings['devices.tls.allowWithoutCertificate']).toBe(true),
    );
  });

  it('is locked under managed policy', async () => {
    await renderM7(<DevicesView deviceId={null} />, {
      devices: { devices: DEVICES },
      managed: { 'devices.tls.allowWithoutCertificate': false },
    });
    const section = await screen.findByRole('region', { name: 'Device certificates' });
    const toggle = within(section).getByRole<HTMLButtonElement>('switch', {
      name: 'Require a device certificate over HTTPS',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.disabled).toBe(true);
    expect(within(section).getByText('Managed by your organization')).toBeTruthy();
    expect(
      await within(section).findByText(
        'No device has reached the Hub over HTTPS since it started.',
      ),
    ).toBeTruthy();
  });

  it('follows device.tls.changed, and shows a failure with Retry', async () => {
    const { state, failNext } = await renderM7(<DevicesView deviceId={null} />, {
      devices: { devices: DEVICES },
      fail: {
        getDeviceTls: new ApiError(500, {
          code: 'server_error',
          message: 'The Hub could not read it',
          retryable: true,
        }),
      },
    });
    const section = await screen.findByRole('region', { name: 'Device certificates' });
    expect((await within(section).findByRole('alert')).textContent).toContain(
      'The Hub could not read it',
    );
    expect(failNext.getDeviceTls).toBeUndefined();
    await userEvent.click(within(section).getByRole('button', { name: 'Retry' }));
    expect(
      await within(section).findByText(
        'No device has reached the Hub over HTTPS since it started.',
      ),
    ).toBeTruthy();
    state.tls = [TLS[0]!];
    for (const s of FakeEventSource.all.filter((x) => !x.closed))
      act(() => {
        s.emit('device.tls.changed', { deviceId: 'd1', certificate: 'verified' });
      });
    expect(
      await within(section).findByRole('list', { name: 'Devices seen over HTTPS' }),
    ).toBeTruthy();
  });

  it('shows none of it with a client that lacks the call', async () => {
    await renderWithAllDevices(<DevicesView deviceId={null} />, {
      devices: { devices: DEVICES },
      omit: ['getDeviceTls'],
    });
    await screen.findByRole('list', { name: 'Devices' });
    expect(screen.queryByRole('region', { name: 'Device certificates' })).toBeNull();
    expect(screen.queryByText(/Certificate/)).toBeNull();
  });
});

describe('a device’s page', () => {
  it('shows its certificate state, or that it has not been seen over HTTPS', async () => {
    const r = await renderM7(<DevicesView deviceId="d3" />, {
      devices: { devices: DEVICES },
      misc: { tls: TLS },
    });
    const term = await screen.findByText('Certificate', { selector: 'dt' });
    const value = term.nextElementSibling as HTMLElement;
    await waitFor(() => expect(value.textContent).toContain('Certificate refused'));
    expect(value.textContent).toContain('its certificate was revoked');
    r.unmount();
    resetDom();
    await renderM7(<DevicesView deviceId="d1" />, { devices: { devices: DEVICES } });
    expect(await screen.findByText('Not seen over HTTPS')).toBeTruthy();
  });
});

describe('refusal reasons', () => {
  it('reads every reason the Hub gives in plain words', () => {
    expect(tlsReasonText('certificate_mismatch')).toBe('it presented another device’s certificate');
    expect(tlsReasonText('certificate_required')).toMatch(/one is required/);
    expect(tlsReasonText('certificate_something_new')).toBe('something new');
    expect(tlsReasonText(null)).toBe('it was refused');
  });
});
