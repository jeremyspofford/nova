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
import { defineMessages, fmt } from '@nova/i18n';
import { listText } from '../devices/format.ts';

/**
 * Computer use's shared words (FR-016). The records below (`STATE_CHIP`, `TIER_TEXT`, ...) read
 * them at render time; the views' own sentences live in `screen.<view>` namespaces.
 */
export const SCREEN_TEXT = defineMessages('screen', {
  states: {
    disabled: 'Computer use off',
    idle: 'On, no apps allowed',
    controlling: 'Nova is controlling apps',
    stopped: 'Stopped by you',
    taken_over: 'You have control',
  },
  controller: {
    disabled: 'Nobody: computer use is off for this computer.',
    idle: 'Nobody yet: Nova can act only in apps you allow.',
    controllingApps: 'Nova can control {apps}.',
    controlling: 'Nova can control the apps you allowed.',
    stopped: 'Nobody: you stopped control. Nova waits until you resume it.',
    takenOverBrowser: 'You have the agent browser. Nova waits until you return control.',
    takenOver: 'You have the keyboard and mouse. Nova waits until you return control.',
  },
  tiers: {
    none: 'No control (you do it)',
    view: 'View only',
    click: 'Click only',
    full: 'Full control',
  },
  /** What the agent may do at a tier (docs/11 §5.1). */
  tierAllows: {
    none: 'Nova never controls this app; it asks you to do the step.',
    view: 'Nova can only look; it acts through the browser tool instead.',
    click: 'Nova can look, left-click and scroll, but not type.',
    full: 'Nova can look, click, type, press keys and drag.',
  },
  /** One recorded action; typed text is only ever its length (FR-101). */
  step: {
    click: '{button, select, right {Right-click} other {Click}}',
    clickAt: '{button, select, right {Right-click at ({x}, {y})} other {Click at ({x}, {y})}}',
    scroll: '{dir, select, up {Scroll up} other {Scroll down}}',
    scrollAt: '{dir, select, up {Scroll up at ({x}, {y})} other {Scroll down at ({x}, {y})}}',
    typeText: 'Type text',
    typeChars: '{n, plural, one {Type # character} other {Type # characters}}',
    press: 'Press {keys}',
    pressKeys: 'Press keys',
    drag: 'Drag',
  },
  actionStatus: {
    ok: 'Done',
    refused: 'Refused',
    failed: 'Failed',
    stopped: 'Stopped',
  },
  actors: {
    you: 'You',
    youTakeover: 'You (takeover)',
    system: 'System',
    nova: 'Nova',
  },
  /** A grant's time left. */
  left: {
    expired: 'Expired',
    seconds: '{n, plural, other {# s left}}',
    minutes: '{n, plural, other {# min left}}',
    hours: '{n, plural, other {# h left}}',
  },
  computerKinds: {
    cloud: 'Cloud computer',
    local_container: 'Local container',
    local_host: 'Your device',
  },
  computer: 'Computer {id}',
});
const S = SCREEN_TEXT;

type ChipTone = 'ready' | 'running' | 'blocked' | 'needs_input' | null;

/** The chip for a control state: text (read when shown), icon and the shared status tone. */
export const STATE_CHIP: Record<
  ScreenControlState,
  { readonly text: string; icon: IconName; tone: ChipTone }
> = {
  disabled: {
    get text() {
      return S.states.disabled;
    },
    icon: 'slash',
    tone: null,
  },
  idle: {
    get text() {
      return S.states.idle;
    },
    icon: 'check',
    tone: 'ready',
  },
  controlling: {
    get text() {
      return S.states.controlling;
    },
    icon: 'eye',
    tone: 'running',
  },
  stopped: {
    get text() {
      return S.states.stopped;
    },
    icon: 'stop',
    tone: 'blocked',
  },
  taken_over: {
    get text() {
      return S.states.taken_over;
    },
    icon: 'hand',
    tone: 'needs_input',
  },
};

