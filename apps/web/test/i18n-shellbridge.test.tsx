// The desktop shell's parts of the web UI in the pseudo-locale (FR-016, FR-008, FR-009, FR-214):
// Settings → Keyboard's global shortcuts (in a browser tab, in the app with a problem, while
// pressing new keys, after a load failure), Settings → Notifications' note and Open in new window
// show every word through messages. Key combinations as the shell prints them and the shell's
// own error text are data.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { CATEGORY } from '../src/commands.ts';
import {
  GLOBAL_SHORTCUTS_TEXT,
  GlobalShortcutsSection,
} from '../src/shellbridge/GlobalShortcuts.tsx';
import { GLOBAL_SHORTCUT_TEXT } from '../src/shellbridge/bridge.ts';
import { ShellNotificationsNote } from '../src/shellbridge/NotificationsNote.tsx';
import {
  OPEN_WINDOW_TEXT,
  OpenInWindowButton,
  useShellCommands,
} from '../src/shellbridge/OpenInWindow.tsx';
import { fakeShell, installShell, renderPlain, uninstallShell } from './fakes-m7-misc.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  uninstallShell();
  resetTestLocale();
});

/** Key combinations as the shell labels them. */
const KEYS = ['Ctrl+Alt+A', 'Ctrl+Alt+N'];

function Commands() {
  useShellCommands();
  return null;
}

describe('the desktop shell parts in a pseudo-locale', () => {
  it('lists the global shortcuts in a browser tab', async () => {
    await activateTestLocale('en-XA');
    const { container } = renderPlain(<GlobalShortcutsSection />);
    expect(screen.getByRole('list', { name: GLOBAL_SHORTCUTS_TEXT.browserList })).toBeTruthy();
    expectFullyLocalized(container);
  });

  it('shows the shortcuts in the app, a problem, the in-app clash and key capture', async () => {
    await activateTestLocale('en-XA');
    const { shell } = fakeShell({ taken: ['Control+Alt+A'] });
    installShell(shell);
    const { container } = renderPlain(<GlobalShortcutsSection />);
    await screen.findByRole('status', { name: GLOBAL_SHORTCUTS_TEXT.problems });
    expectFullyLocalized(container, { data: KEYS });

    const quick = screen.getByRole('listitem', { name: GLOBAL_SHORTCUT_TEXT.quickChat.title });
    await userEvent.click(
      within(quick).getByRole('button', {
        name: GLOBAL_SHORTCUTS_TEXT.changeFor({ title: GLOBAL_SHORTCUT_TEXT.quickChat.title }),
      }),
    );
    expect(document.activeElement?.textContent).toBe(GLOBAL_SHORTCUTS_TEXT.capturing);
    expectFullyLocalized(container, { data: KEYS });
    // A key without a real modifier is refused before asking the shell.
    await userEvent.keyboard('{Shift>}q{/Shift}');
    await within(quick).findByRole('alert');
    expectFullyLocalized(container, { data: KEYS });

    uninstallShell();
    resetDom();
    const { shell: clashing } = fakeShell();
    installShell(clashing);
    const app = renderPlain(<GlobalShortcutsSection />);
    const attach = await screen.findByRole('listitem', {
      name: GLOBAL_SHORTCUT_TEXT.attachWindow.title,
    });
    expect(attach.querySelector('.shb-note')).toBeTruthy();
    expectFullyLocalized(app.container, { data: KEYS });
  });

  it('says when the app could not list them, with Retry', async () => {
    await activateTestLocale('en-XA');
    installShell(fakeShell({ failNext: { shortcuts: 'the shell is busy' } }).shell);
    const { container } = renderPlain(<GlobalShortcutsSection />);
    await screen.findByRole('alert');
    expectFullyLocalized(container, { data: ['The shell is busy.'] });
  });

  it('shows the notifications note and Open in new window, and names the command', async () => {
    await activateTestLocale('en-XA');
    const note = renderPlain(<ShellNotificationsNote />);
    expectFullyLocalized(note.container);
    note.unmount();

    const { shell } = fakeShell();
    shell.openWindow.mockResolvedValueOnce(false);
    installShell(shell);
    const button = renderPlain(<OpenInWindowButton path="/work/r1" />);
    const open = screen.getByRole('button', { name: OPEN_WINDOW_TEXT.open });
    expectFullyLocalized(button.container);
    await userEvent.click(open);
    expect(await screen.findByText(OPEN_WINDOW_TEXT.refused)).toBeTruthy();
    button.unmount();

    renderPlain(<OpenInWindowButton path="/chat/t1" what="Trip planning" compact />);
    expect(
      screen.getByRole('button', { name: OPEN_WINDOW_TEXT.openWhat({ what: 'Trip planning' }) }),
    ).toBeTruthy();

    const commands = renderPlain(<Commands />);
    await waitFor(() =>
      expect(commands.registry.get('window.openCurrent')).toMatchObject({
        title: OPEN_WINDOW_TEXT.command,
        category: CATEGORY.view,
      }),
    );
  });
});
