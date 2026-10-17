// Code sessions (FR-061, FR-063..FR-066, FR-069, FR-073, FR-074, FR-211; docs/10). A session is a
// `code` thread plus a `code_session` row binding an environment (M5: the built-in `local`
// environment, the Hub host), a folder and a permission mode. Its turns run in the shared chat
// loop (ADR-076); this service shapes them through the runtime seams: the permission mode as
// thread policy, an Environment context block and a change refresh after each turn, the coding
// tools, and the blocked status. Changes are captured with a shadow Git repository per session
// (shadow.ts), reviewed hunk by hunk, commented on, reviewed by the model and committed.
import { isolatedSubstrate } from '@nova/policy';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { arch, homedir, platform, release } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { z } from 'zod';
import {
  NovaError,
  uuidv7,
  type CodeChangeView,
  type CodeReviewView,
  type CodeSessionView,
  type CodeSymbolView,
  type CommitResult,
  type DiffCommentView,
  type EnvironmentView,
  type PermissionMode,
  type ReviewFindingView,
  type StatusView,
  type commitSchema,
  type createCodeSessionSchema,
  type diffCommentsSchema,
  type hunkDecisionSchema,
  type updateCodeSessionSchema,
} from '@nova/shared';
import { isWithin, realpathLenient } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { ModelRouter } from '../routing/types.ts';
import type {
  ThreadPolicy,
  ThreadPolicySource,
  ThreadStatusSource,
  TurnExtension,
  TurnStarter,
} from '../runtime/types.ts';
import type { SettingReader } from '../approvals/gate.ts';
import type { ThreadService } from '../threads.ts';
import { isCredentialPath, isProtectedRel } from '../tools/roots.ts';
import { sha256 } from '../tools/text.ts';
import type { AuditSink, SandboxClient, ToolRoot } from '../tools/types.ts';
import type { TerminalManager } from '../workspace/terminals.ts';
import {
  CHANGE_COLUMNS,
  changeView,
  countLines,
  emptyDecided,
  hunkView,
  parseDecided,
  patchOf,
  pendingFile,
  stateOf,
  type ChangeRow,
  type Decided,
} from './changes.ts';
import {
  hasCommitHooks,
  hasStaged,
  identity,
  sandboxHasGit,
  scanStaged,
  stage,
  switchToNewBranch,
  freeBranch,
  unstage,
  type StageEntry,
} from './commit.ts';
import { buildHunkPatch, type ParsedDiffFile } from './diff.ts';
import { HookFreeGit, branchSlug, isDefaultBranch, repoInfo, type RepoInfo } from './git.ts';
import {
  assertModeAvailable,
  describePermissionMode,
  modeUnavailable,
  modePolicy,
  type PermissionModeConditions,
} from './policy.ts';
import { runCodeReview } from './review.ts';
import { ShadowRepo, repoUserExcludes, type ShadowTreeUpdate } from './shadow.ts';
import { SymbolIndex, findCodeRefs, type CodeRef } from './symbols.ts';
import {
  createWorktree,
  releaseWorktree,
  WORKTREE_COLUMNS,
  type WorktreeRow,
} from './worktrees.ts';

export type CreateCodeSessionRequest = z.input<typeof createCodeSessionSchema>;
export type UpdateCodeSessionRequest = z.input<typeof updateCodeSessionSchema>;
export type HunkDecisionRequest = z.input<typeof hunkDecisionSchema>;
export type DiffCommentsRequest = z.input<typeof diffCommentsSchema>;
export type CodeCommitRequest = z.input<typeof commitSchema>;

/**
 * A diff comment as the Hub returns it: the user's own (`author: 'user'`), or a review finding
 * (`author: 'review'` with its `reviewId`), so a client can show findings once.
 */
export interface CodeDiffComment extends DiffCommentView {
  author: 'user' | 'review';
  reviewId: string | null;
  /** When the comment was sent to the agent (FR-065). */
  submittedAt: string | null;
}

/** CommitResult plus whether the repository's hooks ran (docs/10 §8). */
export interface CodeCommitResult extends CommitResult {
  hooksRan: boolean;
  /** Set when the repository has commit hooks that did not run. */
  hooksNote: string | null;
}

export interface CodeServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  audit: AuditSink;
  threads: ThreadService;
  router: ModelRouter;
  dataDir: string;
  setting: SettingReader;
  /** Persist the mode last used in a folder (`code.folderModes`); the Hub writes the setting. */
  rememberMode?: (accountId: string, folder: string, mode: PermissionMode) => Promise<void>;
  /** The tools' sandbox: commit hooks run in it, and Bypass needs a VM or container. */
  sandbox?: () => SandboxClient | null;
  git?: HookFreeGit;
  /** The Hub user's home folder (`~`, refused as a session folder); defaults to the real one. */
  home?: string | null;
  now?: () => Date;
  log?: Logger;
  /** How long a review may take (default 5 min). */
  reviewTimeoutMs?: number;
}

interface SessionRow {
  id: string;
  accountId: string;
  threadId: string;
  environmentId: string | null;
  folderPath: string;
  projectFolderId: string | null;
  worktreeId: string | null;
  worktreePath: string | null;
  worktreeRepo: string | null;
  branch: string | null;
  permissionMode: PermissionMode;
  status: 'active' | 'archived';
  pullRequestUrl: string | null;
  ciStatus: string | null;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  modelId: string | null;
  projectId: string | null;
  threadState: string;
  archived: number;
  deletedAt: string | null;
}

const SESSION_SELECT = `SELECT s.id, s.account_id AS accountId, s.thread_id AS threadId,
  s.environment_id AS environmentId, s.folder_path AS folderPath,
  s.project_folder_id AS projectFolderId, s.worktree_id AS worktreeId,
  w.path AS worktreePath, w.repo_path AS worktreeRepo, s.branch,
  s.permission_mode AS permissionMode, s.status, s.pull_request_url AS pullRequestUrl,
  s.ci_status AS ciStatus, s.created_at AS createdAt, s.updated_at AS updatedAt,
  t.title, t.model_id AS modelId, t.project_id AS projectId, t.state AS threadState,
  t.archived, t.deleted_at AS deletedAt
  FROM code_session s JOIN thread t ON t.id = s.thread_id
  LEFT JOIN worktree w ON w.id = s.worktree_id`;

interface EnvRow {
  id: string;
  accountId: string;
  kind: EnvironmentView['kind'];
  label: string;
  status: EnvironmentView['status'];
  statusDetail: string | null;
  lastCheckAt: string | null;
}

interface CommentRow {
  id: string;
  changeId: string;
  sessionId: string;
  path: string | null;
  line: number | null;
  side: 'old' | 'new' | null;
  body: string;
  author: 'user' | 'review';
  reviewId: string | null;
  submittedAt: string | null;
  resolved: number;
  createdAt: string;
}

const COMMENT_COLUMNS = `id, change_id AS changeId, session_id AS sessionId, path, line, side,
  body, author, review_id AS reviewId, submitted_at AS submittedAt, resolved,
  created_at AS createdAt`;

interface ReviewRow {
  id: string;
  sessionId: string;
  status: CodeReviewView['status'];
  findingsJson: string;
  error: string | null;
  modelId: string | null;
  createdAt: string;
}

/** Folders that are never a session folder (system locations). */
const SYSTEM_FOLDERS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/System',
  '/Library',
  '/private/etc',
];

/** How long repository info is reused between views of a session. */
const REPO_INFO_TTL_MS = 2_000;
/** Symbol indexes kept in memory at once (least recently used dropped first). */
const MAX_INDEXES = 16;

export class CodeService {
  readonly git: HookFreeGit;
  readonly #o: CodeServiceOptions;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #home: string | null;
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #repoCache = new Map<string, { at: number; info: RepoInfo | null }>();
  readonly #indexes = new Map<string, SymbolIndex>();
  readonly #reviews = new Map<string, Promise<CodeReviewView>>();
  readonly #stop = new AbortController();
  #turns: TurnStarter | null = null;
  #terminals: TerminalManager | null = null;
  #statusFn: ((accountId: string, threadId: string) => Promise<StatusView>) | null = null;
  #gitVersion: Promise<string | null> | null = null;