/** Who holds the keyboard and mouse, in one sentence (FR-087). */
export function controllerText(s: ScreenStatusView): string {
  const C = S.controller;
  switch (s.state) {
    case 'disabled':
      return C.disabled;
    case 'idle':
      return C.idle;
    case 'controlling':
      return s.indicator.apps.length
        ? C.controllingApps({ apps: listText(s.indicator.apps) })
        : C.controlling;
    case 'stopped':
      return C.stopped;
    case 'taken_over':
      return s.takeover?.surface === 'browser' ? C.takenOverBrowser : C.takenOver;
  }
}

/** A tier's name; read `TIER_TEXT[tier]` at render time. */
export const TIER_TEXT: Readonly<Record<ScreenControlTier, string>> = S.tiers;

/** What the agent may do at a tier (docs/11 §5.1). */
export const TIER_ALLOWS: Readonly<Record<ScreenControlTier, string>> = S.tierAllows;

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

/** A screen coordinate: the locale's digits, never grouped ("1280", not "1,280"). */
export function coord(n: number): string {
  return fmt.number(n, { useGrouping: false });
}

/** One recorded action in words; typed text is only ever its length (FR-101). */
export function screenActionText(a: ScreenActionView): string {
  const T = S.step;
  const x = num(a.args.x);
  const y = num(a.args.y);
  const at = x !== null && y !== null ? { x: coord(x), y: coord(y) } : null;
  switch (a.kind) {
    case 'click': {
      const button = a.args.button === 'right' ? 'right' : 'left';
      return at ? T.clickAt({ button, ...at }) : T.click({ button });
    }
    case 'scroll': {
      const dir = (num(a.args.dy) ?? 0) < 0 ? 'up' : 'down';
      return at ? T.scrollAt({ dir, ...at }) : T.scroll({ dir });
    }
    case 'type': {
      const n = num(a.args.chars);
      return n === null ? T.typeText : T.typeChars({ n });
    }
    case 'key':
      return typeof a.args.keys === 'string'
        ? T.press({ keys: keyText(a.args.keys) })
        : T.pressKeys;
    case 'drag':
      return T.drag;
  }
}

const ACTION_LOOK: Record<
  ScreenActionView['status'],
  { icon: IconName; tone: 'ready' | 'blocked' | 'needs_input' }
> = {
  ok: { icon: 'check', tone: 'ready' },
  refused: { icon: 'shield', tone: 'needs_input' },
  failed: { icon: 'alert', tone: 'blocked' },
  stopped: { icon: 'stop', tone: 'blocked' },
};

/** A recorded action's status: its words (read in the active locale), icon and tone. */
export const ACTION_STATUS: Record<
  ScreenActionView['status'],
  { readonly text: string; icon: IconName; tone: 'ready' | 'blocked' | 'needs_input' }
> = {
  ok: {
    get text() {
      return S.actionStatus.ok;
    },
    ...ACTION_LOOK.ok,
  },
  refused: {
    get text() {
      return S.actionStatus.refused;
    },
    ...ACTION_LOOK.refused,
  },
  failed: {
    get text() {
      return S.actionStatus.failed;
    },
    ...ACTION_LOOK.failed,
  },
  stopped: {
    get text() {
      return S.actionStatus.stopped;
    },
    ...ACTION_LOOK.stopped,
  },
};

/** "Nova", "You (takeover)" or "System". */
export function actorText(actor: string, origin?: ScreenActionView['origin']): string {
  if (actor === 'user') return origin === 'takeover' ? S.actors.youTakeover : S.actors.you;
  if (actor === 'system') return S.actors.system;
  return S.actors.nova;
}

/** "29 min left", "45 s left", "Expired". */
export function remainingText(seconds: number): string {
  if (seconds <= 0) return S.left.expired;
  if (seconds < 60) return S.left.seconds({ n: seconds });
  const m = Math.ceil(seconds / 60);
  if (m < 120) return S.left.minutes({ n: m });
  return S.left.hours({ n: Math.round(m / 60) });
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
    : fmt.time(d, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A Hub message as a sentence: capital first letter, final period. */
export function sentence(msg: string): string {
  const t = msg.trim();
  if (!t) return t;
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** A computer's name in a list (computers have no name of their own). */
export function computerText(c: ComputerView | undefined, id: string): string {
  return c ? S.computerKinds[c.kind] : S.computer({ id });
}
