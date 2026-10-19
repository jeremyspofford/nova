// The desktop app's parts of the web UI (FR-008, FR-009, FR-214): "Open in new window" exists only
// in the app and reports a refusal; the palette command registers only there; Settings → Keyboard
// lists the global shortcuts (in a browser tab: where they work and their defaults), shows a key
// another app holds, remaps by pressing keys (checked first, the shell's refusal shown), removes
// and resets; a load failure offers Retry; and Settings → Notifications says the app shows OS
// notifications.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalShortcutsSection } from '../src/shellbridge/GlobalShortcuts.tsx';
import { ShellNotificationsNote } from '../src/shellbridge/NotificationsNote.tsx';
import { OpenInWindowButton, useShellCommands } from '../src/shellbridge/OpenInWindow.tsx';
import { fakeShell, installShell, renderPlain, uninstallShell } from './fakes-m7-misc.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  uninstallShell();
});

function Commands() {
  useShellCommands();
  return null;
}

const row = (name: string) => screen.getByRole('listitem', { name });

describe('Open in new window (FR-009)', () => {
  it('is not offered in a browser tab', () => {
    renderPlain(<OpenInWindowButton path="/chat/t1" what="Trip planning" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens the thread in a window of its own inside the app', async () => {
    const { shell, state } = fakeShell();
    installShell(shell);
    renderPlain(<OpenInWindowButton path="/chat/t1" what="Trip planning" />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Open Trip planning in a new window' }),
    );
    await waitFor(() => expect(state.opened).toEqual(['/chat/t1']));
  });

  it('says so when the app refuses, and hides itself for paths that are not app routes', async () => {
    const { shell } = fakeShell();
    installShell(shell);
    shell.openWindow.mockResolvedValueOnce(false);
    const first = renderPlain(<OpenInWindowButton path="/work/r1" compact />);
    const button = screen.getByRole('button', { name: 'Open in new window' });
    expect(button.getAttribute('title')).toBe('Open in new window');
    await userEvent.click(button);
    expect(await screen.findByText('This view cannot open in a window of its own.')).toBeTruthy();
    first.unmount();
    renderPlain(<OpenInWindowButton path="/add-device" />);
    expect(screen.queryByRole('button', { name: 'Open in new window' })).toBeNull();
  });

  it('registers the palette command only inside the app', () => {
    const plain = renderPlain(<Commands />);
    expect(plain.registry.get('window.openCurrent')).toBeUndefined();
    plain.unmount();
    const { shell } = fakeShell();
    installShell(shell);
    const app = renderPlain(<Commands />);
    expect(app.registry.get('window.openCurrent')?.title).toBe('Open this view in a new window');
    app.unmount();
    expect(app.registry.get('window.openCurrent')).toBeUndefined();
  });
});

describe('Settings → Keyboard: global shortcuts (FR-008, FR-214)', () => {
  it('in a browser tab, says only the desktop app can offer them and lists the defaults', () => {
    renderPlain(<GlobalShortcutsSection />);
    expect(screen.getByText(/only the Nova desktop app can offer them/)).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Global shortcuts in the desktop app' });
    expect(within(list).getByRole('img', { name: 'Ctrl plus Alt plus N' })).toBeTruthy();
    expect(within(list).getByRole('img', { name: 'Ctrl plus Alt plus A' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows each shortcut, and a key another app holds as a problem', async () => {
    const { shell } = fakeShell({ taken: ['Control+Alt+A'] });
    installShell(shell);
    renderPlain(<GlobalShortcutsSection />);
    const quick = await screen.findByRole('listitem', { name: 'Open quick chat or focus Nova' });
    expect(within(quick).getByText('Works')).toBeTruthy();
    const attach = row('Attach the frontmost window');
    expect(within(attach).getByText('Taken by another app')).toBeTruthy();
    const problems = screen.getByRole('status', { name: 'Global shortcut problems' });
    expect(problems.textContent).toContain('Attach the frontmost window (Ctrl+Alt+A)');
    expect(problems.textContent).toContain('Another app already uses this key');
    // Not registered, so it takes nothing from Nova's own keys.
    expect(within(attach).queryByText(/wins over Nova’s own/)).toBeNull();
  });

  it('says the default attach key wins over Nova’s own “next item that needs input”', async () => {
    const { shell } = fakeShell();
    installShell(shell);
    renderPlain(<GlobalShortcutsSection />);
    const attach = await screen.findByRole('listitem', { name: 'Attach the frontmost window' });
    expect(within(attach).getByText(/wins over Nova’s own/)).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Global shortcut problems' })).toBeNull();
  });

  it('remaps by pressing keys, and Escape cancels', async () => {
    const { shell, state } = fakeShell({ taken: ['Control+Alt+A'] });
    installShell(shell);
    renderPlain(<GlobalShortcutsSection />);
    const attach = await screen.findByRole('listitem', { name: 'Attach the frontmost window' });
    await userEvent.click(
      within(attach).getByRole('button', {
        name: 'Change the shortcut for Attach the frontmost window',
      }),
    );
    await userEvent.keyboard('{Escape}');
    expect(shell.setShortcut).not.toHaveBeenCalled();
    await userEvent.click(
      within(attach).getByRole('button', {
        name: 'Change the shortcut for Attach the frontmost window',
      }),
    );
    expect(document.activeElement?.textContent).toContain('Press keys');
    await userEvent.keyboard('{Control>}{Alt>}{Shift>}a{/Shift}{/Alt}{/Control}');
    await waitFor(() =>
      expect(shell.setShortcut).toHaveBeenCalledWith('attachWindow', 'Control+Alt+Shift+A'),
    );
    expect(state.config.attachWindow).toBe('Control+Alt+Shift+A');
    expect(await within(attach).findByText('Works')).toBeTruthy();
    expect(
      within(attach).getByRole('img', { name: 'Ctrl plus Alt plus Shift plus A' }),
    ).toBeTruthy();
    // Reset goes back to the default (which another app holds here).
    await userEvent.click(
      within(attach).getByRole('button', {
        name: /Reset the shortcut for Attach the frontmost window/,
      }),
    );
    await waitFor(() =>
      expect(shell.setShortcut).toHaveBeenLastCalledWith('attachWindow', 'Control+Alt+A'),
    );
    expect(await within(attach).findByText('Taken by another app')).toBeTruthy();
  });

  it('refuses a key without a real modifier before asking, and shows the shell’s refusal', async () => {
    const { shell } = fakeShell();
    installShell(shell);
    renderPlain(<GlobalShortcutsSection />);
    const quick = await screen.findByRole('listitem', { name: 'Open quick chat or focus Nova' });
    const change = () =>
      userEvent.click(
        within(quick).getByRole('button', {
          name: 'Change the shortcut for Open quick chat or focus Nova',
        }),
      );
    await change();
    await userEvent.keyboard('{Shift>}q{/Shift}');
    expect((await within(quick).findByRole('alert')).textContent).toMatch(/not only Shift/);
    expect(shell.setShortcut).not.toHaveBeenCalled();
    shell.setShortcut.mockRejectedValueOnce(new Error('that key cannot be registered'));
    await change();
    await userEvent.keyboard('{Control>}{Alt>}q{/Alt}{/Control}');
    expect(await within(quick).findByText('That key cannot be registered.')).toBeTruthy();
  });

  it('removes a shortcut and reports a duplicate', async () => {
    const { shell } = fakeShell({ config: { attachWindow: 'Control+Alt+N' } });
    installShell(shell);
    renderPlain(<GlobalShortcutsSection />);
    const attach = await screen.findByRole('listitem', { name: 'Attach the frontmost window' });
    expect(within(attach).getByText('Used twice')).toBeTruthy();
    await userEvent.click(
      within(attach).getByRole('button', {
        name: 'Remove the shortcut for Attach the frontmost window',
      }),
    );
    await waitFor(() => expect(shell.setShortcut).toHaveBeenCalledWith('attachWindow', null));
    expect(await within(attach).findByText('No shortcut')).toBeTruthy();
    expect(within(attach).getByText('Off')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Global shortcut problems' })).toBeNull();
  });

  it('shows a failure to list them, with Retry', async () => {
    const { shell, state } = fakeShell({ failNext: { shortcuts: 'the shell is busy' } });
    installShell(shell);
    renderPlain(<GlobalShortcutsSection />);
    expect((await screen.findByRole('alert')).textContent).toContain('The shell is busy.');
    expect(state.failNext.shortcuts).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Global shortcuts' })).toBeTruthy();
  });

  it('labels keys the macOS way in the app on a Mac', async () => {
    const { shell } = fakeShell({ platform: 'darwin' });
    installShell(shell);
    renderPlain(<GlobalShortcutsSection />, { mac: true });
    const quick = await screen.findByRole('listitem', { name: 'Open quick chat or focus Nova' });
    expect(within(quick).getByRole('img', { name: '⌃ plus ⌥ plus N' })).toBeTruthy();
    // No in-app clash on macOS.
    expect(screen.queryByText(/wins over Nova’s own/)).toBeNull();
  });
});

describe('Settings → Notifications in the app', () => {
  it('says the desktop app shows notifications from the operating system', () => {
    renderPlain(<ShellNotificationsNote />);
    const section = screen.getByRole('region', { name: 'This device' });
    expect(section.textContent).toContain('shows notifications from your operating system');
    expect(section.textContent).toContain('quiet hours');
  });
});
