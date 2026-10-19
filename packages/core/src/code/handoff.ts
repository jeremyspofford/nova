// Session handoff (FR-213, docs/10 §15 and §14): a Code session moves to another environment (this
// Hub, an SSH host, a device running novad, the cloud runner) or, on this Hub, between the main
// checkout and a worktree, with its Git state:
//
// - the branch and HEAD; local commits not on a remote travel as a Git bundle through the Hub;
// - every uncommitted change (tracked or new, text or binary) as one binary-safe patch
//   (`--binary --full-index`), made in a short-lived shadow that borrows the repository's objects,
//   so no filter, hook or attribute of the user's repository runs and the bytes are exact;
// - the worktree identity, for moves between the main checkout and a worktree.
//
// The session must be on a branch. The target must be the same repository (it shares a root
// commit with the session), be clean, have the commits (or get them from the bundle) and not have
// moved its branch somewhere the source has not been; it checks out the branch, applies the patch and
// confirms that its HEAD and its working-state tree equal the source's. Only then does the
// session move (environment, folder, worktree, branch; its review restarts there). Until that
// confirmation the source working tree is untouched; afterwards it is kept or cleaned as the user
// chose (`code.handoffSource`). Anything else is a refusal with a reason, the target is put back
// as it was, and the session stays where it was. The location changes only between turns
// (FR-127): a handoff waits for the running turn to end (or interrupts it on request) and holds
// the session's next turns until it is done. Every move is recorded in `session_handoff`, the
// session's history, and announced as `session.handedOff`.
//
// A chat moves to another of the account's devices: the move is recorded and announced, so that
// device's client opens it; its turns run on the Hub as before, the next one from there.
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { z } from 'zod';
import {
  NovaError,
  isNovaError,
  sessionHandoffSchema,
  threadHandoffSchema,
  uuidv7,
  type HandoffGitStateView,
  type HandoffReason,
  type HandoffStatus,
  type SessionHandoffView,
} from '@nova/shared';
import { defaultRedactor, isWithin } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { SettingReader } from '../approvals/gate.ts';
import type { EventSink } from '../events.ts';
import type { ThreadService } from '../threads.ts';
import type { AuditSink } from '../tools/types.ts';
import { branchSlug } from './git.ts';
import type { CodeService, CodeSessionInfo } from './service.ts';
import { commonDir } from './merge.ts';
import { ShadowRepo, repoUserExcludes } from './shadow.ts';
import type { CodeWorkspace } from './transport.ts';

export type SessionHandoffRequest = z.input<typeof sessionHandoffSchema>;
export type ThreadHandoffRequest = z.input<typeof threadHandoffSchema>;

/** The largest patch and bundle a handoff carries through the Hub. */
export const MAX_HANDOFF_PATCH_BYTES = 256 * 1024 * 1024;
export const MAX_HANDOFF_BUNDLE_BYTES = 512 * 1024 * 1024;
/** How long a handoff's patch and bundle are kept on the Hub. */
export const HANDOFF_FILES_TTL_MS = 7 * 24 * 3_600_000;
/** How long a handoff waits for the running turn before it is refused. */
const TURN_WAIT_MS = 30 * 60_000;

