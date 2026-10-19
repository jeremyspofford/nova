// Settings → Devices → "Firmware and boot" (FR-146, FR-143; ADR-096 D3): every dangerous switch
// asks first, says what it allows and why it is off by default, and turns on only after the
// confirmation (the firmware ones with `{confirm: true}`, which the Hub requires); turning off never
// asks; a refusal stays in the dialog in plain words; managed policy locks a switch; a member sees
// the owner-only notice.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { FirmwareBootSettings } from '../src/firmware/Settings.tsx';
import { renderWithFirmware } from './fakes-m75-firmware.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const sw = (name: string) => screen.getByRole('switch', { name });
const checked = (name: string) => sw(name).getAttribute('aria-checked');

describe('Firmware and boot settings', () => {
  it('turns each dangerous switch on only after its consent, and off without asking', async () => {
    const { api, hub, setSetting } = await renderWithFirmware(<FirmwareBootSettings />);
    await screen.findByRole('switch', { name: 'Allow BIOS/firmware changes' });
    expect(checked('Allow BIOS/firmware changes')).toBe('false');

    // Cancel changes nothing.
    await userEvent.click(sw('Allow BIOS/firmware changes'));
    let dialog = screen.getByRole('dialog', {
      name: 'Allow BIOS and firmware changes on devices?',
    });
    expect(dialog.textContent).toContain('off by default');
    expect(dialog.textContent).toContain('needs your approval here in Nova');
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.setFirmwarePolicy).not.toHaveBeenCalled();
    expect(checked('Allow BIOS/firmware changes')).toBe('false');

    await userEvent.click(sw('Allow BIOS/firmware changes'));
    dialog = screen.getByRole('dialog', { name: 'Allow BIOS and firmware changes on devices?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow firmware changes' }));
    expect(api.setFirmwarePolicy).toHaveBeenCalledWith({ allowChanges: true, confirm: true });
    await waitFor(() => expect(checked('Allow BIOS/firmware changes')).toBe('true'));
    expect(hub.state.settings['devices.firmware.allowChanges']).toBe(true);

    await userEvent.click(sw('Allow changes that weaken security'));
    dialog = screen.getByRole('dialog', { name: 'Allow firmware changes that weaken security?' });
    expect(dialog.textContent).toContain('Secure Boot or the TPM off');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow these changes' }));
    expect(api.setFirmwarePolicy).toHaveBeenLastCalledWith({
      allowSecurityDegrading: true,
      confirm: true,
    });
    await waitFor(() => expect(checked('Allow changes that weaken security')).toBe('true'));

    // Off: at once, without a confirmation.
    await userEvent.click(sw('Allow BIOS/firmware changes'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.setFirmwarePolicy).toHaveBeenLastCalledWith({ allowChanges: false });
    await waitFor(() => expect(checked('Allow BIOS/firmware changes')).toBe('false'));

    await userEvent.click(sw('Allow low-level boot changes'));
    dialog = screen.getByRole('dialog', { name: 'Allow low-level boot changes on devices?' });
    expect(dialog.textContent).toContain('watchdog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow boot changes' }));
    expect(setSetting).toHaveBeenCalledWith('devices.boot.allowLowLevel', true, { confirm: true });
    await waitFor(() => expect(checked('Allow low-level boot changes')).toBe('true'));

    await userEvent.click(sw('Network boot (PXE)'));
    dialog = screen.getByRole('dialog', { name: 'Serve network boot from this Hub?' });
    expect(dialog.textContent).toContain('without signing in');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on network boot' }));
    expect(setSetting).toHaveBeenCalledWith('devices.pxe.enabled', true, { confirm: true });
    await waitFor(() => expect(checked('Network boot (PXE)')).toBe('true'));
    await userEvent.click(sw('Network boot (PXE)'));
    expect(setSetting).toHaveBeenLastCalledWith('devices.pxe.enabled', false);

    const fwWatchdog = screen.getByLabelText<HTMLSelectElement>('Firmware watchdog');
    expect(fwWatchdog.value).toBe('600');
    expect(screen.getByText(/For firmware changes applied with a restart/)).toBeTruthy();
    await userEvent.selectOptions(fwWatchdog, '900');
    expect(setSetting).toHaveBeenLastCalledWith('devices.firmware.watchdogSeconds', 900);
    await waitFor(() => expect(hub.state.settings['devices.firmware.watchdogSeconds']).toBe(900));

    await userEvent.selectOptions(screen.getByLabelText('Boot watchdog'), '300');
    expect(setSetting).toHaveBeenLastCalledWith('devices.boot.watchdogSeconds', 300);
    expect(hub.state.settings['devices.boot.allowLowLevel']).toBe(true);
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>('Boot watchdog').value).toBe('300'),
    );
  });

  it('keeps the dialog open with a refusal in plain words, and the switch off', async () => {
    const { api } = await renderWithFirmware(<FirmwareBootSettings />);
    await screen.findByRole('switch', { name: 'Allow BIOS/firmware changes' });
    api.setFirmwarePolicy.mockRejectedValueOnce(
      new ApiError(403, {
        code: 'policy_denied',
        message: 'raw',
        retryable: false,
        details: { reason: 'consent_required' },
      }),
    );
    await userEvent.click(sw('Allow BIOS/firmware changes'));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow firmware changes' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Turning this on needs your explicit confirmation.',
    );
    expect(checked('Allow BIOS/firmware changes')).toBe('false');
  });

  it('mirrors the Hub: turning a consent switch on without the confirmation is refused', async () => {
    const { api, setSetting } = await renderWithFirmware(<FirmwareBootSettings />);
    for (const key of ['devices.boot.allowLowLevel', 'devices.pxe.enabled'])
      await expect(setSetting(key, true)).rejects.toMatchObject({
        status: 403,
        body: { details: { reason: 'consent_required' } },
      });
    await expect(setSetting('devices.pxe.enabled', false)).resolves.toBeTruthy();
    await expect(api.setFirmwarePolicy({ allowChanges: true })).rejects.toMatchObject({
      status: 403,
      body: { details: { reason: 'consent_required' } },
    });
    await expect(api.setFirmwarePolicy({ allowChanges: false })).resolves.toEqual({
      allowChanges: false,
      allowSecurityDegrading: false,
    });
  });

  it('shows managed switches as locked', async () => {
    await renderWithFirmware(<FirmwareBootSettings />, {
      managed: {
        'devices.boot.allowLowLevel': false,
        'devices.pxe.enabled': false,
        'devices.firmware.watchdogSeconds': 1200,
      },
    });
    await screen.findByRole('switch', { name: 'Allow BIOS/firmware changes' });
    const fw = screen.getByLabelText<HTMLSelectElement>('Firmware watchdog');
    expect(fw.disabled).toBe(true);
    expect(fw.value).toBe('1200');
    expect((sw('Allow low-level boot changes') as HTMLButtonElement).disabled).toBe(true);
    expect((sw('Network boot (PXE)') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Managed by your organization')).toHaveLength(3);
  });

  it('shows a member the owner-only notice', async () => {
    await renderWithFirmware(<FirmwareBootSettings />, { member: true });
    expect(await screen.findByText(/“Firmware and boot” belongs to the whole Hub/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});
