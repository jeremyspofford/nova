import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { socketUrl } from '../src/terminal/session.ts';
import { terminalKeyFilter } from '../src/terminal/TerminalPanel.tsx';
import { FakeScreen, FakeSocket, createHub, testRegistry } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const panel = () => screen.queryByRole('region', { name: 'Bottom panel' });
const announcer = () => screen.getByTestId('announcer').textContent ?? '';

async function openedSocket(id: string) {
  await waitFor(() => expect(FakeSocket.all.some((s) => s.url.includes(id))).toBe(true));
  const s = FakeSocket.for(id);
  s.open();
  return s;
}

describe('bottom panel and terminal (FR-006)', () => {
  it('Ctrl+J opens the panel with a terminal; Ctrl+` leaves it and comes back', async () => {
    const { hub } = await renderApp();
    expect(panel()).toBeNull();
    screen.getByLabelText('Message').focus();
    await userEvent.keyboard('{Control>}j{/Control}');
    expect(panel()).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Toggle bottom panel' }).getAttribute('aria-expanded'),
    ).toBe('true');
    // With none running, the panel starts one and focuses it.
    await waitFor(() =>
      expect(hub.api.createTerminal).toHaveBeenCalledWith({ cols: 100, rows: 30 }),
    );
    const tab = await within(panel()!).findByRole('tab', { name: 'Terminal 1' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    const socket = await openedSocket('/api/v1/terminals/term');
    expect(socket.sent).toContainEqual({ type: 'resize', cols: 80, rows: 24 });
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Terminal input'),
    );
    expect(announcer()).toMatch(/Terminal started/);

    // Keys typed go to the shell, its output is drawn.
    const term = FakeScreen.all[0]!;
    term.type('ls\r');
    expect(socket.sent).toContainEqual({ type: 'input', data: 'ls\r' });
    socket.frame({ type: 'output', data: 'notes.txt\r\n' });
    expect(term.written).toContain('notes.txt');
    // A changed size is sent once.
    term.cols = 120;
    socket.open();
    expect(socket.sent).toContainEqual({ type: 'resize', cols: 120, rows: 24 });

    // From the terminal, the toggle closes the panel and returns focus.
    await userEvent.keyboard('{Control>}`{/Control}');
    expect(panel()).toBeNull();
    await waitFor(() => expect(document.activeElement?.id).toBe('composer-input'));

    // Again: the same terminal, focused, and no second shell.
    await userEvent.keyboard('{Control>}`{/Control}');
    expect(panel()).toBeTruthy();
    await waitFor(() => expect(term.focused).toBeGreaterThan(1));
    expect(hub.api.createTerminal).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Control>}j{/Control}');
    expect(panel()).toBeNull();
  });

  it('lets the app keys through the terminal and keeps the shell’s own keys', () => {
    const filter = terminalKeyFilter(testRegistry());
    const key = (k: string, mods: Partial<KeyboardEventInit> = {}) =>
      new KeyboardEvent('keydown', { key: k, ...mods });
    // No commands are registered in a bare registry; everything goes to the shell.
    expect(filter(key('j', { ctrlKey: true }))).toBe(true);
  });

  it('passes the panel and terminal toggles and the palette Shift key to the app', async () => {
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle bottom panel' }));
    await openedSocket('/api/v1/terminals/term');
    const filter = FakeScreen.all[0]!.keyFilter!;
    const key = (k: string, code: string, mods: Partial<KeyboardEventInit> = {}) =>
      new KeyboardEvent('keydown', { key: k, code, ...mods });
    expect(filter(key('j', 'KeyJ', { ctrlKey: true }))).toBe(false);
    expect(filter(key('`', 'Backquote', { ctrlKey: true }))).toBe(false);
    expect(filter(key('P', 'KeyP', { ctrlKey: true, shiftKey: true }))).toBe(false);
    // Readline keys stay with the shell, including those the app binds elsewhere.
    expect(filter(key('c', 'KeyC', { ctrlKey: true }))).toBe(true);
    expect(filter(key('k', 'KeyK', { ctrlKey: true }))).toBe(true);
    expect(filter(key('b', 'KeyB', { ctrlKey: true }))).toBe(true);
    expect(filter(key('a', 'KeyA'))).toBe(true);
  });

  it('uses the Alt variants in a browser tab', async () => {
    const { hub } = await renderApp({ registry: testRegistry(false, true) });
    await userEvent.keyboard('{Alt>}j{/Alt}');
    expect(panel()).toBeTruthy();
    await waitFor(() => expect(hub.api.createTerminal).toHaveBeenCalled());
    await userEvent.keyboard('{Alt>}j{/Alt}');
    expect(panel()).toBeNull();
    await userEvent.keyboard('{Alt>}`{/Alt}');
    expect(panel()).toBeTruthy();
  });

  it('shows an exit, starts and closes terminals, and explains a missing sandbox', async () => {
    const { hub } = await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle bottom panel' }));
    const first = await openedSocket('/api/v1/terminals/term');
    first.frame({ type: 'exit', code: 0 });
    const p = panel()!;
    expect(await within(p).findByText('The shell exited with code 0.')).toBeTruthy();
    expect(within(p).getByRole('tab', { name: /Terminal 1 \(exited\)/ })).toBeTruthy();
    expect(first.closed).toBe(true);
    await waitFor(() => expect(announcer()).toMatch(/Terminal exited with code 0/));
    expect(FakeScreen.all[0]!.written).toContain('[Process exited with code 0]');

    await userEvent.click(within(p).getByRole('button', { name: 'New terminal' }));
    const second = await within(p).findByRole('tab', { name: 'Terminal 2' });
    await waitFor(() => expect(second.getAttribute('aria-selected')).toBe('true'));
    // Arrow keys move between terminal tabs.
    second.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(
      within(p)
        .getByRole('tab', { name: /Terminal 1/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    await userEvent.click(within(p).getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(within(p).getAllByRole('tab')).toHaveLength(1));
    expect(hub.api.closeTerminal).toHaveBeenCalledTimes(1);
    expect(FakeScreen.all[0]!.disposed).toBe(true);

    hub.state.failNext.createTerminal = new ApiError(409, {
      code: 'sandbox_unavailable',
      message: 'No sandbox',
      retryable: false,
    });
    await userEvent.click(within(p).getByRole('button', { name: 'New terminal' }));
    expect(await within(p).findByRole('note')).toHaveProperty(
      'textContent',
      expect.stringMatching(/this Hub has none/),
    );
    expect(
      within(p).getByRole<HTMLButtonElement>('button', { name: 'New terminal' }).disabled,
    ).toBe(true);
  });

  it('says when the Hub has no sandbox on the first open, and reports other failures', async () => {
    const hub = createHub();
    hub.state.failNext.createTerminal = new ApiError(409, {
      code: 'sandbox_unavailable',
      message: 'No sandbox',
      retryable: false,
    });
    await renderApp({ hub });
    await userEvent.keyboard('{Control>}`{/Control}');
    expect(await within(panel()!).findByText(/run inside the Hub’s sandbox/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('note'));
  });

  it('reports a failed start without opening anything', async () => {
    const hub = createHub();
    hub.state.failNext.createTerminal = new Error('boom');
    await renderApp({ hub });
    await userEvent.click(screen.getByRole('button', { name: 'Toggle bottom panel' }));
    expect(await screen.findByText('Could not start a terminal: boom')).toBeTruthy();
    expect(within(panel()!).getByText('No terminal is open.')).toBeTruthy();
    await userEvent.click(within(panel()!).getByRole('button', { name: 'Start a terminal' }));
    await waitFor(() => expect(hub.api.createTerminal).toHaveBeenCalledTimes(2));
  });

  it('reattaches a running terminal after a reload, ignores bad frames and reconnects', async () => {
    const hub = createHub();
    hub.state.m4.terminals = [
      {
        id: 'term-old',
        threadId: null,
        cwd: '/data/workspace',
        status: 'running',
        exitCode: null,
        createdAt: '2026-10-01T12:00:00.000Z',
      },
    ];
    await renderApp({ hub });
    await userEvent.click(screen.getByRole('button', { name: 'Toggle bottom panel' }));
    const socket = await openedSocket('term-old');
    expect(hub.api.createTerminal).not.toHaveBeenCalled();
    socket.raw('not json');
    socket.raw(42);
    socket.frame({ type: 'output' });
    expect(FakeScreen.all[0]!.written).toBe('');
    socket.drop();
    const p = panel()!;
    expect(await within(p).findByText(/Disconnected from the terminal/)).toBeTruthy();
    // Input while disconnected is not sent anywhere.
    FakeScreen.all[0]!.type('x');
    expect(socket.sent.some((f) => (f as { type: string }).type === 'input')).toBe(false);
    await userEvent.click(within(p).getByRole('button', { name: 'Reconnect' }));
    await waitFor(() =>
      expect(FakeSocket.all.filter((s) => s.url.includes('term-old'))).toHaveLength(2),
    );
    FakeSocket.for('term-old').open();
    await waitFor(() => expect(within(p).queryByText(/Disconnected/)).toBeNull());
  });

  it('shows a terminal in one place at a time and moves it on request', async () => {
    await renderApp();
    await userEvent.click(screen.getByRole('button', { name: 'Layout' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add terminal pane' }));
    const termPane = screen.getByRole('region', { name: 'Terminal pane' });
    await userEvent.click(within(termPane).getByRole('button', { name: 'Start a terminal' }));
    await openedSocket('/api/v1/terminals/term');
    const screenEl = within(termPane).getByRole('group', { name: 'Terminal 1' });
    expect(screenEl.querySelector('.terminal-host')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Toggle bottom panel' }));
    const p = panel()!;
    // The bottom panel showed it last; the pane offers to take it back.
    await waitFor(() =>
      expect(
        within(p).getByRole('group', { name: 'Terminal 1' }).querySelector('.terminal-host'),
      ).toBeTruthy(),
    );
    expect(within(termPane).getByText('Terminal 1 is shown in another place.')).toBeTruthy();
    await userEvent.click(within(termPane).getByRole('button', { name: 'Show it here' }));
    await waitFor(() =>
      expect(
        within(termPane).getByRole('group', { name: 'Terminal 1' }).querySelector('.terminal-host'),
      ).toBeTruthy(),
    );
    expect(within(p).getByText('Terminal 1 is shown in another place.')).toBeTruthy();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('starts a terminal from the palette and closes the panel from its button', async () => {
    const { hub, registry } = await renderApp();
    act(() => {
      registry.run('terminal.new');
    });
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(await within(panel()!).findByRole('tab', { name: 'Terminal 1' })).toBeTruthy();
    expect(hub.api.createTerminal).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Close the bottom panel' }));
    expect(panel()).toBeNull();
  });

  it('builds socket URLs for http and https', () => {
    expect(socketUrl('/api/v1/terminals/t1/ws', { protocol: 'http:', host: 'hub:7419' })).toBe(
      'ws://hub:7419/api/v1/terminals/t1/ws',
    );
    expect(socketUrl('/x', { protocol: 'https:', host: 'nova.example' })).toBe(
      'wss://nova.example/x',
    );
  });
});