interface HandoffRow {
  id: string;
  accountId: string;
  threadId: string;
  codeSessionId: string | null;
  fromRef: string;
  toRef: string;
  fromLabel: string;
  toLabel: string;
  targetFolder: string | null;
  sourceAction: 'keep' | 'clean';
  gitStateJson: string | null;
  status: HandoffStatus;
  reason: HandoffReason | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** What a handoff's row may change after it is recorded. */
type HandoffPatch = Partial<
  Pick<
    HandoffRow,
    'status' | 'reason' | 'error' | 'gitStateJson' | 'toRef' | 'targetFolder' | 'completedAt'
  >
>;

const HANDOFF_COLUMNS = `id, account_id AS accountId, thread_id AS threadId,
  code_session_id AS codeSessionId, from_ref AS fromRef, to_ref AS toRef, from_label AS fromLabel,
  to_label AS toLabel, target_folder AS targetFolder, source_action AS sourceAction,
  git_state_json AS gitStateJson, status, reason, error, created_at AS createdAt,
  completed_at AS completedAt`;

/** A handoff the target cannot take: recorded as `refused` with its reason. */
class Refusal extends Error {
  readonly reason: HandoffReason;
  constructor(reason: HandoffReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

type Target =
  | { kind: 'environment'; environmentId: string; folder: string }
  | { kind: 'worktree_new' }
  | { kind: 'worktree_main' }
  | { kind: 'worktree'; worktreeId: string };

/** The source's Git state, captured in a short-lived shadow there. */
interface Captured {
  root: string;
  /** The session folder relative to the repository root (`''` at the root). */
  prefix: string;
  head: string;
  /** HEAD's tree at the session folder. */
  headTree: string;
  /** The working state's tree at the session folder. */
  tree: string;
  /** A handoff from a detached HEAD is refused, so there is always a branch. */
  branch: string;
  /** HEAD's root commits: a target repository with none of them is another repository. */
  roots: string[];
  patch: Buffer;
  paths: string[];
  bundle: Buffer | null;
  bundleCommits: number;
  shadow: ShadowRepo;
}

/** Where the target checked out the state, and how to put it back. */
interface Placed {
  environmentId: string;
  ws: CodeWorkspace;
  /** The repository root (or worktree) at the target: the work folder stays inside it. */
  root: string;
  /** The work folder at the target. */
  work: string;
  /** The session's `folder_path` after the move (the main checkout folder for worktrees). */
  folderPath: string;
  branch: string | null;
  worktreeId: string | null;
  toRef: string;
  undo: () => Promise<void>;
  /** Extra cleanup once the move is confirmed. */
  settle: () => Promise<void>;
}

export interface HandoffServiceOptions {
  db: NovaDatabase;
  code: CodeService;
  threads: ThreadService;
  events: EventSink;
  audit: AuditSink;
  dataDir: string;
  setting: SettingReader;
  now?: () => Date;
  log?: Logger;
  /** How long to wait for a running turn (default 30 min). */
  turnWaitMs?: number;
  /** How often the wait looks again (default 200 ms). */
  pollMs?: number;
}

export class HandoffService {
  readonly #o: HandoffServiceOptions;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #running = new Map<string, Promise<SessionHandoffView>>();
  /** The handoff in flight per session. */
  readonly #bySession = new Map<string, string>();
  readonly #stop = new AbortController();

  constructor(opts: HandoffServiceOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.handoff', sinks: [] });
  }

  // ---- Code sessions -----------------------------------------------------------------------

  /**
   * Start moving a session. Returns at once with the recorded handoff (`pending`); `done`
   * settles when it completed, was refused or failed. Request errors (unknown environment, a
   * handoff already running, the same place) throw instead of being recorded.
   */
  async start(
    accountId: string,
    sessionId: string,
    input: SessionHandoffRequest,
    actor: 'user' | 'agent' = 'user',
  ): Promise<{ view: SessionHandoffView; done: Promise<SessionHandoffView> }> {
    const req = sessionHandoffSchema.parse(input);
    const s = this.#o.code.info(accountId, sessionId);
    if (!s.active) throw new NovaError('conflict', 'that session is archived');
    if (this.#bySession.has(s.id))
      throw new NovaError('conflict', 'this session is already being handed off', {
        details: { reason: 'handoff_running', handoffId: this.#bySession.get(s.id) },
      });
    const target = await this.#target(s, req.to);
    const source = req.source ?? (await this.#o.setting('code.handoffSource'));
    const from = s.worktreeId ? `worktree:${s.worktreeId}` : envRef(s.environmentId);
    const fromLabel = this.#locationLabel(s, s.worktreeId);
    const to =
      target.kind === 'environment'
        ? envRef(target.environmentId)
        : target.kind === 'worktree'
          ? `worktree:${target.worktreeId}`
          : target.kind === 'worktree_new'
            ? 'worktree:new'
            : envRef(s.environmentId);
    const toLabel =
      target.kind === 'environment'
        ? `${this.#o.code.environmentLabel(accountId, target.environmentId)}: ${target.folder}`
        : target.kind === 'worktree_main'
          ? 'the main checkout'
          : target.kind === 'worktree_new'
            ? 'a new worktree'
            : 'a worktree';
    const id = uuidv7();
    const row: HandoffRow = {
      id,
      accountId,
      threadId: s.threadId,
      codeSessionId: s.id,
      fromRef: from,
      toRef: to,
      fromLabel,
      toLabel,
      targetFolder: target.kind === 'environment' ? target.folder : null,
      sourceAction: source,
      gitStateJson: null,
      status: 'pending',
      reason: null,
      error: null,
      createdAt: this.#iso(),
      completedAt: null,
    };
    await this.#insert(row);
    this.#bySession.set(s.id, id);
    await this.#audit(row, actor, 'code.handoff.requested', 'ok', {
      to,
      source,
      interrupt: req.interrupt ?? false,
    });
    await this.#announce(row);
    const done = this.#run(row, s, target, req.interrupt ?? false, actor).finally(() => {
      this.#running.delete(id);
      if (this.#bySession.get(s.id) === id) this.#bySession.delete(s.id);
    });
    this.#running.set(id, done);
    void done.catch(() => undefined);
    return { view: this.get(accountId, id), done };
  }

  get(accountId: string, id: string): SessionHandoffView {
    const r = this.#o.db.raw
      .prepare(`SELECT ${HANDOFF_COLUMNS} FROM session_handoff WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as HandoffRow | undefined;
    if (!r) throw new NovaError('not_found', 'handoff not found');
    return viewOf(r);
  }

  /** A session's moves, newest first (its history, FR-213). */
  list(accountId: string, sessionId: string): SessionHandoffView[] {
    const s = this.#o.code.info(accountId, sessionId);
    return this.listThread(accountId, s.threadId);
  }

  /** A thread's moves, newest first. */
  listThread(accountId: string, threadId: string): SessionHandoffView[] {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${HANDOFF_COLUMNS} FROM session_handoff WHERE account_id = ? AND thread_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 200`,
      )
      .all(accountId, threadId) as unknown as HandoffRow[];
    return rows.map(viewOf);
  }

  // ---- chats -------------------------------------------------------------------------------

  /**
   * Move a chat to another of the account's devices: recorded and announced at once (that
   * device's client opens it); it takes effect from the next turn (FR-127), or now when the
   * running turn is interrupted.
   */
  async startChat(
    accountId: string,
    threadId: string,
    input: ThreadHandoffRequest,
  ): Promise<SessionHandoffView> {
    const req = threadHandoffSchema.parse(input);
    const thread = await this.#o.threads.row(accountId, threadId);
    if (thread.mode === 'code')
      throw new NovaError('validation', "move a Code session with its session's handoff", {
        details: { reason: 'code_thread' },
      });
    const device = this.#o.db.raw
      .prepare(
        "SELECT id, name FROM device WHERE id = ? AND account_id = ? AND status != 'revoked'",
      )
      .get(req.to.deviceId, accountId) as { id: string; name: string } | undefined;
    if (!device)
      throw new NovaError('not_found', 'device not found', {
        details: { reason: 'unknown_device' },
      });
    if (req.interrupt && thread.state === 'streaming')
      await this.#o.code.turns?.cancel(accountId, threadId);
    const now = this.#iso();
    const row: HandoffRow = {
      id: uuidv7(),
      accountId,
      threadId,
      codeSessionId: null,
      fromRef: 'hub',
      toRef: `device:${device.id}`,
      fromLabel: 'this Hub',
      toLabel: device.name,
      targetFolder: null,
      sourceAction: 'keep',
      gitStateJson: null,
      status: 'completed',
      reason: null,
      error: null,
      createdAt: now,
      completedAt: now,
    };
    await this.#insert(row);
    await this.#audit(row, 'user', 'thread.handoff', 'ok', {
      deviceId: device.id,
      interrupt: req.interrupt ?? false,
    });
    await this.#announce(row);
    return viewOf(row);
  }

