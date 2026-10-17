// Key binding grammar (FR-004, docs/14 §3). A binding is "mod+shift+k": modifiers in the order
// mod, ctrl, alt, shift, meta, then one key. `mod` is Cmd on macOS and Ctrl elsewhere, so a stored
// binding works on every OS; `ctrl` stays distinct from `mod` only on macOS (the Control key).

export interface Platform {
  mac: boolean;
  /**
   * A plain browser tab: the browser keeps some keys for itself (new window, tab switching), so
   * those defaults get an Alt variant (docs/04 §5). The installed app uses the defaults.
   */
  browserTab: boolean;
}

export function detectPlatform(): Platform {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const mac = /mac|iphone|ipad/i.test(nav?.platform ?? '');
  const standalone =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  return { mac, browserTab: !standalone };
}

const MOD_ORDER = ['mod', 'ctrl', 'alt', 'shift', 'meta'] as const;
type Modifier = (typeof MOD_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  mod: 'mod',
  cmd: 'mod',
  command: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
};

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  ' ': 'space',
  spacebar: 'space',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  plus: '+',
  comma: ',',
};

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'altgraph', 'capslock', 'os']);

/** Canonical form of a binding, or null when it is not a valid binding. */
export function normalizeBinding(binding: string, mac: boolean): string | null {
  const raw = binding.trim().toLowerCase();
  if (!raw) return null;
  // A trailing "++" means the plus key itself.
  const parts = raw.endsWith('++') ? [...raw.slice(0, -2).split('+'), '+'] : raw.split('+');
  const keyPart = parts.pop()?.trim();
  if (!keyPart) return null;
  const mods = new Set<Modifier>();
  for (const p of parts) {
    let m = MODIFIER_ALIASES[p.trim()];
    if (!m) return null;
    if (m === 'ctrl' && !mac) m = 'mod';
    if (m === 'meta' && mac) m = 'mod';
    mods.add(m);
  }
  const key = KEY_ALIASES[keyPart] ?? keyPart;
  if (MODIFIER_ALIASES[key] || MODIFIER_KEYS.has(key)) return null;
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

export function bindingModifiers(binding: string): string[] {
  const parts = binding.endsWith('++') ? [...binding.slice(0, -2).split('+')] : binding.split('+');
  if (!binding.endsWith('++')) parts.pop();
  return parts;
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const CODE_KEYS: Record<string, string> = {
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Semicolon: ';',
  Quote: "'",
  Space: 'space',
};

function keyFromCode(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit?.[1]) return digit[1];
  return CODE_KEYS[code] ?? null;
}

/** The key part of a binding for a keyboard event, or null for a lone modifier. */
export function eventKey(e: KeyLike): string | null {
  const k = e.key;
  if (!k || k === 'Dead' || k === 'Unidentified') return keyFromCode(e.code);
  const lower = k.toLowerCase();
  if (MODIFIER_KEYS.has(lower)) return null;
  if (k.length === 1) {
    if (/^[a-z0-9]$/.test(lower)) return lower;
    if (k === ' ') return 'space';
    // Alt (Option) and Shift change the produced character; use the physical key for letters,
    // digits and punctuation so "alt+n" and "mod+shift+1" still match.
    if (e.altKey || e.shiftKey) {
      const fromCode = keyFromCode(e.code);
      if (fromCode) return fromCode;
    }
    return lower;
  }
  return KEY_ALIASES[lower] ?? lower;
}

/** Canonical binding for a keyboard event, or null for a lone modifier press. */
export function eventToBinding(e: KeyLike, mac: boolean): string | null {
  const key = eventKey(e);
  if (!key) return null;
  const mods: Modifier[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (mac && e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (!mac && e.metaKey) mods.push('meta');
  return [...mods, key].join('+');
}

export function matchesBinding(e: KeyLike, binding: string, mac: boolean): boolean {
  const want = normalizeBinding(binding, mac);
  return want !== null && eventToBinding(e, mac) === want;
}

const MAC_LABELS: Record<string, string> = {
  mod: '⌘',
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
};
const PC_LABELS: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Super',
};
const KEY_LABELS: Record<string, string> = {
  escape: 'Esc',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  home: 'Home',
  end: 'End',
  pageup: 'Page Up',
  pagedown: 'Page Down',
};

function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key.toUpperCase());
}

