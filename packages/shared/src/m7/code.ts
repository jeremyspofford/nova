// M7 Code additions (docs/10 §9, §14, §15; owned by the code area): session handoff with the Git
// state (FR-213), best-of-N attempts (FR-212), three-way merges of attempts, workers and patches
// onto a branch that moved (FR-073), and delegation from an agent to a Code session. Views carry
// no secret and no file content beyond bounded, redacted diffs.
import { z } from 'zod';
import { idSchema } from '../api.ts';
import type { CodeBudgetView, VerifyRunView } from '../m6/code.ts';

// ---- session handoff (FR-213, docs/10 §15) -------------------------------------------------------

/**
 * Where a session moves: another saved environment (this Hub, an SSH host, a device, the cloud)
 * with the repository folder there, or, on this Hub, a worktree of the same repository (`new`
 * creates one on a `nova/<slug>` branch, an id binds an unleased registry worktree) or back to the
 * main checkout (`main`).
 */
export const handoffTargetSchema = z
  .object({
    environmentId: idSchema.optional(),
    /** The repository folder in the target environment (its full path). */
    folder: z.string().trim().min(1).max(1000).optional(),
    worktree: z.union([z.literal('new'), z.literal('main'), idSchema]).optional(),
  })
  .strict()
  .refine((t) => t.environmentId !== undefined || t.worktree !== undefined, 'name a target')
  .refine(
    (t) => !(t.worktree !== undefined && (t.environmentId !== undefined || t.folder)),
    'a worktree target stays in the same environment',
  );

export const HANDOFF_SOURCE = ['keep', 'clean'] as const;

/** POST /code/sessions/:id/handoff. */
export const sessionHandoffSchema = z
  .object({
    to: handoffTargetSchema,
    /** What happens to the source working tree once the target confirmed (default: setting). */
    source: z.enum(HANDOFF_SOURCE).optional(),
    /** Interrupt a running turn instead of waiting for it to end (FR-127). */
    interrupt: z.boolean().optional(),
  })
  .strict();

/** POST /threads/:id/handoff: a chat moves to another of the account's devices. */
export const threadHandoffSchema = z
  .object({
    to: z.object({ deviceId: idSchema }).strict(),
    interrupt: z.boolean().optional(),
  })
  .strict();

export type HandoffStatus = 'pending' | 'running' | 'completed' | 'refused' | 'failed';

/** Why a handoff was refused or failed (also the error's `details.reason`). */
export type HandoffReason =
  | 'turn_running'
  | 'same_location'
  | 'not_a_repository'
  | 'no_commits'
  | 'detached_head'
  | 'target_dirty'
  | 'target_missing'
  | 'target_unreachable'
  | 'protected_folder'
  | 'other_repository'
  | 'missing_commits'
  | 'branch_diverged'
  | 'branch_in_use'
  | 'conflicts'
  | 'verify_failed'
  | 'too_large'
  | 'remote_state_unavailable'
  | 'environment_unavailable'
  | 'failed';

/** The Git state that travels (the patch and bundle stay on the Hub; only hashes are shown). */
export interface HandoffGitStateView {
  branch: string | null;
  head: string;
  /** The tree of the whole working state (HEAD plus every uncommitted change). */
  tree: string;
  /** SHA-256 of the binary-safe patch of the uncommitted changes. */
  patchSha256: string;
  patchBytes: number;
  files: number;
  /** Local commits not on a remote, sent as a Git bundle through the Hub. */
  bundleSha256: string | null;
  bundleCommits: number;
  worktreeId: string | null;
  /** SHA-256 over HEAD and the tree: the target confirms the same value. */
  stateHash: string;
}

