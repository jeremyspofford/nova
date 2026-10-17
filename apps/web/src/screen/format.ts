// Words for computer use (FR-093, FR-207, FR-087; docs/04 §2.8, docs/11 §5): control states,
// tiers, recorded actions and grant lifetimes, shared by the screen panel, the live view, the
// control indicator and Settings. Every state is shown as an icon plus text, never color alone.
import type {
  ComputerView,
  ScreenActionView,
  ScreenControlState,
  ScreenControlTier,
  ScreenStatusView,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

/** The chip for a control state: text, icon and the shared status tone (docs/04 §1.1). */
export const STATE_CHIP: Record<
  ScreenControlState,
  { text: string; icon: IconName; tone: 'ready' | 'running' | 'blocked' | 'needs_input' | null }
> = {
  disabled: { text: 'Computer use off', icon: 'slash', tone: null },
  idle: { text: 'On, no apps allowed', icon: 'check', tone: 'ready' },
  controlling: { text: 'Nova is controlling apps', icon: 'eye', tone: 'running' },
  stopped: { text: 'Stopped by you', icon: 'stop', tone: 'blocked' },
  taken_over: { text: 'You have control', icon: 'hand', tone: 'needs_input' },
};

/** Who holds the keyboard and mouse, in one sentence (FR-087). */
export function controllerText(s: ScreenStatusView): string {
  switch (s.state) {
    case 'disabled':
      return 'Nobody: computer use is off for this computer.';
    case 'idle':
      return 'Nobody yet: Nova can act only in apps you allow.';
    case 'controlling':
      return s.indicator.apps.length
        ? `Nova can control ${s.indicator.apps.join(', ')}.`
        : 'Nova can control the apps you allowed.';
    case 'stopped':
      return 'Nobody: you stopped control. Nova waits until you resume it.';
    case 'taken_over':
      return s.takeover?.surface === 'browser'
        ? 'You have the agent browser. Nova waits until you return control.'
        : 'You have the keyboard and mouse. Nova waits until you return control.';
  }
}

export const TIER_TEXT: Record<ScreenControlTier, string> = {
  none: 'No control (you do it)',
  view: 'View only',
  click: 'Click only',
  full: 'Full control',
};

/** What the agent may do at a tier (docs/11 §5.1). */
export const TIER_ALLOWS: Record<ScreenControlTier, string> = {
  none: 'Nova never controls this app; it asks you to do the step.',
  view: 'Nova can only look; it acts through the browser tool instead.',
  click: 'Nova can look, left-click and scroll, but not type.',
  full: 'Nova can look, click, type, press keys and drag.',
};

/** "Escape" → ["Esc"], "ctrl+alt+k" → ["Ctrl", "Alt", "K"]. */
export function keyCaps(key: string): string[] {
  return key
    .split(/[+ ]/)
    .filter(Boolean)
    .map((k) => {
      const l = k.toLowerCase();
      if (l === 'escape' || l === 'esc') return 'Esc';
      if (l === 'ctrl' || l === 'control') return 'Ctrl';
      if (l === 'meta' || l === 'cmd' || l === 'command') return 'Cmd';
      if (l.length === 1) return l.toUpperCase();
      return k.charAt(0).toUpperCase() + k.slice(1);
    });
}

/** "Esc", "Ctrl+Alt+K". */
export function keyText(key: string): string {
  return keyCaps(key).join('+');
}

/** The aria-keyshortcuts form: "Escape", "Control+Alt+K". */
export function ariaKeys(key: string): string {
  return keyCaps(key)
    .map((k) => (k === 'Esc' ? 'Escape' : k === 'Ctrl' ? 'Control' : k === 'Cmd' ? 'Meta' : k))
    .join('+');
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** One recorded action in words; typed text is only ever its length (FR-101). */
export function screenActionText(a: ScreenActionView): string {
  const x = num(a.args.x);
  const y = num(a.args.y);
  const at = x !== null && y !== null ? ` at (${x}, ${y})` : '';
  switch (a.kind) {
    case 'click':
      return `${a.args.button === 'right' ? 'Right-click' : 'Click'}${at}`;
    case 'scroll': {
      const dy = num(a.args.dy) ?? 0;
      return `Scroll ${dy < 0 ? 'up' : 'down'}${at}`;
    }
    case 'type': {
      const n = num(a.args.chars);
      return n === null ? 'Type text' : `Type ${n} ${n === 1 ? 'character' : 'characters'}`;
    }
    case 'key':
      return typeof a.args.keys === 'string' ? `Press ${keyText(a.args.keys)}` : 'Press keys';
    case 'drag':
      return 'Drag';
  }
}

export const ACTION_STATUS: Record<
  ScreenActionView['status'],
  { text: string; icon: IconName; tone: 'ready' | 'blocked' | 'needs_input' }
> = {
  ok: { text: 'Done', icon: 'check', tone: 'ready' },
  refused: { text: 'Refused', icon: 'shield', tone: 'needs_input' },
  failed: { text: 'Failed', icon: 'alert', tone: 'blocked' },
  stopped: { text: 'Stopped', icon: 'stop', tone: 'blocked' },
};

/** "Nova", "You (takeover)" or "System". */
export function actorText(actor: string, origin?: ScreenActionView['origin']): string {
  if (actor === 'user') return origin === 'takeover' ? 'You (takeover)' : 'You';
  if (actor === 'system') return 'System';
  return 'Nova';
}

/** "29 min left", "45 s left", "Expired". */
export function remainingText(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  if (seconds < 60) return `${seconds} s left`;
  const m = Math.ceil(seconds / 60);
  if (m < 120) return `${m} min left`;
  return `${Math.round(m / 60)} h left`;
}

/** Seconds left of a grant at `now`. */
export function secondsLeft(expiresAt: string, now: number): number {
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((t - now) / 1000));
}

/** A clock time for a trace line. */
export function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A Hub message as a sentence: capital first letter, final period. */
export function sentence(msg: string): string {
  const t = msg.trim();
  if (!t) return t;
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

const KIND_TEXT: Record<ComputerView['kind'], string> = {
  cloud: 'Cloud computer',
  local_container: 'Local container',
  local_host: 'Your device',
};

/** A computer's name in a list (computers have no name of their own). */
export function computerText(c: ComputerView | undefined, id: string): string {
  return c ? KIND_TEXT[c.kind] : `Computer ${id}`;
}
