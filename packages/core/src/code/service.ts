// Code sessions (FR-061, FR-063..FR-066, FR-069, FR-073, FR-074, FR-211; docs/10). A session is a
// `code` thread plus a `code_session` row binding an environment (M5: the built-in `local`
// environment, the Hub host), a folder and a permission mode. Its turns run in the shared chat
// loop (ADR-076); this service shapes them through the runtime seams: the permission mode as
// thread policy, an Environment context block and a change refresh after each turn, the coding
// tools, and the blocked status. Changes are captured with a shadow Git repository per session
// (shadow.ts), reviewed hunk by hunk, commented on, reviewed by the model and committed.
//
// M6 (docs/10 §2, §9): a session binds to any saved environment (environments.ts; the local one
// stays the default). Sessions in a `container` environment work on the Hub's files like local
// ones and run commands in the environment's image; sessions in `ssh`, `wsl` and `device`
// environments work on that machine's files through the helper, so change capture, review,
// commits, the symbol index and the Git tools (all Hub-side) are not available there yet.
// Worktrees come from the registry (worktrees.ts), sessions may carry budgets (docs/09 §2), and
// other parts of the area hear when a turn edited files (auto-verify, FR-068).
//
// M7 (docs/10 §2, §15): sessions on another machine (SSH, WSL, a device, the cloud) get Hub-side
// change capture, review and commits too: their Git runs through the environment's transport
// (transport.ts) and their shadow repository lives in Nova's state folder there. Symbols, refs,
// dev servers and worktrees stay on the Hub's own files. A handoff (handoff.ts) moves a session
// between environments: turns wait while it runs, and the session's location changes only
// between turns (FR-127).
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
  type CodeBudgetView,
  type commitSchema,
  type createCodeSessionM6Schema,
  type createWorktreeSchema,
  type WorktreeView,
  type diffCommentsSchema,
  type extendCodeBudgetSchema,
  type hunkDecisionSchema,
  type updateCodeSessionSchema,
} from '@nova/shared';
import { defaultRedactor, isWithin, realpathLenient } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { ModelRouter } from '../routing/types.ts';
import type {
  BoundHit,
  ThreadPolicy,
  ThreadPolicySource,
  ThreadStatusSource,
  TurnBounds,
  TurnExtension,
  TurnOutcome,
  TurnStarter,
} from '../runtime/types.ts';
import type { SettingReader } from '../approvals/gate.ts';
import { managedDenied, managedRestrictions } from '../managed/restrictions.ts';
import type { ThreadService } from '../threads.ts';
import { MemorySecretStore, type SecretStore } from '@nova/secrets';
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
  COMMIT_HOOKS,
  hasCommitHooks,
  hasStaged,
  hooksDir,
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
import { EnvironmentService, type EnvSshTransport } from './environments.ts';
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
import { RemoteSessionSandbox, WorkspaceRemoteFiles } from './remote-files.ts';
import { SymbolIndex, findCodeRefs, type CodeRef } from './symbols.ts';
import {
  helperTransport,
  localWorkspace,
  transportWorkspace,
  type CodeWorkspace,
  type EnvironmentTransport,
} from './transport.ts';
import { WORKTREE_COLUMNS, WorktreeRegistry, type WorktreeRow } from './worktrees.ts';

export type CreateCodeSessionRequest = z.input<typeof createCodeSessionM6Schema>;
export type ExtendCodeBudgetRequest = z.input<typeof extendCodeBudgetSchema>;
export type CreateWorktreeRequest = z.input<typeof createWorktreeSchema>;
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
  /** The keychain (SSH credentials of saved environments); in-memory by default. */
  secrets?: SecretStore;
  /** A sandbox running a container environment's image (FR-062). */
  containerSandbox?: (image: string) => SandboxClient | null;
  /** `novad` over SSH (FR-062, FR-078). */
  sshTransport?: EnvSshTransport | null;
}

/** What other parts of the Code area need to know about a session (M6). */
export interface CodeSessionInfo {
  id: string;
  accountId: string;
  threadId: string;
  title: string | null;
  /** Where the session works: its worktree (at the same place inside it) or its folder. */
  folder: string;
  /** The folder the user chose (the main checkout when it works in a worktree). */
  folderPath: string;
  environmentId: string | null;
  /** Whether the session works on the Hub's files (local and container environments). */
  hubLocal: boolean;
  worktreeId: string | null;
  branch: string | null;
  permissionMode: PermissionMode;
  modelId: string | null;
  projectId: string | null;
  active: boolean;
  threadState: string;
  updatedAt: string;
}

/** Called when a turn of a session ends, after its changes were refreshed (auto-verify). */
export type CodeTurnEndHook = (
  session: CodeSessionInfo,
  turn: { turnId: string; edited: boolean; outcome: TurnOutcome },
) => Promise<void>;

/** A transport for sessions in an environment kind another area runs (the cloud runner). */
export type EnvironmentTransportProvider = (
  accountId: string,
  environmentId: string,
) => Promise<EnvironmentTransport | null>;

/** Checked before a commit; throws to refuse it (unresolved merge conflicts, merge.ts). */
export type CodeCommitGuard = (session: CodeSessionInfo, ws: CodeWorkspace) => Promise<void>;

interface StateRow {
  timeLimitS: number | null;
  tokenLimit: number | null;
  costLimitUsd: number | null;
  timeUsedMs: number;
  tokensUsed: number;
  costUsedUsd: number;
  budgetReached: 'time' | 'tokens' | 'cost' | null;
  setupStatus: 'running' | 'ok' | 'failed' | null;
  setupDetail: string | null;
  parentSessionId: string | null;
  role: string | null;
}

