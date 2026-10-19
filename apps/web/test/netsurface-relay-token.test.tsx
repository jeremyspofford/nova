// secret-scan: fake-file (fixture tokens, passwords and key headers only)
// Network → Relay, the registration token (FR-137, docs/22 §3): write-only, so the page only says
// "Set" or "Not set"; setting checks the token as the Hub does (8-512 printable characters, no
// spaces) before sending, and the value is never shown back; replacing and removing (which asks
// first and says what it costs) work; the Hub's refusal is shown in the form.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { RelaySection } from '../src/netsurface/Relay.tsx';
import { renderM7 } from './fakes-m7-misc.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const TOKEN = 'relay-registration-token-01';

async function open(opts: Parameters<typeof renderM7>[1] = {}) {
  const r = await renderM7(<RelaySection />, opts);
  const section = await screen.findByRole('region', { name: 'Registration token' });
  return { ...r, section: within(section) };
}

describe('the Relay registration token (FR-137)', () => {
  it('sets a token after checking it, and never shows it back', async () => {
    const { section, state, api } = await open();
    expect(section.getByText('Not set')).toBeTruthy();
    expect(section.queryByRole('button', { name: 'Remove token' })).toBeNull();
    await userEvent.click(section.getByRole('button', { name: 'Set a token' }));
    const field = section.getByLabelText('Registration token');
    expect(field.getAttribute('type')).toBe('password');
    expect(document.activeElement).toBe(field);
    await userEvent.type(field, 'has spaces in it');
    await userEvent.click(section.getByRole('button', { name: 'Save token' }));
    expect(section.getByText('Use 8 to 512 characters, without spaces.')).toBeTruthy();
    expect(api.setRelayRegistrationToken).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, TOKEN);
    await userEvent.click(section.getByRole('button', { name: 'Save token' }));
    await waitFor(() => expect(state.relayToken).toBe(TOKEN));
    expect(await section.findByText('Set')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Registration token' }).textContent).not.toContain(
      TOKEN,
    );
    expect(section.queryByLabelText('Registration token')).toBeNull();
    expect(
      await screen.findByText('Registration token saved. The Hub registers with the Relay again.'),
    ).toBeTruthy();
  });

  it('replaces a token, shows the Hub’s refusal, and cancels without sending', async () => {
    const { section, state, failNext } = await open({ misc: { relayToken: TOKEN } });
    expect(section.getByText('Set')).toBeTruthy();
    await userEvent.click(section.getByRole('button', { name: 'Replace token' }));
    const field = section.getByLabelText('New registration token');
    await userEvent.type(field, 'another-token-value');
    failNext.setRelayRegistrationToken = new ApiError(400, {
      code: 'validation',
      message: 'The vault is locked',
      retryable: false,
    });
    await userEvent.click(section.getByRole('button', { name: 'Save token' }));
    expect(await section.findByText('The vault is locked.')).toBeTruthy();
    expect(state.relayToken).toBe(TOKEN);
    await userEvent.click(section.getByRole('button', { name: 'Cancel' }));
    expect(section.queryByLabelText('New registration token')).toBeNull();
    await userEvent.click(section.getByRole('button', { name: 'Replace token' }));
    // A fresh form: what was typed is gone.
    expect(section.getByLabelText<HTMLInputElement>('New registration token').value).toBe('');
  });

  it('removes the token only after asking', async () => {
    const { section, state } = await open({ misc: { relayToken: TOKEN } });
    await userEvent.click(section.getByRole('button', { name: 'Remove token' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove the registration token?' });
    expect(dialog.textContent).toContain('refuses this Hub until you set one again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(state.relayToken).toBe(TOKEN);
    await userEvent.click(section.getByRole('button', { name: 'Remove token' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Remove the registration token?' })).getByRole(
        'button',
        { name: 'Remove' },
      ),
    );
    await waitFor(() => expect(state.relayToken).toBeNull());
    expect(await section.findByText('Not set')).toBeTruthy();
  });
});
