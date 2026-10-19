// Words for the agent browser (FR-086, FR-092, FR-094, FR-095, FR-098, FR-194; docs/11 §4):
// session states, site levels, recorded actions and their results. Every state pairs an icon
// with text, never color alone (docs/04 §7).
import type {
  BrowserActionResult,
  BrowserActionView,
  BrowserBodyOmitted,
  BrowserConsoleLevel,
  BrowserNetworkEntryView,
  BrowserSessionState,
  BrowserSiteLevel,
  BrowserSiteScopeKind,
} from '@nova/shared';
import type { IconName } from '@nova/ui';

type Tone = 'ready' | 'running' | 'blocked' | 'needs_input' | null;

export const SESSION_CHIP: Record<
  BrowserSessionState,
  { text: string; icon: IconName; tone: Tone }
> = {
  starting: { text: 'Starting', icon: 'refresh', tone: 'running' },
  running: { text: 'Open', icon: 'check', tone: 'ready' },
  paused: { text: 'Paused', icon: 'hand', tone: 'needs_input' },
  closed: { text: 'Closed', icon: 'slash', tone: null },
  error: { text: 'Error', icon: 'alert', tone: 'blocked' },
};

export const LEVEL_TEXT: Record<BrowserSiteLevel, string> = {
  always_ask: 'Always ask',
  auto_review: 'Auto approve with review',
  always_allow: 'Always allow',
};

/** What each level does to write actions on the site (docs/11 §4.4). */
export const LEVEL_HINT: Record<BrowserSiteLevel, string> = {
  always_ask: 'Every change on the site (clicking a button, filling a form) asks you first.',
  auto_review:
    'Changes run when the safety check and the auto-reviewer both pass; anything flagged asks you.',
  always_allow: 'Changes run when the safety check passes; anything flagged still asks you.',
};

export const RESULT_CHIP: Record<
  BrowserActionResult,
  { text: string; icon: IconName; tone: Tone }
> = {
  ok: { text: 'Done', icon: 'check', tone: 'ready' },
  error: { text: 'Failed', icon: 'alert', tone: 'blocked' },
  blocked: { text: 'Blocked site', icon: 'slash', tone: 'blocked' },
  denied: { text: 'Denied', icon: 'shield', tone: 'blocked' },
  handoff: { text: 'Needs you', icon: 'hand', tone: 'needs_input' },
};

const ACTION_TEXT: Record<string, string> = {
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
};

/** "Click", "Download", or the page tool's name for a tool the page registered (FR-208). */
export function browserActionText(a: Pick<BrowserActionView, 'tool' | 'action'>): string {
  if (a.tool.startsWith('page:')) return `Page tool ${a.tool.slice(5)}`;
  return ACTION_TEXT[a.action] ?? a.action.replace(/_/g, ' ');
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
export function actionChip(a: Pick<BrowserActionView, 'tool' | 'result'>): {
  text: string;
  icon: IconName;
  tone: Tone;
} {
  if (a.tool === 'browser.crash') return { text: 'Crashed', icon: 'stop', tone: 'blocked' };
  if (a.tool === 'browser.restart')
    return a.result === 'ok'
      ? { text: 'Restarted', icon: 'refresh', tone: 'ready' }
      : { text: 'Not restarted', icon: 'alert', tone: 'blocked' };
  return RESULT_CHIP[a.result];
}

export function isDownload(a: Pick<BrowserActionView, 'tool' | 'result'>): boolean {
  return a.tool === 'browser.download' && a.result === 'ok';
}

/** "4:59", or "0:00" once it ran out. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---- site levels per project or agent (FR-094, docs/11 §4.4) --------------------------------

export const SCOPE_TEXT: Record<BrowserSiteScopeKind, { one: string; none: string }> = {
  project: { one: 'project', none: 'A removed project' },
  agent: { one: 'agent', none: 'A removed agent' },
};

// ---- console and network capture (FR-092, FR-103) ---------------------------------------------

export const CONSOLE_LEVEL_CHIP: Record<
  BrowserConsoleLevel,
  { text: string; icon: IconName; tone: Tone }
> = {
  error: { text: 'Error', icon: 'stop', tone: 'blocked' },
  warning: { text: 'Warning', icon: 'alert', tone: 'needs_input' },
  info: { text: 'Info', icon: 'bell', tone: null },
  log: { text: 'Log', icon: 'file', tone: null },
  debug: { text: 'Debug', icon: 'tool', tone: null },
};

export const BODY_OMITTED_TEXT: Record<BrowserBodyOmitted, string> = {
  binary: 'Not kept: not text.',
  too_large: 'Not kept: larger than 16 KiB.',
  unavailable: 'Not kept: the browser could not read it.',
  none: 'No body.',
};

/** "200 OK", "Failed: net::ERR_…", "Blocked", or "Waiting" for a request still open. */
export function requestOutcome(r: BrowserNetworkEntryView): {
  text: string;
  icon: IconName;
  tone: Tone;
} {
  if (r.blocked) return { text: 'Blocked', icon: 'slash', tone: 'blocked' };
  if (r.failure) return { text: 'Failed', icon: 'alert', tone: 'blocked' };
  if (r.status === null) return { text: 'Waiting', icon: 'clock', tone: 'running' };
  const text = `${r.status}${r.statusText ? ` ${r.statusText}` : ''}`;
  if (r.status >= 400) return { text, icon: 'alert', tone: 'blocked' };
  if (r.status >= 300) return { text, icon: 'forward', tone: null };
  return { text, icon: 'check', tone: 'ready' };
}

/** A request failed, was blocked, or the server answered with an error. */
export function requestFailed(r: BrowserNetworkEntryView): boolean {
  return r.blocked || r.failure !== null || (r.status !== null && r.status >= 400);
}

/** "512 B", "3.4 KB", "1.2 MB". */
export function sizeText(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** "84 ms", "1.3 s". */
export function durationText(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
