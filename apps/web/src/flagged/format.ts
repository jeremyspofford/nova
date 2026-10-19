// Words for the flagged features (FR-202, FR-203): script run states and why a script stopped, the
// status of each nested call and the policy gate's decision on it, adapter checks, delegation
// states, and the Hub's refusals in plain words. Where each feature is turned on, for the views
// that say so while it is off.
import type { DelegationView, ScriptRunView, ToolCallStatus } from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import { errorReason } from '../code/m6-format.ts';
import type { Spec } from '../code/m7-format.ts';

export type { Spec };

/** Settings → Experimental, where both features are turned on. */
export const EXPERIMENTAL_PATH = '/settings/experimental';
export const EXPERIMENTAL_LABEL = 'Settings → Experimental';

export const FLAGGED_EVENTS = {
  scripts: ['tool.call.started', 'tool.call.completed', 'settings.changed'],
  delegations: [
    'delegation.started',
    'delegation.updated',
    'delegation.finished',
    'settings.changed',
  ],
} as const;

export const SCRIPT_STATUS: Record<ScriptRunView['status'], Spec> = {
  running: { text: 'Running', icon: 'refresh', tone: 'warn' },
  ok: { text: 'Finished', icon: 'check', tone: 'ok' },
  error: { text: 'Stopped', icon: 'alert', tone: 'danger' },
  cancelled: { text: 'Cancelled', icon: 'slash', tone: 'muted' },
};

/** Why a script stopped, in words. */
export function scriptErrorText(code: string | null): string | null {
  switch (code) {
    case null:
      return null;
    case 'cpu_limit':
      return 'It used up its time limit.';
    case 'memory_limit':
      return 'It used up its memory limit.';
    case 'stack_limit':
      return 'It nested calls too deeply.';
    case 'call_limit':
      return 'It made more tool calls than a script may.';
    case 'syntax_error':
      return 'The script did not parse.';
    case 'script_error':
      return 'The script threw an error.';
    case 'tool_error':
      return 'A tool it called failed.';
    case 'cancelled':
      return 'It was cancelled.';
    default:
      return `It stopped: ${code.replace(/_/g, ' ')}.`;
  }
}

export const CALL_STATUS: Record<ToolCallStatus, Spec> = {
  pending: { text: 'Waiting', icon: 'clock', tone: 'muted' },
  awaiting_approval: { text: 'Waiting for approval', icon: 'hand', tone: 'warn' },
  running: { text: 'Running', icon: 'refresh', tone: 'warn' },
  ok: { text: 'Done', icon: 'check', tone: 'ok' },
  error: { text: 'Failed', icon: 'alert', tone: 'danger' },
  denied: { text: 'Denied', icon: 'slash', tone: 'danger' },
  timeout: { text: 'Timed out', icon: 'clock', tone: 'danger' },
  cancelled: { text: 'Cancelled', icon: 'slash', tone: 'muted' },
};

/** The policy gate's decision on a nested call, in words. */
export function decisionText(decision: string | null): string {
  switch (decision) {
    case null:
      return 'Not decided yet';
    case 'allow':
      return 'Allowed by policy';
    case 'ask':
      return 'Asked you';
    case 'deny':
      return 'Denied by policy';
    case 'handoff':
      return 'Handed to you';
    case 'deny_continue':
    case 'deny_stop':
      return 'Denied by you';
    case 'timeout':
      return 'No answer in time';
    default:
      return decision.replace(/_/g, ' ');
  }
}

export const DELEGATION_STATUS: Record<DelegationView['status'], Spec> = {
  starting: { text: 'Starting', icon: 'clock', tone: 'warn' },
  running: { text: 'Working', icon: 'refresh', tone: 'warn' },
  completed: { text: 'Finished', icon: 'check', tone: 'ok' },
  failed: { text: 'Failed', icon: 'alert', tone: 'danger' },
  cancelled: { text: 'Cancelled', icon: 'slash', tone: 'muted' },
};

export function isLiveDelegation(d: Pick<DelegationView, 'status'>): boolean {
  return d.status === 'starting' || d.status === 'running';
}

/** Why the agent stopped, when it says. */
export function stopReasonText(reason: string | null): string | null {
  switch (reason) {
    case null:
    case 'end_turn':
      return null;
    case 'max_tokens':
      return 'It ran out of output tokens.';
    case 'max_turn_requests':
      return 'It reached its limit of requests.';
    case 'refusal':
      return 'The agent refused the task.';
    case 'cancelled':
      return 'It was cancelled.';
    default:
      return `It stopped: ${reason.replace(/_/g, ' ')}.`;
  }
}

/** A refusal of a flagged-feature request, in plain words. */
export function flaggedErrorMessage(
  err: unknown,
  feature: 'scripts' | 'agents',
  fallback = 'That did not work.',
): string {
  switch (errorReason(err)) {
    case 'permission_routing':
      return 'This adapter cannot send its permission requests to Nova, so it cannot be added. Nova must decide every request an agent makes.';
    case 'foreign_secret':
      return 'A variable points at a secret this adapter does not own. Enter the value itself; Nova keeps it in the adapter’s own part of the vault.';
    case 'no_substrate':
      return 'This session runs on an SSH host, in WSL or on a device, where commands have no sandbox, so an external agent cannot run there. Use a session on the Hub, in a container or in the cloud.';
    case 'no_egress_proxy':
      return 'This adapter declares hosts it may reach, but this session’s sandbox (such as the cloud runner’s) cannot hold it to them. Remove its hosts, or use a session on the Hub or in a container.';
    default:
      break;
  }
  if (err instanceof ApiError && err.status === 404 && /turned off/.test(err.body.message))
    return feature === 'scripts'
      ? `Scripted tool calls are off. Turn them on in ${EXPERIMENTAL_LABEL}.`
      : `External coding agents are off. Turn them on in ${EXPERIMENTAL_LABEL}.`;
  if (err instanceof ApiError && err.status === 409) {
    if (/already working/.test(err.body.message))
      return 'An external agent is already working in this session. Wait for it, or cancel it.';
    if (/turned off/.test(err.body.message)) return 'That adapter is turned off. Turn it on first.';
    if (/name exists/.test(err.body.message)) return 'An adapter with this name exists already.';
    if (/archived/.test(err.body.message)) return 'The Code session is archived.';
  }
  return errorMessage(err, fallback);
}

const REFUSALS: [RegExp, string][] = [
  [
    /without a sandbox|no_substrate/i,
    'This session runs on an SSH host, in WSL or on a device, where commands have no sandbox, so an external agent cannot run there. Use a session on the Hub, in a container or in the cloud.',
  ],
  [
    /cannot hold an agent to its declared hosts|no_egress_proxy/i,
    'This adapter declares hosts it may reach, but this session’s sandbox (such as the cloud runner’s) cannot hold it to them. Remove its hosts, or use a session on the Hub or in a container.',
  ],
  [
    /does not own|foreign_secret/i,
    'A variable points at a secret this adapter does not own, so the agent was not started. Enter the value itself in the adapter.',
  ],
];

/** Why a delegation or a check failed (the Hub records its message), in plain words. */
export function failureText(message: string | null): string | null {
  if (!message) return null;
  for (const [re, text] of REFUSALS) if (re.test(message)) return text;
  const m = message.replace(/^refused: /, 'Refused: ');
  return `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}`;
}
