// Words for the cloud runner views (FR-108, FR-071, FR-116): the runner's state, what the runner
// says of an environment and its setup, a run's status and why it stopped, usage against caps,
// sizes and durations, and the Hub's refusals in plain words (docs/04 §7). Every state pairs a
// word with an icon in the views; these are the words. They are messages (FR-016): read them at
// render time so they follow the active locale.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type {
  CloudEnvironmentView,
  CloudRunView,
  CloudRunnerState,
  CloudRunnerView,
} from '@nova/shared';
import type { IconName } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { errorDetails, errorReason, type Tone } from '../code/m6-format.ts';

export type { Tone };

/** Words the cloud runner views share. */
export const CLOUD_TEXT = defineMessages('cloud', {
  cloudRunner: 'Cloud runner',
  retry: 'Retry',
  cancel: 'Cancel',
  delete: 'Delete',
  /** A button that opens a confirmation first. */
  deleteMore: 'Delete…',
  none: 'None',
  unknown: 'Unknown',
  breadcrumb: 'Breadcrumb',
  /** Shown where a run's environment no longer exists. */
  removedEnvironment: 'A removed environment',
  /** The settings page, as a link inside a sentence. */
  settingsLink: 'Settings → Cloud runner',
  /** A state badge with a detail, such as "Setup failed: exit code 1". */
  stateDetail: '{state}: {detail}',
  /** Usage against a cap, such as "10 min of 1 h" or "512 MB of 10 GB". */
  usedOf: '{used} of {cap}',
  /** {when} is a time, such as "5 minutes ago". */
  started: 'Started {when}',
  titleOptional: 'Title (optional)',
  cpuCapMinutes: 'CPU time cap (minutes)',
  wallCapMinutes: 'Running time cap (minutes)',
  /** A duration of whole seconds, for zero seconds used. */
  seconds: '{n} s',
});

/** Settings → Cloud runner, and its environment and run pages (`?env=`, `?run=`). */
export const CLOUD_SETTINGS_PATH = '/settings/cloud';
export const cloudEnvPath = (id: string) => `${CLOUD_SETTINGS_PATH}?env=${encodeURIComponent(id)}`;
export const cloudRunPath = (id: string) => `${CLOUD_SETTINGS_PATH}?run=${encodeURIComponent(id)}`;

export interface StateSpec {
  text: string;
  icon: IconName;
  tone: Tone;
}

type Look = Omit<StateSpec, 'text'>;

export const RUNNER_STATE_TEXT = defineMessages('cloud.runnerState', {
  ok: 'Ready',
  error: 'Not reachable',
  unknown: 'Not checked yet',
  disabled: 'Off',
  unconfigured: 'Not set up',
});

const RUNNER_STATE_LOOK: Record<CloudRunnerState, Look> = {
  ok: { icon: 'check', tone: 'ok' },
  error: { icon: 'alert', tone: 'danger' },
  unknown: { icon: 'clock', tone: 'muted' },
  disabled: { icon: 'slash', tone: 'muted' },
  unconfigured: { icon: 'slash', tone: 'muted' },
};

/** The runner's state as a badge. */
export function runnerStateSpec(state: CloudRunnerState): StateSpec {
  return { text: RUNNER_STATE_TEXT[state], ...RUNNER_STATE_LOOK[state] };
}

/** Whether new cloud work can start: on, set up and not known to be failing. */
export function runnerUsable(r: Pick<CloudRunnerView, 'enabled' | 'state'>): boolean {
  return r.enabled && (r.state === 'ok' || r.state === 'unknown');
}

type RunnerEnvStatus = NonNullable<CloudEnvironmentView['runner']>['status'];

export const ENV_STATE_TEXT = defineMessages('cloud.envState', {
  provisioning: 'Setting up',
  ready: 'Ready',
  failed: 'Setup failed',
  deleting: 'Removing',
  /** The Hub could not ask the runner about this environment. */
  noRunner: 'Runner not reachable',
});

const ENV_STATE_LOOK: Record<RunnerEnvStatus, Look> = {
  provisioning: { icon: 'refresh', tone: 'warn' },
  ready: { icon: 'check', tone: 'ok' },
  failed: { icon: 'alert', tone: 'danger' },
  deleting: { icon: 'trash', tone: 'muted' },
};

/** What the list shows for an environment: the runner's status, or why there is none. */
export function environmentState(e: CloudEnvironmentView): StateSpec {
  if (e.runner)
    return { text: ENV_STATE_TEXT[e.runner.status], ...ENV_STATE_LOOK[e.runner.status] };
  return { text: ENV_STATE_TEXT.noRunner, icon: 'alert', tone: 'warn' };
}

