// Git worktrees for parallel Code sessions (FR-073, docs/10 §9): `<repo>/.nova/worktrees/<name>`
// on a new branch `nova/<slug>`, created and removed with hooks disabled (FR-211). The Hub keeps
// a registry (at most 15 active worktrees per repository) and leases each worktree to one
// session at a time. A lease lasts until it is released, its session is archived, or (when it was
// taken with a length) it expires. When a session is archived a clean worktree is removed (unless
// `code.worktreeCleanup` is `keep`); a dirty one is kept on disk and only released: uncommitted
// work is never deleted silently. At the cap, creating another one offers to remove the oldest
// unleased clean worktree; it is removed only when the caller accepts (`removeOldest`).
//
// `.worktreeinclude` (gitignore syntax, at the repository root) lists Git-ignored files, such as
// local env files, to copy into each new worktree: a file is copied when it is both ignored by the
// repository and matched by the include file. Protected locations (`.git`, `.nova`, `.agents`)
// and credential locations (FR-190) are never copied, nor are symbolic links.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { NovaError, uuidv7, type WorktreeView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { isCredentialPath, isCredentialRel, isProtectedRel } from '../tools/roots.ts';
import type { AuditSink } from '../tools/types.ts';
import { freeBranch, hasHead } from './commit.ts';
import type { HookFreeGit } from './git.ts';

export const MAX_WORKTREES_PER_REPO = 15;
/** `.worktreeinclude` copies at most this many files and bytes into a new worktree. */
export const MAX_INCLUDED_FILES = 2_000;
export const MAX_INCLUDED_BYTES = 200 * 1024 * 1024;

export interface WorktreeRow {
  id: string;
  accountId: string;
  name: string;
  repoPath: string;
  path: string;
  branch: string;
  sourceBranch: string;
  leaseSessionId: string | null;
  leaseExpiresAt: string | null;
  status: 'active' | 'released' | 'removed';
  createdAt: string;
  updatedAt: string;
}

export const WORKTREE_COLUMNS = `id, account_id AS accountId, name, repo_path AS repoPath, path,
  branch, source_branch AS sourceBranch, lease_session_id AS leaseSessionId,
  lease_expires_at AS leaseExpiresAt, status, created_at AS createdAt, updated_at AS updatedAt`;

/** Worktrees of a repository that still exist on disk (leased or kept), oldest first. */
export function activeWorktrees(db: NovaDatabase, repoPath: string): WorktreeRow[] {
  return db.raw
    .prepare(
      `SELECT ${WORKTREE_COLUMNS} FROM worktree
       WHERE device_id IS NULL AND repo_path = ? AND status IN ('active', 'released')
       ORDER BY created_at, id`,
    )
    .all(repoPath) as unknown as WorktreeRow[];
}

/** Whether a worktree has uncommitted changes (null when it cannot be read). */
export async function worktreeDirty(git: HookFreeGit, path: string): Promise<boolean | null> {
  if (!existsSync(path)) return null;
  const r = await git.run(['status', '--porcelain=v1', '--untracked-files=normal'], {
    cwd: path,
    allowFail: true,
  });
  if (r.code !== 0) return null;
  return r.stdout.toString('utf8').trim().length > 0;
}

/**
 * Copy the files `.worktreeinclude` names into a new worktree: untracked files that the
 * repository ignores and the include file matches, minus protected and credential locations and
 * symbolic links. Returns how many were copied.
 */