  constructor(opts: CodeServiceOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.code', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#home = opts.home === undefined ? homedir() : opts.home;
    this.git =
      opts.git ?? new HookFreeGit({ emptyHooksDir: join(opts.dataDir, 'code', 'no-hooks') });
  }

  // ---- late-bound collaborators ------------------------------------------------------------

  /** Comments submitted to the agent start a turn through the chat loop (FR-065). */
  useTurns(starter: TurnStarter): void {
    this.#turns = starter;
  }

  /** Terminals bound to a session folder (FR-066). */
  useTerminals(terminals: TerminalManager): void {
    this.#terminals = terminals;
  }

  /** The shared derived status (FR-215), when the runtime provides one. */
  useStatus(fn: (accountId: string, threadId: string) => Promise<StatusView>): void {
    this.#statusFn = fn;
  }

  // ---- environments (FR-062; M5: local only) -------------------------------------------------

  async environments(accountId: string): Promise<EnvironmentView[]> {
    const env = await this.#localEnv(accountId);
    return [await this.#checkEnv(env)];
  }

  async #localEnv(accountId: string): Promise<EnvRow> {
    const select = () =>
      this.#o.db.raw
        .prepare(
          `SELECT id, account_id AS accountId, kind, label, status, status_detail AS statusDetail,
             last_check_at AS lastCheckAt
           FROM environment WHERE account_id = ? AND kind = 'local'`,
        )
        .get(accountId) as EnvRow | undefined;
    const found = select();
    if (found) return found;
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT OR IGNORE INTO environment (id, account_id, kind, label, status, created_at,
             updated_at) VALUES (?, ?, 'local', 'This Hub', 'unknown', ?, ?)`,
        )
        .run(uuidv7(), accountId, now, now);
    });
    return select()!;
  }

  /** Health of the local environment: Git for change capture, the sandbox for commands. */
  async #checkEnv(env: EnvRow): Promise<EnvironmentView> {
    this.#gitVersion ??= this.git.version();
    const version = await this.#gitVersion;
    const sandbox = this.#o.sandbox?.() ?? null;
    let sandboxOk = false;
    let sandboxDetail = 'no sandbox';
    if (sandbox) {
      try {
        const a = await sandbox.available();
        sandboxOk = a.ok;
        sandboxDetail = a.ok ? `${sandbox.substrate ?? 'sandbox'} sandbox` : a.detail;
      } catch (err) {
        sandboxDetail = err instanceof Error ? err.message : String(err);
      }
    }
    const status: EnvironmentView['status'] = version && sandboxOk ? 'ok' : 'degraded';
    const detail = [
      version
        ? version.replace(/^git version /, 'Git ')
        : 'Git is not installed: changes cannot be captured',
      sandboxOk ? sandboxDetail : `commands cannot run (${sandboxDetail})`,
    ].join('; ');
    const now = this.#iso();
    if (status !== env.status || detail !== env.statusDetail) {
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            `UPDATE environment SET status = ?, status_detail = ?, last_check_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(status, detail, now, now, env.id);
      });
    }
    return {
      id: env.id,
      kind: env.kind,
      label: env.label,
      // The same rule the session policy applies to Bypass (code/policy.ts).
      isolated: sandboxOk && isolatedSubstrate(sandbox?.substrate),
      status,
      detail,
      checkedAt: now,
    };
  }

  // ---- sessions (FR-061) ---------------------------------------------------------------------

  async create(accountId: string, req: CreateCodeSessionRequest): Promise<CodeSessionView> {
    const folder = await this.#checkFolder(req.folder);
    if (req.projectId) this.#assertProject(accountId, req.projectId);
    const env = await this.#localEnv(accountId);
    if (req.environmentId && req.environmentId !== env.id)
      throw new NovaError('not_found', 'environment not found');
    const projectFolderId = this.#projectFolderFor(accountId, folder, req.projectId ?? null);
    const conditions = await this.#conditions();
    let mode: PermissionMode;
    if (req.permissionMode) {
      assertModeAvailable(req.permissionMode, conditions);
      mode = req.permissionMode;
    } else {
      // The mode last used in this folder, else the default; one that cannot be used now
      // falls back to Manual (fail closed).
      const remembered = (await this.#o.setting('code.folderModes'))[folder];
      const fallback = await this.#o.setting('code.permissionMode');
      const candidates: (PermissionMode | undefined)[] = [remembered, fallback];
      mode = candidates.find((m) => m && !modeUnavailable(m, conditions)) ?? 'manual';
    }
    if (req.model !== undefined && !(await this.#o.router.usable(accountId, req.model)))
      throw new NovaError('validation', `unknown model: ${req.model}`, {
        details: { reason: 'unknown_model', model: req.model },
      });

    const id = uuidv7();
    let worktree: WorktreeRow | null = null;
    let work = folder;
    const cleanup: (() => Promise<unknown>)[] = [];
    try {
      if (req.worktree) {
        const info = await repoInfo(this.git, folder);
        if (!info) throw new NovaError('validation', 'a worktree needs a Git repository');
        worktree = await createWorktree({
          git: this.git,
          db: this.#o.db,
          accountId,
          repoRoot: info.root,
          sourceBranch: info.branch ?? 'HEAD',
          slug: branchSlug(req.title ?? basename(folder)),
          now: this.#now,
        });
        const wt = worktree;
        cleanup.push(() =>
          releaseWorktree({ git: this.git, db: this.#o.db, row: wt, now: this.#now }),
        );
        work = join(worktree.path, relative(info.root, folder));
      }
      const shadow = this.#shadowAt(id, work);
      cleanup.push(() => shadow.remove());
      await shadow.init(await repoUserExcludes(this.git, work));
      const baseline = await shadow.snapshot();
      await shadow.setRef('baseline', baseline);
      await shadow.setRef('start', baseline);
      const thread = await this.#o.threads.create(accountId, {
        mode: 'code',
        title: req.title ?? basename(folder),
        ...(req.projectId ? { projectId: req.projectId } : {}),
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
      cleanup.push(() => this.#o.threads.remove(accountId, thread.id));
      const now = this.#iso();
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            `INSERT INTO code_session (id, account_id, thread_id, environment_id, folder_path,
               project_folder_id, worktree_id, branch, permission_mode, status, created_at,
               updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          )
          .run(
            id,
            accountId,
            thread.id,
            env.id,
            folder,
            projectFolderId,
            worktree?.id ?? null,
            worktree?.branch ?? null,
            mode,
            now,
            now,
          );
        if (worktree)
          this.#o.db.raw
            .prepare('UPDATE worktree SET lease_session_id = ?, updated_at = ? WHERE id = ?')
            .run(id, now, worktree.id);
      });
    } catch (err) {
      for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
      throw err;
    }
    if (req.permissionMode && mode !== 'plan') await this.#remember(accountId, folder, mode);
    const s = this.#session(accountId, id);
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'code',
      action: 'code.session.created',
      resource: work,
      decision: mode,
      threadId: s.threadId,
      detail: { sessionId: id, mode, environmentId: env.id, worktreeId: worktree?.id ?? null },
    });
    await this.#emit(s, 'code.session.created', {
      sessionId: id,
      environmentId: env.id,
      mode,
    });
    if (worktree)
      await this.#emit(s, 'worktree.leased', {
        worktreeId: worktree.id,
        repoPath: worktree.repoPath,
        branch: worktree.branch,
        sessionId: id,
        expiresAt: null,
      });
    return this.#view(s);
  }

  async list(accountId: string, opts: { archived?: boolean } = {}): Promise<CodeSessionView[]> {
    await this.sweepArchived(accountId);
    const rows = this.#o.db.raw
      .prepare(
        `${SESSION_SELECT} WHERE s.account_id = ? AND t.deleted_at IS NULL AND t.archived = ?
         ORDER BY s.updated_at DESC, s.id DESC LIMIT 500`,
      )
      .all(accountId, opts.archived ? 1 : 0) as unknown as SessionRow[];
    return Promise.all(rows.map((r) => this.#view(r)));
  }

  async get(accountId: string, id: string): Promise<CodeSessionView> {
    return this.#view(this.#session(accountId, id));
  }

  /** The session of a code thread, or null (tools, policy, extension). */
  sessionForThread(accountId: string, threadId: string): { id: string; folder: string } | null {
    const s = this.#byThread(accountId, threadId);
    return s ? { id: s.id, folder: workFolder(s) } : null;
  }

  async update(
    accountId: string,
    id: string,
    req: UpdateCodeSessionRequest,
  ): Promise<CodeSessionView> {
    const s = this.#session(accountId, id);
    if (req.title !== undefined || req.model !== undefined)
      await this.#o.threads.update(accountId, s.threadId, {
        ...(req.title !== undefined ? { title: req.title } : {}),
        ...(req.model !== undefined ? { model: req.model } : {}),
      });
    const now = this.#iso();
    if (req.permissionMode && req.permissionMode !== s.permissionMode) {
      const to = req.permissionMode;
      assertModeAvailable(to, await this.#conditions());
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare('UPDATE code_session SET permission_mode = ?, updated_at = ? WHERE id = ?')
          .run(to, now, id);
      });
      // Every mode change is audited (docs/10 §3).
      await this.#o.audit.append({
        accountId,
        actor: 'user',
        kind: 'code',
        action: 'code.mode.changed',
        resource: workFolder(s),
        decision: to,
        threadId: s.threadId,
        detail: { sessionId: id, from: s.permissionMode, to },
      });
      await this.#emit(s, 'code.session.modeChanged', {
        sessionId: id,
        from: s.permissionMode,
        to,
      });
      if (to !== 'plan') await this.#remember(accountId, s.folderPath, to);
    } else {
      await this.#o.db.transaction(() => {
        this.#o.db.raw.prepare('UPDATE code_session SET updated_at = ? WHERE id = ?').run(now, id);
      });
    }
    const next = this.#session(accountId, id);
    await this.#emit(next, 'code.session.updated', { sessionId: id });
    return this.#view(next);
  }

  /**
   * Sessions whose thread was archived or deleted are archived too; their worktree lease is
   * released (a clean worktree is removed). Runs lazily and from the Hub's periodic sweep.
   */
  async sweepArchived(accountId?: string): Promise<number> {
    const rows = this.#o.db.raw
      .prepare(
        `${SESSION_SELECT} WHERE s.status = 'active' AND (t.archived = 1 OR t.deleted_at IS NOT NULL)
         ${accountId ? 'AND s.account_id = ?' : ''}`,
      )
      .all(...(accountId ? [accountId] : [])) as unknown as SessionRow[];
    for (const s of rows) {
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare("UPDATE code_session SET status = 'archived', updated_at = ? WHERE id = ?")
          .run(this.#iso(), s.id);
      });
      this.#indexes.delete(s.id);
      if (!s.worktreeId) continue;
      const wt = this.#o.db.raw
        .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktree WHERE id = ?`)
        .get(s.worktreeId) as WorktreeRow | undefined;
      if (!wt || wt.leaseSessionId !== s.id) continue;
      try {
        await releaseWorktree({ git: this.git, db: this.#o.db, row: wt, now: this.#now });
        await this.#emit(s, 'worktree.released', {
          worktreeId: wt.id,
          sessionId: s.id,
          reason: 'done',
        });
      } catch (err) {
        this.#log.warn('releasing a worktree failed', { err, worktreeId: wt.id });
      }
    }
    return rows.length;
  }

  // ---- runtime seams -----------------------------------------------------------------------

  /** The permission mode as approval policy, profile and roots (FR-063, FR-190). */
  readonly policy: ThreadPolicySource = {
    forThread: async (accountId, threadId): Promise<ThreadPolicy | null> => {
      const s = this.#byThread(accountId, threadId);
      if (!s) return null;
      const p = modePolicy(s.permissionMode, workFolder(s), await this.#conditions());
      if (p.permissionMode !== s.permissionMode)
        this.#log.warn('code session mode unavailable; running with manual', {
          sessionId: s.id,
          mode: s.permissionMode,
        });
      return p;
    },
  };

  /** Blocked when the environment is down or the folder is gone (FR-215). */
  readonly status: ThreadStatusSource = {
    blocked: async (accountId, threadIds) => {
      const out = new Map<string, string>();
      for (const threadId of threadIds) {
        const s = this.#byThread(accountId, threadId);
        if (!s) continue;
        const reason = await this.#blockedReason(s);
        if (reason) out.set(threadId, reason);
      }
      return out;
    },
    children: () => Promise.resolve([]),
  };

  /** The Environment block for each turn and a change refresh when it ends (docs/09 §11). */
  readonly extension: TurnExtension = {
    forTurn: async (input) => {
      if (input.mode !== 'code') return null;
      const s = this.#byThread(input.accountId, input.threadId);
      if (!s) return null;
      return {
        context: [{ label: 'Environment', text: await this.#environmentText(s), trusted: true }],
        onEnd: async () => {
          try {
            await this.refresh(s.accountId, s.id);
          } catch (err) {
            this.#log.warn('refreshing changes after a turn failed', { err, sessionId: s.id });
          }
        },
      };
    },
  };

  async #environmentText(s: SessionRow): Promise<string> {
    const work = workFolder(s);
    const info = await this.#repo(work, true);
    const git = info
      ? `branch ${info.branch ?? '(detached HEAD)'}${info.head ? ` at ${info.head.slice(0, 12)}` : ', no commits yet'}; ${info.dirty ? 'uncommitted changes' : 'clean'}`
      : 'not a Git repository';
    return [
      `Working folder: ${work}`,
      `Runs on: this Hub (local environment); commands run in its sandbox`,
      `Operating system: ${platform()} ${release()} (${arch()})`,
      `Git: ${git}`,
      `Time: ${this.#iso()}`,
      `Permission mode: ${describePermissionMode(s.permissionMode)}`,
    ].join('\n');
  }

  // ---- changes (FR-064, FR-065) --------------------------------------------------------------

  /** The session's changes, refreshed from the work tree first. */
  async changes(accountId: string, id: string): Promise<CodeChangeView[]> {
    const s = this.#session(accountId, id);
    // Views read the patch blobs, so they are built before another refresh rewrites them.
    return this.#serial(s.id, async () => {
      await this.#refresh(s, null);
      return this.#changeViews(s.id);
    });
  }

  /** Capture what changed since the last refresh; returns the paths whose state changed. */
  async refresh(accountId: string, id: string, callId: string | null = null): Promise<string[]> {
    const s = this.#session(accountId, id);
    return this.#serial(s.id, () => this.#refresh(s, callId));
  }

  /** Refresh after a tool call on a code thread (the Hub listens for tool.call.completed). */
  async refreshThread(accountId: string, threadId: string, callId: string | null) {
    const s = this.#byThread(accountId, threadId);
    if (!s) return [];
    return this.#serial(s.id, () => this.#refresh(s, callId));
  }

  async #refresh(s: SessionRow, callId: string | null): Promise<string[]> {
    const shadow = await this.#ensureShadow(s);
    const { files } = await shadow.changes();
    const rows = this.#changeRows(s.id);
    const byPath = new Map(rows.map((r) => [r.path, r]));
    const now = this.#iso();
    const writes: (() => void)[] = [];
    const changed: string[] = [];
    const seen = new Set<string>();
    const dir = join(this.#o.dataDir, 'code', s.id, 'patches');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const f of files) {
      seen.add(f.path);
      const patch = patchOf(f);
      const digest = sha256(`${f.kind}\n${f.binary ? 'binary\n' : ''}${patch}`);
      const r = byPath.get(f.path);
      if (r && r.pending === 1 && r.patchSha256 === digest && r.applied === 0) continue;
      const cid = r?.id ?? uuidv7();
      const blob = join('code', s.id, 'patches', `${cid}.patch`);
      await writeFile(join(this.#o.dataDir, blob), patch, { mode: 0o600 });
      // A file that was fully decided (or committed) and changes again starts a new round.
      const fresh = !r || r.pending === 0 || r.applied === 1;
      const decided = fresh ? emptyDecided() : parseDecided(r.decidedJson);
      const counts = countLines(f, decided);
      const state = stateOf(true, decided);
      const call = callId ?? (fresh ? null : r.callId);
      if (r) {
        writes.push(() =>
          this.#o.db.raw
            .prepare(
              `UPDATE code_change SET change_kind = ?, additions = ?, deletions = ?, binary = ?,
                 pending = 1, patch_blob_path = ?, patch_sha256 = ?, decided_json = ?, state = ?,
                 call_id = ?, applied = 0, updated_at = ? WHERE id = ?`,
            )
            .run(
              f.kind,
              counts.additions,
              counts.deletions,
              f.binary ? 1 : 0,
              blob,
              digest,
              JSON.stringify(decided),
              state,
              call,
              now,
              cid,
            ),
        );
      } else {
        writes.push(() =>
          this.#o.db.raw
            .prepare(
              `INSERT INTO code_change (id, session_id, path, change_kind, old_path, additions,
                 deletions, binary, pending, patch_blob_path, patch_sha256, decided_json, state,
                 call_id, applied, created_at, updated_at)
               VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?)`,
            )
            .run(
              cid,
              s.id,
              f.path,
              f.kind,
              counts.additions,
              counts.deletions,
              f.binary ? 1 : 0,
              blob,
              digest,
              JSON.stringify(decided),
              state,
              call,
              now,
              now,
            ),
        );
      }
      changed.push(f.path);
    }
    for (const r of rows) {
      if (seen.has(r.path) || r.pending === 0) continue;
      // Nothing pending any more (decided, or undone by the agent).
      const decided = parseDecided(r.decidedJson);
      const hasComments = this.#o.db.raw
        .prepare('SELECT 1 FROM diff_comment WHERE change_id = ? LIMIT 1')
        .get(r.id);
      if (r.patchBlobPath) await rm(join(this.#o.dataDir, r.patchBlobPath), { force: true });
      if (!decided.hunks.length && !decided.file && !hasComments) {
        writes.push(() => this.#o.db.raw.prepare('DELETE FROM code_change WHERE id = ?').run(r.id));
      } else {
        const counts = countLines(null, decided);
        writes.push(() =>
          this.#o.db.raw
            .prepare(
              `UPDATE code_change SET pending = 0, patch_blob_path = NULL, patch_sha256 = NULL,
                 additions = ?, deletions = ?, state = ?, updated_at = ? WHERE id = ?`,
            )
            .run(counts.additions, counts.deletions, stateOf(false, decided), now, r.id),
        );
      }
      changed.push(r.path);
    }
    if (writes.length)
      await this.#o.db.transaction(() => {
        for (const w of writes) w();
      });
    if (changed.length)
      await this.#emit(s, 'code.changes.updated', { sessionId: s.id, files: changed }, 'system');
    return changed;
  }

  /** Accept or reject single hunks of one file (FR-065). */
  async decideHunks(
    accountId: string,
    id: string,
    changeId: string,
    req: HunkDecisionRequest,
  ): Promise<CodeChangeView> {
    const s = this.#session(accountId, id);
    return this.#serial(s.id, async () => {
      const row = this.#changeRow(s.id, changeId);
      const shadow = await this.#ensureShadow(s);
      const file = (await shadow.changes()).files.find((f) => f.path === row.path);
      if (!file) throw stale('this file has nothing pending; reload the changes');
      const want = new Map<string, boolean>();
      for (const d of req.decisions) want.set(d.hunkId, d.accept);
      for (const hunkId of want.keys())
        if (!file.hunks.some((h) => h.id === hunkId))
          throw stale(`hunk ${hunkId} is not pending in ${row.path}; reload the changes`);
      const accept = new Set([...want].filter(([, a]) => a).map(([h]) => h));
      const reject = new Set([...want].filter(([, a]) => !a).map(([h]) => h));
      const decided = parseDecided(row.decidedJson);
      try {
        if (accept.size) {
          const base = await this.#baseline(shadow);
          await shadow.setRef(
            'baseline',
            await shadow.applyToTree(base, buildHunkPatch(file, accept)),
          );
          for (const h of file.hunks)
            if (accept.has(h.id)) decided.hunks.push(hunkView(h, 'accepted'));
        }
        if (reject.size) {
          await shadow.reverseInWorkTree(buildHunkPatch(file, reject));
          for (const h of file.hunks)
            if (reject.has(h.id)) decided.hunks.push(hunkView(h, 'rejected'));
        }
      } finally {
        await this.#saveDecided(row.id, decided);
        await this.#refresh(s, null);
      }
      await this.#announceDecision(s, accountId, row, file, accept.size > 0, reject.size > 0);
      return this.#changeViewById(s.id, changeId);
    });
  }

  /** Accept or reject everything pending (of the given changes, or all). */
  async decideAll(
    accountId: string,
    id: string,
    accept: boolean,
    changeIds?: readonly string[],
  ): Promise<CodeChangeView[]> {
    const s = this.#session(accountId, id);
    return this.#serial(s.id, async () => {
      const ids = await this.#decideAll(s, accept, changeIds ?? null);
      return Promise.all(ids.map((cid) => this.#changeViewById(s.id, cid)));
    });
  }

  async #decideAll(
    s: SessionRow,
    accept: boolean,
    changeIds: readonly string[] | null,
  ): Promise<string[]> {
    // Rows for everything pending exist before deciding (nothing may have listed them yet).
    await this.#refresh(s, null);
    const shadow = await this.#ensureShadow(s);
    const { tree, files } = await shadow.changes();
    let rows = this.#changeRows(s.id).filter((r) => r.applied === 0);
    if (changeIds) {
      const want = new Set(changeIds);
      for (const cid of want)
        if (!rows.some((r) => r.id === cid)) throw new NovaError('not_found', 'change not found');
      rows = rows.filter((r) => want.has(r.id));
    }
    const byPath = new Map(files.map((f) => [f.path, f]));
    const targets = rows
      .map((r) => ({ row: r, file: byPath.get(r.path) }))
      .filter((t): t is { row: ChangeRow; file: ParsedDiffFile } => !!t.file);
    if (!targets.length) return rows.map((r) => r.id);
    try {
      if (accept) {
        const updates: ShadowTreeUpdate[] = [];
        for (const t of targets) {
          const entry = await shadow.entry(tree, t.file.path);
          updates.push(entry ? { path: t.file.path, entry } : { path: t.file.path, remove: true });
        }
        const base = await this.#baseline(shadow);
        await shadow.setRef('baseline', await shadow.updateTree(base, updates));
      } else {
        await shadow.restore(
          'baseline',
          targets.map((t) => t.file.path),
        );
      }
      for (const t of targets) {
        const decided = parseDecided(t.row.decidedJson);
        const state = accept ? 'accepted' : 'rejected';
        if (t.file.hunks.length)
          for (const h of t.file.hunks) decided.hunks.push(hunkView(h, state));
        else decided.file = state;
        await this.#saveDecided(t.row.id, decided);
      }
    } finally {
      await this.#refresh(s, null);
    }
    for (const t of targets)
      await this.#announceDecision(s, s.accountId, t.row, t.file, accept, !accept);
    return rows.map((r) => r.id);
  }

  async #announceDecision(
    s: SessionRow,
    accountId: string,
    row: ChangeRow,
    file: ParsedDiffFile,
    accepted: boolean,
    rejected: boolean,
  ): Promise<void> {
    if (accepted)
      await this.#emit(s, 'code.change.applied', {
        sessionId: s.id,
        changeId: row.id,
        path: row.path,
        additions: file.additions,
        deletions: file.deletions,
      });
    if (rejected) {
      await this.#emit(s, 'code.change.reverted', { sessionId: s.id, changeId: row.id });
      // Rejecting rewrites the user's files.
      await this.#o.audit.append({
        accountId,
        actor: 'user',
        kind: 'code',
        action: 'code.change.rejected',
        resource: join(workFolder(s), row.path),
        result: 'ok',
        threadId: s.threadId,
        detail: { sessionId: s.id, changeId: row.id },
      });
    }
  }

  async #saveDecided(changeId: string, decided: Decided): Promise<void> {
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare('UPDATE code_change SET decided_json = ?, reviewed_at = ? WHERE id = ?')
        .run(JSON.stringify(decided), this.#iso(), changeId);
    });
  }

  #changeRows(sessionId: string): ChangeRow[] {
    return this.#o.db.raw
      .prepare(`SELECT ${CHANGE_COLUMNS} FROM code_change WHERE session_id = ? ORDER BY path`)
      .all(sessionId) as unknown as ChangeRow[];
  }

  #changeRow(sessionId: string, changeId: string): ChangeRow {
    const r = this.#o.db.raw
      .prepare(`SELECT ${CHANGE_COLUMNS} FROM code_change WHERE session_id = ? AND id = ?`)
      .get(sessionId, changeId) as ChangeRow | undefined;
    if (!r) throw new NovaError('not_found', 'change not found');
    return r;
  }

  async #changeViews(sessionId: string): Promise<CodeChangeView[]> {
    const rows = this.#changeRows(sessionId).filter((r) => r.applied === 0);
    return Promise.all(rows.map((r) => this.#viewOfChange(r)));
  }

  #changeViewById(sessionId: string, changeId: string): Promise<CodeChangeView> {
    return this.#viewOfChange(this.#changeRow(sessionId, changeId));
  }

  async #viewOfChange(r: ChangeRow): Promise<CodeChangeView> {
    let pending: ParsedDiffFile | null = null;
    if (r.pending === 1 && r.patchBlobPath) {
      try {
        pending = pendingFile(r, await readFile(join(this.#o.dataDir, r.patchBlobPath), 'utf8'));
      } catch {
        pending = null;
      }
    }
    return changeView(r, pending);
  }

  // ---- comments (FR-065) ---------------------------------------------------------------------

  comments(accountId: string, id: string): CodeDiffComment[] {
    const s = this.#session(accountId, id);
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM diff_comment WHERE session_id = ? ORDER BY created_at, id`,
      )
      .all(s.id) as unknown as CommentRow[];
    return rows.map(commentView);
  }

  /**
   * Add a batch of comments; `submit` sends every unsent comment of the session to the agent
   * as one user turn, so it revises the diff. The comments are the user's own words (FR-189).
   */
  async addComments(
    accountId: string,
    id: string,
    req: DiffCommentsRequest,
  ): Promise<CodeDiffComment[]> {
    const s = this.#session(accountId, id);
    if (req.submit && !this.#turns)
      throw new NovaError('conflict', 'the agent cannot take comments right now', {
        details: { reason: 'turns_unavailable' },
      });
    const changes = new Map(this.#changeRows(s.id).map((r) => [r.id, r]));
    for (const c of req.comments)
      if (!changes.has(c.changeId)) throw new NovaError('not_found', 'change not found');
    const now = this.#iso();
    const ids: string[] = [];
    await this.#o.db.transaction(() => {
      for (const c of req.comments) {
        const cid = uuidv7();
        ids.push(cid);
        this.#o.db.raw
          .prepare(
            `INSERT INTO diff_comment (id, change_id, session_id, path, line, side, body, author,
               resolved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 0, ?)`,
          )
          .run(cid, c.changeId, s.id, changes.get(c.changeId)!.path, c.line, c.side, c.body, now);
      }
    });
    for (const c of req.comments)
      await this.#emit(s, 'code.diff.commented', {
        changeId: c.changeId,
        line: c.line,
        side: c.side,
      });
    if (req.submit) await this.#submitComments(s);
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM diff_comment WHERE id IN (${ids.map(() => '?').join(',')})
         ORDER BY created_at, id`,
      )
      .all(...ids) as unknown as CommentRow[];
    return rows.map(commentView);
  }

  async #submitComments(s: SessionRow): Promise<void> {
    const pending = this.#o.db.raw
      .prepare(
        `SELECT ${COMMENT_COLUMNS} FROM diff_comment
         WHERE session_id = ? AND author = 'user' AND resolved = 0 AND submitted_at IS NULL
         ORDER BY path, line, created_at`,
      )
      .all(s.id) as unknown as CommentRow[];
    if (!pending.length || !this.#turns) return;
    const text = [
      'Please revise your changes to address these review comments on the diff:',
      '',
      ...pending.map(
        (c) =>
          `- ${c.path ?? '(file)'} line ${c.line ?? '?'} (${c.side === 'old' ? 'old' : 'new'} side): ${c.body}`,
      ),
    ].join('\n');
    await this.#turns.startTurn({
      accountId: s.accountId,
      threadId: s.threadId,
      text,
      trigger: 'user',
      authority: { kind: 'user', source: `code:${s.id}:comments` },
      authorKind: 'user',
    });
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      for (const c of pending)
        this.#o.db.raw
          .prepare('UPDATE diff_comment SET submitted_at = ? WHERE id = ?')
          .run(now, c.id);
    });
  }

  async resolveComment(accountId: string, id: string, commentId: string): Promise<CodeDiffComment> {
    const s = this.#session(accountId, id);
    const found = this.#o.db.raw
      .prepare('SELECT id FROM diff_comment WHERE id = ? AND session_id = ?')
      .get(commentId, s.id);
    if (!found) throw new NovaError('not_found', 'comment not found');
    await this.#o.db.transaction(() => {
      this.#o.db.raw.prepare('UPDATE diff_comment SET resolved = 1 WHERE id = ?').run(commentId);
    });
    const row = this.#o.db.raw
      .prepare(`SELECT ${COMMENT_COLUMNS} FROM diff_comment WHERE id = ?`)
      .get(commentId) as unknown as CommentRow;
    return commentView(row);
  }

  // ---- review (FR-069) -----------------------------------------------------------------------

  /**
   * Start a structured review of the session's uncommitted changes (accepted and pending) with
   * the session's model. Returns at once with a running review; `done` settles when it ends.
   */
  async startReview(
    accountId: string,
    id: string,
  ): Promise<{ view: CodeReviewView; done: Promise<CodeReviewView> }> {
    const s = this.#session(accountId, id);
    const diff = await this.#serial(s.id, async () => {
      await this.#refresh(s, null);
      const shadow = await this.#ensureShadow(s);
      const start = (await shadow.ref('start')) ?? (await this.#baseline(shadow));
      const tree = await shadow.snapshot();
      return (await shadow.diffWithPatch(start, tree)).patch;
    });
    if (!diff.trim()) throw new NovaError('validation', 'there are no changes to review');
    const model = s.modelId ?? (await this.#o.threads.defaultModel(accountId));
    if (!model) throw new NovaError('validation', 'choose a model for this session first');
    const reviewId = uuidv7();
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO code_review (id, session_id, status, model_id, findings_json, attempts,
             created_at) VALUES (?, ?, 'running', ?, '[]', 0, ?)`,
        )
        .run(reviewId, s.id, model, now);
    });
    const done = this.#runReview(s, reviewId, model, diff);
    this.#reviews.set(reviewId, done);
    void done.finally(() => this.#reviews.delete(reviewId));
    return { view: this.review(accountId, id, reviewId), done };
  }

  async #runReview(
    s: SessionRow,
    reviewId: string,
    model: string,
    diff: string,
  ): Promise<CodeReviewView> {
    const signal = AbortSignal.any([
      this.#stop.signal,
      AbortSignal.timeout(this.#o.reviewTimeoutMs ?? 5 * 60_000),
    ]);
    let findings: ReviewFindingView[] = [];
    let status: 'done' | 'failed' = 'done';
    let error: string | null = null;
    let attempts = 0;
    try {
      const r = await runCodeReview({
        router: this.#o.router,
        accountId: s.accountId,
        model,
        diff,
        signal,
      });
      findings = r.findings;
      attempts = r.attempts;
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      attempts = 2;
    }
    // Findings on a changed file become diff comments on that line.
    const changes = new Map(this.#changeRows(s.id).map((r) => [r.path, r]));
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE code_review SET status = ?, findings_json = ?, attempts = ?, error = ?,
             completed_at = ? WHERE id = ?`,
        )
        .run(status, JSON.stringify(findings), attempts, error, now, reviewId);
      for (const f of findings) {
        const change = changes.get(f.path);
        if (!change || f.line === null) continue;
        const body = [
          `[${f.severity}] ${f.title}`,
          f.reasoning,
          f.fix ? `Suggested fix:\n${f.fix}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        this.#o.db.raw
          .prepare(
            `INSERT INTO diff_comment (id, change_id, session_id, path, line, side, body, author,
               review_id, resolved, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?, 'review', ?, 0, ?)`,
          )
          .run(uuidv7(), change.id, s.id, f.path, f.line, body.slice(0, 8000), reviewId, now);
      }
    });
    await this.#o.audit.append({
      accountId: s.accountId,
      actor: 'user',
      kind: 'code',
      action: 'code.review',
      resource: workFolder(s),
      result: status === 'done' ? 'ok' : 'error',
      threadId: s.threadId,
      detail: { sessionId: s.id, reviewId, model, findings: findings.length, attempts },
    });
    await this.#emit(
      s,
      'code.review.completed',
      { sessionId: s.id, reviewId, status, findings: findings.length },
      'system',
    );
    return this.review(s.accountId, s.id, reviewId);
  }

  review(accountId: string, id: string, reviewId: string): CodeReviewView {
    const s = this.#session(accountId, id);
    const r = this.#o.db.raw
      .prepare(
        `SELECT id, session_id AS sessionId, status, findings_json AS findingsJson, error,
           model_id AS modelId, created_at AS createdAt FROM code_review
           WHERE id = ? AND session_id = ?`,
      )
      .get(reviewId, s.id) as ReviewRow | undefined;
    if (!r) throw new NovaError('not_found', 'review not found');
    return {
      id: r.id,
      sessionId: r.sessionId,
      status: r.status,
      findings: JSON.parse(r.findingsJson) as ReviewFindingView[],
      // Why a review failed reaches the client (it is already redacted when stored).
      error: r.error,
      model: r.modelId,
      createdAt: r.createdAt,
    };
  }

  // ---- commit (docs/10 §8) -------------------------------------------------------------------

  /**
   * Commit the session's accepted changes. Refuses on the default branch unless `branch` creates
   * `nova/<slug>`, refuses when the staged diff holds likely secrets, and never pushes.
   */
  async commit(accountId: string, id: string, req: CodeCommitRequest): Promise<CodeCommitResult> {
    const s = this.#session(accountId, id);
    const result = await this.#serial(s.id, async () => {
      const work = workFolder(s);
      const info = await repoInfo(this.git, work);
      if (!info) throw new NovaError('validation', 'the session folder is not a Git repository');
      if (req.acceptPending) await this.#decideAll(s, true, null);
      else await this.#refresh(s, null);
      const shadow = await this.#ensureShadow(s);
      const base = await this.#baseline(shadow);
      const start = (await shadow.ref('start')) ?? base;
      const files = await shadow.diff(start, base);
      if (!files.length)
        throw new NovaError('validation', 'nothing to commit: accept some changes first', {
          details: { reason: 'nothing_accepted' },
        });
      if (await hasStaged(this.git, info.root))
        throw new NovaError(
          'conflict',
          'other changes are staged in this repository; commit or unstage them first',
          {
            details: { reason: 'staged_changes' },
          },
        );
      // Branch guard: never commit on the default branch without a new `nova/<slug>` branch.
      let branch = info.branch;
      if (req.branch) {
        branch = await freeBranch(this.git, info.root, branchSlug(req.branch));
      } else if (!branch) {
        throw new NovaError('conflict', 'HEAD is detached; give a branch name to commit on', {
          details: { reason: 'detached_head' },
        });
      } else if (await isDefaultBranch(this.git, info.root, branch)) {
        throw new NovaError(
          'policy_denied',
          `commits on the default branch (${branch}) are refused; give a branch name to create nova/<name>`,
          { details: { reason: 'default_branch', branch } },
        );
      }
      const prefix = relative(info.root, work).split(sep).filter(Boolean).join('/');
      const entries: StageEntry[] = [];
      for (const f of files) {
        const entry = await shadow.entry(base, f.path);
        entries.push({
          path: prefix ? `${prefix}/${f.path}` : f.path,
          content: entry ? { mode: entry.mode, data: await shadow.blob(entry.sha) } : null,
        });
      }
      const paths = entries.map((e) => e.path);
      const switched = branch !== info.branch;
      if (switched) await switchToNewBranch(this.git, info.root, branch);
      await stage(this.git, info.root, entries);
      try {
        const findings = await scanStaged(this.git, info.root, entries);
        if (findings.length)
          throw new NovaError('policy_denied', 'the commit looks like it contains secrets', {
            details: {
              reason: 'secrets_found',
              findings: findings.map((f) => ({
                path: f.path,
                line: f.line,
                rule: f.rule,
                preview: f.preview,
              })),
            },
          });
        const hooks = await hasCommitHooks(this.git, info.root);
        const ran = hooks ? await this.#commitInSandbox(s, info.root, work, req.message) : false;
        if (!ran) {
          const r = await this.git.run(['commit', '-q', '--no-verify', '-F', '-'], {
            cwd: info.root,
            input: req.message,
            allowFail: true,
          });
          if (r.code !== 0) throw commitFailed(r.stderr);
        }
        await this.#settleCommit(s, shadow, start, base);
        return { hooks, ran, branch, files: entries.length };
      } catch (err) {
        await unstage(this.git, info.root, paths);
        // The new branch points at the same commit: going back changes no file.
        if (switched && info.branch) {
          await this.git.run(['symbolic-ref', 'HEAD', `refs/heads/${info.branch}`], {
            cwd: info.root,
            allowFail: true,
          });
          await this.git.run(['branch', '-D', branch], { cwd: info.root, allowFail: true });
        }
        throw err;
      }
    });
    const head = await this.git.text(['rev-parse', 'HEAD'], { cwd: workFolder(s) });
    const out: CodeCommitResult = {
      sha: head,
      branch: result.branch,
      files: result.files,
      hooksRan: result.ran,
      hooksNote:
        result.hooks && !result.ran
          ? "The repository's commit hooks did not run: no sandbox with Git is available on this Hub."
          : null,
    };
    if (result.branch !== s.branch)
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare('UPDATE code_session SET branch = ?, updated_at = ? WHERE id = ?')
          .run(result.branch, this.#iso(), s.id);
      });
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'code',
      action: 'code.commit',
      resource: workFolder(s),
      decision: 'allow',
      result: 'ok',
      threadId: s.threadId,
      detail: {
        sessionId: s.id,
        sha: out.sha,
        branch: out.branch,
        files: out.files,
        hooksRan: out.hooksRan,
      },
    });
    await this.#emit(s, 'code.commit.created', {
      sessionId: s.id,
      sha: out.sha,
      branch: out.branch,
    });
    await this.#emit(s, 'code.session.updated', { sessionId: s.id });
    return out;
  }

  /** After a commit: committed changes leave the list and `start` moves to the commit. */
  async #settleCommit(s: SessionRow, shadow: ShadowRepo, start: string, base: string) {
    const committed = new Set((await shadow.diff(start, base)).map((f) => f.path));
    await shadow.setRef('start', base);
    const now = this.#iso();
    const rows = this.#changeRows(s.id).filter((r) => committed.has(r.path));
    await this.#o.db.transaction(() => {
      for (const r of rows) {
        if (r.pending === 1) {
          // The accepted part is committed; what is still pending starts a fresh round.
          this.#o.db.raw
            .prepare(
              `UPDATE code_change SET decided_json = ?, state = 'pending', updated_at = ? WHERE id = ?`,
            )
            .run(JSON.stringify(emptyDecided()), now, r.id);
        } else {
          this.#o.db.raw
            .prepare('UPDATE code_change SET applied = 1, updated_at = ? WHERE id = ?')
            .run(now, r.id);
        }
      }
    });
  }

  /**
   * Run `git commit` with the repository's hooks inside the sandbox (FR-211). Returns false when
   * no sandbox with Git is available (the caller commits on the Hub without hooks).
   */
  async #commitInSandbox(
    s: SessionRow,
    repoRoot: string,
    work: string,
    message: string,
  ): Promise<boolean> {
    const sandbox = this.#o.sandbox?.() ?? null;
    if (!sandbox) return false;
    const roots: ToolRoot[] = [{ path: repoRoot, access: 'write', label: basename(repoRoot) }];
    const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(10 * 60_000)]);
    if (!(await sandboxHasGit(sandbox, work, roots, signal))) return false;
    const r = await sandbox.exec({
      cmd: 'printf "%s\\n" "$NOVA_COMMIT_MESSAGE" | git commit -q -F -',
      cwd: repoRoot,
      roots,
      network: 'off',
      env: { ...(await identity(this.git, repoRoot)), NOVA_COMMIT_MESSAGE: message },
      yieldMs: 5 * 60_000,
      signal,
      turnId: `code-commit:${s.id}`,
    });
    if (r.status !== 'exited') {
      await sandbox.killTurn(`code-commit:${s.id}`).catch(() => undefined);
      throw new NovaError('conflict', 'the commit hooks did not finish in time');
    }
    if (r.exitCode !== 0) throw commitFailed(r.output);
    return true;
  }

  // ---- symbols and refs (FR-074) -------------------------------------------------------------

  /**
   * Definitions matching `q`. Paths are relative to the session folder (what the agent's tools
   * take), or to the repository root with `relativeTo: 'repo'` (the API, for the UI).
   */
  async symbols(
    accountId: string,
    id: string,
    q: string,
    limit = 50,
    relativeTo: 'folder' | 'repo' = 'folder',
  ): Promise<CodeSymbolView[]> {
    const s = this.#session(accountId, id);
    const index = await this.#index(s);
    const prefix = relativeTo === 'repo' ? await this.#repoPrefix(s) : '';
    return index.search(q, limit).map((h) => (prefix ? { ...h, path: `${prefix}/${h.path}` } : h));
  }

  async refs(
    accountId: string,
    id: string,
    name: string,
    limit = 100,
    relativeTo: 'folder' | 'repo' = 'folder',
  ): Promise<CodeRef[]> {
    const s = this.#session(accountId, id);
    const files = await this.#serial(s.id, async () => (await this.#ensureShadow(s)).listFiles());
    const prefix = relativeTo === 'repo' ? await this.#repoPrefix(s) : '';
    return (await findCodeRefs(workFolder(s), files, name, { limit })).map((r) =>
      prefix ? { ...r, path: `${prefix}/${r.path}` } : r,
    );
  }

  /** The session folder relative to its repository root (`''` at the root or outside Git). */
  async #repoPrefix(s: SessionRow): Promise<string> {
    const work = workFolder(s);
    const info = await this.#repo(work);
    if (!info) return '';
    return relative(info.root, work).split(sep).filter(Boolean).join('/');
  }

  async #index(s: SessionRow): Promise<SymbolIndex> {
    let index = this.#indexes.get(s.id);
    if (index) this.#indexes.delete(s.id);
    else index = new SymbolIndex();
    this.#indexes.set(s.id, index);
    while (this.#indexes.size > MAX_INDEXES) {
      const oldest = this.#indexes.keys().next().value;
      if (oldest === undefined) break;
      this.#indexes.delete(oldest);
    }
    const files = await this.#serial(s.id, async () => (await this.#ensureShadow(s)).listFiles());
    await index.update(workFolder(s), files);
    return index;
  }

  // ---- read-only Git for the coding tools (FR-211) -------------------------------------------

  async gitStatus(accountId: string, threadId: string): Promise<string> {
    const s = this.#requireThread(accountId, threadId);
    const r = await this.git.run(['status', '--porcelain=v1', '-b', '--untracked-files=normal'], {
      cwd: workFolder(s),
    });
    return r.stdout.toString('utf8');
  }

  async gitDiff(
    accountId: string,
    threadId: string,
    opts: { path?: string; staged?: boolean },
  ): Promise<string> {
    const s = this.#requireThread(accountId, threadId);
    const args = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--src-prefix=a/',
      '--dst-prefix=b/',
    ];
    if (opts.staged) args.push('--cached');
    if (opts.path) args.push('--', `:(literal)${relPath(opts.path)}`);
    const r = await this.git.run(args, { cwd: workFolder(s), maxBytes: 8 * 1024 * 1024 });
    return r.stdout.toString('utf8');
  }

  async gitLog(
    accountId: string,
    threadId: string,
    opts: { limit?: number; path?: string },
  ): Promise<string> {
    const s = this.#requireThread(accountId, threadId);
    const n = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const args = ['log', `-n${n}`, '--no-color', '--date=short', '--format=%h %ad %an%x09%s'];
    if (opts.path) args.push('--', `:(literal)${relPath(opts.path)}`);
    const r = await this.git.run(args, { cwd: workFolder(s), allowFail: true });
    if (r.code !== 0) return r.stderr.includes('does not have any commits') ? '' : r.stderr;
    return r.stdout.toString('utf8');
  }

  /** The session folder of a code thread for tools; `not_found` outside a Code session. */
  folderOfThread(accountId: string, threadId: string): string {
    return workFolder(this.#requireThread(accountId, threadId));
  }

  /** Announce a finished test run (contracts/events.md `code.test.completed`). */
  async testCompleted(
    accountId: string,
    threadId: string,
    status: 'passed' | 'failed' | 'timeout' | 'error',
    summary: string,
  ): Promise<void> {
    const s = this.#byThread(accountId, threadId);
    if (s) await this.#emit(s, 'code.test.completed', { sessionId: s.id, status, summary });
  }

  // ---- terminal (FR-066) ---------------------------------------------------------------------

  async openTerminal(accountId: string, id: string, size: { cols: number; rows: number }) {
    const s = this.#session(accountId, id);
    if (!this.#terminals)
      throw new NovaError('sandbox_unavailable', 'terminals are not available on this Hub');
    return this.#terminals.create(accountId, {
      threadId: s.threadId,
      root: workFolder(s),
      cols: size.cols,
      rows: size.rows,
    });
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async close(): Promise<void> {
    this.#stop.abort();
    await Promise.allSettled([...this.#reviews.values()]);
    await Promise.allSettled([...this.#locks.values()]);
  }

  // ---- internals ---------------------------------------------------------------------------

  #iso(): string {
    return this.#now().toISOString();
  }

  /** Run `fn` after every earlier operation on the same session (one shadow index each). */
  #serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.#locks.set(sessionId, tail);
    void tail.then(() => {
      if (this.#locks.get(sessionId) === tail) this.#locks.delete(sessionId);
    });
    return next;
  }

  #session(accountId: string, id: string): SessionRow {
    const s = this.#o.db.raw
      .prepare(`${SESSION_SELECT} WHERE s.id = ? AND s.account_id = ? AND t.deleted_at IS NULL`)
      .get(id, accountId) as SessionRow | undefined;
    if (!s) throw new NovaError('not_found', 'code session not found');
    return s;
  }

  #byThread(accountId: string, threadId: string): SessionRow | null {
    const s = this.#o.db.raw
      .prepare(`${SESSION_SELECT} WHERE s.thread_id = ? AND s.account_id = ?`)
      .get(threadId, accountId) as SessionRow | undefined;
    return s ?? null;
  }

  #requireThread(accountId: string, threadId: string): SessionRow {
    const s = this.#byThread(accountId, threadId);
    if (!s)
      throw new NovaError('not_found', 'this tool works only in Code sessions', {
        details: { reason: 'not_a_code_session' },
      });
    return s;
  }

  #shadowAt(sessionId: string, work: string): ShadowRepo {
    return new ShadowRepo({
      git: this.git,
      gitDir: join(this.#o.dataDir, 'code', sessionId, 'shadow.git'),
      workTree: work,
    });
  }

  /** The session's shadow; recreated (with a fresh baseline) if the data folder lost it. */
  async #ensureShadow(s: SessionRow): Promise<ShadowRepo> {
    const shadow = this.#shadowAt(s.id, workFolder(s));
    if (!shadow.exists) {
      await shadow.init(await repoUserExcludes(this.git, workFolder(s)));
      const tree = await shadow.snapshot();
      await shadow.setRef('baseline', tree);
      await shadow.setRef('start', tree);
    }
    return shadow;
  }

  async #baseline(shadow: ShadowRepo): Promise<string> {
    const base = await shadow.ref('baseline');
    if (!base) throw new NovaError('conflict', 'the session has no baseline');
    return base;
  }

  async #view(s: SessionRow): Promise<CodeSessionView> {
    const work = workFolder(s);
    return {
      id: s.id,
      threadId: s.threadId,
      title: s.title,
      environmentId: s.environmentId,
      folder: { path: work, projectFolderId: s.projectFolderId },
      repo: await this.#repo(work),
      worktreeId: s.worktreeId,
      permissionMode: s.permissionMode,
      model: s.modelId,
      pullRequestUrl: s.pullRequestUrl,
      ciStatus: s.ciStatus,
      derived: await this.#derived(s),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  async #repo(folder: string, fresh = false): Promise<RepoInfo | null> {
    const hit = this.#repoCache.get(folder);
    const now = Date.now();
    if (!fresh && hit && now - hit.at < REPO_INFO_TTL_MS) return hit.info;
    let info: RepoInfo | null;
    try {
      info = existsSync(folder) ? await repoInfo(this.git, folder) : null;
    } catch {
      info = null;
    }
    this.#repoCache.set(folder, { at: now, info });
    if (this.#repoCache.size > 200) this.#repoCache.delete(this.#repoCache.keys().next().value!);
    return info;
  }

  async #derived(s: SessionRow): Promise<StatusView> {
    if (this.#statusFn) return this.#statusFn(s.accountId, s.threadId);
    const blocked = await this.#blockedReason(s);
    if (blocked) return { status: 'blocked', reason: blocked };
    if (s.threadState === 'streaming') return { status: 'running', reason: null };
    if (s.threadState === 'waiting_approval')
      return { status: 'needs_input', reason: 'Approval needed' };
    if (s.threadState === 'waiting_input') return { status: 'needs_input', reason: 'Input needed' };
    return { status: 'ready', reason: null };
  }

  async #blockedReason(s: SessionRow): Promise<string | null> {
    if (s.environmentId) {
      const env = this.#o.db.raw
        .prepare('SELECT status FROM environment WHERE id = ?')
        .get(s.environmentId) as { status: string } | undefined;
      if (env?.status === 'down') return 'Environment down';
    }
    try {
      if (!(await stat(workFolder(s))).isDirectory()) return 'Folder missing';
    } catch {
      return 'Folder missing';
    }
    return null;
  }

  async #conditions(): Promise<PermissionModeConditions> {
    return {
      reviewerModel: await this.#o.setting('review.model'),
      allowBypass: await this.#o.setting('code.allowBypass'),
      substrate: this.#o.sandbox?.()?.substrate ?? null,
    };
  }

  async #remember(accountId: string, folder: string, mode: PermissionMode): Promise<void> {
    if (!this.#o.rememberMode) return;
    try {
      await this.#o.rememberMode(accountId, folder, mode);
    } catch (err) {
      this.#log.warn('remembering the folder mode failed', { err });
    }
  }

  /**
   * A folder a session may work in: it exists and is a folder, and it is not the filesystem
   * root, a system folder, the home folder or an ancestor of it, the Nova data folder (or
   * around it), a credential location or inside a protected location (docs/12 §7.2).
   */
  async #checkFolder(input: string): Promise<string> {
    let p = input.trim();
    if (this.#home && (p === '~' || p.startsWith('~/'))) p = `${this.#home}${p.slice(1)}`;
    if (!isAbsolute(p))
      throw new NovaError('validation', 'use the full path of a folder on the Hub');
    let real: string;
    try {
      real = await realpath(p);
    } catch {
      throw new NovaError('validation', `no folder at ${p}`, { details: { reason: 'missing' } });
    }
    if (!(await stat(real)).isDirectory())
      throw new NovaError('validation', `${p} is not a folder`, {
        details: { reason: 'not_a_folder' },
      });
    const refuse = (message: string) =>
      new NovaError('policy_denied', message, { details: { reason: 'protected_folder' } });
    if (dirname(real) === real) throw refuse('the whole filesystem cannot be a session folder');
    for (const sys of SYSTEM_FOLDERS)
      if (isWithin(sys, real)) throw refuse(`${sys} is a system folder`);
    const data = realpathLenient(this.#o.dataDir);
    if (isWithin(data, real) || isWithin(real, data))
      throw refuse('the Nova data folder, or a folder containing it, cannot be a session folder');
    if (this.#home && isWithin(real, realpathLenient(this.#home)))
      throw refuse('your home folder cannot be a session folder; choose a folder inside it');
    if (isCredentialPath(real)) throw refuse('credential folders cannot be session folders');
    if (isProtectedRel(real.split(/[\\/]/).filter(Boolean)))
      throw refuse('protected folders (.git, .nova, .agents) cannot be session folders');
    return real;
  }

  #assertProject(accountId: string, projectId: string): void {
    const p = this.#o.db.raw
      .prepare('SELECT id FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .get(projectId, accountId);
    if (!p) throw new NovaError('not_found', 'project not found');
  }

  /** The project folder containing `folder` (the given project's first, then any). */
  #projectFolderFor(accountId: string, folder: string, projectId: string | null): string | null {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT f.id, f.path, f.project_id AS projectId FROM project_folder f
         JOIN project p ON p.id = f.project_id
         WHERE p.account_id = ? AND p.deleted_at IS NULL`,
      )
      .all(accountId) as { id: string; path: string; projectId: string }[];
    const containing = rows
      .filter((r) => isWithin(r.path, folder))
      .sort(
        (a, b) =>
          Number(b.projectId === projectId) - Number(a.projectId === projectId) ||
          b.path.length - a.path.length,
      );
    return containing[0]?.id ?? null;
  }

  async #emit(
    s: SessionRow,
    name: string,
    payload: Record<string, unknown>,
    actor: 'user' | 'system' = 'user',
  ): Promise<void> {
    try {
      await this.#o.events.emit({
        name,
        actor,
        accountId: s.accountId,
        correlation: { threadId: s.threadId, sessionId: s.id },
        payload,
      });
    } catch (err) {
      this.#log.warn('could not announce a code event', { err, name });
    }
  }
}

/** Where a session works: its worktree (at the same place inside it) or its folder. */
function workFolder(s: {
  folderPath: string;
  worktreePath: string | null;
  worktreeRepo: string | null;
}): string {
  if (!s.worktreePath || !s.worktreeRepo) return s.folderPath;
  return join(s.worktreePath, relative(s.worktreeRepo, s.folderPath));
}

/** A path argument of a Git tool: relative to the folder, without `..`. */
function relPath(p: string): string {
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((x) => x && x !== '.');
  if (isAbsolute(p) || parts.includes('..'))
    throw new NovaError('validation', 'use a path inside the session folder');
  return parts.join('/') || '.';
}

function commentView(r: CommentRow): CodeDiffComment {
  return {
    id: r.id,
    changeId: r.changeId,
    path: r.path ?? '',
    line: r.line ?? 0,
    side: r.side ?? 'new',
    body: r.body,
    resolved: r.resolved === 1,
    createdAt: r.createdAt,
    author: r.author,
    reviewId: r.reviewId,
    submittedAt: r.submittedAt,
  };
}

function stale(message: string): NovaError {
  return new NovaError('conflict', message, { details: { reason: 'stale_hunk' } });
}

function commitFailed(output: string): NovaError {
  const text = output.trim().slice(0, 2000);
  if (/tell me who you are|empty ident|user\.email/i.test(text))
    return new NovaError('validation', 'Git has no author identity on the Hub', {
      action: 'Set user.name and user.email in your Git config',
      details: { reason: 'no_identity' },
    });
  return new NovaError('conflict', `the commit failed: ${text.split('\n')[0] ?? ''}`, {
    details: { reason: 'commit_failed', output: text },
  });
}
