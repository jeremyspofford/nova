// Git worktrees for parallel Code sessions (FR-073, docs/10 §9): `<repo>/.nova/worktrees/<name>`
// on a new branch `nova/<slug>`, created and removed with hooks disabled (FR-211). The Hub keeps
// a registry (at most 15 active worktrees per repository) and leases each worktree to one
// session; the lease is released when the session is archived, and a clean worktree is removed
// then. A dirty one is kept on disk and only released: uncommitted work is never deleted.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { NovaError, uuidv7 } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { freeBranch, hasHead } from './commit.ts';
import type { HookFreeGit } from './git.ts';

export const MAX_WORKTREES_PER_REPO = 15;

export interface WorktreeRow {
  id: string;
  accountId: string;
  name: string;
  repoPath: string;
  path: string;
  branch: string;
  sourceBranch: string;
  leaseSessionId: string | null;
  status: 'active' | 'released' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export const WORKTREE_COLUMNS = `id, account_id AS accountId, name, repo_path AS repoPath, path,
  branch, source_branch AS sourceBranch, lease_session_id AS leaseSessionId, status,
  created_at AS createdAt, updated_at AS updatedAt`;

/** Worktrees of a repository that still exist on disk (leased or kept), oldest first. */
export function activeWorktrees(db: NovaDatabase, repoPath: string): WorktreeRow[] {
  return db.raw
    .prepare(
      `SELECT ${WORKTREE_COLUMNS} FROM worktree
       WHERE device_id IS NULL AND repo_path = ? AND status IN ('active', 'released')
       ORDER BY created_at`,
    )
    .all(repoPath) as unknown as WorktreeRow[];
}

/**
 * Create a worktree of `repoRoot` at HEAD on `nova/<slug>`; returns its registry row (not yet
 * leased: the caller leases it to the session it creates in the same transaction).
 */
export async function createWorktree(input: {
  git: HookFreeGit;
  db: NovaDatabase;
  accountId: string;
  repoRoot: string;
  sourceBranch: string;
  slug: string;
  now: () => Date;
}): Promise<WorktreeRow> {
  const { git, db, repoRoot } = input;
  const active = activeWorktrees(db, repoRoot);
  if (active.length >= MAX_WORKTREES_PER_REPO)
    throw new NovaError(
      'conflict',
      `this repository already has ${MAX_WORKTREES_PER_REPO} worktrees; remove one first`,
      {
        details: {
          reason: 'worktree_cap',
          unleased: active.filter((w) => !w.leaseSessionId).map((w) => w.id),
        },
      },
    );
  if (!(await hasHead(git, repoRoot)))
    throw new NovaError('validation', 'a worktree needs a repository with at least one commit');
  const name = randomBytes(4).toString('hex');
  const path = join(repoRoot, '.nova', 'worktrees', name);
  const branch = await freeBranch(git, repoRoot, input.slug);
  await git.run(['worktree', 'add', '-q', '-b', branch, path, 'HEAD'], { cwd: repoRoot });
  const now = input.now().toISOString();
  const row: WorktreeRow = {
    id: uuidv7(),
    accountId: input.accountId,
    name,
    repoPath: repoRoot,
    path,
    branch,
    sourceBranch: input.sourceBranch,
    leaseSessionId: null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await db.transaction(() => {
    db.raw
      .prepare(
        `INSERT INTO worktree (id, account_id, device_id, name, repo_path, path, branch,
           source_branch, lease_session_id, status, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, 'active', ?, ?)`,
      )
      .run(row.id, row.accountId, name, repoRoot, path, branch, row.sourceBranch, now, now);
  });
  return row;
}

/**
 * Release a worktree's lease; a clean worktree is removed from disk (its branch stays), a dirty
 * one is kept. Returns the new status.
 */
export async function releaseWorktree(input: {
  git: HookFreeGit;
  db: NovaDatabase;
  row: WorktreeRow;
  now: () => Date;
}): Promise<'released' | 'removed'> {
  const { git, db, row } = input;
  const r = await git.run(['worktree', 'remove', row.path], {
    cwd: row.repoPath,
    allowFail: true,
  });
  const status = r.code === 0 ? 'removed' : 'released';
  await db.transaction(() => {
    db.raw
      .prepare(
        'UPDATE worktree SET status = ?, lease_session_id = NULL, updated_at = ? WHERE id = ?',
      )
      .run(status, input.now().toISOString(), row.id);
  });
  return status;
}
