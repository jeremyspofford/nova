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
import type { IconName } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { errorReason, type Tone } from './m6-format.ts';

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

export const HANDOFF_STATUS: Record<SessionHandoffView['status'], Spec> = {
  pending: { text: 'Waiting', icon: 'clock', tone: 'warn' },
  running: { text: 'Moving', icon: 'refresh', tone: 'warn' },
  completed: { text: 'Moved', icon: 'check', tone: 'ok' },
  refused: { text: 'Refused', icon: 'slash', tone: 'danger' },
  failed: { text: 'Failed', icon: 'alert', tone: 'danger' },
};

/** Why a move was refused or failed, and what to do about it. */
export const HANDOFF_REASON: Record<HandoffReason, string> = {
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
};

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
  applied: { text: 'Merged', icon: 'check', tone: 'ok' },
  conflicted: { text: 'Conflicts to resolve', icon: 'alert', tone: 'danger' },
  resolved: { text: 'Resolved', icon: 'check', tone: 'ok' },
  refused: { text: 'Refused: conflicts', icon: 'slash', tone: 'muted' },
  aborted: { text: 'Aborted', icon: 'undo', tone: 'muted' },
};

export const FILE_RESULT: Record<MergeFileResult, string> = {
  applied: 'Taken from the work',
  merged: 'Merged',
  conflict: 'Conflict',
  added: 'Added',
  deleted: 'Deleted',
  unchanged: 'Unchanged',
  binary_conflict: 'Conflict (binary, not merged)',
};

export function isConflict(r: MergeFileResult): boolean {
  return r === 'conflict' || r === 'binary_conflict';
}

export const MERGE_SOURCE: Record<CodeMergeView['source']['kind'], string> = {
  session: 'Another session',
  attempt: 'An attempt',
  patch: 'A patch',
};

export const SET_STATUS: Record<CodeAttemptSetView['status'], Spec> = {
  running: { text: 'Attempts running', icon: 'refresh', tone: 'warn' },
  ready: { text: 'Ready to compare', icon: 'compare', tone: 'ok' },
  applied: { text: 'Applied', icon: 'check', tone: 'ok' },
  discarded: { text: 'Discarded', icon: 'trash', tone: 'muted' },
};

export const ATTEMPT_STATUS: Record<CodeAttemptView['status'], Spec> = {
  running: { text: 'Working', icon: 'refresh', tone: 'warn' },
  done: { text: 'Done', icon: 'check', tone: 'ok' },
  failed: { text: 'Failed', icon: 'alert', tone: 'danger' },
  applied: { text: 'Applied', icon: 'check', tone: 'ok' },
  discarded: { text: 'Discarded', icon: 'trash', tone: 'muted' },
};

/** A refusal of an M7 Code request, in plain words. */
export function codeM7ErrorMessage(err: unknown, fallback = 'That did not work.'): string {
  switch (errorReason(err)) {
    case 'handoff_running':
      return 'This session is already moving. Wait for that move to finish.';
    case 'same_location':
      return 'The session already works there.';
    case 'worktree_unavailable':
      return 'Worktrees are only available for folders on the Hub.';
    case 'worktree_repo':
      return 'That worktree belongs to another repository.';
    case 'remote_environment':
      return 'This works only for sessions whose folder is on the Hub.';
    case 'no_commits':
      return 'Attempts need a Git repository with at least one commit.';
    case 'other_repository':
      return 'The two sessions work in different repositories.';
    case 'other_folder':
      return 'The two sessions work in different folders of the repository.';
    case 'same_session':
      return 'A session cannot merge into itself.';
    case 'patch_mismatch':
      return 'The patch does not apply to its base commit.';
    case 'missing_base':
      return 'The repository does not have the patch’s base commit.';
    case 'too_large':
      return 'The work is too large to merge.';
    case 'merge_conflict':
      return 'The work conflicts with the session’s files, so nothing was written.';
    case 'merge_conflicts':
      return 'Conflict markers are still in some files. Resolve them first.';
    case 'merge_settled':
      return 'That merge is already settled.';
    case 'attempts_settled':
      return 'These attempts were already applied or discarded.';
    case 'turns_unavailable':
      return 'Attempts cannot start right now. Try again in a moment.';
    case 'unknown_device':
      return 'That device is not one of yours, or it was revoked.';
    default:
      return errorMessage(err, fallback);
  }
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
