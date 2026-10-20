// The design system's own words (FR-016): status names, field locks and errors, the toast
// region, the preset scale's ends and the spoken names of key caps. Read at render time, so they
// follow the active locale.
import { defineMessages } from '@nova/i18n';

export const UI_TEXT = defineMessages('ui', {
  managed: 'Managed by your organization',
  notifications: 'Notifications',
  dismissNotification: 'Dismiss notification',
  faster: 'Faster',
  smarter: 'Smarter',
  color: {
    hex: '{label} hex value',
    reset: 'Reset to theme',
    /** The reset button's accessible name: the action, then the field it resets. */
    resetFor: '{action}: {label}',
    invalid: 'Enter a hash sign and six hex digits (0–9, a–f)',
  },
  status: {
    needs_input: 'Needs input',
    blocked: 'Blocked',
    running: 'Running',
    ready: 'Ready',
    withReason: '{status}: {reason}',
  },
});

/**
 * Spoken names of key caps, for a key combination's accessible name ("Ctrl plus K"). The visible
 * caps stay as printed on the keyboard; single letters and digits are read as they are.
 */
export const KEY_TEXT = defineMessages('ui.keys', {
  combination: '{first} plus {rest}',
  ctrl: 'Ctrl',
  alt: 'Alt',
  altGr: 'AltGr',
  shift: 'Shift',
  super: 'Super',
  esc: 'Esc',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageUp: 'Page Up',
  pageDown: 'Page Down',
  printScreen: 'Print Screen',
  macCommand: '⌘',
  macControl: '⌃',
  macOption: '⌥',
  macShift: '⇧',
});

// Caps as the apps print them → the message that names them.
const SPOKEN: Record<string, keyof typeof KEY_TEXT> = {
  Ctrl: 'ctrl',
  Alt: 'alt',
  AltGr: 'altGr',
  Shift: 'shift',
  Super: 'super',
  Esc: 'esc',
  Enter: 'enter',
  Space: 'space',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  'Page Up': 'pageUp',
  'Page Down': 'pageDown',
  PrintScreen: 'printScreen',
  '⌘': 'macCommand',
  '⌃': 'macControl',
  '⌥': 'macOption',
  '⇧': 'macShift',
};

/** The spoken name of one key cap in the active locale. */
export function spokenKey(cap: string): string {
  const key = Object.hasOwn(SPOKEN, cap) ? SPOKEN[cap] : undefined;
  const name = key ? KEY_TEXT[key] : cap;
  return typeof name === 'string' ? name : cap;
}

/** A key combination's accessible name: "Ctrl plus Shift plus P". */
export function spokenKeys(caps: readonly string[]): string {
  const names = caps.map(spokenKey);
  const last = names.pop();
  if (last === undefined) return '';
  return names.reduceRight((rest, first) => KEY_TEXT.combination({ first, rest }), last);
}
