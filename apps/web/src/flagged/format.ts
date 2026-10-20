// Words for the flagged features (FR-202, FR-203): script run states and why a script stopped, the
// status of each nested call and the policy gate's decision on it, adapter checks, delegation
// states, and the Hub's refusals in plain words. Where each feature is turned on, for the views
// that say so while it is off. The words are messages (FR-016): read them at render time so they
// follow the active locale.
import { defineMessages, messageFor, subscribe } from '@nova/i18n';
import type { DelegationView, ScriptRunView, ToolCallStatus } from '@nova/shared';
import type { IconName } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { errorReason, type Tone } from '../code/m6-format.ts';
import type { Spec } from '../code/m7-format.ts';

export type { Spec };

/** Words the flagged views share. */
export const FLAGGED_TEXT = defineMessages('flagged', {
  /** Where both features are turned on: the Settings page as the navigation names it. */
  where: 'Settings → Experimental',
  didNotWork: 'That did not work.',
  retry: 'Retry',
  close: 'Close',
  cancel: 'Cancel',
  /** A refusal the Hub explains in its own words: "Refused: <the Hub's reason>". */
  refused: 'Refused: {reason}',
});

/** Settings → Experimental, where both features are turned on. */
export const EXPERIMENTAL_PATH = '/settings/experimental';
/**
 * The page's name in the active locale, for other areas (CodeM7Settings renders it). A live
 * binding, updated when the locale changes: read it at render time (copying it into a constant at
 * load freezes the language). Inside flagged/ use `FLAGGED_TEXT.where`.
 */
export let EXPERIMENTAL_LABEL = FLAGGED_TEXT.where;
subscribe(() => {
  EXPERIMENTAL_LABEL = FLAGGED_TEXT.where;
});

export const FLAGGED_EVENTS = {
  scripts: ['tool.call.started', 'tool.call.completed', 'settings.changed'],
  delegations: [
    'delegation.started',
    'delegation.updated',
    'delegation.finished',
    'settings.changed',
  ],
} as const;

/** The state words of script runs, their nested calls and delegations. */
export const FLAGGED_STATUS_TEXT = defineMessages('flagged.status', {
  script: {
    running: 'Running',
    ok: 'Finished',
    error: 'Stopped',
    cancelled: 'Cancelled',
  },
  call: {
    pending: 'Waiting',
    awaiting_approval: 'Waiting for approval',
    running: 'Running',
    ok: 'Done',
    error: 'Failed',
    denied: 'Denied',
    timeout: 'Timed out',
    cancelled: 'Cancelled',
  },
  delegation: {
    starting: 'Starting',
    running: 'Working',
    completed: 'Finished',
    failed: 'Failed',
    cancelled: 'Cancelled',
  },
});

/** A spec whose word is read when it is shown, so it follows the active locale. */
function spec(text: () => string, icon: IconName, tone: Tone): Spec {
  return {
    get text() {
      return text();
    },
    icon,
    tone,
  };
}

const ST = FLAGGED_STATUS_TEXT;

export const SCRIPT_STATUS: Record<ScriptRunView['status'], Spec> = {
  running: spec(() => ST.script.running, 'refresh', 'warn'),
  ok: spec(() => ST.script.ok, 'check', 'ok'),
  error: spec(() => ST.script.error, 'alert', 'danger'),
  cancelled: spec(() => ST.script.cancelled, 'slash', 'muted'),
};

/** Why a script stopped, by the Hub's error code. */
export const SCRIPT_ERROR_TEXT = defineMessages('flagged.scriptError', {
  cpu_limit: 'It used up its time limit.',
  memory_limit: 'It used up its memory limit.',
  stack_limit: 'It nested calls too deeply.',
  call_limit: 'It made more tool calls than a script may.',
  syntax_error: 'The script did not parse.',
  script_error: 'The script threw an error.',
  tool_error: 'A tool it called failed.',
  cancelled: 'It was cancelled.',
  /** An error code without words of its own, as the Hub names it ("weird stop"). */
  other: 'It stopped: {code}.',
});

/** Why a script stopped, in words. */
export function scriptErrorText(code: string | null): string | null {
  if (code === null) return null;
  return (
    messageFor(SCRIPT_ERROR_TEXT, code) ??
    SCRIPT_ERROR_TEXT.other({ code: code.replace(/_/g, ' ') })
  );
}

export const CALL_STATUS: Record<ToolCallStatus, Spec> = {
  pending: spec(() => ST.call.pending, 'clock', 'muted'),
  awaiting_approval: spec(() => ST.call.awaiting_approval, 'hand', 'warn'),
  running: spec(() => ST.call.running, 'refresh', 'warn'),
  ok: spec(() => ST.call.ok, 'check', 'ok'),
  error: spec(() => ST.call.error, 'alert', 'danger'),
  denied: spec(() => ST.call.denied, 'slash', 'danger'),
  timeout: spec(() => ST.call.timeout, 'clock', 'danger'),
  cancelled: spec(() => ST.call.cancelled, 'slash', 'muted'),
};

/** The policy gate's decision on a nested call. */
export const DECISION_TEXT = defineMessages('flagged.decision', {
  undecided: 'Not decided yet',
  /** The person denied it when asked (to continue or to stop the script). */
  deniedByYou: 'Denied by you',
  /** By the gate's decision code. */
  by: {
    allow: 'Allowed by policy',
    ask: 'Asked you',
    deny: 'Denied by policy',
    handoff: 'Handed to you',
    timeout: 'No answer in time',
  },
});

