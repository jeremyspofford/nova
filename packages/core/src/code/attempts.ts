// Best-of-N attempts (FR-212, docs/10 §9). One task runs as N attempts (default 2, at most 4),
// each a Code session of its own in its own worktree on a `nova/<slug>` branch from the session's
// last commit, each its own agent turn with its own budget (time, tokens, cost; docs/09 §2) and,
// optionally, its own model. When an attempt's turn ends its checks run in its worktree (the
// auto-verify run if one started, else one on request), so the comparison view shows, side by
// side, what each attempt changed against the base (files, counts and the patch), its test
// results and what it cost. Applying one merges it three-way onto the session's folder
// (merge.ts: the branch may have moved meanwhile; conflicts are surfaced, never resolved
// silently); then every attempt session is archived and its worktree removed. Discarding removes
// them all. The objective is the user's words: each attempt's turn carries the user's authority.
import { relative, sep } from 'node:path';
import {
  NovaError,
  isNovaError,
  startAttemptsSchema,
  uuidv7,
  type CodeAttemptFileView,
  type CodeAttemptSetView,
  type CodeAttemptView,
  type CodeMergeView,
  type applyAttemptSchema,
} from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { z } from 'zod';
import type { SettingReader } from '../approvals/gate.ts';
import type { AuditSink } from '../tools/types.ts';
import type { MergeService } from './merge.ts';
import { commonDir, subtree, tempShadow } from './merge.ts';
import type { CodeService, CodeSessionInfo } from './service.ts';
import type { AutoVerifier } from './verify.ts';

export type StartAttemptsRequest = z.input<typeof startAttemptsSchema>;
export type ApplyAttemptRequest = z.input<typeof applyAttemptSchema>;

/** Characters of each attempt's patch the comparison carries. */
const PATCH_CHARS = 256 * 1024;

interface SetRow {
  id: string;
  accountId: string;
  sessionId: string;
  objective: string;
  baseSha: string;
  status: CodeAttemptSetView['status'];
  appliedAttemptId: string | null;
  mergeId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AttemptRow {
  id: string;
  setId: string;
  idx: number;
  sessionId: string;
  modelId: string | null;
  status: CodeAttemptView['status'];
  reply: string | null;
  createdAt: string;
  updatedAt: string;
}

const SET_COLUMNS = `id, account_id AS accountId, session_id AS sessionId, objective,
  base_sha AS baseSha, status, applied_attempt_id AS appliedAttemptId, merge_id AS mergeId,
  created_at AS createdAt, updated_at AS updatedAt`;
const ATTEMPT_COLUMNS = `id, set_id AS setId, idx, session_id AS sessionId, model_id AS modelId,
  status, reply, created_at AS createdAt, updated_at AS updatedAt`;

export interface AttemptServiceOptions {
  db: NovaDatabase;
  code: CodeService;
  merges: MergeService;
  /** Runs each attempt's checks (FR-068); without it attempts show no test results. */
  verifier?: AutoVerifier | null;
  audit: AuditSink;
  setting: SettingReader;
  now?: () => Date;
  log?: Logger;
}

export class AttemptService {
  readonly #o: AttemptServiceOptions;
  readonly #now: () => Date;
  readonly #log: Logger;
  /** Attempts whose turn (and checks) are still going. */
  readonly #tracked = new Map<string, Promise<void>>();
  #closed = false;

  constructor(opts: AttemptServiceOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.attempts', sinks: [] });
  }