export async function copyWorktreeIncludes(
  git: HookFreeGit,
  repoRoot: string,
  target: string,
): Promise<number> {
  const includeFile = join(repoRoot, '.worktreeinclude');
  if (!existsSync(includeFile)) return 0;
  // Untracked files the include patterns match (the include file is the only exclude source).
  const matched = await git.run(
    ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${includeFile}`],
    { cwd: repoRoot, allowFail: true, maxBytes: 16 * 1024 * 1024 },
  );
  if (matched.code !== 0) return 0;
  const candidates = splitZ(matched.stdout).filter((p) => {
    const parts = p.split('/');
    return !isProtectedRel(parts) && !isCredentialRel(parts);
  });
  if (!candidates.length) return 0;
  // ...that the repository itself ignores.
  const ignored = await git.run(['check-ignore', '-z', '--stdin'], {
    cwd: repoRoot,
    input: candidates.join('\0') + '\0',
    allowFail: true,
    maxBytes: 16 * 1024 * 1024,
  });
  const files = new Set(splitZ(ignored.stdout));
  let count = 0;
  let bytes = 0;
  for (const rel of candidates) {
    if (!files.has(rel)) continue;
    if (count >= MAX_INCLUDED_FILES) break;
    const src = join(repoRoot, rel);
    if (isCredentialPath(src)) continue;
    let st;
    try {
      st = await lstat(src);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (bytes + st.size > MAX_INCLUDED_BYTES) continue;
    const dst = join(target, rel);
    try {
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      await chmod(dst, st.mode & 0o777);
    } catch {
      continue;
    }
    count++;
    bytes += st.size;
  }
  return count;
}

function splitZ(b: Buffer): string[] {
  return b
    .toString('utf8')
    .split('\0')
    .filter((s) => s.length > 0);
}

export interface WorktreeRegistryOptions {
  db: NovaDatabase;
  git: HookFreeGit;
  events: EventSink;
  audit: AuditSink;
  now?: () => Date;
  log?: Logger;
}

export interface CreateWorktreeInput {
  accountId: string;
  /** The repository root (already a validated folder on the Hub). */
  repoRoot: string;
  sourceBranch: string;
  slug: string;
  /** The session holding the lease, if any. */
  leaseSessionId?: string | null;
  /** Lease length; without it the lease lasts until released. */
  ttlMinutes?: number | null;
  /** At the cap, remove the oldest unleased clean worktree first. */
  removeOldest?: boolean;
  /** The commit to start from (default HEAD of the main checkout). */
  base?: string;
  /** Who asked (audit actor). */
  actor?: 'user' | 'agent' | 'system';
}

/** The worktree registry (FR-073, contracts/hub-api.md `/code/worktrees`). */
export class WorktreeRegistry {
  readonly #o: WorktreeRegistryOptions;
  readonly #now: () => Date;
  readonly #log: Logger;

  constructor(opts: WorktreeRegistryOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.worktrees', sinks: [] });
  }

  /** The account's worktrees on the Hub (`deviceId` worktrees come with device sessions). */
  async list(
    accountId: string,
    opts: { repoRoot?: string; status?: 'active' | 'released' | 'removed' | 'all' } = {},
  ): Promise<WorktreeView[]> {
    const status = opts.status ?? 'active';
    const where = ['account_id = ?', 'device_id IS NULL'];
    const args: string[] = [accountId];
    if (opts.repoRoot) {
      where.push('repo_path = ?');
      args.push(opts.repoRoot);
    }
    // `active` lists every worktree still on disk (leased or kept).
    if (status === 'active') where.push("status IN ('active', 'released')");
    else if (status !== 'all') {
      where.push('status = ?');
      args.push(status);
    }
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM worktree WHERE ${where.join(' AND ')}
         ORDER BY repo_path, created_at, id LIMIT 500`,
      )
      .all(...args) as unknown as WorktreeRow[];
    return Promise.all(rows.map((r) => this.#view(r)));
  }

  get(accountId: string, id: string): WorktreeRow {
    const r = this.#o.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktree WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as WorktreeRow | undefined;
    if (!r) throw new NovaError('not_found', 'worktree not found');
    return r;
  }

  async view(accountId: string, id: string, included: number | null = null) {
    return this.#view(this.get(accountId, id), included);
  }

  /**
   * Create a worktree of `repoRoot` at HEAD on `nova/<slug>`, copy its `.worktreeinclude` files and
   * lease it to `leaseSessionId` when given. At the cap it fails with `worktree_cap`, naming the
   * unleased worktrees and the clean ones that could be removed, unless `removeOldest` accepts
   * removing the oldest unleased clean one.
   */
  async create(input: CreateWorktreeInput): Promise<{ row: WorktreeRow; included: number }> {
    const { git, db } = this.#o;
    const repoRoot = input.repoRoot;
    const active = activeWorktrees(db, repoRoot);
    if (active.length >= MAX_WORKTREES_PER_REPO) {
      const unleased = active.filter((w) => !this.#leased(w) && !this.#inUse(w.id));
      const removable: WorktreeRow[] = [];
      for (const w of unleased) if ((await worktreeDirty(git, w.path)) === false) removable.push(w);
      const oldest = removable[0];
      if (input.removeOldest && oldest) {
        await this.#removeRow(oldest, false, input.accountId, input.actor ?? 'user');
      } else {
        throw new NovaError(
          'conflict',
          `this repository already has ${MAX_WORKTREES_PER_REPO} worktrees; remove one first`,
          {
            details: {
              reason: 'worktree_cap',
              unleased: unleased.map((w) => w.id),
              removable: removable.map((w) => w.id),
            },
          },
        );
      }
    }
    if (!(await hasHead(git, repoRoot)))
      throw new NovaError('validation', 'a worktree needs a repository with at least one commit');
    const name = randomBytes(4).toString('hex');
    const path = join(repoRoot, '.nova', 'worktrees', name);
    const branch = await freeBranch(git, repoRoot, input.slug);
    await git.run(['worktree', 'add', '-q', '-b', branch, path, input.base ?? 'HEAD'], {
      cwd: repoRoot,
    });
    let included = 0;
    try {
      included = await copyWorktreeIncludes(git, repoRoot, path);
    } catch (err) {
      this.#log.warn('copying .worktreeinclude files failed', { err, path });
    }
    const now = this.#now();
    const iso = now.toISOString();
    const expires = input.ttlMinutes
      ? new Date(now.getTime() + input.ttlMinutes * 60_000).toISOString()
      : null;
    const row: WorktreeRow = {
      id: uuidv7(),
      accountId: input.accountId,
      name,
      repoPath: repoRoot,
      path,
      branch,
      sourceBranch: input.sourceBranch,
      leaseSessionId: input.leaseSessionId ?? null,
      leaseExpiresAt: input.leaseSessionId ? expires : null,
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    try {
      await db.transaction(() => {
        db.raw
          .prepare(
            `INSERT INTO worktree (id, account_id, device_id, name, repo_path, path, branch,
               source_branch, lease_session_id, lease_expires_at, status, created_at, updated_at)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(
            row.id,
            row.accountId,
            name,
            repoRoot,
            path,
            branch,
            row.sourceBranch,
            row.leaseSessionId,
            row.leaseExpiresAt,
            iso,
            iso,
          );
      });
    } catch (err) {
      await git.run(['worktree', 'remove', '--force', path], { cwd: repoRoot, allowFail: true });
      throw err;
    }
    await this.#audit(input.accountId, input.actor ?? 'user', 'code.worktree.created', row, {
      included,
    });
    if (row.leaseSessionId) await this.#leasedEvent(row);
    return { row, included };
  }

  /**
   * A worktree a new session may work in: on disk, not removed, unleased (or its lease ended) and
   * no active session in it. The caller leases it in the same transaction as the session.
   */
  assertBindable(accountId: string, id: string): WorktreeRow {
    const r = this.get(accountId, id);
    if (r.status === 'removed')
      throw new NovaError('conflict', 'this worktree was removed', {
        details: { reason: 'removed' },
      });
    if (!existsSync(r.path))
      throw new NovaError('conflict', 'this worktree is missing on disk', {
        details: { reason: 'missing' },
      });
    if (this.#leased(r) || this.#inUse(r.id))
      throw new NovaError('conflict', 'this worktree is leased to another session', {
        details: { reason: 'leased', sessionId: r.leaseSessionId },
      });
    return r;
  }

  /** Extend a lease by `ttlMinutes` from now (default: the hour). */
  async renew(accountId: string, id: string, ttlMinutes?: number): Promise<WorktreeView> {
    const r = this.get(accountId, id);
    if (!this.#leased(r))
      throw new NovaError('conflict', 'this worktree is not leased', {
        details: { reason: 'not_leased' },
      });
    const expires = new Date(this.#now().getTime() + (ttlMinutes ?? 60) * 60_000).toISOString();
    await this.#setLease(r.id, r.leaseSessionId, expires);
    const next = this.get(accountId, id);
    await this.#leasedEvent(next);
    return this.#view(next);
  }

  /** Drop a lease; the worktree stays. Refused while an active session works in it. */
  async release(accountId: string, id: string): Promise<WorktreeView> {
    const r = this.get(accountId, id);
    if (this.#inUse(r.id))
      throw new NovaError('conflict', 'a Code session works in this worktree; archive it first', {
        details: { reason: 'in_use' },
      });
    if (r.leaseSessionId) {
      await this.#setLease(r.id, null, null, 'released');
      await this.#releasedEvent(r, 'done');
      await this.#audit(accountId, 'user', 'code.worktree.released', r, {});
    }
    return this.#view(this.get(accountId, id));
  }

  /**
   * Remove a worktree from disk (its branch stays). Leased or in-use worktrees are refused; a
   * dirty one only with `force`.
   */
  async remove(accountId: string, id: string, force = false): Promise<WorktreeView> {
    const r = this.get(accountId, id);
    if (r.status === 'removed') return this.#view(r);
    if (this.#inUse(r.id))
      throw new NovaError('conflict', 'a Code session works in this worktree; archive it first', {
        details: { reason: 'in_use' },
      });
    if (this.#leased(r))
      throw new NovaError('conflict', 'this worktree is leased; release it first', {
        details: { reason: 'leased', sessionId: r.leaseSessionId },
      });
    if (!force && (await worktreeDirty(this.#o.git, r.path)) === true)
      throw new NovaError('conflict', 'this worktree has uncommitted changes', {
        details: { reason: 'dirty' },
      });
    await this.#removeRow(r, force, accountId, 'user');
    return this.#view(this.get(accountId, id));
  }

  /**
   * When a session is archived: release its lease, and remove a clean worktree unless the
   * cleanup setting keeps it. Returns the new status.
   */
  async releaseForArchive(
    row: WorktreeRow,
    cleanup: 'remove_clean' | 'keep',
  ): Promise<'released' | 'removed'> {
    let status: 'released' | 'removed' = 'released';
    if (cleanup === 'remove_clean') {
      const r = await this.#o.git.run(['worktree', 'remove', row.path], {
        cwd: row.repoPath,
        allowFail: true,
      });
      if (r.code === 0) status = 'removed';
    }
    await this.#setLease(row.id, null, null, status);
    return status;
  }

  /** Leases past their end are released (the worktrees stay); returns how many. */
  async sweepExpired(): Promise<number> {
    const now = this.#now().toISOString();
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${WORKTREE_COLUMNS} FROM worktree
         WHERE lease_session_id IS NOT NULL AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ? AND status = 'active'`,
      )
      .all(now) as unknown as WorktreeRow[];
    for (const r of rows) {
      if (this.#inUse(r.id)) continue;
      await this.#setLease(r.id, null, null, 'released');
      await this.#releasedEvent(r, 'expired');
    }
    return rows.length;
  }

  /** Release every lease a session holds without working in it (the session was archived). */
  async releaseHeldBy(sessionId: string): Promise<number> {
    const rows = this.#o.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktree WHERE lease_session_id = ?`)
      .all(sessionId) as unknown as WorktreeRow[];
    let n = 0;
    for (const r of rows) {
      if (this.#inUse(r.id)) continue;
      await this.#setLease(r.id, null, null, r.status === 'removed' ? 'removed' : 'released');
      await this.#releasedEvent(r, 'done');
      n++;
    }
    return n;
  }

  // ---- internals ------------------------------------------------------------------------------

  #leased(r: WorktreeRow): boolean {
    if (!r.leaseSessionId) return false;
    return !r.leaseExpiresAt || r.leaseExpiresAt > this.#now().toISOString();
  }

  /** Whether an active Code session works in the worktree. */
  #inUse(id: string): boolean {
    return !!this.#o.db.raw
      .prepare(
        `SELECT 1 FROM code_session s JOIN thread t ON t.id = s.thread_id
         WHERE s.worktree_id = ? AND s.status = 'active' AND t.archived = 0
           AND t.deleted_at IS NULL LIMIT 1`,
      )
      .get(id);
  }

  async #setLease(
    id: string,
    sessionId: string | null,
    expires: string | null,
    status: WorktreeRow['status'] = 'active',
  ): Promise<void> {
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE worktree SET lease_session_id = ?, lease_expires_at = ?, status = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(sessionId, expires, status, this.#now().toISOString(), id);
    });
  }

  async #removeRow(r: WorktreeRow, force: boolean, accountId: string, actor: string) {
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), r.path];
    const res = await this.#o.git.run(args, { cwd: r.repoPath, allowFail: true });
    if (res.code !== 0 && existsSync(r.path))
      throw new NovaError('conflict', `the worktree could not be removed: ${res.stderr.trim()}`, {
        details: { reason: 'remove_failed' },
      });
    // A worktree deleted by hand leaves Git's bookkeeping behind.
    await this.#o.git.run(['worktree', 'prune'], { cwd: r.repoPath, allowFail: true });
    await this.#setLease(r.id, null, null, 'removed');
    await this.#audit(accountId, actor, 'code.worktree.removed', r, { force });
  }

  async #view(r: WorktreeRow, included: number | null = null): Promise<WorktreeView> {
    const leased = this.#leased(r);
    return {
      id: r.id,
      name: r.name,
      repoPath: r.repoPath,
      path: r.path,
      branch: r.branch,
      sourceBranch: r.sourceBranch,
      leasedBy: leased ? r.leaseSessionId : null,
      leaseExpiresAt: leased ? r.leaseExpiresAt : null,
      status: r.status,
      dirty: r.status === 'removed' ? false : await worktreeDirty(this.#o.git, r.path),
      included,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  async #leasedEvent(r: WorktreeRow): Promise<void> {
    await this.#emit(r.accountId, 'worktree.leased', r.leaseSessionId, {
      worktreeId: r.id,
      repoPath: r.repoPath,
      branch: r.branch,
      sessionId: r.leaseSessionId,
      expiresAt: r.leaseExpiresAt,
    });
  }

  async #releasedEvent(r: WorktreeRow, reason: 'done' | 'expired' | 'handoff' | 'removed') {
    await this.#emit(r.accountId, 'worktree.released', r.leaseSessionId, {
      worktreeId: r.id,
      sessionId: r.leaseSessionId,
      reason,
    });
  }

  async #emit(
    accountId: string,
    name: string,
    sessionId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#o.events.emit({
        name,
        actor: 'system',
        accountId,
        ...(sessionId ? { correlation: { sessionId } } : {}),
        payload,
      });
    } catch (err) {
      this.#log.warn('could not announce a worktree event', { err, name });
    }
  }

  async #audit(
    accountId: string,
    actor: string,
    action: string,
    r: WorktreeRow,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.#o.audit.append({
      accountId,
      actor,
      kind: 'code',
      action,
      resource: r.path,
      result: 'ok',
      detail: { worktreeId: r.id, repoPath: r.repoPath, branch: r.branch, ...detail },
    });
  }
}
