// Text for the M6 Code views (docs/10 §2, §7-§10): environment kinds and health, where a session
// runs, pull request and CI states, verify and dev server states, worktree leases and budgets.
// Every state pairs a word with its icon in the views (docs/04 §7); these are the words.
import type {
  CiCheckView,
  CiStatus,
  CodeBudgetView,
  DevServerView,
  EnvironmentConnectionView,
  EnvironmentView,
  PullRequestView,
  SavedEnvironmentView,
  VerifyCheckView,
  VerifyRunView,
  WorktreeView,
} from '@nova/shared';
import type { IconName } from '@nova/ui';
import { formatCost, formatSpan, formatTokens } from '../work/format.ts';

export { formatCost, formatSpan, formatTokens };

/** Kinds a user can create (the built-in local one exists already). */
export const CREATABLE_KINDS = ['container', 'ssh', 'wsl', 'device'] as const;
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

export const KIND_LABEL: Record<EnvironmentView['kind'], string> = {
  local: 'This Hub',
  cloud: 'Cloud',
  ssh: 'SSH host',
  wsl: 'WSL',
  container: 'Container',
  vm: 'Virtual machine',
  device: 'Device',
};

export const KIND_DESCRIPTION: Record<CreatableKind, string> = {
  container:
    'Commands run in a container image on the Hub, with a setup script run once per session.',
  ssh: 'Nova installs its helper on the host and works there over SSH. Sessions keep running while you are away.',
  wsl: 'A Linux distro on a Windows device that runs the Nova device agent.',
  device: 'A registered device that runs the Nova device agent, under that device’s own grants.',
};

/**
 * Whether a session in this environment works on another machine: the Hub then cannot capture
 * its diff, review it, commit, push, search symbols or run dev servers (`remote_environment`).
 * The Hub's rule: only local and container environments are on the Hub.
 */
export function isRemoteKind(kind: EnvironmentView['kind'] | null | undefined): boolean {
  return !!kind && kind !== 'local' && kind !== 'container';
}

export const HEALTH_TEXT: Record<EnvironmentView['status'], string> = {
  ok: 'Ready',
  degraded: 'Degraded',
  down: 'Unavailable',
  unknown: 'Not checked',
};

export const HEALTH_ICON: Record<EnvironmentView['status'], IconName> = {
  ok: 'check',
  degraded: 'alert',
  down: 'stop',
  unknown: 'clock',
};

export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

export const HEALTH_TONE: Record<EnvironmentView['status'], Tone> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'danger',
  unknown: 'muted',
};

/** One line on where an environment's connection points (never a secret). */
export function connectionSummary(
  c: EnvironmentConnectionView,
  deviceName: (id: string) => string,
): string {
  switch (c.kind) {
    case 'local':
      return 'The Hub itself';
    case 'container':
      return `Image ${c.image}${c.setupScript ? ', with a setup script' : ''}`;
    case 'ssh':
      return `${c.user}@${c.host}${c.port === 22 ? '' : `:${c.port}`}${c.root ? ` in ${c.root}` : ''}`;
    case 'wsl':
      return `${c.distro} on ${deviceName(c.deviceId)}`;
    case 'device':
      return `${deviceName(c.deviceId)}${c.root ? ` in ${c.root}` : ''}`;
  }
}

/** A saved view's connection, or what the plain view implies (older Hubs send no connection). */
export function connectionOf(e: EnvironmentView): EnvironmentConnectionView | null {
  const c = (e as Partial<SavedEnvironmentView>).connection;
  if (c) return c;
  return e.kind === 'local' ? { kind: 'local' } : null;
}

// ---- pull requests and CI -----------------------------------------------------------------

export const CI_TEXT: Record<CiStatus, string> = {
  none: 'No checks',
  queued: 'Checks queued',
  running: 'Checks running',
  passed: 'Checks passed',
  failed: 'Checks failed',
};

export const CI_ICON: Record<CiStatus, IconName> = {
  none: 'clock',
  queued: 'clock',
  running: 'refresh',
  passed: 'check',
  failed: 'stop',
};

export const CI_TONE: Record<CiStatus, Tone> = {
  none: 'muted',
  queued: 'muted',
  running: 'warn',
  passed: 'ok',
  failed: 'danger',
};

export const PR_STATE_TEXT: Record<PullRequestView['state'], string> = {
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
};

/** One check's state in words: "Queued", "Running", or its conclusion. */
export function checkText(c: Pick<CiCheckView, 'status' | 'conclusion'>): string {
  if (c.status === 'queued') return 'Queued';
  if (c.status === 'running') return 'Running';
  const conclusion = c.conclusion ?? 'done';
  const words: Record<string, string> = {
    success: 'Passed',
    failure: 'Failed',
    cancelled: 'Cancelled',
    timed_out: 'Timed out',
    skipped: 'Skipped',
    neutral: 'Neutral',
    action_required: 'Action required',
    stale: 'Stale',
  };
  return words[conclusion] ?? conclusion.replace(/_/g, ' ');
}