const STATE_COLUMNS = `time_limit_s AS timeLimitS, token_limit AS tokenLimit,
  cost_limit_usd AS costLimitUsd, time_used_ms AS timeUsedMs, tokens_used AS tokensUsed,
  cost_used_usd AS costUsedUsd, budget_reached AS budgetReached, setup_status AS setupStatus,
  setup_detail AS setupDetail, parent_session_id AS parentSessionId, role`;

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
  /** Saved environments and their health (FR-062). */
  readonly envs: EnvironmentService;
  /** The worktree registry (FR-073). */
  readonly worktrees: WorktreeRegistry;
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
  readonly #turnEndHooks: CodeTurnEndHook[] = [];
  readonly #turnDoneHooks: CodeTurnEndHook[] = [];
  readonly #commitGuards: CodeCommitGuard[] = [];
  readonly #transports = new Map<string, EnvironmentTransportProvider>();
  readonly #workspaces = new Map<string, CodeWorkspace>();
  /** Sessions whose turns wait (a handoff is moving them, FR-127). */
  readonly #turnGates = new Map<string, Promise<void>>();
  /** Sessions with a turn past its start (it runs where the session was when it began). */
  readonly #inTurn = new Set<string>();
  #stateTable = false;

  constructor(opts: CodeServiceOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.code', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#home = opts.home === undefined ? homedir() : opts.home;
    this.git =
      opts.git ?? new HookFreeGit({ emptyHooksDir: join(opts.dataDir, 'code', 'no-hooks') });
    this.envs = new EnvironmentService({
      db: opts.db,
      events: opts.events,
      audit: opts.audit,
      secrets: opts.secrets ?? new MemorySecretStore(),
      git: this.git,
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      ...(opts.containerSandbox ? { containerSandbox: opts.containerSandbox } : {}),
      sshTransport: opts.sshTransport ?? null,
      now: this.#now,
      log: this.#log,
    });
    this.worktrees = new WorktreeRegistry({
      db: opts.db,
      git: this.git,
      events: opts.events,
      audit: opts.audit,
      now: this.#now,
      log: this.#log,
    });
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

  /** Called after each turn of a session ends and its changes were refreshed (M6). */
  useTurnEndHook(hook: CodeTurnEndHook): void {
    this.#turnEndHooks.push(hook);
  }

  /**
   * Called after every turn of every session, those on other machines included (M7: pending
   * handoffs, attempts and delegations). `useTurnEndHook` hooks hear only sessions on the Hub.
   */
  useTurnDoneHook(hook: CodeTurnEndHook): void {
    this.#turnDoneHooks.push(hook);
  }

  /** Checked before every commit (M7: unresolved merge conflicts). */
  useCommitGuard(guard: CodeCommitGuard): void {
    this.#commitGuards.push(guard);
  }

  /**
   * The transport of an environment kind this service does not reach itself: the cloud runner
   * registers `cloud` (FR-071, decision 4). Sessions there get the same Hub-side capture,
   * review, commits and handoffs as SSH and device sessions.
   */
  useEnvironmentTransport(kind: EnvironmentView['kind'], provider: EnvironmentTransportProvider) {
    this.#transports.set(kind, provider);
    for (const [id, ws] of [...this.#workspaces]) if (!ws.hubLocal) this.#workspaces.delete(id);
  }

  // ---- environments (FR-062) -------------------------------------------------------------------

  /** `GET /environments`: every saved environment, the local one checked now. */
  async environments(accountId: string): Promise<EnvironmentView[]> {
    return this.envs.views(accountId);
  }

  // ---- sessions (FR-061) ---------------------------------------------------------------------

  async create(
    accountId: string,
    req: CreateCodeSessionRequest,
    extra: { parentSessionId?: string; role?: string; base?: string; remember?: boolean } = {},
  ): Promise<CodeSessionView> {
    if (req.projectId) this.#assertProject(accountId, req.projectId);
    const env = await this.envs.resolve(accountId, req.environmentId);
    const hubLocal = this.envs.isHubLocal(env.kind);
    if (!hubLocal && (req.worktree || req.worktreeId))
      throw new NovaError('validation', 'worktrees are only available for folders on the Hub', {
        details: { reason: 'worktree_unavailable' },
      });
    await this.#assertManagedSession(env, hubLocal);
    const folder = hubLocal
      ? await this.#checkFolder(req.folder)
      : await this.envs.checkRemoteFolder(accountId, env.id, this.#checkRemotePath(req.folder));
    if (hubLocal) await this.#assertManagedFolder(folder);
    const projectFolderId = hubLocal
      ? this.#projectFolderFor(accountId, folder, req.projectId ?? null)
      : null;
    const conditions = await this.#conditions({ accountId, environmentId: env.id });
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
    const defaults = await this.#o.setting('code.budgets');
    const budgets = {
      timeSeconds:
        req.budgets?.timeSeconds !== undefined ? req.budgets.timeSeconds : defaults.timeSeconds,
      tokens: req.budgets?.tokens !== undefined ? req.budgets.tokens : defaults.tokens,
      costUsd: req.budgets?.costUsd !== undefined ? req.budgets.costUsd : defaults.costUsd,
    };

    const id = uuidv7();
    let worktree: WorktreeRow | null = null;
    let work = folder;
    const cleanup: (() => Promise<unknown>)[] = [];
    try {
      if (req.worktree) {
        const info = await repoInfo(this.git, folder);
        if (!info) throw new NovaError('validation', 'a worktree needs a Git repository');
        worktree = (
          await this.worktrees.create({
            accountId,
            repoRoot: info.root,
            sourceBranch: info.branch ?? 'HEAD',
            slug: branchSlug(req.title ?? basename(folder)),
            ...(extra.base ? { base: extra.base } : {}),
            actor: extra.parentSessionId ? 'agent' : 'user',
          })
        ).row;
        const wt = worktree;
        cleanup.push(() => this.worktrees.releaseForArchive(wt, 'remove_clean'));
        work = join(worktree.path, relative(info.root, folder));
      } else if (req.worktreeId) {
        const info = await repoInfo(this.git, folder);
        const wt = this.worktrees.assertBindable(accountId, req.worktreeId);
        if (!info || wt.repoPath !== info.root)
          throw new NovaError('validation', 'the worktree belongs to another repository', {
            details: { reason: 'worktree_repo' },
          });
        worktree = wt;
        work = join(wt.path, relative(info.root, folder));
      }
      if (hubLocal) {
        const shadow = this.#shadowAt(id, work);
        cleanup.push(() => shadow.remove());
        await initShadow(shadow, localWorkspace(this.git, this.#stateDir()), work);
      } else {
        // M7: the baseline of a session on another machine is taken there now, so the agent's
        // first edits are captured; an environment that cannot hold it yet leaves the baseline
        // to the session's first turn.
        try {
          const ws = await this.#workspaceOf(accountId, env.id);
          const shadow = await this.#remoteShadow(ws, id, work);
          cleanup.push(() => shadow.remove());
          await initShadow(shadow, ws, work);
        } catch (err) {
          this.#log.warn('no change capture in the environment yet', {
            err,
            environmentId: env.id,
          });
        }
      }
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
            .prepare(
              `UPDATE worktree SET lease_session_id = ?, lease_expires_at = NULL, status = 'active',
                 updated_at = ? WHERE id = ?`,
            )
            .run(id, now, worktree.id);
        if (this.#hasStateTable())
          this.#o.db.raw
            .prepare(
              `INSERT INTO code_session_state (session_id, time_limit_s, token_limit,
                 cost_limit_usd, parent_session_id, role, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              budgets.timeSeconds,
              budgets.tokens,
              budgets.costUsd,
              extra.parentSessionId ?? null,
              extra.role ?? null,
              now,
            );
      });
    } catch (err) {
      for (const undo of cleanup.reverse()) await undo().catch(() => undefined);
      throw err;
    }
    // A worker's mode is its parent's, not a choice to remember for the folder.
    if (req.permissionMode && mode !== 'plan' && !extra.parentSessionId && extra.remember !== false)
      await this.#remember(accountId, folder, mode);
    const s = this.#session(accountId, id);
    await this.#o.audit.append({
      accountId,
      actor: extra.parentSessionId ? 'agent' : 'user',
      kind: 'code',
      action: 'code.session.created',
      resource: work,
      decision: mode,
      threadId: s.threadId,
      detail: {
        sessionId: id,
        mode,
        environmentId: env.id,
        worktreeId: worktree?.id ?? null,
        ...(extra.parentSessionId ? { parentSessionId: extra.parentSessionId } : {}),
      },
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
    const setup = this.envs.setupScript(accountId, env.id);
    if (setup) this.#runSetup(s, setup);
    return this.#view(s);
  }

  /**
   * Run a container environment's setup script once in the session folder, in the background
   * (network off until the egress proxy grants more, docs/12 §8). The result is kept on the
   * session and announced as `code.session.updated`.
   */
  #runSetup(s: SessionRow, script: string): void {
    const sandbox = s.environmentId ? this.envs.sandboxFor(s.accountId, s.environmentId) : null;
    if (!this.#hasStateTable()) return;
    const done = (status: 'ok' | 'failed', detail: string) =>
      this.#o.db
        .transaction(() => {
          this.#o.db.raw
            .prepare(
              'UPDATE code_session_state SET setup_status = ?, setup_detail = ?, updated_at = ? WHERE session_id = ?',
            )
            .run(status, detail.slice(0, 4000), this.#iso(), s.id);
        })
        .then(() => this.#emit(s, 'code.session.updated', { sessionId: s.id }, 'system'));
    const work = workFolder(s);
    const run = async () => {
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            "UPDATE code_session_state SET setup_status = 'running', updated_at = ? WHERE session_id = ?",
          )
          .run(this.#iso(), s.id);
      });
      if (!sandbox) {
        await done('failed', 'no container engine on this Hub');
        return;
      }
      const r = await sandbox.exec({
        cmd: script,
        cwd: work,
        roots: [{ path: work, access: 'write', label: basename(work) }],
        network: 'off',
        yieldMs: 30 * 60_000,
        signal: AbortSignal.any([this.#stop.signal, AbortSignal.timeout(31 * 60_000)]),
        turnId: `code-setup:${s.id}`,
      });
      if (r.status !== 'exited') {
        await sandbox.killTurn(`code-setup:${s.id}`).catch(() => undefined);
        await done('failed', 'the setup script did not finish in 30 minutes');
        return;
      }
      const tail = defaultRedactor.redactString(r.output.trim().split('\n').slice(-20).join('\n'));
      await done(
        r.exitCode === 0 ? 'ok' : 'failed',
        `exit ${r.exitCode}${tail ? `\n${tail}` : ''}`,
      );
    };
    void run().catch((err: unknown) =>
      done('failed', err instanceof Error ? err.message : String(err)).catch(() => undefined),
    );
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
      assertModeAvailable(to, await this.#conditions(s));
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
      await this.#releaseOwnWorktree(s);
      // Leases the session held for its workers end with it (FR-073).
      await this.worktrees.releaseHeldBy(s.id).catch(() => 0);
    }
    return rows.length;
  }

  async #releaseOwnWorktree(s: SessionRow): Promise<void> {
    if (!s.worktreeId) return;
    const wt = this.#o.db.raw
      .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktree WHERE id = ?`)
      .get(s.worktreeId) as WorktreeRow | undefined;
    if (wt?.leaseSessionId !== s.id) return;
    try {
      await this.worktrees.releaseForArchive(wt, await this.#o.setting('code.worktreeCleanup'));
      await this.#emit(s, 'worktree.released', {
        worktreeId: wt.id,
        sessionId: s.id,
        reason: 'done',
      });
    } catch (err) {
      this.#log.warn('releasing a worktree failed', { err, worktreeId: wt.id });
    }
  }

  // ---- runtime seams -----------------------------------------------------------------------

  /** The permission mode as approval policy, profile and roots (FR-063, FR-190). */
  readonly policy: ThreadPolicySource = {
    forThread: async (accountId, threadId): Promise<ThreadPolicy | null> => {
      const s = this.#byThread(accountId, threadId);
      if (!s) return null;
      const p = modePolicy(s.permissionMode, workFolder(s), await this.#conditions(s));
      if (p.permissionMode !== s.permissionMode)
        this.#log.warn('code session mode unavailable; running with manual', {
          sessionId: s.id,
          mode: s.permissionMode,
        });
      // Managed policy (FR-106) that turns sessions on this machine off reaches the sessions made
      // before it too: they keep no roots, so their tools touch nothing (fail closed).
      if (!this.#remote(s)) {
        const why = managedRestrictions(await this.#o.setting('managed.restrict')).localSessions();
        if (why) return { ...p, roots: [] };
      }
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

  /**
   * The Environment block for each turn, the session's budgets (docs/09 §2), and a change
   * refresh when it ends (docs/09 §11); then the turn-end hooks hear whether the turn edited
   * files (auto-verify, FR-068).
   */
  readonly extension: TurnExtension = {
    forTurn: async (input) => {
      if (input.mode !== 'code') return null;
      const first = this.#byThread(input.accountId, input.threadId);
      if (!first) return null;
      // A handoff moving the session finishes first: the turn runs where it lands (FR-127).
      const gate = this.#turnGates.get(first.id);
      if (gate) await gate.catch(() => undefined);
      const s = this.#byThread(input.accountId, input.threadId) ?? first;
      this.#inTurn.add(s.id);
      // A session on another machine takes its baseline before its first tool call (M7).
      if (this.#remote(s))
        await this.#serial(s.id, () => this.#ensureShadow(s)).catch((err: unknown) =>
          this.#log.warn('no change capture in the environment', { err, sessionId: s.id }),
        );
      const before = this.#fingerprint(s.id);
      return {
        context: [{ label: 'Environment', text: await this.#environmentText(s), trusted: true }],
        bounds: this.#bounds(s.id),
        onEnd: async (outcome) => {
          this.#inTurn.delete(s.id);
          if (outcome.stop === 'budget' && outcome.bound)
            await this.#budgetReached(s, outcome.bound);
          try {
            await this.refresh(s.accountId, s.id);
          } catch (err) {
            this.#log.warn('refreshing changes after a turn failed', { err, sessionId: s.id });
          }
          // M6 hooks (auto-verify) hear sessions on the Hub; M7 ones hear every session.
          const hooks = [...this.#turnDoneHooks, ...(this.#remote(s) ? [] : this.#turnEndHooks)];
          if (!hooks.length) return;
          const edited = this.#fingerprint(s.id) !== before;
          const info = this.#info(this.#session(s.accountId, s.id));
          for (const hook of hooks) {
            try {
              await hook(info, { turnId: input.turnId, edited, outcome });
            } catch (err) {
              this.#log.warn('a code turn-end hook failed', { err, sessionId: s.id });
            }
          }
        },
      };
    },
  };

  async #environmentText(s: SessionRow): Promise<string> {
    const work = workFolder(s);
    const remote = this.#remote(s);
    const info = remote ? null : await this.#repo(work, true);
    const git = remote
      ? 'read it with git.status, git.diff and git.log; your edits are captured for review on the Hub'
      : info
        ? `branch ${info.branch ?? '(detached HEAD)'}${info.head ? ` at ${info.head.slice(0, 12)}` : ', no commits yet'}; ${info.dirty ? 'uncommitted changes' : 'clean'}`
        : 'not a Git repository';
    const lines = [
      `Working folder: ${work}`,
      `Runs on: ${this.envs.describe(s.accountId, s.environmentId)}`,
    ];
    if (!remote) lines.push(`Operating system: ${platform()} ${release()} (${arch()})`);
    lines.push(
      `Git: ${git}`,
      `Time: ${this.#iso()}`,
      `Permission mode: ${describePermissionMode(s.permissionMode)}`,
    );
    const budget = this.budget(s.accountId, s.id);
    const left: string[] = [];
    if (budget.limits.timeSeconds !== null)
      left.push(
        `${Math.max(0, Math.round((budget.limits.timeSeconds - budget.used.timeSeconds) / 60))} min`,
      );
    if (budget.limits.tokens !== null)
      left.push(`${Math.max(0, budget.limits.tokens - budget.used.tokens)} tokens`);
    if (budget.limits.costUsd !== null)
      left.push(`$${Math.max(0, budget.limits.costUsd - budget.used.costUsd).toFixed(2)}`);
    if (left.length) lines.push(`Budget left: ${left.join(', ')}`);
    return lines.join('\n');
  }

  // ---- budgets (docs/09 §2; ADR-058) ---------------------------------------------------------

  /** The session's bounds and what its turns used. */
  budget(accountId: string, id: string): CodeBudgetView {
    const s = this.#session(accountId, id);
    const st = this.#state(s.id);
    return {
      limits: {
        timeSeconds: st?.timeLimitS ?? null,
        tokens: st?.tokenLimit ?? null,
        costUsd: st?.costLimitUsd ?? null,
      },
      used: {
        timeSeconds: Math.round((st?.timeUsedMs ?? 0) / 1000),
        tokens: st?.tokensUsed ?? 0,
        costUsd: st?.costUsedUsd ?? 0,
      },
      reached: st?.budgetReached ?? null,
    };
  }

  /**
   * What a session's child (a worker, an attempt) may use at most: per bound, the parent's
   * remaining budget, or the request when it asks for less (a delegated session's workers keep
   * the agent's limits, M7).
   */
  childBudgets(
    accountId: string,
    parentId: string,
    requested: {
      timeSeconds?: number | null | undefined;
      tokens?: number | null | undefined;
      costUsd?: number | null | undefined;
    } = {},
  ): { timeSeconds: number | null; tokens: number | null; costUsd: number | null } {
    const b = this.budget(accountId, parentId);
    const pick = (limit: number | null, used: number, want: number | null | undefined) => {
      const left = limit === null ? null : Math.max(0, limit - used);
      const asked = want ?? null;
      if (left === null) return asked;
      return asked === null ? left : Math.min(asked, left);
    };
    return {
      timeSeconds: pick(b.limits.timeSeconds, b.used.timeSeconds, requested.timeSeconds),
      tokens: pick(b.limits.tokens, b.used.tokens, requested.tokens),
      costUsd: pick(b.limits.costUsd, b.used.costUsd, requested.costUsd),
    };
  }

  /** Extend the bounds: each given amount is added to its limit (a session without one gets it). */
  async extendBudget(
    accountId: string,
    id: string,
    req: ExtendCodeBudgetRequest,
  ): Promise<CodeBudgetView> {
    const s = this.#session(accountId, id);
    const b = this.budget(accountId, id);
    const add = (limit: number | null, used: number, more: number | undefined) =>
      more === undefined ? limit : (limit === null ? used : limit) + more;
    await this.#ensureState(s.id);
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE code_session_state SET time_limit_s = ?, token_limit = ?, cost_limit_usd = ?,
             budget_reached = NULL, updated_at = ? WHERE session_id = ?`,
        )
        .run(
          add(b.limits.timeSeconds, b.used.timeSeconds, req.timeSeconds),
          add(b.limits.tokens, b.used.tokens, req.tokens),
          add(b.limits.costUsd, b.used.costUsd, req.costUsd),
          this.#iso(),
          s.id,
        );
    });
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'code',
      action: 'code.budget.extended',
      resource: workFolder(s),
      result: 'ok',
      threadId: s.threadId,
      detail: { sessionId: s.id, ...req },
    });
    await this.#emit(s, 'code.session.updated', { sessionId: s.id });
    return this.budget(accountId, id);
  }

  /**
   * Bounds checked before each model step of a session's turn; each step's usage is written
   * through at once, so a restart loses nothing and parallel turns add up.
   */
  #bounds(sessionId: string): TurnBounds {
    return {
      check: (): BoundHit | null => {
        const st = this.#state(sessionId);
        if (!st) return null;
        const timeS = st.timeUsedMs / 1000;
        if (st.timeLimitS !== null && timeS >= st.timeLimitS)
          return { bound: 'time', used: Math.round(timeS), limit: st.timeLimitS };
        if (st.tokenLimit !== null && st.tokensUsed >= st.tokenLimit)
          return { bound: 'tokens', used: st.tokensUsed, limit: st.tokenLimit };
        if (st.costLimitUsd !== null && st.costUsedUsd >= st.costLimitUsd)
          return { bound: 'cost', used: st.costUsedUsd, limit: st.costLimitUsd };
        return null;
      },
      record: (step) => {
        if (!this.#hasStateTable()) return;
        const tokens = step.inputTokens + step.outputTokens;
        const at = this.#iso();
        void this.#o.db
          .transaction(() => {
            this.#o.db.raw
              .prepare(
                `UPDATE code_session_state SET time_used_ms = time_used_ms + ?,
                   tokens_used = tokens_used + ?, cost_used_usd = cost_used_usd + ?,
                   updated_at = ? WHERE session_id = ?`,
              )
              .run(Math.round(step.activeMs), tokens, step.costUsd, at, sessionId);
          })
          .catch((err: unknown) => this.#log.warn('recording session usage failed', { err }));
      },
    };
  }

  async #budgetReached(s: SessionRow, hit: BoundHit): Promise<void> {
    if (!this.#hasStateTable()) return;
    await this.#ensureState(s.id);
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          'UPDATE code_session_state SET budget_reached = ?, updated_at = ? WHERE session_id = ?',
        )
        .run(hit.bound, this.#iso(), s.id);
    });
    await this.#emit(s, 'code.session.updated', { sessionId: s.id }, 'system');
  }

  /**
   * Whether the database has `code_session_state` (migration 0025). Without it sessions work as
   * in M5: no budgets, setup state or worker lineage are kept.
   */
  #hasStateTable(): boolean {
    if (this.#stateTable) return true;
    this.#stateTable = !!this.#o.db.raw
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'code_session_state'")
      .get();
    return this.#stateTable;
  }

  #state(sessionId: string): StateRow | null {
    if (!this.#hasStateTable()) return null;
    return (
      (this.#o.db.raw
        .prepare(`SELECT ${STATE_COLUMNS} FROM code_session_state WHERE session_id = ?`)
        .get(sessionId) as StateRow | undefined) ?? null
    );
  }

  /** M5 sessions have no state row yet. */
  async #ensureState(sessionId: string): Promise<void> {
    if (!this.#hasStateTable())
      throw new NovaError('server_error', 'session budgets need the database to be upgraded');
    if (this.#state(sessionId)) return;
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare('INSERT OR IGNORE INTO code_session_state (session_id, updated_at) VALUES (?, ?)')
        .run(sessionId, this.#iso());
    });
  }

  /** Pending changes of a session as one string; a turn that changes it edited files. */
  #fingerprint(sessionId: string): string {
    const r = this.#o.db.raw
      .prepare(
        `SELECT group_concat(path || ':' || COALESCE(patch_sha256, '') || ':' || pending, '|')
           AS f FROM (SELECT path, patch_sha256, pending FROM code_change
           WHERE session_id = ? ORDER BY path)`,
      )
      .get(sessionId) as { f: string | null } | undefined;
    return r?.f ?? '';
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
    // Sessions on another machine are captured there, through their transport (M7).
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
  async commit(
    accountId: string,
    id: string,
    req: CodeCommitRequest,
    actor: 'user' | 'agent' = 'user',
  ): Promise<CodeCommitResult> {
    const s = this.#session(accountId, id);
    // M7: a session on another machine commits there through its transport, hooks off.
    const ws = await this.#workspace(s);
    const git = ws.git;
    const result = await this.#serial(s.id, async () => {
      const work = workFolder(s);
      const info = await repoInfo(git, work);
      if (!info) throw new NovaError('validation', 'the session folder is not a Git repository');
      for (const guard of this.#commitGuards) await guard(this.#info(s), ws);
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
      if (await hasStaged(git, info.root))
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
        branch = await freeBranch(git, info.root, branchSlug(req.branch));
      } else if (!branch) {
        throw new NovaError('conflict', 'HEAD is detached; give a branch name to commit on', {
          details: { reason: 'detached_head' },
        });
      } else if (await isDefaultBranch(git, info.root, branch)) {
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
      if (switched) await switchToNewBranch(git, info.root, branch);
      await stage(git, info.root, entries);
      try {
        const findings = await scanStaged(git, info.root, entries);
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
        // Hooks run only in a Nova sandbox; another machine has none (docs/10 §8, FR-211).
        const hooks = ws.hubLocal
          ? await hasCommitHooks(git, info.root)
          : await remoteHasHooks(ws, info.root);
        const ran =
          hooks && ws.hubLocal
            ? await this.#commitInSandbox(s, info.root, work, req.message)
            : false;
        if (!ran) {
          const r = await git.run(['commit', '-q', '--no-verify', '-F', '-'], {
            cwd: info.root,
            input: req.message,
            allowFail: true,
          });
          if (r.code !== 0) throw commitFailed(r.stderr);
        }
        await this.#settleCommit(s, shadow, start, base);
        return { hooks, ran, branch, files: entries.length };
      } catch (err) {
        await unstage(git, info.root, paths);
        // The new branch points at the same commit: going back changes no file.
        if (switched && info.branch) {
          await git.run(['symbolic-ref', 'HEAD', `refs/heads/${info.branch}`], {
            cwd: info.root,
            allowFail: true,
          });
          await git.run(['branch', '-D', '--end-of-options', branch], {
            cwd: info.root,
            allowFail: true,
          });
        }
        throw err;
      }
    });
    const head = await git.text(['rev-parse', 'HEAD'], { cwd: workFolder(s) });
    const out: CodeCommitResult = {
      sha: head,
      branch: result.branch,
      files: result.files,
      hooksRan: result.ran,
      hooksNote:
        result.hooks && !result.ran
          ? ws.hubLocal
            ? "The repository's commit hooks did not run: no sandbox with Git is available on this Hub."
            : `The repository's commit hooks did not run: Nova has no sandbox in ${ws.label}.`
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
      actor,
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
        ...(ws.hubLocal ? {} : { environmentId: s.environmentId }),
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

  /**
   * Create `nova/<slug>` (a short suffix when taken) at HEAD and switch to it without a checkout,
   * so no file changes and no hook runs (docs/10 §8, FR-211).
   */
  async createBranch(
    accountId: string,
    id: string,
    name: string,
    actor: 'user' | 'agent' = 'user',
  ): Promise<{ branch: string; from: string | null }> {
    const s = this.#session(accountId, id);
    const { git } = await this.#workspace(s);
    const branch = await this.#serial(s.id, async () => {
      const info = await repoInfo(git, workFolder(s));
      if (!info) throw new NovaError('validation', 'the session folder is not a Git repository');
      const next = await freeBranch(git, info.root, branchSlug(name));
      await switchToNewBranch(git, info.root, next);
      this.#repoCache.delete(workFolder(s));
      return { branch: next, from: info.branch };
    });
    await this.setBranch(s.id, branch.branch);
    await this.#o.audit.append({
      accountId,
      actor,
      kind: 'code',
      action: 'code.branch.created',
      resource: workFolder(s),
      result: 'ok',
      threadId: s.threadId,
      detail: { sessionId: s.id, branch: branch.branch, from: branch.from },
    });
    await this.#emit(s, 'code.session.updated', { sessionId: s.id });
    return branch;
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
      // Git writes `.git`; its config, hooks and info stay read-only (docs/12 §7.2).
      gitWrite: true,
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
    // The index reads the Hub's own files.
    if (this.#remote(s)) throw notOnHub();
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
    if (this.#remote(s)) throw notOnHub();
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
    const { git } = await this.#workspace(s);
    const r = await git.run(['status', '--porcelain=v1', '-b', '--untracked-files=normal'], {
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
    const { git } = await this.#workspace(s);
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
    const r = await git.run(args, { cwd: workFolder(s), maxBytes: 8 * 1024 * 1024 });
    return r.stdout.toString('utf8');
  }

  async gitLog(
    accountId: string,
    threadId: string,
    opts: { limit?: number; path?: string },
  ): Promise<string> {
    const s = this.#requireThread(accountId, threadId);
    const { git } = await this.#workspace(s);
    const n = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const args = ['log', `-n${n}`, '--no-color', '--date=short', '--format=%h %ad %an%x09%s'];
    if (opts.path) args.push('--', `:(literal)${relPath(opts.path)}`);
    const r = await git.run(args, { cwd: workFolder(s), allowFail: true });
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
    // Terminals run in the Hub's sandbox on the Hub's disk: never at the path of a session on
    // another machine (SSH, WSL, a device, cloud).
    if (this.#remote(s)) throw notOnHub();
    if (!this.#terminals)
      throw new NovaError('sandbox_unavailable', 'terminals are not available on this Hub');
    return this.#terminals.create(accountId, {
      threadId: s.threadId,
      root: workFolder(s),
      cols: size.cols,
      rows: size.rows,
    });
  }

  // ---- worktree registry (FR-073) ------------------------------------------------------------

  /** The account's worktrees, of one repository (a folder inside it) when `repo` is given. */
  async listWorktrees(
    accountId: string,
    q: { repo?: string; status?: 'active' | 'released' | 'removed' | 'all' } = {},
  ): Promise<WorktreeView[]> {
    let repoRoot: string | undefined;
    if (q.repo) {
      const info = await repoInfo(this.git, await this.#checkFolder(q.repo));
      if (!info) throw new NovaError('validation', 'that folder is not in a Git repository');
      repoRoot = info.root;
    }
    return this.worktrees.list(accountId, {
      ...(repoRoot ? { repoRoot } : {}),
      ...(q.status ? { status: q.status } : {}),
    });
  }

  /**
   * Create a worktree of the repository a folder belongs to, optionally leased to a session of
   * the account (with a length); `.worktreeinclude` files are copied in.
   */
  async createWorktree(accountId: string, req: CreateWorktreeRequest): Promise<WorktreeView> {
    const folder = await this.#checkFolder(req.repo);
    const info = await repoInfo(this.git, folder);
    if (!info) throw new NovaError('validation', 'a worktree needs a Git repository');
    if (req.sessionId) {
      const s = this.#session(accountId, req.sessionId);
      if (s.status !== 'active' || s.archived)
        throw new NovaError('conflict', 'that session is archived');
    }
    const { row, included } = await this.worktrees.create({
      accountId,
      repoRoot: info.root,
      sourceBranch: info.branch ?? 'HEAD',
      slug: branchSlug(req.branch ?? basename(info.root)),
      leaseSessionId: req.sessionId ?? null,
      ttlMinutes: req.ttlMinutes ?? null,
      removeOldest: req.removeOldest ?? false,
    });
    return this.worktrees.view(accountId, row.id, included);
  }

  // ---- M6: what the rest of the area reads ------------------------------------------------

  /** A session as the rest of the area sees it; `not_found` for another account's. */
  info(accountId: string, id: string): CodeSessionInfo {
    return this.#info(this.#session(accountId, id));
  }

  /** The session of a code thread, or null. */
  infoByThread(accountId: string, threadId: string): CodeSessionInfo | null {
    const s = this.#byThread(accountId, threadId);
    return s ? this.#info(s) : null;
  }

  /** The account's sessions (active ones by default), newest change first. */
  infos(accountId: string, opts: { archived?: boolean; limit?: number } = {}): CodeSessionInfo[] {
    const rows = this.#o.db.raw
      .prepare(
        `${SESSION_SELECT} WHERE s.account_id = ? AND t.deleted_at IS NULL AND t.archived = ?
         ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`,
      )
      .all(accountId, opts.archived ? 1 : 0, opts.limit ?? 200) as unknown as SessionRow[];
    return rows.map((r) => this.#info(r));
  }

  /** Ids of every active session (the Hub's sweep stops the dev servers of the others). */
  activeSessionIds(): string[] {
    return (
      this.#o.db.raw
        .prepare(
          `SELECT s.id FROM code_session s JOIN thread t ON t.id = s.thread_id
           WHERE s.status = 'active' AND t.archived = 0 AND t.deleted_at IS NULL`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  /** Archive a session's thread; the session and its worktree lease follow (sweepArchived). */
  async archive(accountId: string, id: string): Promise<void> {
    const s = this.#session(accountId, id);
    await this.#o.threads.update(accountId, s.threadId, { archived: true });
    await this.sweepArchived(accountId);
  }

  /** The parent session and role of a worker session (task.spawn), if it is one. */
  lineage(sessionId: string): { parentSessionId: string | null; role: string | null } {
    const st = this.#state(sessionId);
    return { parentSessionId: st?.parentSessionId ?? null, role: st?.role ?? null };
  }

  /** Worker sessions a session started with task.spawn. */
  workers(accountId: string, parentSessionId: string): CodeSessionInfo[] {
    if (!this.#hasStateTable()) return [];
    const rows = this.#o.db.raw
      .prepare(
        `${SESSION_SELECT} JOIN code_session_state st ON st.session_id = s.id
         WHERE s.account_id = ? AND st.parent_session_id = ? AND t.deleted_at IS NULL
         ORDER BY s.created_at`,
      )
      .all(accountId, parentSessionId) as unknown as SessionRow[];
    return rows.map((r) => this.#info(r));
  }

  /** The container setup state of a session (null when it has none). */
  setupState(
    sessionId: string,
  ): { status: 'running' | 'ok' | 'failed'; detail: string | null } | null {
    const st = this.#state(sessionId);
    return st?.setupStatus ? { status: st.setupStatus, detail: st.setupDetail } : null;
  }

  /**
   * The sandbox a session's commands run in: null for the local environment (the Hub's own),
   * the environment's image for a container, the helper for ssh, wsl and device environments.
   */
  sandboxFor(info: Pick<CodeSessionInfo, 'accountId' | 'environmentId'>): SandboxClient | null {
    if (!info.environmentId) return null;
    try {
      return this.envs.sandboxFor(info.accountId, info.environmentId);
    } catch {
      return null;
    }
  }

  /** `sandboxFor` by thread (the tool runtime picks the session's sandbox per call). */
  sandboxForThread(accountId: string, threadId: string): SandboxClient | null {
    const s = this.#byThread(accountId, threadId);
    if (!s) return null;
    if (!this.#helperSession(s)) return this.sandboxFor(s);
    // M7: a session on another machine runs its commands and its file tools there, through its
    // helper; when that cannot be set up, nothing falls back to the Hub's own sandbox or disk.
    const inner = this.sandboxFor(s);
    let files: WorkspaceRemoteFiles | null = null;
    try {
      files = new WorkspaceRemoteFiles(
        this.#helperWorkspace(s.accountId, s.environmentId!),
        workFolder(s),
        s.permissionMode === 'plan' ? 'read' : 'write',
        this.environmentLabel(s.accountId, s.environmentId),
      );
    } catch (err) {
      this.#log.warn('the session folder on its machine is not reachable', { err });
    }
    return new RemoteSessionSandbox(inner, inner ? files : null);
  }

  /**
   * The thread policy the tool runtime reads (M7): the gate's (`policy`), except that a session on
   * another machine (SSH, WSL, a device) has no root on the Hub at all. Its folder's path names a
   * place on that machine; the file tools and commands reach it through the session's sandbox
   * (fs-remote.ts), and nothing that reads the Hub's disk by the thread's roots (mentions,
   * instruction files, the file browser, documents) can touch the Hub's disk at that path. Wire
   * it as the tools' thread policy: `tools.useThreadPolicy(code.toolPolicy)`.
   */
  readonly toolPolicy: ThreadPolicySource = {
    forThread: async (accountId, threadId) => {
      const p = await this.policy.forThread(accountId, threadId);
      if (!p) return null;
      const s = this.#byThread(accountId, threadId);
      return s && this.#helperSession(s) ? { ...p, roots: [] } : p;
    },
  };

  /** Whether a thread is a session on another machine through a helper (SSH, WSL, a device). */
  remoteHelperThread(accountId: string, threadId: string): boolean {
    const s = this.#byThread(accountId, threadId);
    return !!s && this.#helperSession(s);
  }

  /** The Hub's own sandbox (local sessions). */
  hubSandbox(): SandboxClient | null {
    return this.#o.sandbox?.() ?? null;
  }

  /** A folder on the Hub a session or a worktree may use (the same checks as a new session). */
  checkFolder(input: string): Promise<string> {
    return this.#checkFolder(input);
  }

  /**
   * A folder a session may work in, in any environment of the account (a handoff's target): the
   * Hub's checks on the Hub, and elsewhere the path checks plus a folder the environment has.
   */
  async checkFolderIn(accountId: string, environmentId: string, input: string): Promise<string> {
    const kind = this.envs.kindOf(accountId, environmentId);
    if (kind === null) throw new NovaError('not_found', 'environment not found');
    if (this.envs.isHubLocal(kind)) return this.#checkFolder(input);
    const p = this.#checkRemotePath(input);
    if (!p.startsWith('/') || p.split('/').includes('..'))
      throw new NovaError('validation', 'use the full path of a folder in the environment');
    if (p === '/')
      throw new NovaError('policy_denied', 'the whole filesystem cannot be a session folder', {
        details: { reason: 'protected_folder' },
      });
    const ws = await this.#workspaceOf(accountId, environmentId);
    const st = await ws.fs.stat(p);
    if (!st)
      throw new NovaError('validation', `no folder at ${p}`, { details: { reason: 'missing' } });
    if (st.kind !== 'dir')
      throw new NovaError('validation', `${p} is not a folder`, {
        details: { reason: 'not_a_folder' },
      });
    return p;
  }

  /** The TurnStarter (comments, CI feedback, auto-verify feedback, workers). */
  get turns(): TurnStarter | null {
    return this.#turns;
  }

  /** Announce an event about a session (other parts of the area). */
  async announce(
    info: Pick<CodeSessionInfo, 'id' | 'accountId' | 'threadId'>,
    name: string,
    payload: Record<string, unknown>,
    actor: 'user' | 'system' = 'system',
  ): Promise<void> {
    await this.#emit(
      { id: info.id, accountId: info.accountId, threadId: info.threadId } as SessionRow,
      name,
      payload,
      actor,
    );
  }

  /** Record the pull request and CI status on the session (CodeSessionView fields). */
  async setPullRequest(sessionId: string, url: string | null, ci: string | null): Promise<void> {
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          'UPDATE code_session SET pull_request_url = ?, ci_status = ?, updated_at = ? WHERE id = ?',
        )
        .run(url, ci, this.#iso(), sessionId);
    });
  }

  /** Record the branch a session works on (after git.branch). */
  async setBranch(sessionId: string, branch: string): Promise<void> {
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare('UPDATE code_session SET branch = ?, updated_at = ? WHERE id = ?')
        .run(branch, this.#iso(), sessionId);
    });
  }

  // ---- M7: workspaces, handoffs (FR-213) -----------------------------------------------------

  /** Where a session's Git and files are reached: this Hub, or its environment's transport. */
  workspace(info: Pick<CodeSessionInfo, 'accountId' | 'environmentId'>): Promise<CodeWorkspace> {
    return this.#workspace(info);
  }

  /** The workspace of an environment of the account (a handoff's target). */
  workspaceOf(accountId: string, environmentId: string): Promise<CodeWorkspace> {
    return this.#workspaceOf(accountId, environmentId);
  }

  /** A readable name of an environment for messages and the handoff history. */
  environmentLabel(accountId: string, environmentId: string | null): string {
    if (!environmentId) return 'this Hub';
    const r = this.#o.db.raw
      .prepare(
        'SELECT kind, label, config_json AS configJson FROM environment WHERE id = ? AND account_id = ?',
      )
      .get(environmentId, accountId) as
      { kind: string; label: string; configJson: string | null } | undefined;
    if (!r) return 'a removed environment';
    if (r.kind === 'local') return 'this Hub';
    if (r.kind === 'ssh') {
      try {
        const c = JSON.parse(r.configJson ?? '{}') as { user?: string; host?: string };
        if (c.user && c.host) return `${r.label} (${c.user}@${c.host})`;
      } catch {
        // The label alone.
      }
    }
    return r.label;
  }

  /**
   * The shadow a session uses in an environment and folder; `next` is a handoff's staging copy,
   * prepared at the target before the session moves there.
   */
  async shadowIn(
    sessionId: string,
    ws: CodeWorkspace,
    work: string,
    next = false,
  ): Promise<ShadowRepo> {
    if (!ws.hubLocal) return this.#remoteShadow(ws, sessionId, work, next);
    return new ShadowRepo({
      git: this.git,
      gitDir: join(this.#o.dataDir, 'code', sessionId, next ? 'shadow.next.git' : 'shadow.git'),
      workTree: work,
    });
  }

  /** Take a fresh baseline (`baseline` = `start` = the folder now) in a shadow. */
  async baselineShadow(shadow: ShadowRepo, ws: CodeWorkspace, work: string): Promise<void> {
    await initShadow(shadow, ws, work);
  }

  /** Hold the session's next turns until the returned function runs (a handoff, FR-127). */
  holdTurns(sessionId: string): () => void {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    this.#turnGates.set(sessionId, held);
    return () => {
      if (this.#turnGates.get(sessionId) === held) this.#turnGates.delete(sessionId);
      release();
    };
  }

  /** Run `fn` after the session's other bookkeeping (one shadow index per session). */
  serialized<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.#serial(sessionId, fn);
  }

  /**
   * Move a session to another place (docs/10 §15): its environment, folder, worktree and branch
   * change, the shadow prepared at the target (`shadowIn(..., next)`) takes over and the review
   * restarts there (every change the target shows is pending). A mode the target cannot offer
   * (Bypass on another machine) becomes Manual. Called between turns, with turns held.
   */
  async relocate(
    accountId: string,
    id: string,
    to: {
      environmentId: string;
      folderPath: string;
      worktreeId: string | null;
      branch: string | null;
    },
  ): Promise<CodeSessionInfo> {
    const s = this.#session(accountId, id);
    const fromWs = await this.#workspace(s);
    const toWs = await this.#workspaceOf(accountId, to.environmentId);
    const oldShadow = fromWs.hubLocal
      ? this.#shadowAt(s.id, workFolder(s))
      : await this.#remoteShadow(fromWs, s.id, workFolder(s));
    const projectFolderId = toWs.hubLocal
      ? this.#projectFolderFor(accountId, to.folderPath, s.projectId)
      : null;
    const conditions = await this.#conditions({ accountId, environmentId: to.environmentId });
    const mode = modeUnavailable(s.permissionMode, conditions) ? 'manual' : s.permissionMode;
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE code_session SET environment_id = ?, folder_path = ?, project_folder_id = ?,
             worktree_id = ?, branch = ?, permission_mode = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          to.environmentId,
          to.folderPath,
          projectFolderId,
          to.worktreeId,
          to.branch,
          mode,
          now,
          s.id,
        );
      if (s.worktreeId && s.worktreeId !== to.worktreeId)
        this.#o.db.raw
          .prepare(
            `UPDATE worktree SET lease_session_id = NULL, lease_expires_at = NULL,
               status = 'released', updated_at = ? WHERE id = ? AND lease_session_id = ?`,
          )
          .run(now, s.worktreeId, s.id);
      if (to.worktreeId && to.worktreeId !== s.worktreeId)
        this.#o.db.raw
          .prepare(
            `UPDATE worktree SET lease_session_id = ?, lease_expires_at = NULL, status = 'active',
               updated_at = ? WHERE id = ?`,
          )
          .run(s.id, now, to.worktreeId);
      // The review restarts at the target: earlier rows are kept (their comments with them) but
      // hidden, and come back as fresh rounds when their paths change there.
      this.#o.db.raw
        .prepare(
          `UPDATE code_change SET pending = 0, applied = 1, patch_blob_path = NULL,
             patch_sha256 = NULL, updated_at = ? WHERE session_id = ?`,
        )
        .run(now, s.id);
    });
    await rm(join(this.#o.dataDir, 'code', s.id, 'patches'), { recursive: true, force: true });
    this.#indexes.delete(s.id);
    this.#repoCache.clear();
    const next = this.#session(accountId, id);
    const work = workFolder(next);
    try {
      await oldShadow.remove();
      const staged = await this.shadowIn(s.id, toWs, work, true);
      const current = await this.shadowIn(s.id, toWs, work, false);
      await toWs.fs.remove(current.gitDir, true);
      await toWs.fs.rename(staged.gitDir, current.gitDir);
    } catch (err) {
      // The next refresh takes a fresh baseline there; nothing in the folder is lost.
      this.#log.warn('moving the session shadow failed', { err, sessionId: s.id });
    }
    if (s.worktreeId && s.worktreeId !== to.worktreeId)
      await this.#emit(next, 'worktree.released', {
        worktreeId: s.worktreeId,
        sessionId: s.id,
        reason: 'handoff',
      });
    if (mode !== s.permissionMode) {
      await this.#o.audit.append({
        accountId,
        actor: 'system',
        kind: 'code',
        action: 'code.mode.changed',
        resource: work,
        decision: mode,
        threadId: s.threadId,
        detail: { sessionId: s.id, from: s.permissionMode, to: mode, reason: 'handoff' },
      });
      await this.#emit(next, 'code.session.modeChanged', {
        sessionId: s.id,
        from: s.permissionMode,
        to: mode,
      });
    }
    await this.#emit(next, 'code.session.updated', { sessionId: s.id });
    return this.#info(next);
  }

  /**
   * Whether a turn of the session is past its start (it runs where the session is now). A turn
   * held at its start by `holdTurns` is not. A mark left by a turn that ended without its end
   * callback is dropped once the thread is idle.
   */
  insideTurn(accountId: string, id: string): boolean {
    if (!this.#inTurn.has(id)) return false;
    const state = this.#session(accountId, id).threadState;
    if (state === 'idle' || state === 'error') {
      this.#inTurn.delete(id);
      return false;
    }
    return true;
  }

  #info(s: SessionRow): CodeSessionInfo {
    return {
      id: s.id,
      accountId: s.accountId,
      threadId: s.threadId,
      title: s.title,
      folder: workFolder(s),
      folderPath: s.folderPath,
      environmentId: s.environmentId,
      hubLocal: !this.#remote(s),
      worktreeId: s.worktreeId,
      branch: s.branch,
      permissionMode: s.permissionMode,
      modelId: s.modelId,
      projectId: s.projectId,
      active: s.status === 'active' && s.archived === 0 && !s.deletedAt,
      threadState: s.threadState,
      updatedAt: s.updatedAt,
    };
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  async close(): Promise<void> {
    this.#stop.abort();
    await this.envs.close();
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
    const ws = await this.#workspace(s);
    const shadow = ws.hubLocal
      ? this.#shadowAt(s.id, workFolder(s))
      : await this.#remoteShadow(ws, s.id, workFolder(s));
    if (!(ws.hubLocal ? shadow.exists : await shadow.initialized()))
      await initShadow(shadow, ws, workFolder(s));
    return shadow;
  }

  /** A session's shadow on another machine: in Nova's state folder there (never the repo). */
  async #remoteShadow(ws: CodeWorkspace, sessionId: string, work: string, next = false) {
    const dir = join(await ws.stateDir(), 'shadow', `${sessionId}${next ? '.next' : ''}.git`);
    return new ShadowRepo({ git: ws.git, gitDir: dir, workTree: work, fs: ws.fs });
  }

  /** Where Nova keeps its own state for sessions on the Hub (handoff scratch). */
  #stateDir(): string {
    return join(this.#o.dataDir, 'code', 'state');
  }

  /** The workspace a session's Git and files are reached through (this Hub or its transport). */
  async #workspace(s: { accountId: string; environmentId: string | null }): Promise<CodeWorkspace> {
    if (!this.#remote(s)) return localWorkspace(this.git, this.#stateDir());
    return this.#workspaceOf(s.accountId, s.environmentId!);
  }

  async #workspaceOf(accountId: string, environmentId: string): Promise<CodeWorkspace> {
    const kind = this.envs.kindOf(accountId, environmentId);
    if (kind === null) throw new NovaError('not_found', 'environment not found');
    if (this.envs.isHubLocal(kind)) return localWorkspace(this.git, this.#stateDir());
    const cached = this.#workspaces.get(environmentId);
    if (cached) return cached;
    if (kind === 'ssh' || kind === 'wsl' || kind === 'device')
      return this.#helperWorkspace(accountId, environmentId);
    const transport: EnvironmentTransport | null =
      (await this.#transports.get(kind)?.(accountId, environmentId)) ?? null;
    if (!transport)
      throw new NovaError(
        'capability_missing',
        `${kind} environments have no transport on this Hub yet`,
        { details: { reason: 'remote_environment' } },
      );
    const ws = transportWorkspace(transport);
    this.#workspaces.set(environmentId, ws);
    return ws;
  }

  /** The workspace of an SSH, WSL or device environment: its helper's transport. */
  #helperWorkspace(accountId: string, environmentId: string): CodeWorkspace {
    const cached = this.#workspaces.get(environmentId);
    if (cached) return cached;
    const ws = transportWorkspace(
      helperTransport(
        () => this.envs.connection(accountId, environmentId),
        this.environmentLabel(accountId, environmentId),
      ),
    );
    this.#workspaces.set(environmentId, ws);
    return ws;
  }

  /** Whether a session works on another machine through a helper (SSH, WSL, a device). */
  #helperSession(s: { accountId: string; environmentId: string | null }): boolean {
    const kind = this.envs.kindOf(s.accountId, s.environmentId);
    return kind === 'ssh' || kind === 'wsl' || kind === 'device';
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
      repo: this.#remote(s) ? null : await this.#repo(work),
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

  /** Whether the session works on another machine (ssh, wsl or device environment). */
  #remote(s: { accountId: string; environmentId: string | null }): boolean {
    const kind = this.envs.kindOf(s.accountId, s.environmentId);
    return kind !== null && !this.envs.isHubLocal(kind);
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
    if (this.#remote(s)) return null;
    try {
      if (!(await stat(workFolder(s))).isDirectory()) return 'Folder missing';
    } catch {
      return 'Folder missing';
    }
    return null;
  }

  /**
   * What the modes need. The substrate is the one the session's commands run in: a session in
   * another environment (SSH, WSL, a device) runs them there, unsandboxed by Nova, so Bypass is
   * never available for it (FR-063).
   */
  async #conditions(
    session: { accountId: string; environmentId: string | null } | null = null,
  ): Promise<PermissionModeConditions> {
    const own = session?.environmentId ? this.sandboxFor(session) : null;
    const managed = managedRestrictions(await this.#o.setting('managed.restrict'));
    return {
      reviewerModel: await this.#o.setting('review.model'),
      allowBypass: await this.#o.setting('code.allowBypass'),
      managed: (mode) => managed.permissionMode(mode),
      // Another machine: no Nova sandbox at all. A container environment: its own. Else the Hub's.
      substrate:
        session && this.#remote(session)
          ? null
          : ((own ?? this.#o.sandbox?.() ?? null)?.substrate ?? null),
    };
  }

  /**
   * Managed policy (FR-106): sessions on the Hub's own files and SSH sessions (to a host it does
   * not allow) may be turned off. The SSH transport checks every connection too.
   */
  async #assertManagedSession(
    env: { kind: EnvironmentView['kind']; configJson: string | null },
    hubLocal: boolean,
  ): Promise<void> {
    const managed = managedRestrictions(await this.#o.setting('managed.restrict'));
    let why: string | null = null;
    if (hubLocal) why = managed.localSessions();
    else if (env.kind === 'ssh') why = managed.sshHost(sshHostOf(env.configJson));
    if (why) throw managedDenied(why, { environment: env.kind });
  }

  /** Managed policy (FR-106): a session folder on the Hub must be inside the allowed folders. */
  async #assertManagedFolder(folder: string): Promise<void> {
    const why = managedRestrictions(await this.#o.setting('managed.restrict'), {
      ...(this.#home ? { home: this.#home } : {}),
    }).folder(folder);
    if (why) throw managedDenied(why, { folder });
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

  /**
   * A folder on another machine gets the checks a path can have without its filesystem: not a
   * system folder, a credential location or inside a protected one (the helper checks the rest).
   */
  #checkRemotePath(input: string): string {
    const p = input.trim().replace(/\/+$/, '') || '/';
    const refuse = (message: string) =>
      new NovaError('policy_denied', message, { details: { reason: 'protected_folder' } });
    for (const sys of SYSTEM_FOLDERS)
      if (isWithin(sys, p)) throw refuse(`${sys} is a system folder`);
    if (isCredentialPath(p)) throw refuse('credential folders cannot be session folders');
    if (isProtectedRel(p.split('/').filter(Boolean)))
      throw refuse('protected folders (.git, .nova, .agents) cannot be session folders');
    return p;
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

/** Create a shadow (if needed) and take its first baseline: the folder as it is now. */
async function initShadow(shadow: ShadowRepo, ws: CodeWorkspace, work: string): Promise<void> {
  await shadow.init(await repoUserExcludes(ws.git, work, ws.fs));
  const tree = await shadow.snapshot();
  await shadow.setRef('baseline', tree);
  await shadow.setRef('start', tree);
}

/** Whether a repository on another machine has commit hooks (existing files are counted). */
async function remoteHasHooks(ws: CodeWorkspace, root: string): Promise<boolean> {
  try {
    const dir = await hooksDir(ws.git, root);
    for (const n of COMMIT_HOOKS)
      if ((await ws.fs.stat(join(dir, n)))?.kind === 'file') return true;
  } catch {
    // No hooks folder.
  }
  return false;
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

function notOnHub(): NovaError {
  return new NovaError(
    'capability_missing',
    'this works only for sessions whose folder is on the Hub; use exec.run in this environment',
    { details: { reason: 'remote_environment' } },
  );
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

/** The host an SSH environment's stored configuration names ('' when it cannot be read). */
function sshHostOf(configJson: string | null): string {
  try {
    const host = (JSON.parse(configJson ?? '{}') as { host?: unknown }).host;
    return typeof host === 'string' ? host : '';
  } catch {
    return '';
  }
}