export interface SessionHandoffView {
  id: string;
  threadId: string;
  /** Null for a chat handoff. */
  sessionId: string | null;
  /** `environment:<id>`, `worktree:<id>`, `device:<id>` or `hub`. */
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  status: HandoffStatus;
  reason: HandoffReason | null;
  /** Redacted detail for a refusal or failure. */
  detail: string | null;
  source: (typeof HANDOFF_SOURCE)[number];
  git: HandoffGitStateView | null;
  /** The target folder the session continues in. */
  folder: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ---- three-way merges (FR-073, docs/10 §9 and §14) -----------------------------------------------

export const MERGE_CONFLICT_MODES = ['refuse', 'markers'] as const;

/**
 * Merge another session's work (a worker, an attempt) or a patch onto this session's folder.
 * `refuse` (default) writes nothing when a file conflicts; `markers` writes conflict markers for
 * the user to resolve in the Diff pane. A conflict is never resolved silently.
 */
export const mergeSchema = z
  .object({
    from: z.union([
      z.object({ sessionId: idSchema }).strict(),
      z
        .object({
          /** A unified patch (`git diff --binary --full-index` output). */
          patch: z
            .string()
            .min(1)
            .max(16 * 1024 * 1024),
          /** The commit the patch was made against (default: the session's HEAD). */
          base: z
            .string()
            .regex(/^[0-9a-f]{7,64}$/)
            .optional(),
        })
        .strict(),
    ]),
    onConflict: z.enum(MERGE_CONFLICT_MODES).optional(),
  })
  .strict();

export type MergeFileResult =
  'applied' | 'merged' | 'conflict' | 'added' | 'deleted' | 'unchanged' | 'binary_conflict';

export interface MergeFileView {
  path: string;
  result: MergeFileResult;
  /** Conflicting regions in the file (0 unless `conflict`). */
  conflicts: number;
}

/** A conflicted file's three sides for the three-way view (bounded, redacted text). */
export interface MergeConflictView {
  path: string;
  binary: boolean;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  /** With conflict markers (diff3 style). */
  merged: string | null;
  truncated: boolean;
}

export interface CodeMergeView {
  id: string;
  sessionId: string;
  source: { kind: 'session' | 'attempt' | 'patch'; ref: string | null };
  /** `refused`: nothing written; `conflicted`: markers written, not yet resolved. */
  status: 'applied' | 'conflicted' | 'resolved' | 'refused' | 'aborted';
  baseSha: string | null;
  files: MergeFileView[];
  conflicts: MergeConflictView[];
  createdAt: string;
  resolvedAt: string | null;
}

// ---- best-of-N attempts (FR-212, docs/10 §9) -----------------------------------------------------

export const MAX_CODE_ATTEMPTS = 4;

const attemptBudgetSchema = z
  .object({
    timeSeconds: z
      .number()
      .int()
      .min(60)
      .max(7 * 24 * 3600)
      .nullable()
      .optional(),
    tokens: z.number().int().min(1_000).max(1_000_000_000).nullable().optional(),
    costUsd: z.number().min(0.01).max(100_000).nullable().optional(),
  })
  .strict();

/** POST /code/sessions/:id/attempts: N attempts of one task, each in its own worktree. */
export const startAttemptsSchema = z
  .object({
    objective: z.string().trim().min(1).max(20_000),
    /** How many (default `code.attempts.count`, at most 4). */
    count: z.number().int().min(2).max(MAX_CODE_ATTEMPTS).optional(),
    /** The bounds of each attempt (default `code.attempts.budgets`). */
    budgets: attemptBudgetSchema.optional(),
    /** A model per attempt (by index); the session's model otherwise. */
    models: z.array(z.string().min(1).max(200)).max(MAX_CODE_ATTEMPTS).optional(),
  })
  .strict();

export const applyAttemptSchema = z
  .object({
    attemptId: idSchema,
    onConflict: z.enum(MERGE_CONFLICT_MODES).optional(),
  })
  .strict();

export interface CodeAttemptFileView {
  path: string;
  kind: 'add' | 'modify' | 'delete' | 'rename';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CodeAttemptView {
  id: string;
  index: number;
  sessionId: string;
  threadId: string;
  worktreeId: string | null;
  branch: string | null;
  model: string | null;
  status: 'running' | 'done' | 'failed' | 'applied' | 'discarded';
  /** What the attempt changed against the base commit, file by file. */
  files: CodeAttemptFileView[];
  additions: number;
  deletions: number;
  /** The unified patch against the base (redacted, at most 256 KiB). */
  patch: string;
  patchTruncated: boolean;
  /** The newest check run in the attempt's worktree (FR-068). */
  tests: VerifyRunView | null;
  budget: CodeBudgetView;
  /** The attempt's last reply (its words: untrusted). */
  reply: string | null;
}

export interface CodeAttemptSetView {
  id: string;
  sessionId: string;
  objective: string;
  baseSha: string;
  status: 'running' | 'ready' | 'applied' | 'discarded';
  attempts: CodeAttemptView[];
  appliedAttemptId: string | null;
  /** The merge that applied the chosen attempt. */
  mergeId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---- delegation from an agent (FR-091 groundwork, docs/09 §4) ------------------------------------

export interface CodeDelegationView {
  id: string;
  agentId: string;
  /** The agent thread that delegated (results return to the agent's main thread). */
  agentThreadId: string;
  sessionId: string;
  threadId: string;
  status: 'running' | 'done' | 'failed';
  createdAt: string;
  completedAt: string | null;
}