  /** Start N attempts of a task from the session's last commit. */
  async start(
    accountId: string,
    sessionId: string,
    input: StartAttemptsRequest,
    actor: 'user' | 'agent' = 'user',
  ): Promise<CodeAttemptSetView> {
    const req = startAttemptsSchema.parse(input);
    const code = this.#o.code;
    const parent = code.info(accountId, sessionId);
    if (!parent.active) throw new NovaError('conflict', 'that session is archived');
    if (!parent.hubLocal)
      throw new NovaError('capability_missing', 'attempts need a folder on the Hub (worktrees)', {
        details: { reason: 'remote_environment' },
      });
    const turns = code.turns;
    if (!turns)
      throw new NovaError('conflict', 'attempts cannot start right now', {
        details: { reason: 'turns_unavailable' },
      });
    const head = await code.git.run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], {
      cwd: parent.folder,
      allowFail: true,
    });
    const base = head.code === 0 ? head.stdout.toString('utf8').trim() : '';
    if (!base)
      throw new NovaError('validation', 'attempts need a Git repository with a commit', {
        details: { reason: 'no_commits' },
      });
    const cfg = await this.#o.setting('code.attempts');
    const count = req.count ?? cfg.count;
    // Each attempt's bounds, never more than the session has left (a delegated session's agent
    // limits included).
    const budgets = code.childBudgets(accountId, parent.id, {
      timeSeconds:
        req.budgets?.timeSeconds !== undefined ? req.budgets.timeSeconds : cfg.budgets.timeSeconds,
      tokens: req.budgets?.tokens !== undefined ? req.budgets.tokens : cfg.budgets.tokens,
      costUsd: req.budgets?.costUsd !== undefined ? req.budgets.costUsd : cfg.budgets.costUsd,
    });
    const setId = uuidv7();
    const objective = req.objective;
    const short = objective.replace(/\s+/g, ' ').slice(0, 50);
    const made: CodeSessionInfo[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const model = req.models?.[i] ?? parent.modelId ?? undefined;
        const create = (mode: CodeSessionInfo['permissionMode'] | undefined) =>
          code.create(
            accountId,
            {
              folder: parent.folderPath,
              ...(parent.environmentId ? { environmentId: parent.environmentId } : {}),
              ...(parent.projectId ? { projectId: parent.projectId } : {}),
              ...(model ? { model } : {}),
              ...(mode ? { permissionMode: mode } : {}),
              title: `Attempt ${i + 1}/${count}: ${short}`,
              worktree: true,
              budgets,
            },
            { parentSessionId: parent.id, role: 'attempt', base },
          );
        let view;
        try {
          view = await create(parent.permissionMode);
        } catch (err) {
          // A mode the attempt cannot use (Auto without a reviewer) falls back to Manual.
          if (!isNovaError(err) || reasonOf(err) !== 'mode_unavailable') throw err;
          view = await create('manual');
        }
        made.push(code.info(accountId, view.id));
      }
    } catch (err) {
      for (const m of made) await this.#retire(accountId, m.id, base).catch(() => undefined);
      throw err;
    }
    const now = this.#iso();
    const rows: AttemptRow[] = made.map((m, i) => ({
      id: uuidv7(),
      setId,
      idx: i,
      sessionId: m.id,
      modelId: m.modelId,
      status: 'running',
      reply: null,
      createdAt: now,
      updatedAt: now,
    }));
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO code_attempt_set (id, account_id, session_id, objective, base_sha, status,
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(setId, accountId, parent.id, objective, base, now, now);
      for (const r of rows)
        this.#o.db.raw
          .prepare(
            `INSERT INTO code_attempt (id, set_id, idx, session_id, model_id, status, created_at,
               updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
          )
          .run(r.id, setId, r.idx, r.sessionId, r.modelId, now, now);
    });
    await this.#o.audit.append({
      accountId,
      actor,
      kind: 'code',
      action: 'code.attempts.started',
      resource: parent.folder,
      result: 'ok',
      threadId: parent.threadId,
      detail: { sessionId: parent.id, setId, count, base, budgets },
    });
    for (const [i, r] of rows.entries()) {
      const s = made[i]!;
      const started = await turns.startTurn({
        accountId,
        threadId: s.threadId,
        text: [
          `Best-of-${count} attempt ${i + 1} of ${count} for the session "${parent.title ?? parent.id}":`,
          '',
          objective,
          '',
          `You work in your own Git worktree on branch ${s.branch ?? 'a nova/ branch'}, started from the session's last commit ${base.slice(0, 12)} (its uncommitted changes are not here). Other attempts work on the same task in parallel; the user compares them and applies one. Do not commit. When you are done, reply with a short summary of your approach and what you changed.`,
        ].join('\n'),
        trigger: 'user',
        triggerRef: setId,
        // The user typed the objective for these attempts (FR-189).
        authority:
          actor === 'user'
            ? { kind: 'user', source: `code:${parent.id}:attempts` }
            : { kind: 'none', origin: 'tool' },
        authorKind: actor === 'user' ? 'user' : 'subagent',
      });
      const tracked = started.done
        .then(async (outcome) => {
          await this.#finished(accountId, r, outcome.replyText, outcome.status === 'failed');
        })
        .catch((err: unknown) =>
          this.#log.warn('an attempt did not finish', { err, attemptId: r.id }),
        )
        .finally(() => this.#tracked.delete(r.id));
      this.#tracked.set(r.id, tracked);
    }
    await this.#announce(parent, setId, 'running');
    return this.get(accountId, setId);
  }

  async list(accountId: string, sessionId: string): Promise<CodeAttemptSetView[]> {
    const s = this.#o.code.info(accountId, sessionId);
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${SET_COLUMNS} FROM code_attempt_set WHERE session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 50`,
      )
      .all(s.id) as unknown as SetRow[];
    return Promise.all(rows.map((r) => this.#view(r)));
  }

  /** The comparison view: each attempt's diff, test results and cost. */
  async get(accountId: string, setId: string): Promise<CodeAttemptSetView> {
    return this.#view(this.#set(accountId, setId));
  }

  /**
   * Apply one attempt: merged three-way onto the session's folder; then every attempt is
   * archived and its worktree removed. A refused merge (conflicts, `onConflict: refuse`) changes
   * nothing and keeps the attempts.
   */
  async apply(
    accountId: string,
    setId: string,
    input: ApplyAttemptRequest,
    actor: 'user' | 'agent' = 'user',
  ): Promise<{ set: CodeAttemptSetView; merge: CodeMergeView }> {
    const set = this.#set(accountId, setId);
    if (set.status === 'applied' || set.status === 'discarded')
      throw new NovaError('conflict', `these attempts were ${set.status}`, {
        details: { reason: 'attempts_settled' },
      });
    const attempts = this.#attempts(set.id);
    const chosen = attempts.find((a) => a.id === input.attemptId);
    if (!chosen) throw new NovaError('not_found', 'attempt not found');
    await this.#stopRunning(accountId, attempts);
    const merge = await this.#o.merges.mergeSession(
      accountId,
      set.sessionId,
      chosen.sessionId,
      input.onConflict ?? 'refuse',
      'attempt',
      actor,
    );
    for (const a of attempts)
      await this.#retire(accountId, a.sessionId, set.baseSha).catch((err: unknown) =>
        this.#log.warn('retiring an attempt failed', { err, attemptId: a.id }),
      );
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE code_attempt_set SET status = 'applied', applied_attempt_id = ?, merge_id = ?,
             updated_at = ? WHERE id = ?`,
        )
        .run(chosen.id, merge.id, now, set.id);
      this.#o.db.raw
        .prepare(
          `UPDATE code_attempt SET status = CASE WHEN id = ? THEN 'applied' ELSE 'discarded' END,
             updated_at = ? WHERE set_id = ?`,
        )
        .run(chosen.id, now, set.id);
    });
    const parent = this.#o.code.info(accountId, set.sessionId);
    await this.#o.audit.append({
      accountId,
      actor,
      kind: 'code',
      action: 'code.attempt.applied',
      resource: parent.folder,
      result: merge.status === 'applied' ? 'ok' : 'conflict',
      threadId: parent.threadId,
      detail: { sessionId: parent.id, setId, attemptId: chosen.id, mergeId: merge.id },
    });
    await this.#announce(parent, setId, 'applied', chosen.id);
    return { set: await this.get(accountId, setId), merge };
  }

  /** Discard every attempt: stopped, archived, worktrees removed. */
  async discard(
    accountId: string,
    setId: string,
    actor: 'user' | 'agent' = 'user',
  ): Promise<CodeAttemptSetView> {
    const set = this.#set(accountId, setId);
    if (set.status === 'applied' || set.status === 'discarded') return this.#view(set);
    const attempts = this.#attempts(set.id);
    await this.#stopRunning(accountId, attempts);
    for (const a of attempts)
      await this.#retire(accountId, a.sessionId, set.baseSha).catch(() => undefined);
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare("UPDATE code_attempt_set SET status = 'discarded', updated_at = ? WHERE id = ?")
        .run(now, set.id);
      this.#o.db.raw
        .prepare("UPDATE code_attempt SET status = 'discarded', updated_at = ? WHERE set_id = ?")
        .run(now, set.id);
    });
    const parent = this.#o.code.info(accountId, set.sessionId);
    await this.#o.audit.append({
      accountId,
      actor,
      kind: 'code',
      action: 'code.attempts.discarded',
      resource: parent.folder,
      result: 'ok',
      threadId: parent.threadId,
      detail: { sessionId: parent.id, setId },
    });
    await this.#announce(parent, setId, 'discarded');
    return this.get(accountId, setId);
  }

  /** Stop listening: attempts still running finish on their own (their turns belong to the loop). */
  close(): Promise<void> {
    this.#closed = true;
    this.#tracked.clear();
    return Promise.resolve();
  }

  // ---- internals -----------------------------------------------------------------------------

  /** An attempt's turn ended: keep its reply, then run its checks if nothing ran them. */
  async #finished(accountId: string, r: AttemptRow, reply: string, failed: boolean) {
    if (this.#closed) return;
    const verifier = this.#o.verifier;
    // The checks run only where the user keeps auto-verify on (FR-068); off means no checks.
    const projectId = this.#o.code.info(accountId, r.sessionId).projectId;
    const verify = (await this.#o.setting('code.autoVerify', projectId)).enabled;
    if (verifier && verify) {
      await verifier.idle(r.sessionId);
      const last = verifier.list(accountId, r.sessionId, 1)[0];
      if (!failed && (!last || last.createdAt < r.createdAt)) {
        try {
          const { done } = await verifier.run(accountId, r.sessionId);
          await done;
        } catch (err) {
          this.#log.warn('checking an attempt failed', { err, attemptId: r.id });
        }
      }
    }
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE code_attempt SET status = CASE WHEN status = 'running' THEN ? ELSE status END,
             reply = ?, updated_at = ? WHERE id = ?`,
        )
        .run(failed ? 'failed' : 'done', reply.slice(0, 4000) || null, this.#iso(), r.id);
    });
    const set = this.#o.db.raw
      .prepare(`SELECT ${SET_COLUMNS} FROM code_attempt_set WHERE id = ?`)
      .get(r.setId) as SetRow | undefined;
    if (!set || set.status !== 'running') return;
    const open = this.#attempts(set.id).some((a) => a.status === 'running');
    if (!open)
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            "UPDATE code_attempt_set SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'running'",
          )
          .run(this.#iso(), set.id);
      });
    const parent = this.#o.code.info(accountId, set.sessionId);
    await this.#announce(parent, set.id, open ? 'running' : 'ready', r.id);
  }

  async #stopRunning(accountId: string, attempts: AttemptRow[]): Promise<void> {
    const turns = this.#o.code.turns;
    for (const a of attempts) {
      const s = this.#o.code.info(accountId, a.sessionId);
      if (s.threadState === 'streaming' || this.#tracked.has(a.id))
        await turns?.cancel(accountId, s.threadId).catch(() => undefined);
    }
  }

  /** Archive an attempt's session and remove its worktree; its branch goes too when unused. */
  async #retire(accountId: string, sessionId: string, base: string): Promise<void> {
    const code = this.#o.code;
    const s = code.info(accountId, sessionId);
    await code.archive(accountId, sessionId);
    if (!s.worktreeId) return;
    const wt = code.worktrees.get(accountId, s.worktreeId);
    if (wt.status !== 'removed') await code.worktrees.remove(accountId, wt.id, true);
    const tip = await code.git.run(['rev-parse', '-q', '--verify', `refs/heads/${wt.branch}`], {
      cwd: wt.repoPath,
      allowFail: true,
    });
    if (tip.code === 0 && tip.stdout.toString('utf8').trim() === base)
      await code.git.run(['branch', '-D', '--end-of-options', wt.branch], {
        cwd: wt.repoPath,
        allowFail: true,
      });
  }

  async #view(set: SetRow): Promise<CodeAttemptSetView> {
    const code = this.#o.code;
    const attempts: CodeAttemptView[] = [];
    for (const a of this.#attempts(set.id)) {
      const s = code.info(set.accountId, a.sessionId);
      const settled = a.status === 'applied' || a.status === 'discarded';
      const running = !settled && (this.#tracked.has(a.id) || s.threadState === 'streaming');
      const status: CodeAttemptView['status'] = settled
        ? a.status
        : running
          ? 'running'
          : a.status === 'running'
            ? 'done'
            : a.status;
      const diff = settled ? null : await this.#diff(s, set.baseSha).catch(() => null);
      attempts.push({
        id: a.id,
        index: a.idx,
        sessionId: s.id,
        threadId: s.threadId,
        worktreeId: s.worktreeId,
        branch: s.branch,
        model: a.modelId,
        status,
        files: diff?.files ?? [],
        additions: diff?.files.reduce((n, f) => n + f.additions, 0) ?? 0,
        deletions: diff?.files.reduce((n, f) => n + f.deletions, 0) ?? 0,
        patch: diff?.patch ?? '',
        patchTruncated: diff?.truncated ?? false,
        tests: this.#o.verifier?.list(set.accountId, s.id, 1)[0] ?? null,
        budget: code.budget(set.accountId, s.id),
        reply: a.reply,
      });
    }
    return {
      id: set.id,
      sessionId: set.sessionId,
      objective: set.objective,
      baseSha: set.baseSha,
      status: set.status,
      attempts,
      appliedAttemptId: set.appliedAttemptId,
      mergeId: set.mergeId,
      createdAt: set.createdAt,
      updatedAt: set.updatedAt,
    };
  }

  /** What an attempt changed against the base: its commits and its uncommitted work. */
  async #diff(
    s: CodeSessionInfo,
    base: string,
  ): Promise<{ files: CodeAttemptFileView[]; patch: string; truncated: boolean }> {
    const code = this.#o.code;
    const ws = await code.workspace(s);
    const top = await ws.git.text(['rev-parse', '--show-toplevel'], { cwd: s.folder });
    const prefix = relative(top, s.folder).split(sep).filter(Boolean).join('/');
    const shadow = await tempShadow(ws, s.folder, await commonDir(ws, s.folder));
    try {
      const head = await ws.git.text(['rev-parse', 'HEAD'], { cwd: s.folder });
      const from = await subtree(shadow, base, prefix);
      await shadow.readTree(await subtree(shadow, head, prefix));
      const to = await shadow.snapshot();
      const d = await shadow.diffWithPatch(from, to);
      const text = defaultRedactor.redactString(d.patch);
      return {
        files: d.files.map((f) => ({
          path: f.path,
          kind: f.kind,
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary,
        })),
        patch: text.slice(0, PATCH_CHARS),
        truncated: text.length > PATCH_CHARS,
      };
    } finally {
      await shadow.remove().catch(() => undefined);
    }
  }

  #set(accountId: string, setId: string): SetRow {
    const r = this.#o.db.raw
      .prepare(`SELECT ${SET_COLUMNS} FROM code_attempt_set WHERE id = ? AND account_id = ?`)
      .get(setId, accountId) as SetRow | undefined;
    if (!r) throw new NovaError('not_found', 'attempts not found');
    return r;
  }

  #attempts(setId: string): AttemptRow[] {
    return this.#o.db.raw
      .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM code_attempt WHERE set_id = ? ORDER BY idx`)
      .all(setId) as unknown as AttemptRow[];
  }

  async #announce(
    parent: CodeSessionInfo,
    setId: string,
    status: CodeAttemptSetView['status'],
    attemptId?: string,
  ): Promise<void> {
    await this.#o.code.announce(parent, 'code.attempts.updated', {
      sessionId: parent.id,
      setId,
      status,
      ...(attemptId ? { attemptId } : {}),
    });
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

function reasonOf(err: NovaError): unknown {
  return (err.details as { reason?: unknown } | undefined)?.reason;
}
