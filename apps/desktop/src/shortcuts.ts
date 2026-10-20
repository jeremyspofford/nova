// Global shortcuts of the desktop shell (FR-008, FR-214, docs/04 §5): open the quick overlay or
// focus Nova (Ctrl+Alt+N, ⌃⌥N) and attach the frontmost window (Ctrl+Alt+A, ⌃⌥A). Both are
// remappable or can be unbound. A key another app holds is reported, never forced: the shell
// registers what the OS grants and says which keys it could not have.
import type { ShellShortcutAction, ShellShortcutView } from '@nova/shared';
import { SHELL_SHORTCUT_ACTIONS } from '@nova/shared';
import { SHORTCUT_TEXT } from './text.ts';

export const DEFAULT_SHORTCUTS: Record<ShellShortcutAction, string> = {
  quickChat: 'Control+Alt+N',
  attachWindow: 'Control+Alt+A',
};

const MODIFIERS: Record<string, string> = {
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
};

const NAMED_KEYS = [
  'Space',
  'Tab',
  'Backspace',
  'Delete',
  'Insert',
  'Return',
  'Enter',
  'Up',
  'Down',
  'Left',
  'Right',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Escape',
  'Esc',
  'Plus',
  'PrintScreen',
];
const KEY_BY_LOWER = new Map(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));

