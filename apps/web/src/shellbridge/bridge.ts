// The desktop shell's bridge (FR-008, FR-009, FR-214; apps/desktop, `NovaShellBridge` in
// @nova/shared). Inside the Nova desktop app the Hub's web UI finds `window.novaShell`; in a
// browser tab it is absent and every helper here says so instead of failing. The bridge offers two
// things: a window of its own for an app route ("Open in new window") and the global shortcuts
// (Open quick chat, Attach the frontmost window) with what the OS let the shell have. Window
// capture is never reachable from the page (contracts/ipc-channels.md rule 6): it starts only from
// the shell's own shortcut, tray or overlay.
import { useState } from 'react';
import { defineMessages } from '@nova/i18n';
import {
  SHELL_SHORTCUT_ACTIONS,
  type NovaShellBridge,
  type ShellShortcutAction,
  type ShellShortcutView,
} from '@nova/shared';
import type { KeyLike } from '../keys.ts';

export type { ShellShortcutAction, ShellShortcutView };

/**
 * The parts of the bridge this module relies on: windows and global shortcuts. The local runtime
 * (FR-128) arrived later, so an older shell may lack it; callers check before using it.
 */
export type ShellBridge = Omit<NovaShellBridge, 'localRuntime'> &
  Partial<Pick<NovaShellBridge, 'localRuntime'>>;

/**
 * The bridge when this page runs inside the desktop app, else null. Only a bridge with the shape
 * this UI knows is used; a page in a browser tab (or a future, incompatible shell) gets null.
 */
export function getShell(
  win: unknown = typeof window === 'undefined' ? undefined : window,
): ShellBridge | null {
  const b = (win as { novaShell?: unknown } | undefined)?.novaShell;
  if (!b || typeof b !== 'object') return null;
  const s = b as Partial<Record<keyof ShellBridge, unknown>>;
  if (typeof s.version !== 'number' || s.version < 1) return null;
  if (
    typeof s.openWindow !== 'function' ||
    typeof s.shortcuts !== 'function' ||
    typeof s.setShortcut !== 'function'
  )
    return null;
  return b as ShellBridge;
}

/** The desktop app's bridge, read once per mount (the shell sets it before the page loads). */
export function useShell(): ShellBridge | null {
  const [shell] = useState(() => getShell());
  return shell;
}

/** Route heads a shell window may open (apps/desktop/src/routes.ts mirrors the web router). */
const WINDOW_ROUTES = new Set([
  'chat',
  'work',
  'code',
  'agents',
  'projects',
  'library',
  'spaces',
  'sites',
  'apps',
  'devices',
  'network',
  'computers',
  'approvals',
  'settings',
]);

/**
 * Whether `path` is an app route a window of its own can show: an absolute path on this origin
 * whose first segment is one of the app's routes. The shell checks again and may still refuse.
 */
