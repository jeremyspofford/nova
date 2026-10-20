// Words for the M7 Code views (docs/10 §9, §14, §15): a handoff's state and every refusal reason in
// plain words, merge and file results, attempt states, and the Hub's request errors for these
// actions. Every state pairs a word with its icon in the views (docs/04 §7); these are the words.
import type {
  CodeAttemptSetView,
  CodeAttemptView,
  CodeMergeView,
  HandoffReason,
  MergeFileResult,
  SessionHandoffView,
} from '@nova/shared';
import { defineMessages, messageFor } from '@nova/i18n';
import type { IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { errorReason, type Tone } from './m6-format.ts';

/** The words of the specs below; each spec reads its word at render time. */
export const M7_TEXT = defineMessages('code.m7', {
  handoff: {
    pending: 'Waiting',
    running: 'Moving',
    completed: 'Moved',
    refused: 'Refused',
    failed: 'Failed',
  },
  merge: {
    applied: 'Merged',
    conflicted: 'Conflicts to resolve',
    resolved: 'Resolved',
    refused: 'Refused: conflicts',
    aborted: 'Aborted',
  },
  set: {
    running: 'Attempts running',
    ready: 'Ready to compare',
    applied: 'Applied',
    discarded: 'Discarded',
  },
  attempt: {
    running: 'Working',
    done: 'Done',
    failed: 'Failed',
    applied: 'Applied',
    discarded: 'Discarded',
  },
  didNotWork: 'That did not work.',
  /** A refusal of an M7 Code request, by the Hub's reason code. */
  error: {
    handoff_running: 'This session is already moving. Wait for that move to finish.',
    same_location: 'The session already works there.',
    worktree_unavailable: 'Worktrees are only available for folders on the Hub.',
    worktree_repo: 'That worktree belongs to another repository.',
    remote_environment: 'This works only for sessions whose folder is on the Hub.',
    no_commits: 'Attempts need a Git repository with at least one commit.',
    other_repository: 'The two sessions work in different repositories.',
    other_folder: 'The two sessions work in different folders of the repository.',
    same_session: 'A session cannot merge into itself.',
    patch_mismatch: 'The patch does not apply to its base commit.',
    missing_base: 'The repository does not have the patch’s base commit.',
    too_large: 'The work is too large to merge.',
    merge_conflict: 'The work conflicts with the session’s files, so nothing was written.',
    merge_conflicts: 'Conflict markers are still in some files. Resolve them first.',
    merge_settled: 'That merge is already settled.',
    attempts_settled: 'These attempts were already applied or discarded.',
    turns_unavailable: 'Attempts cannot start right now. Try again in a moment.',
    unknown_device: 'That device is not one of yours, or it was revoked.',
  },
});

export interface Spec {
  text: string;
  icon: IconName;
  tone: Tone;
}

/** The M7 Code events the session's new panes follow (contracts/events.md, M7 E). */
export const CODE_M7_EVENTS = [
  'session.handedOff',
  'code.merge.completed',
  'code.attempts.updated',
  'code.session.updated',
  'code.commit.created',
  'code.verify.completed',
  'worktree.released',
] as const;

/** A spec whose word is read when it is shown, so it follows the active locale. */
function spec(words: Record<string, string>, key: string, icon: IconName, tone: Tone): Spec {
  return {
    get text() {
      return words[key] ?? key;
    },
    icon,
    tone,
  };
}

export const HANDOFF_STATUS: Record<SessionHandoffView['status'], Spec> = {
  pending: spec(M7_TEXT.handoff, 'pending', 'clock', 'warn'),
  running: spec(M7_TEXT.handoff, 'running', 'refresh', 'warn'),
  completed: spec(M7_TEXT.handoff, 'completed', 'check', 'ok'),
  refused: spec(M7_TEXT.handoff, 'refused', 'slash', 'danger'),
  failed: spec(M7_TEXT.handoff, 'failed', 'alert', 'danger'),
};

/** Why a move was refused or failed, and what to do about it. */
export const HANDOFF_REASON = defineMessages('code.handoffReason', {
  turn_running:
    'A turn was still running. Wait for it to end, or move again and choose to interrupt it.',
  same_location: 'The session already works there.',
  not_a_repository: 'The session’s folder is not a Git repository, so its state cannot travel.',
  no_commits: 'The repository has no commits yet. Commit once, then move it.',
  detached_head: 'The session is not on a branch. Create a branch first, then move it.',
  target_dirty:
    'The folder there has uncommitted changes. Commit or discard them there first; nothing was overwritten.',
  target_missing: 'There is no such folder or repository there.',
  target_unreachable: 'The target could not be reached. Check that it is on and connected.',
  protected_folder:
    'That folder is protected there, or the session would end up outside its repository. Choose another folder.',
  other_repository: 'The folder there is a different repository.',
  missing_commits:
    'The commits the session builds on are missing there, and could not be sent. Push them, or fetch them there.',
  branch_diverged:
    'The branch there has commits the session does not have. Bring the two together first.',
  branch_in_use: 'The branch is checked out in another worktree there.',
  conflicts: 'The uncommitted changes do not apply cleanly there.',
  verify_failed:
    'The target did not end up with the same commit and files, so the session stayed here.',
  too_large: 'The uncommitted changes are too large to send.',
  remote_state_unavailable: 'The session’s Git state on its machine could not be read.',
  environment_unavailable: 'That environment cannot take sessions right now.',
  failed: 'The move failed. The session stayed where it was.',
}) satisfies Record<HandoffReason, string>;

export function handoffReasonText(v: SessionHandoffView): string | null {
  if (v.status !== 'refused' && v.status !== 'failed') return null;
  const base = v.reason ? HANDOFF_REASON[v.reason] : HANDOFF_REASON.failed;
  return base;
}

/** "This Hub", "worktree:…" refs as the Hub labels them. */
export function shortHash(h: string | null | undefined, n = 12): string {
  return h ? h.slice(0, n) : '';
}

export const MERGE_STATUS: Record<CodeMergeView['status'], Spec> = {
  applied: spec(M7_TEXT.merge, 'applied', 'check', 'ok'),
  conflicted: spec(M7_TEXT.merge, 'conflicted', 'alert', 'danger'),
  resolved: spec(M7_TEXT.merge, 'resolved', 'check', 'ok'),
  refused: spec(M7_TEXT.merge, 'refused', 'slash', 'muted'),
  aborted: spec(M7_TEXT.merge, 'aborted', 'undo', 'muted'),
};

export const FILE_RESULT = defineMessages('code.fileResult', {
  applied: 'Taken from the work',
  merged: 'Merged',
  conflict: 'Conflict',
  added: 'Added',
  deleted: 'Deleted',
  unchanged: 'Unchanged',
  binary_conflict: 'Conflict (binary, not merged)',
}) satisfies Record<MergeFileResult, string>;

export function isConflict(r: MergeFileResult): boolean {
  return r === 'conflict' || r === 'binary_conflict';
}

export const MERGE_SOURCE = defineMessages('code.mergeSource', {
  session: 'Another session',
  attempt: 'An attempt',
  patch: 'A patch',
}) satisfies Record<CodeMergeView['source']['kind'], string>;

export const SET_STATUS: Record<CodeAttemptSetView['status'], Spec> = {
  running: spec(M7_TEXT.set, 'running', 'refresh', 'warn'),
  ready: spec(M7_TEXT.set, 'ready', 'compare', 'ok'),
  applied: spec(M7_TEXT.set, 'applied', 'check', 'ok'),
  discarded: spec(M7_TEXT.set, 'discarded', 'trash', 'muted'),
};

export const ATTEMPT_STATUS: Record<CodeAttemptView['status'], Spec> = {
  running: spec(M7_TEXT.attempt, 'running', 'refresh', 'warn'),
  done: spec(M7_TEXT.attempt, 'done', 'check', 'ok'),
  failed: spec(M7_TEXT.attempt, 'failed', 'alert', 'danger'),
  applied: spec(M7_TEXT.attempt, 'applied', 'check', 'ok'),
  discarded: spec(M7_TEXT.attempt, 'discarded', 'trash', 'muted'),
};

/** A refusal of an M7 Code request, in plain words. */
export function codeM7ErrorMessage(err: unknown, fallback?: string): string {
  const reason = errorReason(err);
  return (
    (reason ? messageFor(M7_TEXT.error, reason) : undefined) ??
    errorMessage(err, fallback ?? M7_TEXT.didNotWork)
  );
}

/** The paths a 409 merge refusal names. */
export function conflictPaths(err: unknown): string[] {
  const body = (err as { body?: { details?: { paths?: unknown } } } | null)?.body;
  const p = body?.details?.paths;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

/** The merge a 409 merge refusal recorded. */
export function conflictMergeId(err: unknown): string | null {
  const body = (err as { body?: { details?: { mergeId?: unknown } } } | null)?.body;
  const id = body?.details?.mergeId;
  return typeof id === 'string' ? id : null;
}
