// Words for the cloud runner views (FR-108, FR-071, FR-116): the runner's state, what the runner
// says of an environment and its setup, a run's status and why it stopped, usage against caps,
// sizes and durations, and the Hub's refusals in plain words (docs/04 §7). Every state pairs a
// word with an icon in the views; these are the words.
import type {
  CloudEnvironmentView,
  CloudRunView,
  CloudRunnerState,
  CloudRunnerView,
  CloudSnapshotView,
} from '@nova/shared';
import type { IconName } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { errorDetails, errorReason, type Tone } from '../code/m6-format.ts';

export type { Tone };

/** Settings → Cloud runner, and its environment and run pages (`?env=`, `?run=`). */
export const CLOUD_SETTINGS_PATH = '/settings/cloud';
export const cloudEnvPath = (id: string) => `${CLOUD_SETTINGS_PATH}?env=${encodeURIComponent(id)}`;
export const cloudRunPath = (id: string) => `${CLOUD_SETTINGS_PATH}?run=${encodeURIComponent(id)}`;

export interface StateSpec {
  text: string;
  icon: IconName;
  tone: Tone;
}

export const RUNNER_STATE: Record<CloudRunnerState, StateSpec> = {
  ok: { text: 'Ready', icon: 'check', tone: 'ok' },
  error: { text: 'Not reachable', icon: 'alert', tone: 'danger' },
  unknown: { text: 'Not checked yet', icon: 'clock', tone: 'muted' },
  disabled: { text: 'Off', icon: 'slash', tone: 'muted' },
  unconfigured: { text: 'Not set up', icon: 'slash', tone: 'muted' },
};

/** Whether new cloud work can start: on, set up and not known to be failing. */
export function runnerUsable(r: Pick<CloudRunnerView, 'enabled' | 'state'>): boolean {
  return r.enabled && (r.state === 'ok' || r.state === 'unknown');
}

type RunnerEnvStatus = NonNullable<CloudEnvironmentView['runner']>['status'];

export const RUNNER_ENV_STATUS: Record<RunnerEnvStatus, StateSpec> = {
  provisioning: { text: 'Setting up', icon: 'refresh', tone: 'warn' },
  ready: { text: 'Ready', icon: 'check', tone: 'ok' },
  failed: { text: 'Setup failed', icon: 'alert', tone: 'danger' },
  deleting: { text: 'Removing', icon: 'trash', tone: 'muted' },
};

/** What the list shows for an environment: the runner's status, or why there is none. */
export function environmentState(e: CloudEnvironmentView): StateSpec {
  if (e.runner) return RUNNER_ENV_STATUS[e.runner.status];
  return { text: 'Runner not reachable', icon: 'alert', tone: 'warn' };
}

type SetupStatus = NonNullable<CloudEnvironmentView['runner']>['setup']['status'];

export const SETUP_TEXT: Record<SetupStatus, string> = {
  none: 'No setup script',
  running: 'The setup script is running',
  ok: 'The setup script finished',
  failed: 'The setup script failed',
};

export const NETWORK_TEXT: Record<CloudEnvironmentView['connection']['network'], string> = {
  off: 'No network',
  setup: 'Network only while the setup script runs',
  on: 'Network on',
};

export const NETWORK_DESCRIPTION: Record<CloudEnvironmentView['connection']['network'], string> = {
  off: 'Commands cannot reach the network. The runner still clones the repositories.',
  setup:
    'Only the setup script reaches the network, to install dependencies, straight from the runner without the Hub’s egress rules. Commands after it cannot.',
  on: 'Every command reaches the network straight from the runner, without the Hub’s egress rules or audit.',
};

export const RUN_STATUS: Record<CloudRunView['status'], StateSpec> = {
  active: { text: 'Running', icon: 'refresh', tone: 'warn' },
  capped: { text: 'Stopped at a cap', icon: 'stop', tone: 'danger' },
  completed: { text: 'Finished', icon: 'check', tone: 'ok' },
  cancelled: { text: 'Cancelled', icon: 'slash', tone: 'muted' },
  failed: { text: 'Failed', icon: 'alert', tone: 'danger' },
  lost: { text: 'Lost by the runner', icon: 'alert', tone: 'danger' },
};

export const RUN_KIND: Record<CloudRunView['kind'], string> = {
  code: 'Code session',
  work: 'Work run',
  system: 'The Hub',
};