function normalizeKey(raw: string): string | null {
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  if (/^[`\-=[\];',./]$/.test(raw)) return raw;
  return KEY_BY_LOWER.get(raw.toLowerCase()) ?? null;
}

export type AcceleratorCheck = { ok: true; accelerator: string } | { ok: false; reason: string };

/**
 * An Electron accelerator in canonical form. A global key needs a modifier other than Shift, so
 * the shell never takes a plain key (or Shift plus a letter) from every other app.
 */
export function parseAccelerator(raw: string): AcceleratorCheck {
  let text = raw.trim();
  // `Control+Alt++` names the plus key.
  const plusKey = text.endsWith('++');
  if (plusKey) text = text.slice(0, -2);
  const parts = text.split('+').map((p) => p.trim());
  if (plusKey) parts.push('Plus');
  if (parts.length < 2 || parts.length > 5 || parts.some((p) => p === ''))
    return { ok: false, reason: SHORTCUT_TEXT.format({ example: 'Control+Alt+N' }) };
  const keyRaw = parts.at(-1) ?? '';
  const key = normalizeKey(keyRaw);
  if (!key)
    return {
      ok: false,
      reason: keyRaw ? SHORTCUT_TEXT.notAKey({ key: keyRaw }) : SHORTCUT_TEXT.notAKeyEmpty,
    };
  const mods: string[] = [];
  for (const m of parts.slice(0, -1)) {
    const mod = MODIFIERS[m.toLowerCase()];
    if (!mod) return { ok: false, reason: SHORTCUT_TEXT.notAModifier({ key: m }) };
    if (!mods.includes(mod)) mods.push(mod);
  }
  // Two modifiers besides Shift: a global key is taken from every other app, so the everyday
  // keys (Ctrl+C, Ctrl+V, Alt+Tab, Alt+F4, Super+L…) are never available to it.
  if (mods.filter((m) => m !== 'Shift').length < 2)
    return { ok: false, reason: SHORTCUT_TEXT.twoModifiers({ example: 'Control+Alt+N' }) };
  const order = ['CommandOrControl', 'Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const accelerator = [...mods, key].join('+');
  if (reservedBySystem(accelerator))
    return { ok: false, reason: SHORTCUT_TEXT.reserved({ key: accelerator }) };
  return { ok: true, accelerator };
}

// Two-modifier keys the desktop itself uses: log out, lock, terminal, workspaces, consoles, force
// quit, full screen, the character viewer.
const RESERVED = new Set([
  'Control+Alt+Delete',
  'Control+Alt+Backspace',
  'Control+Alt+Escape',
  'Control+Alt+Tab',
  'Control+Alt+T',
  'Control+Alt+L',
  'Control+Alt+D',
  'Control+Alt+Up',
  'Control+Alt+Down',
  'Control+Alt+Left',
  'Control+Alt+Right',
  ...Array.from({ length: 12 }, (_, i) => `Control+Alt+F${i + 1}`),
  'Command+Alt+Escape',
  'Command+Control+Q',
  'Command+Control+F',
  'Command+Control+Space',
  'Command+Alt+D',
]);

/** Whether a key is the system's, with CommandOrControl read both ways. */
export function reservedBySystem(accelerator: string): boolean {
  const variants = accelerator.includes('CommandOrControl')
    ? [
        accelerator.replace('CommandOrControl', 'Command'),
        accelerator.replace('CommandOrControl', 'Control'),
      ]
    : [accelerator];
  const order = ['Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];
  return variants.some((v) => {
    const parts = v.split('+');
    const key = parts.pop() ?? '';
    const mods = [...new Set(parts)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return RESERVED.has([...mods, key].join('+'));
  });
}

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

/** How a key reads on a platform: `⌃⌥N` on macOS, `Ctrl+Alt+N` elsewhere. */
export function acceleratorLabel(accelerator: string, platform: string): string {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  if (platform === 'darwin') return `${parts.map((m) => MAC_SYMBOL[m] ?? m).join('')}${key}`;
  return [...parts.map((m) => PC_NAME[m] ?? m), key].join('+');
}

export interface ShortcutRegistry {
  /** Electron's `globalShortcut.register`: false when another app holds the key. */
  register(accelerator: string, run: () => void): boolean;
  unregisterAll(): void;
}

/** The configured accelerators: `undefined` keeps the default, null unbinds. */
export type ShortcutConfig = Partial<Record<ShellShortcutAction, string | null>>;

/** Register every shortcut and report each one's outcome (docs/04 §5 "conflicts ... reported"). */
export function registerShortcuts(
  config: ShortcutConfig,
  registry: ShortcutRegistry,
  handlers: Record<ShellShortcutAction, () => void>,
  platform: string,
): ShellShortcutView[] {
  registry.unregisterAll();
  const taken = new Map<string, ShellShortcutAction>();
  return SHELL_SHORTCUT_ACTIONS.map((action): ShellShortcutView => {
    const configured = config[action];
    const raw = configured === undefined ? DEFAULT_SHORTCUTS[action] : configured;
    if (raw === null)
      return { action, accelerator: null, label: null, registered: false, problem: null };
    const parsed = parseAccelerator(raw);
    if (!parsed.ok)
      return { action, accelerator: raw, label: raw, registered: false, problem: 'invalid' };
    const accelerator = parsed.accelerator;
    const label = acceleratorLabel(accelerator, platform);
    if (taken.has(accelerator))
      return { action, accelerator, label, registered: false, problem: 'duplicate' };
    let ok: boolean;
    try {
      ok = registry.register(accelerator, handlers[action]);
    } catch {
      ok = false;
    }
    if (!ok) return { action, accelerator, label, registered: false, problem: 'conflict' };
    taken.set(accelerator, action);
    return { action, accelerator, label, registered: true, problem: null };
  });
}

/** One sentence per shortcut that did not register, for the tray and Settings → Keyboard. */
export function shortcutProblems(views: readonly ShellShortcutView[]): string[] {
  return views.flatMap((v) => {
    if (!v.problem) return [];
    const key = v.label ?? v.accelerator ?? '';
    const action = SHORTCUT_TEXT.action[v.action];
    if (v.problem === 'conflict') return [SHORTCUT_TEXT.conflict({ action, key })];
    if (v.problem === 'duplicate') return [SHORTCUT_TEXT.duplicate({ action, key })];
    return [SHORTCUT_TEXT.invalid({ action, key })];
  });
}