/** The setup script's result, as the runner reports it. */
export const SETUP_TEXT = defineMessages('cloud.setup', {
  status: {
    none: 'No setup script.',
    running: 'The setup script is running.',
    ok: 'The setup script finished.',
    failed: 'The setup script failed.',
  },
  /** {when} is when the setup ended, such as "5 minutes ago" or a date. */
  statusAt: {
    running: 'The setup script is running, {when}.',
    ok: 'The setup script finished, {when}.',
    failed: 'The setup script failed, {when}.',
  },
  failedCode: 'The setup script failed (exit code {code}).',
  /** {when} is when the setup ended, such as "5 minutes ago" or a date. */
  failedCodeAt: 'The setup script failed (exit code {code}), {when}.',
  fixIt: 'Fix the script or the repositories, then rebuild.',
});

export const NETWORK_TEXT = defineMessages('cloud.network', {
  off: 'No network',
  setup: 'Network only while the setup script runs',
  on: 'Network on',
});

export const NETWORK_DESCRIPTION = defineMessages('cloud.networkDescription', {
  off: 'Commands cannot reach the network. The runner still clones the repositories.',
  setup:
    'Only the setup script reaches the network, to install dependencies, straight from the runner without the Hub’s egress rules. Commands after it cannot.',
  on: 'Every command reaches the network straight from the runner, without the Hub’s egress rules or audit.',
});

export const RUN_STATUS_TEXT = defineMessages('cloud.runStatus', {
  active: 'Running',
  capped: 'Stopped at a cap',
  completed: 'Finished',
  cancelled: 'Cancelled',
  failed: 'Failed',
  lost: 'Lost by the runner',
});

const RUN_STATUS_LOOK: Record<CloudRunView['status'], Look> = {
  active: { icon: 'refresh', tone: 'warn' },
  capped: { icon: 'stop', tone: 'danger' },
  completed: { icon: 'check', tone: 'ok' },
  cancelled: { icon: 'slash', tone: 'muted' },
  failed: { icon: 'alert', tone: 'danger' },
  lost: { icon: 'alert', tone: 'danger' },
};

/** A run's status as a badge. */
export function runStatusSpec(status: CloudRunView['status']): StateSpec {
  return { text: RUN_STATUS_TEXT[status], ...RUN_STATUS_LOOK[status] };
}

/** What a cloud run belongs to. */
export const RUN_KIND = defineMessages('cloud.runKind', {
  code: 'Code session',
  work: 'Work run',
  system: 'The Hub',
});

/** The resource a cap applies to, as a `select` value for messages. */
export type CapResource = 'cpu' | 'wall' | 'disk' | 'other';

export function capResource(resource: string | null | undefined): CapResource {
  return resource === 'cpu' || resource === 'wall' || resource === 'disk' ? resource : 'other';
}

/** Caps in words. */
export const CAP_TEXT = defineMessages('cloud.caps', {
  /** A resource's name inside a sentence: "Set the {what} cap in whole minutes". */
  resource: { cpu: 'CPU time', wall: 'running time' },
  /** The usage meters' labels. */
  meter: { cpu: 'CPU time', wall: 'Running time' },
  /** {what} is a resource's name, such as "CPU time". */
  wholeMinutes: 'Set the {what} cap in whole minutes, from {min} to {max}.',
  /** {used} is a duration, such as "1 h"; {what} a resource's name, such as "CPU time". */
  aboveUsed: 'The run has used {used} of {what}; set a cap above that.',
});

export const SNAPSHOT_REASON = defineMessages('cloud.snapshotReason', {
  manual: 'Taken by you',
  run_start: 'Before a Work run',
  before_restore: 'Before a restore',
});

export function isLiveRun(r: Pick<CloudRunView, 'status'>): boolean {
  return r.status === 'active' || r.status === 'capped';
}

/**
 * "45 s", "12 min", "1 h 5 min" in the active locale: whole seconds, the seconds dropped from
 * ten minutes on and the minutes kept with hours.
 */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return CLOUD_TEXT.seconds({ n: 0 });
  if (s < 60) return fmt.duration(s * 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return fmt.duration((s % 60 && m < 10 ? s : m * 60) * 1000);
  return fmt.duration(m * 60_000);
}

/** "512 B", "12.5 KB", "3.2 GB" (1024-based, as disks report) in the active locale. */
export function formatBytes(n: number): string {
  return fmt.bytes(n);
}

export interface UsageLine {
  resource: 'cpu' | 'wall';
  label: string;
  used: number;
  cap: number;
  share: number;
  /** Past the warning share (or the runner said so). */
  warn: boolean;
  /** Stopped at this cap. */
  capped: boolean;
}

/** CPU and running time against their caps, with the warning and capped state of each. */
export function usageLines(r: CloudRunView, warnAt = 0.8): UsageLine[] {
  const line = (resource: 'cpu' | 'wall', used: number, cap: number): UsageLine => {
    const share = cap > 0 ? used / cap : 0;
    const capped = r.status === 'capped' && r.reason === resource;
    return {
      resource,
      label: CAP_TEXT.meter[resource],
      used,
      cap,
      share,
      warn: !capped && (share >= warnAt || r.warnings.includes(resource)),
      capped,
    };
  };
  return [
    line('cpu', r.usage.cpuSeconds, r.caps.cpuSeconds),
    line('wall', r.usage.wallSeconds, r.caps.wallSeconds),
  ];
}

