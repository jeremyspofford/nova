// The desktop shell's bridge helpers (FR-008, FR-009, FR-214): finding `window.novaShell` only when
// it has the shape this UI knows, which paths a window may open, the global-shortcut accelerator a
// key press makes (letters by position, Command on macOS and Super elsewhere), the shell's
// "needs a modifier other than Shift" rule, labels per platform, and opening a window (refused,
// opened, failed).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceleratorKeys,
  acceleratorLabel,
  acceleratorProblem,
  eventToAccelerator,
  getShell,
  isWindowPath,
  shellErrorMessage,
  shortcutProblemText,
} from '../src/shellbridge/bridge.ts';
import { openInWindow, openWindowCommand } from '../src/shellbridge/OpenInWindow.tsx';
import { fakeShell, installShell, uninstallShell } from './fakes-m7-misc.ts';

afterEach(() => uninstallShell());

const key = (
  k: string,
  code: string,
  mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>> = {},
) => ({
  key: k,
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe('getShell', () => {
  it('is null in a browser tab and for bridges of another shape', () => {
    expect(getShell()).toBeNull();
    expect(getShell(undefined)).toBeNull();
    expect(getShell({ novaShell: 'yes' })).toBeNull();
    expect(
      getShell({ novaShell: { version: 0, openWindow() {}, shortcuts() {}, setShortcut() {} } }),
    ).toBeNull();
    expect(getShell({ novaShell: { version: 1, openWindow() {} } })).toBeNull();
  });

  it('finds the desktop app’s bridge on the window', () => {
    const { shell } = fakeShell();
    installShell(shell);
    expect(getShell()).toBe(shell);
  });
});

describe('isWindowPath', () => {
  it('accepts app routes on this origin only', () => {
    expect(isWindowPath('/chat/t1')).toBe(true);
    expect(isWindowPath('/work/r1?x=1')).toBe(true);
    expect(isWindowPath('/settings/keyboard')).toBe(true);
    expect(isWindowPath('/add-device')).toBe(false);
    expect(isWindowPath('//evil.example.com/chat')).toBe(false);
    expect(isWindowPath('/\\evil.example.com')).toBe(false);
    expect(isWindowPath('https://example.com/chat')).toBe(false);
    expect(isWindowPath('chat/t1')).toBe(false);
  });
});

describe('accelerators', () => {
  it('builds the accelerator from the key’s position, after the modifiers', () => {
    expect(eventToAccelerator(key('n', 'KeyN', { ctrl: true, alt: true }), false)).toBe(
      'Control+Alt+N',
    );
    // Shift changes the character, not the position.
    expect(eventToAccelerator(key('!', 'Digit1', { ctrl: true, shift: true }), false)).toBe(
      'Control+Shift+1',
    );
    expect(eventToAccelerator(key('F5', 'F5', { alt: true }), false)).toBe('Alt+F5');
    expect(eventToAccelerator(key('ArrowUp', 'ArrowUp', { ctrl: true }), false)).toBe('Control+Up');
    expect(eventToAccelerator(key(' ', 'Space', { ctrl: true }), false)).toBe('Control+Space');
    expect(eventToAccelerator(key('å', 'KeyA', { alt: true, meta: true }), true)).toBe(
      'Command+Alt+A',
    );
    expect(eventToAccelerator(key('a', 'KeyA', { meta: true }), false)).toBe('Super+A');
    // Without a usable code, the character.
    expect(eventToAccelerator(key('k', '', { ctrl: true }), false)).toBe('Control+K');
  });

  it('waits while only modifiers are down and refuses keys it cannot use', () => {
    expect(eventToAccelerator(key('Control', 'ControlLeft', { ctrl: true }), false)).toBeNull();
    expect(eventToAccelerator(key('Shift', 'ShiftLeft', { shift: true }), false)).toBeNull();
    expect(eventToAccelerator(key('Dead', 'IntlBackslash', { ctrl: true }), false)).toBeNull();
  });

  it('needs a modifier other than Shift', () => {
    expect(acceleratorProblem('Control+Alt+N')).toBeNull();
    expect(acceleratorProblem('Shift+N')).toMatch(/not only Shift/);
    expect(acceleratorProblem('N')).toMatch(/one or more modifiers/);
  });

  it('reads as the platform shows keys', () => {
    expect(acceleratorLabel('Control+Alt+N', 'linux')).toBe('Ctrl+Alt+N');
    expect(acceleratorLabel('Control+Alt+N', 'darwin')).toBe('⌃⌥N');
    expect(acceleratorKeys('Command+Shift+K', 'darwin')).toEqual(['⌘', '⇧', 'K']);
    expect(acceleratorKeys('Super+K', 'win32')).toEqual(['Super', 'K']);
  });

  it('says what each problem means', () => {
    const v = {
      action: 'quickChat' as const,
      accelerator: 'Control+Alt+N',
      label: 'Ctrl+Alt+N',
      registered: false,
    };
    expect(shortcutProblemText({ ...v, problem: 'conflict' })).toMatch(/Another app/);
    expect(shortcutProblemText({ ...v, problem: 'duplicate' })).toMatch(/Both/);
    expect(shortcutProblemText({ ...v, problem: 'invalid' })).toMatch(/not a key combination/);
    expect(shortcutProblemText({ ...v, registered: true, problem: null })).toBeNull();
  });

  it('turns a rejection into a sentence', () => {
    expect(shellErrorMessage(new Error('that key is taken'), 'x')).toBe('That key is taken.');
    expect(shellErrorMessage('nope', 'Fallback.')).toBe('Fallback.');
  });
});

describe('opening a window (FR-009)', () => {
  it('opens app routes and says when the shell refuses or fails', async () => {
    const { shell, state } = fakeShell();
    expect(await openInWindow(shell, '/chat/t1')).toBeNull();
    expect(state.opened).toEqual(['/chat/t1']);
    expect(await openInWindow(shell, '/add-device')).toMatch(/cannot open/);
    expect(shell.openWindow).toHaveBeenCalledTimes(1);
    // The shell refuses a path the page thought was fine.
    shell.openWindow.mockResolvedValueOnce(false);
    expect(await openInWindow(shell, '/work/r1')).toMatch(/cannot open/);
    state.failNext.openWindow = 'the window could not be created';
    expect(await openInWindow(shell, '/work/r1')).toBe('The window could not be created.');
  });

  it('the palette command opens the current view and reports a refusal', async () => {
    const { shell } = fakeShell();
    const report = vi.fn();
    const cmd = openWindowCommand(shell, { path: () => '/code/s1', report });
    expect(cmd.id).toBe('window.openCurrent');
    cmd.run();
    await vi.waitFor(() => expect(shell.openWindow).toHaveBeenCalledWith('/code/s1'));
    const bad = openWindowCommand(shell, { path: () => '/join?token=x', report });
    bad.run();
    await vi.waitFor(() =>
      expect(report).toHaveBeenCalledWith(expect.stringMatching(/cannot open/)),
    );
  });
});