/** Key caps for display, e.g. ["Ctrl", "Shift", "P"] or ["⌘", "⇧", "P"]. */
export function formatBinding(binding: string, mac: boolean): string[] {
  const labels = mac ? MAC_LABELS : PC_LABELS;
  const key = binding.endsWith('++') ? '+' : (binding.split('+').at(-1) ?? '');
  return [...bindingModifiers(binding).map((m) => labels[m] ?? m), keyLabel(key)];
}

export function bindingText(binding: string, mac: boolean): string {
  return formatBinding(binding, mac).join(mac ? '' : '+');
}

const ARIA_MODS: Record<string, [string, string]> = {
  mod: ['Control', 'Meta'],
  ctrl: ['Control', 'Control'],
  alt: ['Alt', 'Alt'],
  shift: ['Shift', 'Shift'],
  meta: ['Meta', 'Meta'],
};
const ARIA_KEYS: Record<string, string> = { escape: 'Escape', enter: 'Enter', space: 'Space' };

/** Value for the aria-keyshortcuts attribute. */
export function ariaKeyShortcut(binding: string, mac: boolean): string {
  const key = binding.split('+').at(-1) ?? '';
  const mods = bindingModifiers(binding).map((m) => ARIA_MODS[m]?.[mac ? 1 : 0] ?? m);
  return [...mods, ARIA_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key)].join('+');
}

// Keys a browser tab cannot intercept (docs/04 §5): new window/tab, close, tab switching, and
// the browser's own find (Find in chat, FR-025), downloads and bookmarks (the bottom panel,
// terminal, browser and diff pane keys, FR-005, FR-006).
const BROWSER_RESERVED = new Set([
  'mod+f',
  'mod+j',
  'mod+`',
  'ctrl+`',
  'mod+shift+b',
  'mod+shift+d',
  'mod+n',
  'mod+shift+n',
  'mod+t',
  'mod+shift+t',
  'mod+w',
  'mod+shift+w',
  'mod+tab',
  'mod+shift+tab',
  'ctrl+tab',
  'ctrl+shift+tab',
  'mod+1',
  'mod+2',
  'mod+3',
  'mod+4',
  'mod+5',
  'mod+6',
  'mod+7',
  'mod+8',
  'mod+9',
]);

export function isBrowserReserved(binding: string): boolean {
  return BROWSER_RESERVED.has(binding);
}

/** The Alt variant shown in a browser tab for a reserved default (docs/04 §5). */
export function browserAlternate(binding: string, mac: boolean): string {
  const mods = bindingModifiers(binding).filter((m) => m !== 'mod' && m !== 'ctrl');
  const key = binding.split('+').at(-1) ?? '';
  return normalizeBinding([...mods, 'alt', key].join('+'), mac) ?? binding;
}

/** Bindings without a modifier (or with only Shift) that would type a character. */
export function typesCharacter(binding: string): boolean {
  const mods = bindingModifiers(binding);
  const key = binding.split('+').at(-1) ?? '';
  return mods.every((m) => m === 'shift') && (key.length === 1 || key === 'space');
}

// ---- when-clauses (docs/14 §3) -----------------------------------------------------------------

export type WhenContext = Record<string, string | boolean | undefined>;

/**
 * Evaluate a when-clause: identifiers are truthy context keys, `!x` negates, `x == v` and
 * `x != v` compare strings, `&&` binds tighter than `||`. An empty clause is always true.
 */
export function evaluateWhen(expr: string | undefined, ctx: WhenContext): boolean {
  if (!expr?.trim()) return true;
  return expr.split('||').some((alt) => alt.split('&&').every((t) => evalTerm(t.trim(), ctx)));
}

function evalTerm(term: string, ctx: WhenContext): boolean {
  const cmp = /^([\w.]+)\s*(==|!=)\s*([\w.-]+)$/.exec(term);
  if (cmp) {
    const [, name = '', op, want] = cmp;
    const have = ctx[name];
    const v = have === undefined ? '' : String(have);
    return op === '==' ? v === want : v !== want;
  }
  if (term.startsWith('!')) return !evalTerm(term.slice(1).trim(), ctx);
  const v = ctx[term];
  return v !== undefined && v !== false && v !== '';
}