  async close(): Promise<void> {
    this.#stop.abort();
    await Promise.allSettled([...this.#running.values()]);
  }

  /**
   * Handoff files (the patch, a bundle) expire: removed once the handoff is older than `maxAgeMs`
   * (default 7 days), or when no handoff owns them. Called from the Hub's periodic sweep.
   */
  async sweepFiles(maxAgeMs = HANDOFF_FILES_TTL_MS): Promise<number> {
    const dir = join(this.#o.dataDir, 'code', 'handoffs');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    const cutoff = new Date(this.#now().getTime() - maxAgeMs).toISOString();
    let removed = 0;
    for (const id of names) {
      if (this.#running.has(id)) continue;
      const r = this.#o.db.raw
        .prepare('SELECT created_at AS createdAt FROM session_handoff WHERE id = ?')
        .get(id) as { createdAt: string } | undefined;
      if (r && r.createdAt > cutoff) continue;
      await rm(join(dir, id), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  // ---- the move ----------------------------------------------------------------------------

  async #run(
    row: HandoffRow,
    s0: CodeSessionInfo,
    target: Target,
    interrupt: boolean,
    actor: 'user' | 'agent',
  ): Promise<SessionHandoffView> {
    const code = this.#o.code;
    let release: (() => void) | null = null;
    let captured: Captured | null = null;
    let state: HandoffGitStateView | null = null;
    // The final state and its audit entry, published only once the session is free again.
    let final: HandoffPatch;
    let outcome: { action: string; result: string; detail: Record<string, unknown> };
    try {
      release = await this.#betweenTurns(s0, interrupt);
      await this.#update(row, { status: 'running' });
      const s = code.info(s0.accountId, s0.id);
      const sws = await code.workspace(s);
      captured = await code.serialized(s.id, () => this.#capture(row, s, sws));
      const c = captured;
      const blobs = await this.#keep(row.id, c);
      state = {
        branch: c.branch,
        head: c.head,
        tree: c.tree,
        patchSha256: sha256(c.patch),
        patchBytes: c.patch.length,
        files: c.paths.length,
        bundleSha256: blobs.bundleSha256,
        bundleCommits: c.bundleCommits,
        worktreeId: s.worktreeId,
        stateHash: sha256(`${c.head}\n${c.tree}\n`),
      };
      await this.#update(row, { gitStateJson: JSON.stringify(state) });
      const placed = await this.#place(row, s, c, target);
      try {
        await this.#checkWork(s, placed);
      } catch (err) {
        await placed
          .undo()
          .catch((e: unknown) =>
            this.#log.warn('putting the target back failed', { err: e, handoffId: row.id }),
          );
        throw err;
      }
      let applied = false;
      const tShadow = await this.#tempShadow(row.id, 'dst', placed.ws, placed.work);
      const next = await code.shadowIn(s.id, placed.ws, placed.work, true);
      try {
        // The session's shadow at the target starts from the target before the patch, so the
        // traveled changes show as pending there.
        await next.remove();
        await code.baselineShadow(next, placed.ws, placed.work);
        if (c.patch.length) {
          const r = await tShadow.applyToWorkTree(c.patch);
          if (!r.ok)
            throw new Refusal(
              'conflicts',
              `the changes do not apply at the target: ${firstLine(r.stderr)}`,
            );
          applied = true;
        }
        const thead = await placed.ws.git.text(['rev-parse', 'HEAD'], { cwd: placed.work });
        const prefix = await repoPrefix(placed.ws, placed.work);
        const theadTree = await tShadow
          .git(['rev-parse', prefix ? `${thead}:${prefix}` : `${thead}^{tree}`])
          .then((r) => r.stdout.toString('utf8').trim());
        await tShadow.readTree(theadTree);
        const ttree = await tShadow.snapshot();
        if (thead !== c.head || ttree !== c.tree)
          throw new Refusal(
            'verify_failed',
            `the target does not match the source after the move (HEAD ${thead.slice(0, 12)}, state ${ttree.slice(0, 12)})`,
          );
      } catch (err) {
        if (applied) {
          const prefix = await repoPrefix(placed.ws, placed.work).catch(() => c.prefix);
          await tShadow
            .restoreFrom(prefix ? `${c.head}:${prefix}` : c.head, c.paths)
            .catch((e: unknown) => this.#log.warn('undoing the patch failed', { err: e }));
        }
        await next.remove().catch(() => undefined);
        await placed
          .undo()
          .catch((e: unknown) =>
            this.#log.warn('putting the target back failed', { err: e, handoffId: row.id }),
          );
        throw err;
      } finally {
        await tShadow.remove().catch(() => undefined);
      }
      // Confirmed: the session continues at the target.
      await code.relocate(s.accountId, s.id, {
        environmentId: placed.environmentId,
        folderPath: placed.folderPath,
        worktreeId: placed.worktreeId,
        branch: placed.branch,
      });
      await placed
        .settle()
        .catch((e: unknown) =>
          this.#log.warn('cleaning up after a handoff failed', { err: e, handoffId: row.id }),
        );
      // The bundle served its purpose; the patch stays until the files expire (sweepFiles).
      await rm(join(this.#o.dataDir, 'code', 'handoffs', row.id, 'state.bundle'), { force: true });
      if (row.sourceAction === 'clean' && c.paths.length) {
        try {
          await c.shadow.restoreFrom(c.headTree, c.paths);
        } catch (err) {
          this.#log.warn('cleaning the source failed', { err, handoffId: row.id });
        }
        if (s.worktreeId && placed.worktreeId !== s.worktreeId)
          await code.worktrees.remove(s.accountId, s.worktreeId).catch(() => undefined);
      }
      final = {
        status: 'completed',
        toRef: placed.toRef,
        targetFolder: placed.work,
        completedAt: this.#iso(),
      };
      outcome = {
        action: 'code.handoff.completed',
        result: 'ok',
        detail: {
          to: placed.toRef,
          stateHash: state.stateHash,
          files: state.files,
          bundleCommits: state.bundleCommits,
          source: row.sourceAction,
        },
      };
    } catch (err) {
      const refused = err instanceof Refusal;
      const reason: HandoffReason = refused ? err.reason : reasonOf(err);
      const detail = defaultRedactor
        .redactString(err instanceof Error ? err.message : String(err))
        .slice(0, 2000);
      if (!refused) this.#log.warn('a handoff failed', { err, handoffId: row.id });
      final = {
        status: refused ? 'refused' : 'failed',
        reason,
        error: detail,
        completedAt: this.#iso(),
      };
      outcome = {
        action: refused ? 'code.handoff.refused' : 'code.handoff.failed',
        result: refused ? 'denied' : 'error',
        detail: { reason },
      };
    } finally {
      if (captured) await captured.shadow.remove().catch(() => undefined);
      release?.();
      // Free the session before the final state shows: whoever sees it may hand the session off
      // again at once, and must not be refused as `handoff_running` by this one's cleanup.
      if (row.codeSessionId && this.#bySession.get(row.codeSessionId) === row.id)
        this.#bySession.delete(row.codeSessionId);
    }
    await this.#update(row, final);
    await this.#audit(row, actor, outcome.action, outcome.result, outcome.detail);
    const view = this.get(row.accountId, row.id);
    await this.#announce(row, view.git?.branch ?? state?.branch ?? null);
    return view;
  }

  /**
   * Wait until no turn of the session runs, then hold its next turns (FR-127). `interrupt`
   * cancels the running one first.
   */
  async #betweenTurns(s: CodeSessionInfo, interrupt: boolean): Promise<() => void> {
    const code = this.#o.code;
    const end = Date.now() + (this.#o.turnWaitMs ?? TURN_WAIT_MS);
    if (interrupt && code.insideTurn(s.accountId, s.id))
      await code.turns?.cancel(s.accountId, s.threadId);
    for (;;) {
      const release = code.holdTurns(s.id);
      if (!code.insideTurn(s.accountId, s.id)) return release;
      release();
      if (Date.now() > end || this.#stop.signal.aborted)
        throw new Refusal('turn_running', 'a turn is still running; try again or interrupt it');
      await new Promise((r) => setTimeout(r, this.#o.pollMs ?? 200));
    }
  }

  /** The source's Git state, without changing anything there. */
  async #capture(row: HandoffRow, s: CodeSessionInfo, ws: CodeWorkspace): Promise<Captured> {
    const git = ws.git;
    const work = s.folder;
    const top = await git.run(['rev-parse', '--show-toplevel'], { cwd: work, allowFail: true });
    if (top.code !== 0)
      throw new Refusal('not_a_repository', 'the session folder is not in a Git repository');
    const root = top.stdout.toString('utf8').trim();
    const headR = await git.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], {
      cwd: work,
      allowFail: true,
    });
    const head = headR.code === 0 ? headR.stdout.toString('utf8').trim() : '';
    if (!head) throw new Refusal('no_commits', 'a handoff needs a repository with a commit');
    const br = await git.run(['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: work,
      allowFail: true,
    });
    const branch = br.code === 0 ? br.stdout.toString('utf8').trim() : '';
    // Commits made at the target would belong to no branch and be easy to lose.
    if (!branch)
      throw new Refusal('detached_head', 'the session is not on a branch; create a branch first');
    // Names reach Git after `--end-of-options` too; one that looks like an option never travels.
    if (!/^[^-\s][^\s]*$/.test(branch))
      throw new Refusal('failed', 'the branch name cannot be handed off');
    const rootsR = await git.run(['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: work,
      allowFail: true,
    });
    const roots =
      rootsR.code === 0 ? rootsR.stdout.toString('utf8').split(/\s+/).filter(Boolean) : [];
    const prefix = await repoPrefix(ws, work);
    if (prefix.split('/').includes('..'))
      throw new Refusal('protected_folder', 'the session folder is outside its repository');
    const shadow = await this.#tempShadow(row.id, 'src', ws, work);
    const headTree = (
      await shadow.git(['rev-parse', prefix ? `${head}:${prefix}` : `${head}^{tree}`])
    ).stdout
      .toString('utf8')
      .trim();
    await shadow.readTree(headTree);
    const tree = await shadow.snapshot();
    const patch = await shadow.binaryPatch(headTree, tree);
    if (patch.length > MAX_HANDOFF_PATCH_BYTES)
      throw new Refusal('too_large', 'the uncommitted changes are too large to hand off');
    const paths = await shadow.changedPaths(headTree, tree);
    // Local commits no remote has travel as a bundle (docs/10 §15).
    const count = await git.run(['rev-list', '--count', 'HEAD', '--not', '--remotes'], {
      cwd: work,
      allowFail: true,
    });
    const bundleCommits = count.code === 0 ? Number(count.stdout.toString('utf8').trim()) || 0 : 0;
    let bundle: Buffer | null = null;
    if (bundleCommits > 0) {
      const file = join(await ws.stateDir(), `handoff-${row.id}.bundle`);
      try {
        const r = await git.run(
          ['bundle', 'create', file, `refs/heads/${branch}`, '--not', '--remotes'],
          { cwd: work, allowFail: true, timeoutMs: 10 * 60_000 },
        );
        if (r.code !== 0)
          throw new NovaError(
            'server_error',
            `the commits could not be bundled: ${firstLine(r.stderr)}`,
          );
        const st = await ws.fs.stat(file);
        if (!st || st.size > MAX_HANDOFF_BUNDLE_BYTES)
          throw new Refusal('too_large', 'the local commits are too large to hand off');
        bundle = await ws.fs.readFile(file, MAX_HANDOFF_BUNDLE_BYTES);
      } finally {
        await ws.fs.remove(file).catch(() => undefined);
      }
    }
    return {
      root,
      prefix,
      head,
      headTree,
      tree,
      branch,
      roots,
      patch,
      paths,
      bundle,
      bundleCommits,
      shadow,
    };
  }

  /** Keep the patch (and bundle) under the data folder for this handoff. */
  async #keep(id: string, c: Captured): Promise<{ bundleSha256: string | null }> {
    const dir = join(this.#o.dataDir, 'code', 'handoffs', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'changes.patch'), c.patch, { mode: 0o600 });
    if (!c.bundle) return { bundleSha256: null };
    await writeFile(join(dir, 'state.bundle'), c.bundle, { mode: 0o600 });
    return { bundleSha256: sha256(c.bundle) };
  }

  /** Check out the source's state at the target (clean, same commits, branch not moved away). */
  async #place(row: HandoffRow, s: CodeSessionInfo, c: Captured, target: Target): Promise<Placed> {
    const code = this.#o.code;
    const rel = c.prefix;
    if (target.kind === 'worktree_new') {
      let made;
      try {
        made = await code.worktrees.create({
          accountId: s.accountId,
          repoRoot: c.root,
          sourceBranch: c.branch,
          slug: branchSlug(s.title ?? 'handoff'),
          base: c.head,
          actor: 'user',
        });
      } catch (err) {
        if (isNovaError(err) && reasonIn(err) === 'worktree_cap')
          throw new Refusal('target_missing', err.message);
        throw err;
      }
      const wt = made.row;
      const ws = await code.workspace(s);
      return {
        environmentId: await this.#envId(s),
        ws,
        root: wt.path,
        work: rel ? join(wt.path, ...rel.split('/')) : wt.path,
        folderPath: s.folderPath,
        branch: wt.branch,
        worktreeId: wt.id,
        toRef: `worktree:${wt.id}`,
        undo: async () => {
          await code.worktrees.remove(s.accountId, wt.id, true);
        },
        settle: () => Promise.resolve(),
      };
    }
    if (target.kind === 'worktree_main') {
      const wt = code.worktrees.get(s.accountId, s.worktreeId!);
      const ws = await code.workspace(s);
      const git = ws.git;
      const main = wt.repoPath;
      await this.#assertClean(ws, main);
      const prev = await currentRef(ws, main);
      // The branch moves from the worktree to the main checkout: detach the worktree (no file
      // changes), then check the branch out in the main checkout.
      await git.run(['checkout', '-q', '--detach'], { cwd: c.root });
      const r = await git.run(['checkout', '-q', '--end-of-options', c.branch, '--'], {
        cwd: main,
        allowFail: true,
      });
      if (r.code !== 0) {
        await git.run(['checkout', '-q', '--end-of-options', c.branch, '--'], {
          cwd: c.root,
          allowFail: true,
        });
        throw new Refusal(
          'branch_in_use',
          `the main checkout cannot take ${c.branch}: ${firstLine(r.stderr)}`,
        );
      }
      return {
        environmentId: await this.#envId(s),
        ws,
        root: main,
        work: s.folderPath,
        folderPath: s.folderPath,
        branch: c.branch,
        worktreeId: null,
        toRef: envRef(s.environmentId),
        undo: async () => {
          await checkoutRef(ws, main, prev);
          await git.run(['checkout', '-q', '--end-of-options', c.branch, '--'], {
            cwd: c.root,
            allowFail: true,
          });
        },
        settle: () => Promise.resolve(),
      };
    }
    if (target.kind === 'worktree') {
      const wt = code.worktrees.assertBindable(s.accountId, target.worktreeId);
      const ws = await code.workspace(s);
      const git = ws.git;
      await this.#assertClean(ws, wt.path);
      const wtHead = await git.text(['rev-parse', 'HEAD'], { cwd: wt.path });
      if (wtHead !== c.head) {
        const anc = await git.run(['merge-base', '--is-ancestor', wtHead, c.head], {
          cwd: wt.path,
          allowFail: true,
        });
        if (anc.code !== 0)
          throw new Refusal(
            'branch_diverged',
            `the worktree's branch ${wt.branch} has commits the session does not have`,
          );
        await git.run(['checkout', '-q', '-B', wt.branch, c.head], { cwd: wt.path });
      }
      return {
        environmentId: await this.#envId(s),
        ws,
        root: wt.path,
        work: rel ? join(wt.path, ...rel.split('/')) : wt.path,
        folderPath: s.folderPath,
        branch: wt.branch,
        worktreeId: wt.id,
        toRef: `worktree:${wt.id}`,
        undo: async () => {
          if (wtHead !== c.head)
            await git.run(['checkout', '-q', '-B', wt.branch, wtHead], { cwd: wt.path });
        },
        settle: () => Promise.resolve(),
      };
    }
    return this.#placeInEnvironment(row, s, c, target);
  }

  async #placeInEnvironment(
    row: HandoffRow,
    s: CodeSessionInfo,
    c: Captured,
    target: Extract<Target, { kind: 'environment' }>,
  ): Promise<Placed> {
    const code = this.#o.code;
    let ws: CodeWorkspace;
    let folder: string;
    try {
      ws = await code.workspaceOf(s.accountId, target.environmentId);
      folder = await code.checkFolderIn(s.accountId, target.environmentId, target.folder);
    } catch (err) {
      if (isNovaError(err) && (err.code === 'validation' || err.code === 'policy_denied'))
        throw new Refusal('target_missing', err.message);
      throw new Refusal(
        'target_unreachable',
        `the target cannot be reached: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const git = ws.git;
    const top = await git.run(['rev-parse', '--show-toplevel'], { cwd: folder, allowFail: true });
    if (top.code !== 0)
      throw new Refusal('not_a_repository', `${folder} is not in a Git repository at the target`);
    const troot = top.stdout.toString('utf8').trim();
    await this.#assertSameRepository(ws, troot, c);
    await this.#assertClean(ws, troot);
    const tempRef = `refs/nova/handoff/${row.id}`;
    let fetched = false;
    if (c.bundle) {
      const file = join(await ws.stateDir(), `handoff-${row.id}.bundle`);
      try {
        await ws.fs.writeFile(file, c.bundle, 0o600);
        const v = await git.run(['bundle', 'verify', file], { cwd: troot, allowFail: true });
        if (v.code !== 0)
          throw new Refusal(
            'missing_commits',
            `the target lacks commits the session's branch builds on: ${firstLine(v.stderr)}`,
          );
        const src = `refs/heads/${c.branch}`;
        const f = await git.run(['fetch', '-q', '--no-tags', file, `${src}:${tempRef}`], {
          cwd: troot,
          allowFail: true,
          timeoutMs: 10 * 60_000,
        });
        if (f.code !== 0)
          throw new Refusal(
            'missing_commits',
            `the commits could not be added: ${firstLine(f.stderr)}`,
          );
        fetched = true;
      } finally {
        await ws.fs.remove(file).catch(() => undefined);
      }
    }
    const has = await git.run(['cat-file', '-e', `${c.head}^{commit}`], {
      cwd: troot,
      allowFail: true,
    });
    if (has.code !== 0) {
      if (fetched) await git.run(['update-ref', '-d', tempRef], { cwd: troot, allowFail: true });
      throw new Refusal(
        'missing_commits',
        `the target does not have commit ${c.head.slice(0, 12)}; fetch it there first`,
      );
    }
    const dropTemp = async () => {
      if (fetched) await git.run(['update-ref', '-d', tempRef], { cwd: troot, allowFail: true });
    };
    const prev = await currentRef(ws, troot);
    const tb = await git.run(['rev-parse', '-q', '--verify', `refs/heads/${c.branch}`], {
      cwd: troot,
      allowFail: true,
    });
    const branchBefore = tb.code === 0 ? tb.stdout.toString('utf8').trim() : null;
    if (branchBefore && branchBefore !== c.head) {
      const anc = await git.run(['merge-base', '--is-ancestor', branchBefore, c.head], {
        cwd: troot,
        allowFail: true,
      });
      if (anc.code !== 0) {
        await dropTemp();
        throw new Refusal(
          'branch_diverged',
          `${c.branch} at the target has commits the session does not have`,
        );
      }
    }
    const r = await git.run(['checkout', '-q', '-B', c.branch, c.head], {
      cwd: troot,
      allowFail: true,
    });
    if (r.code !== 0) {
      await dropTemp();
      throw new Refusal(
        'branch_in_use',
        `the target cannot check out ${c.branch}: ${firstLine(r.stderr)}`,
      );
    }
    const work = c.prefix ? join(troot, ...c.prefix.split('/')) : troot;
    return {
      environmentId: target.environmentId,
      ws,
      root: troot,
      work,
      folderPath: work,
      branch: c.branch,
      worktreeId: null,
      toRef: envRef(target.environmentId),
      undo: async () => {
        await checkoutRef(ws, troot, prev);
        if (prev.branch !== c.branch) {
          if (branchBefore)
            await git.run(['branch', '-f', '--end-of-options', c.branch, branchBefore], {
              cwd: troot,
              allowFail: true,
            });
          else
            await git.run(['branch', '-D', '--end-of-options', c.branch], {
              cwd: troot,
              allowFail: true,
            });
        } else if (branchBefore && branchBefore !== c.head) {
          await git.run(['reset', '-q', '--keep', branchBefore], { cwd: troot, allowFail: true });
        }
        await dropTemp();
      },
      settle: dropTemp,
    };
  }

  /**
   * The folder the session lands in passes the same checks as a new session's (the Hub's folder
   * rules, or the path rules elsewhere) and stays inside the target repository. A worktree is
   * Nova's own: its main checkout's folder is the one checked.
   */
  async #checkWork(s: CodeSessionInfo, placed: Placed): Promise<void> {
    const code = this.#o.code;
    if (
      !isWithin(placed.root, placed.work) ||
      relative(placed.root, placed.work).split(sep).includes('..')
    )
      throw new Refusal('protected_folder', 'the session folder would be outside the repository');
    const checked = placed.worktreeId ? placed.folderPath : placed.work;
    let real: string;
    try {
      real = await code.checkFolderIn(s.accountId, placed.environmentId, checked);
    } catch (err) {
      if (isNovaError(err) && (err.code === 'policy_denied' || err.code === 'validation'))
        throw new Refusal('protected_folder', err.message);
      throw err;
    }
    if (!placed.worktreeId) {
      placed.work = real;
      placed.folderPath = real;
    }
  }

  /**
   * The target folder's repository is the session's: it has one of HEAD's root commits. Without
   * this, a bundle with no prerequisites would graft the session's history onto an unrelated
   * repository. An empty repository (nothing to compare) and a shallow clone (its roots are cut)
   * pass; the commit checks that follow still apply.
   */
  async #assertSameRepository(ws: CodeWorkspace, root: string, c: Captured): Promise<void> {
    if (!c.roots.length) return;
    const git = ws.git;
    const shallow = await git.run(['rev-parse', '--is-shallow-repository'], {
      cwd: root,
      allowFail: true,
    });
    if (shallow.code !== 0 || shallow.stdout.toString('utf8').trim() !== 'false') return;
    const any = await git.run(['rev-list', '-n', '1', '--all'], { cwd: root, allowFail: true });
    if (any.code !== 0 || !any.stdout.toString('utf8').trim()) return;
    for (const commit of c.roots) {
      const has = await git.run(['cat-file', '-e', `${commit}^{commit}`], {
        cwd: root,
        allowFail: true,
      });
      if (has.code === 0) return;
    }
    throw new Refusal(
      'other_repository',
      `${root} is another repository: it shares no history with the session's`,
    );
  }

  async #assertClean(ws: CodeWorkspace, root: string): Promise<void> {
    // Nova's own worktrees under `.nova/` are not the user's changes.
    const r = await ws.git.run(
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=normal',
        '--ignore-submodules',
        '--',
        ':(top)',
        ':(top,exclude).nova',
      ],
      { cwd: root, allowFail: true },
    );
    if (r.code !== 0)
      throw new Refusal(
        'target_missing',
        `the target repository cannot be read: ${firstLine(r.stderr)}`,
      );
    if (r.stdout.toString('utf8').trim())
      throw new Refusal(
        'target_dirty',
        'the target has uncommitted changes; commit, stash or discard them there first',
      );
  }

  /** A short-lived shadow over a work folder that borrows its repository's objects. */
  async #tempShadow(
    id: string,
    side: 'src' | 'dst',
    ws: CodeWorkspace,
    work: string,
  ): Promise<ShadowRepo> {
    const common = await commonDir(ws, work);
    const shadow = new ShadowRepo({
      git: ws.git,
      gitDir: join(await ws.stateDir(), `handoff-${id}-${side}.git`),
      workTree: work,
      fs: ws.fs,
    });
    await shadow.remove();
    await shadow.init(await repoUserExcludes(ws.git, work, ws.fs), {
      alternates: join(common, 'objects'),
    });
    return shadow;
  }

  /** Resolve the request's target; problems the request itself has throw (not recorded). */
  async #target(s: CodeSessionInfo, to: SessionHandoffRequest['to']): Promise<Target> {
    const code = this.#o.code;
    if (to.worktree !== undefined) {
      if (!s.hubLocal)
        throw new NovaError('validation', 'worktrees are only available for folders on the Hub', {
          details: { reason: 'worktree_unavailable' },
        });
      if (to.worktree === 'main') {
        if (!s.worktreeId)
          throw new NovaError('conflict', 'the session already works in the main checkout', {
            details: { reason: 'same_location' },
          });
        return { kind: 'worktree_main' };
      }
      if (to.worktree === 'new') return { kind: 'worktree_new' };
      if (to.worktree === s.worktreeId)
        throw new NovaError('conflict', 'the session already works in that worktree', {
          details: { reason: 'same_location' },
        });
      const wt = code.worktrees.get(s.accountId, to.worktree);
      const main = s.worktreeId ? code.worktrees.get(s.accountId, s.worktreeId).repoPath : null;
      const root =
        main ?? (await code.git.text(['rev-parse', '--show-toplevel'], { cwd: s.folder }));
      if (wt.repoPath !== root)
        throw new NovaError('validation', 'the worktree belongs to another repository', {
          details: { reason: 'worktree_repo' },
        });
      return { kind: 'worktree', worktreeId: wt.id };
    }
    const environmentId = to.environmentId!;
    await code.envs.resolve(s.accountId, environmentId);
    if (!to.folder)
      throw new NovaError('validation', 'name the repository folder in the target environment');
    const here = s.environmentId ?? (await code.envs.local(s.accountId)).id;
    if (environmentId === here && trimSlash(to.folder) === trimSlash(s.folder))
      throw new NovaError('conflict', 'the session already works there', {
        details: { reason: 'same_location' },
      });
    return { kind: 'environment', environmentId, folder: to.folder };
  }

  async #envId(s: CodeSessionInfo): Promise<string> {
    return s.environmentId ?? (await this.#o.code.envs.local(s.accountId)).id;
  }

  #locationLabel(s: CodeSessionInfo, worktreeId: string | null): string {
    const env = this.#o.code.environmentLabel(s.accountId, s.environmentId);
    return worktreeId ? `${env}: worktree ${s.folder}` : `${env}: ${s.folder}`;
  }

  // ---- rows, events, audit ------------------------------------------------------------------

  async #insert(r: HandoffRow): Promise<void> {
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO session_handoff (id, account_id, thread_id, code_session_id, from_ref, to_ref,
             from_label, to_label, target_folder, source_action, git_state_json, status, reason,
             error, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          r.id,
          r.accountId,
          r.threadId,
          r.codeSessionId,
          r.fromRef,
          r.toRef,
          r.fromLabel,
          r.toLabel,
          r.targetFolder,
          r.sourceAction,
          r.gitStateJson,
          r.status,
          r.reason,
          r.error,
          r.createdAt,
          r.completedAt,
        );
    });
  }

  async #update(r: HandoffRow, patch: HandoffPatch): Promise<void> {
    Object.assign(r, patch);
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE session_handoff SET status = ?, reason = ?, error = ?, git_state_json = ?,
             to_ref = ?, target_folder = ?, completed_at = ? WHERE id = ?`,
        )
        .run(
          r.status,
          r.reason,
          r.error,
          r.gitStateJson,
          r.toRef,
          r.targetFolder,
          r.completedAt,
          r.id,
        );
    });
    if (patch.status === 'running') await this.#announce(r);
  }

  async #announce(r: HandoffRow, branch: string | null = null): Promise<void> {
    try {
      await this.#o.events.emit({
        name: 'session.handedOff',
        actor: 'system',
        accountId: r.accountId,
        correlation: {
          threadId: r.threadId,
          ...(r.codeSessionId ? { sessionId: r.codeSessionId } : {}),
        },
        payload: {
          handoffId: r.id,
          threadId: r.threadId,
          ...(r.codeSessionId ? { sessionId: r.codeSessionId } : {}),
          from: r.fromRef,
          to: r.toRef,
          ...(branch ? { branch } : {}),
          status: r.status,
          ...(r.reason ? { reason: r.reason } : {}),
        },
      });
    } catch (err) {
      this.#log.warn('could not announce a handoff', { err, handoffId: r.id });
    }
  }

  async #audit(
    r: HandoffRow,
    actor: string,
    action: string,
    result: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.#o.audit.append({
      accountId: r.accountId,
      actor,
      kind: 'code',
      action,
      resource: r.targetFolder ?? r.toRef,
      result,
      threadId: r.threadId,
      detail: {
        handoffId: r.id,
        ...(r.codeSessionId ? { sessionId: r.codeSessionId } : {}),
        from: r.fromRef,
        ...detail,
      },
    });
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function viewOf(r: HandoffRow): SessionHandoffView {
  let git: HandoffGitStateView | null = null;
  if (r.gitStateJson) {
    try {
      git = JSON.parse(r.gitStateJson) as HandoffGitStateView;
    } catch {
      git = null;
    }
  }
  return {
    id: r.id,
    threadId: r.threadId,
    sessionId: r.codeSessionId,
    from: r.fromRef,
    to: r.toRef,
    fromLabel: r.fromLabel,
    toLabel: r.toLabel,
    status: r.status,
    reason: r.reason,
    detail: r.error,
    source: r.sourceAction,
    git,
    folder: r.targetFolder,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}

function envRef(environmentId: string | null): string {
  return environmentId ? `environment:${environmentId}` : 'hub';
}

function trimSlash(p: string): string {
  return p.trim().replace(/\/+$/, '') || '/';
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 300) ?? 'unknown error'
  );
}

function reasonIn(err: NovaError): unknown {
  return (err.details as { reason?: unknown } | undefined)?.reason;
}

function reasonOf(err: unknown): HandoffReason {
  if (isNovaError(err)) {
    const r = reasonIn(err);
    if (r === 'remote_state_unavailable' || r === 'remote_environment')
      return r === 'remote_environment' ? 'environment_unavailable' : 'remote_state_unavailable';
    if (err.code === 'capability_missing') return 'environment_unavailable';
  }
  return 'failed';
}

/** The work folder relative to its repository root (`''` at the root), `/`-separated. */
async function repoPrefix(ws: CodeWorkspace, work: string): Promise<string> {
  const top = await ws.git.text(['rev-parse', '--show-toplevel'], { cwd: work });
  return relative(top, work).split(sep).filter(Boolean).join('/');
}

interface Ref {
  branch: string | null;
  sha: string;
}

async function currentRef(ws: CodeWorkspace, root: string): Promise<Ref> {
  const b = await ws.git.run(['symbolic-ref', '--short', '-q', 'HEAD'], {
    cwd: root,
    allowFail: true,
  });
  const sha = await ws.git.text(['rev-parse', 'HEAD'], { cwd: root });
  return { branch: b.code === 0 ? b.stdout.toString('utf8').trim() || null : null, sha };
}

async function checkoutRef(ws: CodeWorkspace, root: string, ref: Ref): Promise<void> {
  if (ref.branch)
    await ws.git.run(['checkout', '-q', '--end-of-options', ref.branch, '--'], {
      cwd: root,
      allowFail: true,
    });
  else await ws.git.run(['checkout', '-q', '--detach', ref.sha], { cwd: root, allowFail: true });
}

/** Remove a handoff's kept files (tests and data cleanup). */
export async function removeHandoffFiles(dataDir: string, id: string): Promise<void> {
  await rm(join(dataDir, 'code', 'handoffs', id), { recursive: true, force: true });
}
