import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { dark } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import { createHub } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const root = () => document.documentElement;

describe('Settings → Appearance (FR-010)', () => {
  it('applies theme, colors, fonts, size and motion live and saves them', async () => {
    const { hub } = await renderApp({ path: '/settings/appearance' });
    await userEvent.click(screen.getByRole('radio', { name: 'High contrast dark' }));
    await waitFor(() => expect(root().dataset.theme).toBe('nova.high-contrast-dark'));
    expect(hub.state.settings['appearance.theme']).toBe('high-contrast-dark');

    const accent = screen.getByRole('textbox', { name: 'Accent hex value' });
    await userEvent.clear(accent);
    await userEvent.type(accent, '#ff8800{Enter}');
    await waitFor(() => expect(root().style.getPropertyValue('--u-accent')).toBe('#ff8800'));
    expect(root().style.getPropertyValue('--u-accent-contrast')).toBe('#000000');
    expect(hub.state.settings['appearance.accent']).toBe('#ff8800');
    await userEvent.click(screen.getByRole('button', { name: 'Reset to theme: Accent' }));
    await waitFor(() => expect(root().style.getPropertyValue('--u-accent')).toBe('#ffd60a'));
    expect(hub.state.settings['appearance.accent']).toBeNull();

    const ui = screen.getByRole('textbox', { name: 'Interface font' });
    await userEvent.type(ui, 'Inter, sans-serif{Enter}');
    await waitFor(() =>
      expect(root().style.getPropertyValue('--u-font-ui')).toBe('Inter, sans-serif'),
    );
    const code = screen.getByRole('textbox', { name: 'Code font' });
    await userEvent.type(code, 'bad;font');
    expect(screen.getByText(/letters, digits, spaces/)).toBeTruthy();
    code.blur();
    expect(hub.state.settings['appearance.codeFont']).toBeUndefined();

    fireEvent.change(screen.getByRole('slider', { name: /Text size/ }), {
      target: { value: '1.25' },
    });
    expect(root().style.getPropertyValue('--u-font-scale')).toBe('1.25');
    expect(screen.getByText('Text size: 125%')).toBeTruthy();
    await waitFor(() => expect(hub.state.settings['appearance.fontScale']).toBe(1.25), {
      timeout: 2000,
    });

    await userEvent.click(screen.getByRole('radio', { name: 'Reduce motion' }));
    await waitFor(() => expect(root().dataset.motion).toBe('reduce'));
  });

  it('warns about low contrast between text and background', async () => {
    const hub = createHub();
    hub.state.settings['appearance.background'] = '#101010';
    await renderApp({ hub, path: '/settings/appearance' });
    expect(screen.queryByText(/Text on background: contrast is/)).toBeNull();
    const text = screen.getByRole('textbox', { name: 'Text hex value' });
    await userEvent.clear(text);
    await userEvent.type(text, '#202020{Enter}');
    expect(
      await screen.findByText(/Text on background: contrast is 1\.\d:1, below the 4\.5:1 minimum/),
    ).toBeTruthy();
    await waitFor(() => expect(root().style.getPropertyValue('--u-bg')).toBe('#101010'));
  });

  it('shows managed settings disabled with the reason', async () => {
    const hub = createHub({
      managed: { 'appearance.theme': 'dark', 'appearance.accent': '#3366ff' },
    });
    await renderApp({ hub, path: '/settings/appearance' });
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Light' }).disabled).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Accent hex value' }).disabled,
    ).toBe(true);
    expect(screen.getAllByText('Managed by your organization').length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(root().style.getPropertyValue('--u-accent')).toBe('#3366ff'));
  });

  it('rolls back and reports a rejected change', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/appearance' });
    await waitFor(() => expect(root().dataset.theme).toBe(dark.id));
    hub.state.failNext.setSetting = new ApiError(500, {
      code: 'x',
      message: 'Disk full',
      retryable: true,
    });
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(await screen.findByText('Could not save: Disk full')).toBeTruthy();
    await waitFor(() => expect(root().dataset.theme).toBe(dark.id));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'System' }).checked).toBe(true);
    expect(
      screen.getByRole('radio', { name: 'System' }).getAttribute('aria-describedby'),
    ).toBeTruthy();
  });
});