/** Why a run ended or stopped. */
export const RUN_REASON_TEXT = defineMessages('cloud.runReason', {
  capped:
    '{resource, select, cpu {It reached its CPU time cap.} wall {It reached its running time cap.} disk {It reached its disk cap.} other {It reached a cap.}}',
  lost: 'The runner no longer knows this run.',
  cancelled: 'It was cancelled.',
  /** {reason} is the runner's own words (English). */
  failedBecause: 'It failed: {reason}.',
  failed: 'It failed.',
});

/** Why a run ended or stopped, in words, or null when there is nothing to say. */
export function runReasonText(r: CloudRunView): string | null {
  const S = RUN_REASON_TEXT;
  if (r.status === 'capped') return S.capped({ resource: capResource(r.reason) });
  if (r.status === 'lost') return S.lost;
  if (r.status === 'cancelled') return S.cancelled;
  if (r.status === 'failed') return r.reason ? S.failedBecause({ reason: r.reason }) : S.failed;
  return null;
}

/** The Hub's refusals about the runner, its environments and runs, in plain words. */
export const CLOUD_ERROR_TEXT = defineMessages('cloud.errors', {
  didNotWork: 'That did not work.',
  /** {where} is the settings page's name, "Settings → Cloud runner". */
  runner_unconfigured: 'No cloud runner is set up. Set one up in {where}.',
  runner_disabled: 'The cloud runner is turned off. Turn it on in {where}.',
  runner_token_missing: 'The runner token is missing from the vault. Enter it again in {where}.',
  runner_token: 'The runner refused the token. Enter a new one in {where}.',
  /** {why} is the runner's own words (English). */
  testFailedBecause: 'The runner did not pass its test, so it was not turned on: {why}.',
  testFailed: 'The runner did not pass its test, so it was not turned on.',
  unreachable: 'The cloud runner cannot be reached.',
  gone: 'It no longer exists.',
  /** By the Hub's reason code. */
  reason: {
    token_required: 'Enter the runner token.',
    no_cloud_runner: 'This Hub has no cloud runner.',
    busy: 'Commands are running in this environment. Wait for them to finish, or cancel its runs first.',
    cap_reached: 'The run reached its cap. Raise the caps to continue.',
    ended: 'This run has ended.',
    not_ready: 'The environment is not ready yet. Wait for its setup to finish.',
    not_cloud: 'That is not a cloud environment.',
    review_model_required:
      'An autonomous run needs a reviewer model. Choose one in Settings → Code.',
    in_use: 'Sessions still use this environment. Archive them first.',
    managed: 'Your organization manages this setting.',
    cloud_network_off:
      'Cloud environments get no network on this Hub, because their traffic would not pass the Hub’s egress rules. Choose No network, or turn on Unrestricted network in Settings → Cloud runner.',
    credentials_in_url: 'Leave user names and passwords out of repository addresses.',
    runner_path: 'The runner reported a folder outside /workspace, so the Hub refused to use it.',
    not_a_folder: 'There is nothing at that path on the runner now.',
    not_a_file: 'There is nothing at that path on the runner now.',
    outside_workspace: 'Paths on the runner must be full paths under /workspace.',
    relative: 'Paths on the runner must be full paths under /workspace.',
  },
});

/** Hub text as a sentence: capitalized, ending in a period. */
function sentence(text: string): string {
  return `${capitalize(text)}${/[.!?]$/.test(text) ? '' : '.'}`;
}

/** A Hub refusal about the runner, its environments or runs, in plain words. */
export function cloudErrorMessage(
  err: unknown,
  fallback: string = CLOUD_ERROR_TEXT.didNotWork,
): string {
  const E = CLOUD_ERROR_TEXT;
  const reason = errorReason(err);
  const where = CLOUD_TEXT.settingsLink;
  switch (reason) {
    case 'runner_unconfigured':
    case 'runner_disabled':
    case 'runner_token_missing':
    case 'runner_token':
      return E[reason]({ where });
    case 'runner_test_failed': {
      const test = errorDetails(err).test as { detail?: unknown } | undefined;
      const why = typeof test?.detail === 'string' ? test.detail : null;
      return why ? E.testFailedBecause({ why }) : E.testFailed;
    }
    case 'runner_unreachable': {
      const text = errorMessage(err, E.unreachable);
      return text === E.unreachable ? text : sentence(text);
    }
    case 'over_cap':
      // The Hub names the cap and the value (English, D9).
      return sentence(errorMessage(err));
    default: {
      const words = reason ? messageFor(E.reason, reason) : undefined;
      if (words) return words;
    }
  }
  if (err instanceof ApiError && err.status === 404) return E.gone;
  const text = errorMessage(err, fallback);
  return text === fallback ? text : sentence(text);
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "repo" from "https://host/org/repo.git#branch". */
export function repoName(url: string): string {
  const noRef = url.split('#')[0] ?? url;
  const last = noRef.replace(/\/+$/, '').split('/').pop() ?? noRef;
  return last.replace(/\.git$/, '') || noRef;
}
