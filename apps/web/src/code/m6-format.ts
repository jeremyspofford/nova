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
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type { IconName } from '@nova/ui';
import { formatCost, formatSpan, formatTokens } from '../work/format.ts';

export { formatCost, formatSpan, formatTokens };

/** Kinds a user can create (the built-in local one exists already). */
export const CREATABLE_KINDS = ['container', 'ssh', 'wsl', 'device'] as const;
export type CreatableKind = (typeof CREATABLE_KINDS)[number];

export const KIND_LABEL = defineMessages('code.envKind', {
  local: 'This Hub',
  cloud: 'Cloud',
  ssh: 'SSH host',
  wsl: 'WSL',
  container: 'Container',
  vm: 'Virtual machine',
  device: 'Device',
}) satisfies Record<EnvironmentView['kind'], string>;

export const KIND_DESCRIPTION = defineMessages('code.envKindDescription', {
  container:
    'Commands run in a container image on the Hub, with a setup script run once per session.',
  ssh: 'Nova installs its helper on the host and works there over SSH. Sessions keep running while you are away.',
  wsl: 'A Linux distro on a Windows device that runs the Nova device agent.',
  device: 'A registered device that runs the Nova device agent, under that device’s own grants.',
}) satisfies Record<CreatableKind, string>;

/** Words of the format helpers below (FR-016). */
export const FORMAT_TEXT = defineMessages('code.format', {
  connection: {
    cloud: '{repos} on the cloud runner',
    cloudIn: '{repos} on the cloud runner, in {folder}',
    cloudNone: 'No repositories on the cloud runner',
    cloudNoneIn: 'No repositories on the cloud runner, in {folder}',
    local: 'The Hub itself',
    image: 'Image {image}',
    imageWithSetup: 'Image {image}, with a setup script',
    in: '{target} in {folder}',
    wsl: '{distro} on {device}',
  },
  check: {
    queued: 'Queued',
    running: 'Running',
    success: 'Passed',
    failure: 'Failed',
    cancelled: 'Cancelled',
    timed_out: 'Timed out',
    skipped: 'Skipped',
    neutral: 'Neutral',
    action_required: 'Action required',
    stale: 'Stale',
  },
  lease: {
    removed: 'Removed from disk',
    none: 'Not leased',
    untilReleased: 'Leased to {who} until it is released or archived',
    to: 'Leased to {who}',
    ended: 'Lease to {who} has ended',
    until: 'Leased to {who} until {time}',
  },
  /** A budget's use without a limit ("12 min used") and against one ("12 min / 60 min"). */
  used: '{used} used',
  usedOf: '{used} / {limit}',
});

/**
 * Whether a session in this environment works on another machine: the Hub then cannot capture
 * its diff, review it, commit, push, search symbols or run dev servers (`remote_environment`).
 * The Hub's rule: only local and container environments are on the Hub.
 */
export function isRemoteKind(kind: EnvironmentView['kind'] | null | undefined): boolean {
  return !!kind && kind !== 'local' && kind !== 'container';
}

export const HEALTH_TEXT = defineMessages('code.health', {
  ok: 'Ready',
  degraded: 'Degraded',
  down: 'Unavailable',
  unknown: 'Not checked',
}) satisfies Record<EnvironmentView['status'], string>;

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
  const T = FORMAT_TEXT.connection;
  switch (c.kind) {
    case 'cloud': {
      // M7: a cloud environment's repositories on the runner (CloudConnectionView).
      const names = c.repoUrls.map(
        (u) =>
          (u.split('#')[0] ?? u)
            .replace(/\/+$/, '')
            .split('/')
            .pop()
            ?.replace(/\.git$/, '') ?? u,
      );
      if (!c.repoUrls.length) return c.folder ? T.cloudNoneIn({ folder: c.folder }) : T.cloudNone;
      const repos = fmt.list(names, { type: 'unit', style: 'short' });
      return c.folder ? T.cloudIn({ repos, folder: c.folder }) : T.cloud({ repos });
    }
    case 'local':
      return T.local;
    case 'container':
      return c.setupScript ? T.imageWithSetup({ image: c.image }) : T.image({ image: c.image });
    case 'ssh': {
      const target = `${c.user}@${c.host}${c.port === 22 ? '' : `:${c.port}`}`;
      return c.root ? T.in({ target, folder: c.root }) : target;
    }
    case 'wsl':
      return T.wsl({ distro: c.distro, device: deviceName(c.deviceId) });
    case 'device': {
      const target = deviceName(c.deviceId);
      return c.root ? T.in({ target, folder: c.root }) : target;
    }
  }
}

