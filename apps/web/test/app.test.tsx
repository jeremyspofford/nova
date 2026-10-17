import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/App.tsx';
import { ApiError, type Api } from '../src/api.ts';
import { CommandRegistry, filterCommands, fuzzyScore, matchesBinding } from '../src/commands.ts';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('style');
});

const hello = { name: 'nova-hub', version: '0.0.0-dev', apiVersions: ['v1'], setupRequired: false };

function fakeApi(over: Partial<Api> = {}): Api {
  return {
    hello: vi.fn().mockResolvedValue(hello),
    session: vi.fn().mockResolvedValue({ accountId: 'a1', displayName: 'Sam' }),
    setup: vi.fn().mockResolvedValue({ accountId: 'a1' }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    settings: vi.fn().mockResolvedValue({
      settings: [{ key: 'appearance.theme', value: 'dark', source: 'global', locked: false }],
    }),
    setSetting: vi.fn().mockResolvedValue({ settings: [] }),
    ...over,
  };
}

const unauthorized = new ApiError(401, {
  code: 'token_required',
  message: 'sign in',
  retryable: false,
});

describe('App shell', () => {
  it('greets a signed-in owner and applies the stored theme', async () => {
    render(<App api={fakeApi()} takeSetupCode={() => null} />);
    expect(await screen.findByRole('heading', { name: 'Welcome, Sam' })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('nova.dark'));
  });

  it('cycles the theme and saves it to the Hub', async () => {
    const api = fakeApi();
    render(<App api={api} takeSetupCode={() => null} />);
    const btn = await screen.findByRole('button', { name: /Theme: Dark/ });
    await userEvent.click(btn);
    expect(api.setSetting).toHaveBeenCalledWith('appearance.theme', 'system');
    expect(screen.getByRole('button', { name: /Theme: System/ })).toBeTruthy();
  });

  it('opens the command palette with the keyboard and shows the empty state', async () => {
    render(<App api={fakeApi()} takeSetupCode={() => null} />);
    await screen.findByRole('heading', { name: 'Welcome, Sam' });
    await userEvent.keyboard('{Control>}k{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(dialog.textContent).toContain('No commands yet');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('runs a registered command from the palette', async () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    registry.register({
      id: 'demo.hello',
      title: 'Say hello',
      category: 'Demo',
      binding: 'mod+shift+h',
      run,
    });
    render(<App api={fakeApi()} registry={registry} takeSetupCode={() => null} />);
    await screen.findByRole('heading', { name: 'Welcome, Sam' });
    await userEvent.click(screen.getByRole('button', { name: 'Commands' }));
    await userEvent.keyboard('hello');
    expect(screen.getByRole('option', { name: /Say hello/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await userEvent.keyboard('{Enter}');
    expect(run).toHaveBeenCalledOnce();
  });

  it('finishes setup from a setup link', async () => {
    let signedIn = false;
    const api = fakeApi({
      session: vi
        .fn()
        .mockImplementation(() =>
          signedIn
            ? Promise.resolve({ accountId: 'a1', displayName: 'Pat' })
            : Promise.reject(unauthorized),
        ),
      setup: vi.fn().mockImplementation(() => {
        signedIn = true;
        return Promise.resolve({ accountId: 'a1' });
      }),
    });
    render(<App api={api} takeSetupCode={() => 'nvs_abcdefghijklmnop'} />);
    await screen.findByText(/Setup link detected/);
    await userEvent.type(screen.getByLabelText('Your name (optional)'), 'Pat');
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(api.setup).toHaveBeenCalledWith('nvs_abcdefghijklmnop', 'Pat');
    expect(await screen.findByRole('heading', { name: 'Welcome, Pat' })).toBeTruthy();
  });

  it('asks for a code when there is no link, and reports a bad code', async () => {
    const api = fakeApi({
      session: vi.fn().mockRejectedValue(unauthorized),
      setup: vi.fn().mockRejectedValue(unauthorized),
    });
    render(<App api={api} takeSetupCode={() => null} />);
    const field = await screen.findByLabelText('Setup code');
    const submit = screen.getByRole('button', { name: 'Finish setup' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(field, 'nvs_wrongwrongwrong');
    await userEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'That setup code is invalid or has expired.',
    );
  });

  it('shows an actionable error when the Hub is unreachable', async () => {
    const api = fakeApi({
      hello: vi.fn().mockRejectedValueOnce(new Error('Failed to fetch')).mockResolvedValue(hello),
    });
    render(<App api={api} takeSetupCode={() => null} />);
    expect(await screen.findByRole('heading', { name: 'Cannot reach the Hub' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Welcome, Sam' })).toBeTruthy();
  });
});

describe('command helpers', () => {
  it('scores fuzzy matches and rejects non-matches', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('tt', 'Toggle theme')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Toggle theme')).toBeNull();
    expect(fuzzyScore('theme', 'Toggle theme')! > fuzzyScore('tme', 'Toggle theme')!).toBe(true);
  });

  it('filters and sorts commands', () => {
    const noop = () => undefined;
    const cmds = [
      { id: 'a', title: 'Open settings', category: 'App', run: noop },
      { id: 'b', title: 'Toggle theme', category: 'View', run: noop },
    ];
    expect(filterCommands(cmds, 'theme').map((c) => c.id)).toEqual(['b']);
    expect(filterCommands(cmds, '').map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('registers, lists, runs and unregisters commands', () => {
    const r = new CommandRegistry();
    const run = vi.fn();
    const off = r.register({ id: 'x', title: 'X', category: 'C', run });
    expect(() => r.register({ id: 'x', title: 'X', category: 'C', run })).toThrow(
      /already registered/,
    );
    expect(r.run('x')).toBe(true);
    expect(r.run('missing')).toBe(false);
    off();
    expect(r.list()).toEqual([]);
  });

  it('matches key bindings per platform', () => {
    const ev = (key: string, mods: Partial<KeyboardEvent> = {}) => ({
      key,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...mods,
    });
    expect(matchesBinding(ev('k', { ctrlKey: true }), 'mod+k', false)).toBe(true);
    expect(matchesBinding(ev('k', { metaKey: true }), 'mod+k', true)).toBe(true);
    expect(matchesBinding(ev('k', { metaKey: true }), 'mod+k', false)).toBe(false);
    expect(matchesBinding(ev('P', { ctrlKey: true, shiftKey: true }), 'mod+shift+p', false)).toBe(
      true,
    );
    expect(matchesBinding(ev('k'), 'k', false)).toBe(true);
    expect(matchesBinding(ev('k', { ctrlKey: true }), 'k', false)).toBe(false);
  });
});