export function isWindowPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  const head = path.slice(1).split(/[/?#]/, 1)[0] ?? '';
  return WINDOW_ROUTES.has(head);
}

/** The current app path (path and query), the target of "Open this view in a new window". */
export function currentPath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

// ---- global shortcuts (docs/04 §5) -----------------------------------------------------------

/** The defaults of docs/04 §5, in the shell's accelerator syntax. */
export const DEFAULT_GLOBAL_SHORTCUTS: Record<ShellShortcutAction, string> = {
  quickChat: 'Control+Alt+N',
  attachWindow: 'Control+Alt+A',
};

/** What each global shortcut does, keyed by its action (read at render). */
export const GLOBAL_SHORTCUT_TEXT = defineMessages('shellbridge.shortcuts', {
  quickChat: {
    title: 'Open quick chat or focus Nova',
    hint: 'Opens the quick overlay to ask Nova, start a task or see what needs you; pressed again, it brings Nova to the front.',
  },
  attachWindow: {
    title: 'Attach the frontmost window',
    hint: 'Captures the window in front (a screenshot and its text) for a chat. You see it, and can remove parts, before anything is sent.',
  },
}) satisfies Record<ShellShortcutAction, { title: string; hint: string }>;

/** Why a key cannot be a global shortcut. */
export const SHORTCUT_PROBLEM_TEXT = defineMessages('shellbridge.problems', {
  /** `{example}` is a key combination as printed, like "Ctrl+Alt+N". */
  needsModifier: 'Use one or more modifiers and one key, like {example}.',
  onlyShift: 'A global shortcut needs Ctrl, Alt, Super or Command, not only Shift.',
  conflict: 'Another app already uses this key, so it does nothing in Nova. Choose another key.',
  duplicate: 'Both global shortcuts use this key. Change one of them.',
  invalid: 'This is not a key combination the app can use.',
});

/** The order the shortcuts are listed in. */
export const GLOBAL_SHORTCUT_ACTIONS: readonly ShellShortcutAction[] = SHELL_SHORTCUT_ACTIONS;

const MAC_SYMBOL: Record<string, string> = {
  Command: '⌘',
  CommandOrControl: '⌘',
  Control: '⌃',
  Alt: '⌥',
  AltGr: '⌥',
  Shift: '⇧',
  Super: '⌘',
};
const PC_NAME: Record<string, string> = {
  Command: 'Super',
  CommandOrControl: 'Ctrl',
  Control: 'Ctrl',
  Alt: 'Alt',
  AltGr: 'AltGr',
  Shift: 'Shift',
  Super: 'Super',
};

/** The keys of an accelerator as they read on a platform: `⌃ ⌥ N` on macOS, `Ctrl Alt N` elsewhere. */
export function acceleratorKeys(accelerator: string, platform: string): string[] {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  const names = platform === 'darwin' ? MAC_SYMBOL : PC_NAME;
  return [...parts.map((m) => names[m] ?? m), key];
}

/** How an accelerator reads on a platform: `⌃⌥N` on macOS, `Ctrl+Alt+N` elsewhere. */
export function acceleratorLabel(accelerator: string, platform: string): string {
  return acceleratorKeys(accelerator, platform).join(platform === 'darwin' ? '' : '+');
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Enter: 'Return',
  NumpadEnter: 'Return',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  PrintScreen: 'PrintScreen',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const MODIFIER_KEY_NAMES = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'OS', 'Super']);

/** The key part of an accelerator for a key event, from its physical position when known. */
function acceleratorKey(e: KeyLike): string | null {
  const code = e.code ?? '';
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  // No usable code (some virtual keyboards): fall back to the character.
  if (/^[a-z0-9]$/i.test(e.key)) return e.key.toUpperCase();
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) return e.key;
  if (e.key === ' ') return 'Space';
  return null;
}

/**
 * The Electron accelerator (`Control+Alt+N`) for a key press, or null while only modifiers are
 * down or for a key a global shortcut cannot use. `Meta` is Command on macOS and Super elsewhere.
 */
export function eventToAccelerator(e: KeyLike, mac: boolean): string | null {
  if (MODIFIER_KEY_NAMES.has(e.key)) return null;
  const key = acceleratorKey(e);
  if (!key) return null;
  const mods: string[] = [];
  if (e.metaKey && mac) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey && !mac) mods.push('Super');
  return [...mods, key].join('+');
}

/**
 * Why the shell would refuse an accelerator (it checks again), or null. A global key needs a
 * modifier other than Shift, so Nova never takes a plain key from every other app.
 */
export function acceleratorProblem(accelerator: string): string | null {
  const parts = accelerator.split('+');
  const mods = parts.slice(0, -1);
  if (!parts.at(-1) || mods.length === 0)
    return SHORTCUT_PROBLEM_TEXT.needsModifier({ example: 'Ctrl+Alt+N' });
  if (!mods.some((m) => m !== 'Shift')) return SHORTCUT_PROBLEM_TEXT.onlyShift;
  return null;
}

/** What a shortcut's state means, in a sentence for its row. */
export function shortcutProblemText(v: ShellShortcutView): string | null {
  if (v.problem === 'conflict') return SHORTCUT_PROBLEM_TEXT.conflict;
  if (v.problem === 'duplicate') return SHORTCUT_PROBLEM_TEXT.duplicate;
  if (v.problem === 'invalid') return SHORTCUT_PROBLEM_TEXT.invalid;
  return null;
}

/**
 * The rejection message of a bridge call, in a sentence. The desktop app writes it in English
 * (like Hub error messages, D9); `fallback` is a message.
 */
export function shellErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message.trim() : '';
  if (!raw) return fallback;
  const text = raw.charAt(0).toUpperCase() + raw.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