/** A saved view's connection, or what the plain view implies (older Hubs send no connection). */
export function connectionOf(e: EnvironmentView): EnvironmentConnectionView | null {
  const c = (e as Partial<SavedEnvironmentView>).connection;
  if (c) return c;
  return e.kind === 'local' ? { kind: 'local' } : null;
}

// ---- pull requests and CI -----------------------------------------------------------------

export const CI_TEXT = defineMessages('code.ci', {
  none: 'No checks',
  queued: 'Checks queued',
  running: 'Checks running',
  passed: 'Checks passed',
  failed: 'Checks failed',
}) satisfies Record<CiStatus, string>;

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

export const PR_STATE_TEXT = defineMessages('code.prState', {
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
}) satisfies Record<PullRequestView['state'], string>;

/** One check's state in words: "Queued", "Running", or its conclusion. */
export function checkText(c: Pick<CiCheckView, 'status' | 'conclusion'>): string {
  if (c.status === 'queued') return FORMAT_TEXT.check.queued;
  if (c.status === 'running') return FORMAT_TEXT.check.running;
  const conclusion = c.conclusion ?? 'done';
  // An unknown conclusion is the Hub's own word, shown as it is.
  return messageFor(FORMAT_TEXT.check, conclusion) ?? conclusion.replace(/_/g, ' ');
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

export const VERIFY_TEXT = defineMessages('code.verify', {
  running: 'Checking',
  passed: 'All checks passed',
  failed: 'Checks failed',
  error: 'Checks could not run',
  skipped: 'Skipped',
}) satisfies Record<VerifyRunView['status'], string>;

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

export const CHECK_TEXT = defineMessages('code.verifyCheck', {
  passed: 'Passed',
  failed: 'Failed',
  timeout: 'Timed out',
  error: 'Error',
  skipped: 'Skipped',
}) satisfies Record<VerifyCheckView['status'], string>;

export const CHECK_ICON: Record<VerifyCheckView['status'], IconName> = {
  passed: 'check',
  failed: 'stop',
  timeout: 'clock',
  error: 'alert',
  skipped: 'slash',
};

/** "450 ms", "4.2 s", "1 min 5 s" in the active locale. */
export function formatDuration(ms: number): string {
  return fmt.duration(ms);
}

// ---- dev servers ----------------------------------------------------------------------------

export const SERVER_TEXT = defineMessages('code.server', {
  starting: 'Starting',
  running: 'Serving',
  stopped: 'Stopped',
  failed: 'Failed',
}) satisfies Record<DevServerView['status'], string>;

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
  const L = FORMAT_TEXT.lease;
  if (w.status === 'removed') return L.removed;
  if (!w.leasedBy) return L.none;
  const who = sessionName(w.leasedBy);
  if (!w.leaseExpiresAt) return L.untilReleased({ who });
  const t = Date.parse(w.leaseExpiresAt);
  if (Number.isNaN(t)) return L.to({ who });
  if (t <= now) return L.ended({ who });
  return L.until({ who, time: formatClock(t, now) });
}

/** "14:05" today, else "Oct 3, 14:05". */
export function formatClock(t: number, now = Date.now()): string {
  const d = new Date(t);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return fmt.dateTime(d, {
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

export function hasLimits(b: CodeBudgetView): boolean {
  return b.limits.timeSeconds !== null || b.limits.tokens !== null || b.limits.costUsd !== null;
}

/** "12 min / 60 min", or "12 min used" without a limit. */
export function timeText(b: CodeBudgetView): string {
  const used = formatSpan(b.used.timeSeconds);
  return b.limits.timeSeconds === null
    ? FORMAT_TEXT.used({ used })
    : FORMAT_TEXT.usedOf({ used, limit: formatSpan(b.limits.timeSeconds) });
}

export function tokensText(b: CodeBudgetView): string {
  const used = formatTokens(b.used.tokens);
  return b.limits.tokens === null
    ? FORMAT_TEXT.used({ used })
    : FORMAT_TEXT.usedOf({ used, limit: formatTokens(b.limits.tokens) });
}

export function costText(b: CodeBudgetView): string {
  const used = formatCost(b.used.costUsd);
  return b.limits.costUsd === null
    ? FORMAT_TEXT.used({ used })
    : FORMAT_TEXT.usedOf({ used, limit: formatCost(b.limits.costUsd) });
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