/** The policy gate's decision on a nested call, in words (an unknown code as the Hub names it). */
export function decisionText(decision: string | null): string {
  if (decision === null) return DECISION_TEXT.undecided;
  if (decision === 'deny_continue' || decision === 'deny_stop') return DECISION_TEXT.deniedByYou;
  return messageFor(DECISION_TEXT.by, decision) ?? decision.replace(/_/g, ' ');
}

export const DELEGATION_STATUS: Record<DelegationView['status'], Spec> = {
  starting: spec(() => ST.delegation.starting, 'clock', 'warn'),
  running: spec(() => ST.delegation.running, 'refresh', 'warn'),
  completed: spec(() => ST.delegation.completed, 'check', 'ok'),
  failed: spec(() => ST.delegation.failed, 'alert', 'danger'),
  cancelled: spec(() => ST.delegation.cancelled, 'slash', 'muted'),
};

export function isLiveDelegation(d: Pick<DelegationView, 'status'>): boolean {
  return d.status === 'starting' || d.status === 'running';
}

/** Why the agent stopped, by its protocol's stop reason. */
export const STOP_REASON_TEXT = defineMessages('flagged.stopReason', {
  max_tokens: 'It ran out of output tokens.',
  max_turn_requests: 'It reached its limit of requests.',
  refusal: 'The agent refused the task.',
  cancelled: 'It was cancelled.',
  /** A stop reason without words of its own, as the agent names it ("out of time"). */
  other: 'It stopped: {reason}.',
});

/** Why the agent stopped, when it says. */
export function stopReasonText(reason: string | null): string | null {
  if (reason === null || reason === 'end_turn') return null;
  return (
    messageFor(STOP_REASON_TEXT, reason) ??
    STOP_REASON_TEXT.other({ reason: reason.replace(/_/g, ' ') })
  );
}

/** The Hub's refusals of flagged-feature requests, in plain words. */
export const FLAGGED_ERROR_TEXT = defineMessages('flagged.errors', {
  /** By the Hub's reason code. */
  reason: {
    permission_routing:
      'This adapter cannot send its permission requests to Nova, so it cannot be added. Nova ' +
      'must decide every request an agent makes.',
    foreign_secret:
      'A variable points at a secret this adapter does not own. Enter the value itself; Nova ' +
      'keeps it in the adapter’s own part of the vault.',
    no_substrate:
      'This session runs on an SSH host, in WSL or on a device, where commands have no sandbox, ' +
      'so an external agent cannot run there. Use a session on the Hub, in a container or in ' +
      'the cloud.',
    no_egress_proxy:
      'This adapter declares hosts it may reach, but this session’s sandbox (such as the cloud ' +
      'runner’s) cannot hold it to them. Remove its hosts, or use a session on the Hub or in a ' +
      'container.',
  },
  /** A delegation that did not start because a variable points at another adapter's secret. */
  notStartedForeignSecret:
    'A variable points at a secret this adapter does not own, so the agent was not started. ' +
    'Enter the value itself in the adapter.',
  /** {where} is the Settings page's name, "Settings → Experimental". */
  scriptsOff: 'Scripted tool calls are off. Turn them on in {where}.',
  /** {where} is the Settings page's name, "Settings → Experimental". */
  agentsOff: 'External coding agents are off. Turn them on in {where}.',
  alreadyWorking:
    'An external agent is already working in this session. Wait for it, or cancel it.',
  adapterOff: 'That adapter is turned off. Turn it on first.',
  nameExists: 'An adapter with this name exists already.',
  archived: 'The Code session is archived.',
});

/** A refusal of a flagged-feature request, in plain words. */
export function flaggedErrorMessage(
  err: unknown,
  feature: 'scripts' | 'agents',
  fallback: string = FLAGGED_TEXT.didNotWork,
): string {
  const E = FLAGGED_ERROR_TEXT;
  const byReason = messageFor(E.reason, errorReason(err) ?? '');
  if (byReason) return byReason;
  if (err instanceof ApiError && err.status === 404 && /turned off/.test(err.body.message))
    return feature === 'scripts'
      ? E.scriptsOff({ where: FLAGGED_TEXT.where })
      : E.agentsOff({ where: FLAGGED_TEXT.where });
  if (err instanceof ApiError && err.status === 409) {
    if (/already working/.test(err.body.message)) return E.alreadyWorking;
    if (/turned off/.test(err.body.message)) return E.adapterOff;
    if (/name exists/.test(err.body.message)) return E.nameExists;
    if (/archived/.test(err.body.message)) return E.archived;
  }
  return errorMessage(err, fallback);
}

const REFUSALS: [RegExp, () => string][] = [
  [/without a sandbox|no_substrate/i, () => FLAGGED_ERROR_TEXT.reason.no_substrate],
  [
    /cannot hold an agent to its declared hosts|no_egress_proxy/i,
    () => FLAGGED_ERROR_TEXT.reason.no_egress_proxy,
  ],
  [/does not own|foreign_secret/i, () => FLAGGED_ERROR_TEXT.notStartedForeignSecret],
];

/**
 * Why a delegation or a check failed, in plain words: the refusals Nova knows in its own words,
 * anything else as the Hub recorded it (English, D9) as a sentence.
 */
export function failureText(message: string | null): string | null {
  if (!message) return null;
  for (const [re, text] of REFUSALS) if (re.test(message)) return text();
  const period = /[.!?]$/.test(message) ? '' : '.';
  if (message.startsWith('refused: '))
    return FLAGGED_TEXT.refused({ reason: `${message.slice('refused: '.length)}${period}` });
  return `${message.charAt(0).toUpperCase()}${message.slice(1)}${period}`;
}