describe('Settings → Keyboard (FR-004)', () => {
  it('rebinds by capturing keys, persists the map, and runs the command on the new keys', async () => {
    const { hub } = await renderApp({ path: '/settings/keyboard' });
    const row = () => screen.getByRole('row', { name: /Toggle sidebar/ });
    expect(within(row()).getByLabelText('Ctrl plus B')).toBeTruthy();
    await userEvent.click(
      within(row()).getByRole('button', { name: 'Change shortcut for Toggle sidebar' }),
    );
    const capture = within(row()).getByRole('button', { name: /Press the new shortcut/ });
    expect(document.activeElement).toBe(capture);
    await userEvent.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    await waitFor(() =>
      expect(hub.state.settings['keyboard.bindings']).toEqual({
        'view.toggleSidebar': 'mod+alt+s',
      }),
    );
    expect(within(row()).getByLabelText('Ctrl plus Alt plus S')).toBeTruthy();
    expect(within(row()).getByText('(changed)')).toBeTruthy();
    // The old binding no longer toggles; the new one does.
    await userEvent.keyboard('{Control>}b{/Control}');
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
    await userEvent.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
    await userEvent.click(
      within(row()).getByRole('button', { name: 'Reset shortcut for Toggle sidebar' }),
    );
    await waitFor(() => expect(hub.state.settings['keyboard.bindings']).toEqual({}));
  });

  it('detects conflicts, unbinds, resets all, and cancels capture with Escape', async () => {
    const { hub } = await renderApp({ path: '/settings/keyboard' });
    const row = (name: RegExp) =>
      screen.getAllByRole('row').find((r) => name.test(r.querySelector('th')?.textContent ?? ''))!;
    await userEvent.click(
      within(row(/Open settings$/)).getByRole('button', { name: /Change shortcut/ }),
    );
    await userEvent.keyboard('{Escape}');
    expect(
      within(row(/Open settings$/)).getByRole('button', { name: /Change shortcut/ }),
    ).toBeTruthy();
    expect(hub.api.setSetting).not.toHaveBeenCalled();

    await userEvent.click(
      within(row(/Open settings$/)).getByRole('button', { name: /Change shortcut/ }),
    );
    await userEvent.keyboard('{Control>}b{/Control}');
    const conflicts = await screen.findByRole('status', { name: 'Shortcut conflicts' });
    expect(conflicts.textContent).toMatch(/Ctrl\+B is bound to Open settings and Toggle sidebar/);
    expect(await screen.findByText(/Ctrl\+B is also used by Toggle sidebar/)).toBeTruthy();
    expect(within(row(/Toggle sidebar/)).getByText('Conflict')).toBeTruthy();

    await userEvent.click(
      within(row(/Toggle sidebar/)).getByRole('button', { name: /Remove shortcut/ }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Shortcut conflicts' })).toBeNull(),
    );
    expect(within(row(/Toggle sidebar/)).getByText('Not bound')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Reset all' }));
    const dialog = screen.getByRole('dialog', { name: 'Reset all shortcuts?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset all' }));
    await waitFor(() => expect(hub.state.settings['keyboard.bindings']).toEqual({}));
    expect(within(row(/Toggle sidebar/)).getByLabelText('Ctrl plus B')).toBeTruthy();
  });

  it('searches by name and by pressing keys', async () => {
    await renderApp({ path: '/settings/keyboard' });
    const search = screen.getByRole('searchbox', { name: 'Search shortcuts by name' });
    await userEvent.type(search, 'palette');
    expect(screen.getAllByRole('row')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Record keys' }));
    const keys = screen.getByRole('searchbox', { name: 'Press a shortcut to find it' });
    keys.focus();
    await userEvent.keyboard('{Control>}1{/Control}');
    expect(screen.getByRole('row', { name: /Switch to Chat/ })).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(window.location.pathname).toBe('/settings/keyboard');
    await userEvent.keyboard('{Control>}{Alt>}{Shift>}z{/Shift}{/Alt}{/Control}');
    expect(screen.getByText('No command uses Ctrl+Alt+Shift+Z.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop recording' }));
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search shortcuts by name' }));
    expect(screen.getAllByRole('row').length).toBeGreaterThan(10);
  });

  it('locks editing when bindings are managed', async () => {
    const hub = createHub({ managed: { 'keyboard.bindings': {} } });
    await renderApp({ hub, path: '/settings/keyboard' });
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Change shortcut for Toggle sidebar' })
        .disabled,
    ).toBe(true);
  });
});

describe('Settings → General and Accounts', () => {
  it('sets enter-to-send and the default model', async () => {
    const { hub } = await renderApp({ path: '/settings/general' });
    await userEvent.click(screen.getByRole('radio', { name: /Ctrl\+Enter/ }));
    await waitFor(() => expect(hub.state.settings['general.enterToSend']).toBe('mod+enter'));
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Default model for new chats' }),
      'pa1/mock-smart',
    );
    await waitFor(() => expect(hub.state.settings['chat.defaultModel']).toBe('pa1/mock-smart'));
    await userEvent.click(screen.getByRole('link', { name: 'Accounts' }));
    expect(window.location.pathname).toBe('/settings/accounts');
  });

  it('saves the display name and adds, tests and removes providers', async () => {
    const { hub } = await renderApp({ path: '/settings/accounts' });
    expect(await screen.findByText('No providers connected yet.')).toBeTruthy();
    const name = screen.getByRole('textbox', { name: 'Display name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Robin');
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(hub.api.updateAccount).toHaveBeenCalledWith({ displayName: 'Robin' }),
    );
    expect(await screen.findByRole('button', { name: 'Account: Robin' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Add a provider' }));
    await userEvent.click(screen.getByRole('radio', { name: 'OpenAI' }));
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save and test' });
    expect(save.disabled).toBe(true);
    const key = screen.getByLabelText('API key');
    expect(key.getAttribute('type')).toBe('password');
    await userEvent.type(key, 'sk-test');
    await userEvent.click(save);
    await waitFor(() =>
      expect(hub.api.createProvider).toHaveBeenCalledWith({
        provider: 'openai',
        label: 'OpenAI',
        apiKey: 'sk-test',
      }),
    );
    expect(await screen.findByText('OpenAI connected with 2 models.')).toBeTruthy();
    expect(screen.getByText(/key stored/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('sk-test');

    hub.state.testResult = { ok: false, detail: 'Invalid key' };
    await userEvent.click(screen.getByRole('button', { name: /Test/ }));
    expect(await screen.findByText('OpenAI could not connect: Invalid key')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    expect(await screen.findByText('OpenAI removed.')).toBeTruthy();
    expect(hub.state.providers).toEqual([]);
  });
});
