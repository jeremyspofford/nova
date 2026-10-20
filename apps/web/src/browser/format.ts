// Words for the agent browser (FR-086, FR-092, FR-094, FR-095, FR-098, FR-194; docs/11 §4):
// session states, site levels, recorded actions and their results. Every state pairs an icon
// with text, never color alone (docs/04 §7). The words are messages (FR-016): read them at render
// time so they follow the active locale.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type {
  BrowserActionResult,
  BrowserActionView,
  BrowserConsoleLevel,
  BrowserNetworkEntryView,
  BrowserSessionState,
  BrowserSiteLevel,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

type Tone = 'ready' | 'running' | 'blocked' | 'needs_input' | null;

/** A state as a chip: an icon and text, with the shared status tone (docs/04 §1.1). */
export interface BrowserChip {
  text: string;
  icon: IconName;
  tone: Tone;
}

/** Words the browser views share. */
export const BROWSER_TEXT = defineMessages('browser', {
  retry: 'Retry',
  cancel: 'Cancel',
  remove: 'Remove',
  refresh: 'Refresh',
  /** A site's level or access could not be changed; `reason` is the Hub's sentence. */
  changeFailed: 'Could not change {site}: {reason}',
  /** Announced when a site's level for one project or agent changed ("x.com for Ops: Always ask."). */
  scopedLevelSet: '{site} for {scope}: {level}.',
});

export const SESSION_TEXT = defineMessages('browser.session', {
  starting: 'Starting',
  running: 'Open',
  paused: 'Paused',
  closed: 'Closed',
  error: 'Error',
  /** No agent browser is open on the computer. */
  notOpen: 'Not open',
});

const SESSION_LOOK: Record<BrowserSessionState, Omit<BrowserChip, 'text'>> = {
  starting: { icon: 'refresh', tone: 'running' },
  running: { icon: 'check', tone: 'ready' },
  paused: { icon: 'hand', tone: 'needs_input' },
  closed: { icon: 'slash', tone: null },
  error: { icon: 'alert', tone: 'blocked' },
};

/** The chip of a browser session's state, or "Not open" without a session. */
export function sessionChip(state: BrowserSessionState | null): BrowserChip {
  if (state === null) return { text: SESSION_TEXT.notOpen, icon: 'slash', tone: null };
  return { text: SESSION_TEXT[state], ...SESSION_LOOK[state] };
}

/** A site's permission level for changes on it (docs/11 §4.4). */
export const LEVEL_TEXT = defineMessages('browser.levels', {
  always_ask: 'Always ask',
  auto_review: 'Auto approve with review',
  always_allow: 'Always allow',
});

/** What each level does to write actions on the site (docs/11 §4.4). */
export const LEVEL_HINT = defineMessages('browser.levelHints', {
  always_ask: 'Every change on the site (clicking a button, filling a form) asks you first.',
  auto_review:
    'Changes run when the safety check and the auto-reviewer both pass; anything flagged asks you.',
  always_allow: 'Changes run when the safety check passes; anything flagged still asks you.',
});

/** The levels as select options, in the active locale. */
export function levelOptions(levels: readonly BrowserSiteLevel[]) {
  return levels.map((l) => ({ value: l, label: LEVEL_TEXT[l] }));
}

/** A recorded action's result. */
export const RESULT_TEXT = defineMessages('browser.results', {
  ok: 'Done',
  error: 'Failed',
  blocked: 'Blocked site',
  denied: 'Denied',
  handoff: 'Needs you',
});

const RESULT_LOOK: Record<BrowserActionResult, Omit<BrowserChip, 'text'>> = {
  ok: { icon: 'check', tone: 'ready' },
  error: { icon: 'alert', tone: 'blocked' },
  blocked: { icon: 'slash', tone: 'blocked' },
  denied: { icon: 'shield', tone: 'blocked' },
  handoff: { icon: 'hand', tone: 'needs_input' },
};

/** What the agent did in the browser, by the Hub's action name. */
export const ACTION_TEXT = defineMessages('browser.actions', {
  kinds: {
    navigate: 'Open page',
    read: 'Read page',
    click: 'Click',
    type: 'Type',
    select: 'Choose an option',
    press: 'Press a key',
    scroll: 'Scroll',
    wait: 'Wait',
    back: 'Go back',
    screenshot: 'Screenshot',
    download: 'Download',
    upload: 'Upload a file',
    sign_in: 'Sign in',
    evaluate: 'Developer protocol',
    hover: 'Hover',
    crash: 'The browser crashed',
    restart: 'Restarted the browser',
  },
  /** A tool the page registered for the agent (FR-208); `name` is the tool's own name. */
  pageTool: 'Page tool {name}',
  /** The chip of a crash row. */
  crashed: 'Crashed',
  /** The chip of a restart row that worked. */
  restarted: 'Restarted',
  /** The chip of a restart row that did not work. */
  notRestarted: 'Not restarted',
});

/** "Click", "Download", or the page tool's name for a tool the page registered (FR-208). */
export function browserActionText(a: Pick<BrowserActionView, 'tool' | 'action'>): string {
  if (a.tool.startsWith('page:')) return ACTION_TEXT.pageTool({ name: a.tool.slice(5) });
  // An action this client does not know yet: the Hub's name, as data.
  return messageFor(ACTION_TEXT.kinds, a.action) ?? a.action.replace(/_/g, ' ');
}

/**
 * A write refused because the page came from an external AI agent (FR-194). The Hub records the
 * reason only as text, so it is recognised by its wording.
 */