export function checkTone(c: Pick<CiCheckView, 'status' | 'conclusion'>): Tone {
  if (c.status !== 'completed') return 'warn';
  if (c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped')
    return 'ok';
  return 'danger';
}

export function checkIcon(c: Pick<CiCheckView, 'status' | 'conclusion'>): IconName {
  const tone = checkTone(c);
  if (c.status !== 'completed') return c.status === 'queued' ? 'clock' : 'refresh';
  return tone === 'ok' ? 'check' : 'stop';
}

/** The CI status a `code.pr.ci.changed` event or a view carries, when it is a known one. */
export function asCiStatus(v: unknown): CiStatus | null {
  return v === 'none' || v === 'queued' || v === 'running' || v === 'passed' || v === 'failed'
    ? v
    : null;
}

// ---- auto-verify ----------------------------------------------------------------------------

export const VERIFY_TEXT: Record<VerifyRunView['status'], string> = {
  running: 'Checking',
  passed: 'All checks passed',
  failed: 'Checks failed',
  error: 'Checks could not run',
  skipped: 'Skipped',
};

export const VERIFY_ICON: Record<VerifyRunView['status'], IconName> = {
  running: 'refresh',
  passed: 'check',
  failed: 'stop',
  error: 'alert',
  skipped: 'slash',
};

export const VERIFY_TONE: Record<VerifyRunView['status'], Tone> = {
  running: 'warn',
  passed: 'ok',
  failed: 'danger',
  error: 'danger',
  skipped: 'muted',
};

export const CHECK_TEXT: Record<VerifyCheckView['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  timeout: 'Timed out',
  error: 'Error',
  skipped: 'Skipped',
};

export const CHECK_ICON: Record<VerifyCheckView['status'], IconName> = {
  passed: 'check',
  failed: 'stop',
  timeout: 'clock',
  error: 'alert',
  skipped: 'slash',
};

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${m} min ${rest} s` : `${m} min`;
}

// ---- dev servers ----------------------------------------------------------------------------

export const SERVER_TEXT: Record<DevServerView['status'], string> = {
  starting: 'Starting',
  running: 'Serving',
  stopped: 'Stopped',
  failed: 'Failed',
};

export const SERVER_ICON: Record<DevServerView['status'], IconName> = {
  starting: 'clock',
  running: 'check',
  stopped: 'stop',
  failed: 'alert',
};

export const SERVER_TONE: Record<DevServerView['status'], Tone> = {
  starting: 'warn',
  running: 'ok',
  stopped: 'muted',
  failed: 'danger',
};

export function isLive(s: Pick<DevServerView, 'status'>): boolean {
  return s.status === 'running' || s.status === 'starting';
}

// ---- worktrees ------------------------------------------------------------------------------

/** "Leased to <session> until 14:05", "Leased to <session>", "Not leased", "Removed". */
export function leaseText(
  w: Pick<WorktreeView, 'leasedBy' | 'leaseExpiresAt' | 'status'>,
  sessionName: (id: string) => string,
  now = Date.now(),
): string {
  if (w.status === 'removed') return 'Removed from disk';
  if (!w.leasedBy) return 'Not leased';
  const who = sessionName(w.leasedBy);
  if (!w.leaseExpiresAt) return `Leased to ${who} until it is released or archived`;
  const t = Date.parse(w.leaseExpiresAt);
  if (Number.isNaN(t)) return `Leased to ${who}`;
  if (t <= now) return `Lease to ${who} has ended`;
  return `Leased to ${who} until ${formatClock(t, now)}`;
}

/** "14:05" today, else "Oct 3, 14:05". */
export function formatClock(t: number, now = Date.now()): string {
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return d.toLocaleString(undefined, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A worktree a new session may bind to: on disk and not leased (or its lease ended). */
export function isBindable(w: WorktreeView, now = Date.now()): boolean {
  if (w.status === 'removed') return false;
  if (!w.leasedBy) return true;
  return !!w.leaseExpiresAt && Date.parse(w.leaseExpiresAt) <= now;
}

/** Whether `folder` is the repository at `repoPath` or a folder inside it. */
export function inRepo(folder: string, repoPath: string): boolean {
  const f = folder.replace(/\/+$/, '');
  const r = repoPath.replace(/\/+$/, '');
  return f === r || f.startsWith(`${r}/`);
}

// ---- budgets --------------------------------------------------------------------------------

export const BOUND_TEXT: Record<NonNullable<CodeBudgetView['reached']>, string> = {
  time: 'time',
  tokens: 'tokens',
  cost: 'cost',
};

export function hasLimits(b: CodeBudgetView): boolean {
  return b.limits.timeSeconds !== null || b.limits.tokens !== null || b.limits.costUsd !== null;
}

/** "12 min / 60 min", or "12 min used" without a limit. */
export function timeText(b: CodeBudgetView): string {
  const used = formatSpan(b.used.timeSeconds);
  return b.limits.timeSeconds === null
    ? `${used} used`
    : `${used} / ${formatSpan(b.limits.timeSeconds)}`;
}

export function tokensText(b: CodeBudgetView): string {
  const used = formatTokens(b.used.tokens);
  return b.limits.tokens === null ? `${used} used` : `${used} / ${formatTokens(b.limits.tokens)}`;
}

export function costText(b: CodeBudgetView): string {
  const used = formatCost(b.used.costUsd);
  return b.limits.costUsd === null ? `${used} used` : `${used} / ${formatCost(b.limits.costUsd)}`;
}

// ---- links ----------------------------------------------------------------------------------

/** Only http(s) URLs become links; anything else (javascript:, data:) is shown as text. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Details of an ApiError body, typed loosely: the views read only known fields. */
export function errorDetails(err: unknown): Record<string, unknown> {
  const body = (err as { body?: { details?: unknown } } | null)?.body;
  const d = body?.details;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
}

export function errorReason(err: unknown): string | null {
  const r = errorDetails(err).reason;
  return typeof r === 'string' ? r : null;
}