/** A resource a cap applies to, in words. */
export function resourceText(resource: string | null | undefined): string {
  switch (resource) {
    case 'cpu':
      return 'CPU time';
    case 'wall':
      return 'running time';
    case 'disk':
      return 'disk';
    default:
      return resource ? resource : 'a';
  }
}

export const SNAPSHOT_REASON: Record<CloudSnapshotView['reason'], string> = {
  manual: 'Taken by you',
  run_start: 'Before a Work run',
  before_restore: 'Before a restore',
};

export function isLiveRun(r: Pick<CloudRunView, 'status'>): boolean {
  return r.status === 'active' || r.status === 'capped';
}

/** "45 s", "12 min", "1 h 5 min". */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rest = s % 60;
    return rest && m < 10 ? `${m} min ${rest} s` : `${m} min`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}

/** "512 B", "12.5 KB", "3.2 GB" (1024-based, as disks report). */
export function formatBytes(n: number): string {
  const v = Math.max(0, n);
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`;
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
      label: resource === 'cpu' ? 'CPU time' : 'Running time',
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

/** Why a run ended or stopped, in words, or null when there is nothing to say. */
export function runReasonText(r: CloudRunView): string | null {
  if (r.status === 'capped') return `It reached its ${resourceText(r.reason)} cap.`;
  if (r.status === 'lost') return 'The runner no longer knows this run.';
  if (r.status === 'cancelled') return 'It was cancelled.';
  if (r.status === 'failed') return r.reason ? `It failed: ${r.reason}.` : 'It failed.';
  return null;
}

/** "Settings → Cloud runner" in a refusal's next step. */
const WHERE = 'Settings → Cloud runner';

/** A Hub refusal about the runner, its environments or runs, in plain words. */
export function cloudErrorMessage(err: unknown, fallback = 'That did not work.'): string {
  const reason = errorReason(err);
  const detail = errorDetails(err);
  switch (reason) {
    case 'runner_unconfigured':
      return `No cloud runner is set up. Set one up in ${WHERE}.`;
    case 'runner_disabled':
      return `The cloud runner is turned off. Turn it on in ${WHERE}.`;
    case 'runner_token_missing':
      return `The runner token is missing from the vault. Enter it again in ${WHERE}.`;
    case 'runner_token':
      return `The runner refused the token. Enter a new one in ${WHERE}.`;
    case 'token_required':
      return 'Enter the runner token.';
    case 'runner_test_failed': {
      const test = detail.test as { detail?: unknown } | undefined;
      const why = typeof test?.detail === 'string' ? test.detail : null;
      return why
        ? `The runner did not pass its test, so it was not turned on: ${why}.`
        : 'The runner did not pass its test, so it was not turned on.';
    }
    case 'runner_unreachable':
      return `${capitalize(errorMessage(err, 'The cloud runner cannot be reached.'))}.`;
    case 'no_cloud_runner':
      return 'This Hub has no cloud runner.';
    case 'busy':
      return 'Commands are running in this environment. Wait for them to finish, or cancel its runs first.';
    case 'cap_reached':
      return 'The run reached its cap. Raise the caps to continue.';
    case 'ended':
      return 'This run has ended.';
    case 'not_ready':
      return 'The environment is not ready yet. Wait for its setup to finish.';
    case 'not_cloud':
      return 'That is not a cloud environment.';
    case 'review_model_required':
      return 'An autonomous run needs a reviewer model. Choose one in Settings → Code.';
    case 'in_use':
      return 'Sessions still use this environment. Archive them first.';
    case 'managed':
      return 'Your organization manages this setting.';
    case 'over_cap':
      return `${capitalize(errorMessage(err))}.`;
    case 'cloud_network_off':
      return 'Cloud environments get no network on this Hub, because their traffic would not pass the Hub’s egress rules. Choose No network, or turn on Unrestricted network in Settings → Cloud runner.';
    case 'credentials_in_url':
      return 'Leave user names and passwords out of repository addresses.';
    case 'runner_path':
      return 'The runner reported a folder outside /workspace, so the Hub refused to use it.';
    case 'not_a_folder':
    case 'not_a_file':
      return 'There is nothing at that path on the runner now.';
    case 'outside_workspace':
    case 'relative':
      return 'Paths on the runner must be full paths under /workspace.';
    default:
      break;
  }
  if (err instanceof ApiError && err.status === 404) return 'It no longer exists.';
  const text = errorMessage(err, fallback);
  return text === fallback ? text : `${capitalize(text)}${/[.!?]$/.test(text) ? '' : '.'}`;
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