export function isExternalAgentNotice(a: Pick<BrowserActionView, 'result' | 'error'>): boolean {
  return a.result === 'denied' && /external AI agent/i.test(a.error ?? '');
}

/** The agent's name in an external-agent refusal (`… agent ("billing-bot") …`), if any. */
export function externalAgentName(error: string | null): string | null {
  const m = /external AI agent \("([^"]{1,200})"\)/i.exec(error ?? '');
  return m?.[1] ?? null;
}

/** A crash or restart row (docs/11 §10): about the browser itself, not a step the agent took. */
export function isLifecycle(a: Pick<BrowserActionView, 'tool'>): boolean {
  return a.tool === 'browser.crash' || a.tool === 'browser.restart';
}

/** The chip of a trace row: crash and restart rows say what happened to the browser. */
export function actionChip(a: Pick<BrowserActionView, 'tool' | 'result'>): BrowserChip {
  if (a.tool === 'browser.crash')
    return { text: ACTION_TEXT.crashed, icon: 'stop', tone: 'blocked' };
  if (a.tool === 'browser.restart')
    return a.result === 'ok'
      ? { text: ACTION_TEXT.restarted, icon: 'refresh', tone: 'ready' }
      : { text: ACTION_TEXT.notRestarted, icon: 'alert', tone: 'blocked' };
  return { text: RESULT_TEXT[a.result], ...RESULT_LOOK[a.result] };
}

export function isDownload(a: Pick<BrowserActionView, 'tool' | 'result'>): boolean {
  return a.tool === 'browser.download' && a.result === 'ok';
}

/** "4:59", or "0:00" once it ran out, with the locale's digits. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${fmt.number(Math.floor(s / 60))}:${fmt.number(s % 60, { minimumIntegerDigits: 2 })}`;
}

/** The time of day of a Hub timestamp, to the second ("12:00:05 PM"); the text itself if invalid. */
export function timeText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? iso
    : fmt.time(t, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---- site levels per project or agent (FR-094, docs/11 §4.4) --------------------------------

export const SCOPE_TEXT = defineMessages('browser.scopes', {
  /** A level set for a project or agent that no longer exists. */
  removed: '{kind, select, project {A removed project} other {A removed agent}}',
  /** What a scope is, under its name. */
  kind: '{kind, select, project {Project} other {Agent}}',
  /** A scope's row, for screen readers. */
  named: '{kind, select, project {Project: {name}} other {Agent: {name}}}',
  /** Option groups when choosing a project or agent. */
  groups: { project: 'Projects', agent: 'Agents' },
});

// ---- console and network capture (FR-092, FR-103) ---------------------------------------------

/** A console message's level. */
export const CONSOLE_LEVEL_TEXT = defineMessages('browser.consoleLevels', {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
  log: 'Log',
  debug: 'Debug',
});

const CONSOLE_LEVEL_LOOK: Record<BrowserConsoleLevel, Omit<BrowserChip, 'text'>> = {
  error: { icon: 'stop', tone: 'blocked' },
  warning: { icon: 'alert', tone: 'needs_input' },
  info: { icon: 'bell', tone: null },
  log: { icon: 'file', tone: null },
  debug: { icon: 'tool', tone: null },
};

/** The chip of a console message's level. */
export function consoleLevelChip(level: BrowserConsoleLevel): BrowserChip {
  return { text: CONSOLE_LEVEL_TEXT[level], ...CONSOLE_LEVEL_LOOK[level] };
}

/** Why a response body was not kept. */
export const BODY_OMITTED_TEXT = defineMessages('browser.bodyOmitted', {
  binary: 'Not kept: not text.',
  too_large: 'Not kept: larger than 16 KiB.',
  unavailable: 'Not kept: the browser could not read it.',
  none: 'No body.',
});

/** A request's outcome when there is no status line to show. */
export const REQUEST_TEXT = defineMessages('browser.requests', {
  blocked: 'Blocked',
  failed: 'Failed',
  /** The request is still open. */
  waiting: 'Waiting',
});

/**
 * "200 OK" (the server's status line, as data), "Failed", "Blocked", or "Waiting" for a request
 * still open.
 */
export function requestOutcome(r: BrowserNetworkEntryView): BrowserChip {
  if (r.blocked) return { text: REQUEST_TEXT.blocked, icon: 'slash', tone: 'blocked' };
  if (r.failure) return { text: REQUEST_TEXT.failed, icon: 'alert', tone: 'blocked' };
  if (r.status === null) return { text: REQUEST_TEXT.waiting, icon: 'clock', tone: 'running' };
  const text = `${r.status}${r.statusText ? ` ${r.statusText}` : ''}`;
  if (r.status >= 400) return { text, icon: 'alert', tone: 'blocked' };
  if (r.status >= 300) return { text, icon: 'forward', tone: null };
  return { text, icon: 'check', tone: 'ready' };
}

/** A request failed, was blocked, or the server answered with an error. */
export function requestFailed(r: BrowserNetworkEntryView): boolean {
  return r.blocked || r.failure !== null || (r.status !== null && r.status >= 400);
}

/** "512 B", "3.4 KB", "1.2 MB" in the active locale. */
export function sizeText(bytes: number | null): string | null {
  return bytes === null ? null : fmt.bytes(bytes);
}

/** "84 ms", "1.3 s" in the active locale. */
export function durationText(ms: number | null): string | null {
  return ms === null ? null : fmt.duration(ms);
}
