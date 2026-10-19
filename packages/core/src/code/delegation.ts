// Delegation from an agent to a Code session (docs/09 §4, docs/10 §10; M7). An agent's tool
// `code.delegate` starts a Code session in one of the account's projects (its first folder, or a
// folder inside one the agent names) and reports back: when the session's turn ends, its result
// returns to the agent's main thread as a turn without authority (the session's words are data,
// FR-189). The session runs under the agent's rules: `delegatedRules` gives the gate the agent's
// rules, scoped to the session's thread, so whatever the agent may not do in its own threads it
// may not do there either. The session itself is never broader than the agent: Manual (or Plan)
// mode, the agent's budgets, no user authority. Proactive research threads only read, and a thread
// shared with other people never starts work on the owner's files.
import { isWithin } from '@nova/security';
import { NovaError, uuidv7, type CodeDelegationView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { SettingReader } from '../approvals/gate.ts';
import type { CommandRule, PolicyRule } from '@nova/policy';
import type { ToolLimitSource } from '../approvals/limits.ts';
import type { AgentRuleSource } from '../runtime/types.ts';
import { argsOf, builtinDescriptor, fail, ok, str, type BuiltinTool } from '../tools/builtin.ts';
import type { AuditSink } from '../tools/types.ts';
import type { CodeService } from './service.ts';

/** The agents area, as delegation needs it (late-bound; the Hub wires it). */
export interface CodeAgentHost {
  /** The agent that owns a thread, with the thread's kind and audience; null for others. */
  agentOf(
    accountId: string,
    threadId: string,
  ): Promise<{ agentId: string; kind: string; audience: string } | null>;
  /** The agent's main thread, where results return. */
  mainThread(accountId: string, agentId: string): Promise<string>;
  /** The agent's budgets for work it starts (docs/09 §2); none when it has none. */
  budgets?(
    accountId: string,
    agentId: string,
  ): Promise<{ timeSeconds: number | null; tokens: number | null; costUsd: number | null }>;
  /** Whether the agent exists and is not paused (survives a restart; events cover the rest). */
  isActive?(accountId: string, agentId: string): Promise<boolean>;
}

export interface CodeDelegateInput {
  projectId: string;
  objective: string;
  /** A folder inside one of the project's folders (default: its first folder). */
  folder?: string | undefined;
  title?: string | undefined;
  /** `plan` only reads; never broader than Manual. */
  mode?: 'manual' | 'plan' | undefined;
}

interface DelegationRow {
  id: string;
  accountId: string;
  agentId: string;
  agentThreadId: string;
  sessionId: string;
  threadId: string;
  status: CodeDelegationView['status'];
  createdAt: string;
  completedAt: string | null;
}

const COLUMNS = `id, account_id AS accountId, agent_id AS agentId,
  agent_thread_id AS agentThreadId, session_id AS sessionId, thread_id AS threadId, status,
  created_at AS createdAt, completed_at AS completedAt`;

/**
 * Tools that work only on the Hub's disk by the thread's roots and are not routed to another
 * machine: hidden in SSH, WSL and device sessions (M7).
 */
export const HUB_ONLY_FILE_TOOLS = ['fs.search', 'document.read', 'document.create'] as const;

/** Characters of the session's reply that return to the agent. */
const REPLY_CHARS = 4_000;

export interface CodeDelegationsOptions {
  db: NovaDatabase;
  code: CodeService;
  audit: AuditSink;
  setting: SettingReader;
  now?: () => Date;
  log?: Logger;
}

export class CodeDelegations {
  readonly #o: CodeDelegationsOptions;
  readonly #now: () => Date;
  readonly #log: Logger;
  #host: CodeAgentHost | null = null;
  readonly #pending = new Set<Promise<unknown>>();
  /** Agents paused or stopped (from the agents area's events): their delegated work is held. */
  readonly #pausedAgents = new Set<string>();
  #closed = false;

  constructor(opts: CodeDelegationsOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.delegation', sinks: [] });
  }

  /** The agents area (late-bound). */
  useAgents(host: CodeAgentHost): void {
    this.#host = host;
  }

  /** Start a Code session for an agent's thread and report its result back to the agent. */
  async delegate(
    accountId: string,
    agentThreadId: string,
    input: CodeDelegateInput,
  ): Promise<CodeDelegationView> {
    const host = this.#host;
    if (!host)
      throw new NovaError('capability_missing', 'agents cannot start Code sessions on this Hub', {
        details: { reason: 'no_agents' },
      });
    const link = await host.agentOf(accountId, agentThreadId);
    if (!link)
      throw new NovaError('not_found', 'code.delegate works only in an agent thread', {
        details: { reason: 'not_an_agent_thread' },
      });
    if (link.kind === 'proactive')
      throw new NovaError('policy_denied', 'proactive research only reads', {
        details: { reason: 'proactive_read_only' },
      });
    if (link.audience !== 'private')
      throw new NovaError(
        'policy_denied',
        "a shared thread cannot start work on the owner's files",
        {
          details: { reason: 'shared_thread' },
        },
      );
    const code = this.#o.code;
    const turns = code.turns;
    if (!turns)
      throw new NovaError('conflict', 'Code sessions cannot start right now', {
        details: { reason: 'turns_unavailable' },
      });
    const folder = await this.#folder(accountId, input.projectId, input.folder);
    const budgets =
      (await host.budgets?.(accountId, link.agentId)) ?? (await this.#o.setting('code.budgets'));
    const objective = input.objective.trim();
    const view = await code.create(
      accountId,
      {
        folder,
        projectId: input.projectId,
        permissionMode: input.mode === 'plan' ? 'plan' : 'manual',
        title: (input.title?.trim() || objective.split('\n')[0] || 'Delegated work').slice(0, 200),
        budgets: {
          timeSeconds: budgets.timeSeconds !== null ? Math.max(60, budgets.timeSeconds) : null,
          tokens: budgets.tokens !== null ? Math.max(1_000, budgets.tokens) : null,
          costUsd: budgets.costUsd !== null ? Math.max(0.01, budgets.costUsd) : null,
        },
      },
      // The agent's choice of mode is not the user's choice for the folder.
      { role: `agent:${link.agentId}`, remember: false },
    );
    const s = code.info(accountId, view.id);
    const row: DelegationRow = {
      id: uuidv7(),
      accountId,
      agentId: link.agentId,
      agentThreadId,
      sessionId: s.id,
      threadId: s.threadId,
      status: 'running',
      createdAt: this.#iso(),
      completedAt: null,
    };
    // Recorded before the first turn, so the gate applies the agent's rules from its first call.
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO code_delegation (id, account_id, agent_id, agent_thread_id, session_id,
             thread_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
        )
        .run(row.id, accountId, row.agentId, agentThreadId, s.id, s.threadId, row.createdAt);
    });
    await this.#o.audit.append({
      accountId,
      actor: `agent:${link.agentId}`,
      kind: 'code',
      action: 'code.delegate',
      resource: s.folder,
      result: 'ok',
      threadId: agentThreadId,
      detail: {
        delegationId: row.id,
        sessionId: s.id,
        projectId: input.projectId,
        mode: s.permissionMode,
      },
    });
    await code.announce(s, 'code.delegation.started', {
      delegationId: row.id,
      agentId: row.agentId,
      sessionId: s.id,
      threadId: s.threadId,
    });
    const started = await turns.startTurn({
      accountId,
      threadId: s.threadId,
      text: [
        `Task from the agent ${link.agentId} (delegated from its thread):`,
        '',
        objective,
        '',
        'When you are done, reply with a short summary of what you did and what is left; it goes back to the agent.',
      ].join('\n'),
      trigger: 'event',
      triggerRef: `agent:${link.agentId}`,
      // The agent wrote the task: no user authority (FR-189).
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'subagent',
    });
    const report = started.done
      .then((o) => this.#report(row, o.status === 'failed' ? 'failed' : 'done', o.replyText))
      .catch((err: unknown) => this.#log.warn('a delegated session did not report', { err }));
    this.#pending.add(report);
    void report.finally(() => this.#pending.delete(report));
    return viewOf(row);
  }

  /** The delegations an agent started (newest first). */
  list(accountId: string, agentId: string): CodeDelegationView[] {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${COLUMNS} FROM code_delegation WHERE account_id = ? AND agent_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 100`,
      )
      .all(accountId, agentId) as unknown as DelegationRow[];
    return rows.map(viewOf);
  }

  /**
   * The gate's agent rules with delegated sessions included: a thread an agent owns gets its own
   * rules (as before); a Code session an agent started gets that agent's rules, scoped to the
   * session's thread. A delegation whose rules cannot be read fails closed (the gate denies).
   */
  delegatedRules(inner: AgentRuleSource): AgentRuleSource {
    return {
      forThread: async (accountId, threadId) => {
        const found = await this.#rulesFor(inner, accountId, threadId);
        // M7: a session on another machine (SSH, WSL, a device) has no Hub files: the tools that
        // only read or write the Hub's disk are hidden there (the fs.* tools it keeps reach the
        // remote folder through its transport; fs-remote.ts).
        if (!this.#o.code.remoteHelperThread(accountId, threadId)) return found;
        const rule: PolicyRule = {
          id: `remote-hub-files:${threadId}`,
          label: "A session on another machine: these tools would act on the Hub's disk",
          priority: 0,
          scope: { kind: 'session', ref: threadId },
          match: { tool: [...HUB_ONLY_FILE_TOOLS] },
          effect: 'deny',
        };
        return {
          rules: [...(found?.rules ?? []), rule],
          commandRules: found?.commandRules ?? [],
        };
      },
    };
  }

  async #rulesFor(
    inner: AgentRuleSource,
    accountId: string,
    threadId: string,
  ): Promise<{ rules: PolicyRule[]; commandRules: CommandRule[] } | null> {
    const own = await inner.forThread(accountId, threadId);
    if (own) return own;
    // The session's own delegation, or that of the session its worker or attempt came from.
    const d = this.#delegationOf(accountId, threadId);
    if (!d) return null;
    const scope = { kind: 'thread' as const, ref: threadId };
    const theirs = await inner.forThread(accountId, d.agentThreadId);
    // The agent is gone: nothing it started may act any more (fail closed).
    if (!theirs)
      return {
        rules: [denyAll(d, scope, 'the agent that started this work is gone')],
        commandRules: [],
      };
    const rules: PolicyRule[] = theirs.rules.map((r) => ({
      ...r,
      id: `${r.id}@${threadId}`,
      scope,
    }));
    // A paused agent's work is held: its sessions take no action until it resumes.
    if (await this.#paused(accountId, d.agentId))
      rules.push(denyAll(d, scope, 'the agent that started this work is paused'));
    return { rules, commandRules: theirs.commandRules.map((r) => ({ ...r, scope })) };
  }

  /**
   * The gate's tool limits for delegated work: the agent's connected plugins (FR-045) apply in
   * the sessions it started and in their workers and attempts. Wire it next to the agents'
   * own: `gate.useToolLimits(code.delegatedToolLimits(agents.service.toolLimits))`.
   */
  delegatedToolLimits(inner: ToolLimitSource): ToolLimitSource {
    return {
      forThread: async (accountId, threadId) => {
        const d = this.#delegationOf(accountId, threadId);
        return d ? inner.forThread(accountId, d.agentThreadId) : null;
      },
    };
  }

  /**
   * The agent was paused (or stopped), resumed or deleted: its delegated work (the sessions and
   * everything they started) is held, released or cancelled. The running turns stop at once;
   * while paused the gate denies their actions (`delegatedRules`); a deleted agent's sessions are
   * archived and its delegations end as failed.
   */
  async agentChanged(
    accountId: string,
    agentId: string,
    change: 'paused' | 'active' | 'deleted',
  ): Promise<void> {
    if (change === 'active') {
      this.#pausedAgents.delete(agentId);
      return;
    }
    if (change === 'paused') this.#pausedAgents.add(agentId);
    else this.#pausedAgents.delete(agentId);
    const code = this.#o.code;
    const turns = code.turns;
    const rows = this.#o.db.raw
      .prepare(`SELECT ${COLUMNS} FROM code_delegation WHERE account_id = ? AND agent_id = ?`)
      .all(accountId, agentId) as unknown as DelegationRow[];
    for (const d of rows) {
      // A delegation that reported back still has its session (and workers) to hold.
      let touched = false;
      for (const sessionId of this.#tree(accountId, d.sessionId)) {
        let s;
        try {
          s = code.info(accountId, sessionId);
        } catch {
          continue;
        }
        if (!s.active) continue;
        touched = true;
        if (s.threadState !== 'idle' && s.threadState !== 'error')
          await turns?.cancel(accountId, s.threadId).catch(() => undefined);
        if (change === 'deleted' && s.active)
          await code
            .archive(accountId, sessionId)
            .catch((err: unknown) =>
              this.#log.warn('archiving delegated work failed', { err, sessionId }),
            );
      }
      if (!touched && d.status !== 'running') continue;
      if (change === 'deleted')
        await this.#o.db.transaction(() => {
          this.#o.db.raw
            .prepare(
              "UPDATE code_delegation SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'running'",
            )
            .run(this.#iso(), d.id);
        });
      await this.#o.audit.append({
        accountId,
        actor: 'system',
        kind: 'code',
        action: change === 'deleted' ? 'code.delegation.cancelled' : 'code.delegation.held',
        resource: d.sessionId,
        result: 'ok',
        threadId: d.threadId,
        detail: { delegationId: d.id, agentId, sessionId: d.sessionId },
      });
    }
  }

  /** The `code.delegate` tool (offered in agent threads). */
  tool(): BuiltinTool {
    return {
      descriptor: builtinDescriptor({
        name: 'code.delegate',
        title: 'Start a Code session',
        description:
          "Start a Code session in one of the user's projects for a coding task, under your rules and budgets, in Manual mode (or Plan to only read). It runs on its own; its result comes back to you here when its turn ends.",
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', minLength: 1, maxLength: 100 },
            objective: { type: 'string', minLength: 1, maxLength: 8000 },
            folder: { type: 'string', minLength: 1, maxLength: 1000 },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            mode: { type: 'string', enum: ['manual', 'plan'] },
          },
          required: ['projectId', 'objective'],
          additionalProperties: false,
        },
        annotations: { action: 'execute' },
      }),
      origin: null,
      handler: async (args, ctx) => {
        const a = argsOf(args);
        try {
          const mode = str(a.mode);
          const d = await this.delegate(ctx.accountId, ctx.threadId, {
            projectId: str(a.projectId) ?? '',
            objective: str(a.objective) ?? '',
            folder: str(a.folder),
            title: str(a.title),
            mode: mode === 'plan' ? 'plan' : 'manual',
          });
          return ok(
            `Code session ${d.sessionId} started; its result comes back to you when its turn ends.`,
            { delegationId: d.id, sessionId: d.sessionId },
          );
        } catch (err) {
          if (err instanceof NovaError) {
            const reason = (err.details as { reason?: unknown } | undefined)?.reason;
            return fail(typeof reason === 'string' ? reason : err.code, err.message);
          }
          throw err;
        }
      },
    };
  }

  /** Stop reporting: sessions still running finish on their own. */
  close(): Promise<void> {
    this.#closed = true;
    this.#pending.clear();
    return Promise.resolve();
  }

  // ---- internals -----------------------------------------------------------------------------

  /** The delegation a thread's work belongs to: its session's, or an ancestor session's. */
  #delegationOf(accountId: string, threadId: string): DelegationRow | null {
    const s = this.#o.db.raw
      .prepare('SELECT id FROM code_session WHERE thread_id = ? AND account_id = ?')
      .get(threadId, accountId) as { id: string } | undefined;
    let sessionId: string | null = s?.id ?? null;
    for (let depth = 0; sessionId && depth < 8; depth++) {
      const d = this.#o.db.raw
        .prepare(`SELECT ${COLUMNS} FROM code_delegation WHERE session_id = ? AND account_id = ?`)
        .get(sessionId, accountId) as DelegationRow | undefined;
      if (d) return d;
      sessionId = this.#o.code.lineage(sessionId).parentSessionId;
    }
    return null;
  }

  /** A session and every session it started (workers, attempts), depth first. */
  #tree(accountId: string, sessionId: string): string[] {
    const out: string[] = [];
    const visit = (id: string, depth: number) => {
      if (depth > 8 || out.includes(id)) return;
      out.push(id);
      for (const w of this.#o.code.workers(accountId, id)) visit(w.id, depth + 1);
    };
    visit(sessionId, 0);
    return out;
  }

  async #paused(accountId: string, agentId: string): Promise<boolean> {
    if (this.#pausedAgents.has(agentId)) return true;
    const host = this.#host;
    if (!host?.isActive) return false;
    try {
      return !(await host.isActive(accountId, agentId));
    } catch {
      // Unknown: held (fail closed).
      return true;
    }
  }

  async #folder(accountId: string, projectId: string, wanted: string | undefined): Promise<string> {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT f.path FROM project_folder f JOIN project p ON p.id = f.project_id
         WHERE p.id = ? AND p.account_id = ? AND p.deleted_at IS NULL ORDER BY f.created_at, f.id`,
      )
      .all(projectId, accountId) as { path: string }[];
    const exists = this.#o.db.raw
      .prepare('SELECT 1 FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .get(projectId, accountId);
    if (!exists) throw new NovaError('not_found', 'project not found');
    if (!rows.length)
      throw new NovaError('validation', 'the project has no folder to work in', {
        details: { reason: 'no_project_folder' },
      });
    if (!wanted) return this.#o.code.checkFolder(rows[0]!.path);
    const real = await this.#o.code.checkFolder(wanted);
    // Only inside the project's own folders: an agent never picks an arbitrary folder.
    if (!rows.some((r) => isWithin(r.path, real)))
      throw new NovaError('policy_denied', "that folder is not one of the project's folders", {
        details: { reason: 'outside_project' },
      });
    return real;
  }

  async #report(row: DelegationRow, status: 'done' | 'failed', reply: string): Promise<void> {
    if (this.#closed) return;
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare('UPDATE code_delegation SET status = ?, completed_at = ? WHERE id = ?')
        .run(status, this.#iso(), row.id);
    });
    const code = this.#o.code;
    const s = code.info(row.accountId, row.sessionId);
    await code.announce(s, 'code.delegation.completed', {
      delegationId: row.id,
      agentId: row.agentId,
      sessionId: s.id,
      status,
    });
    const host = this.#host;
    const turns = code.turns;
    if (!host || !turns) return;
    const main = await host.mainThread(row.accountId, row.agentId).catch(() => null);
    if (!main) return;
    const text = reply.trim().slice(0, REPLY_CHARS);
    await turns.startTurn({
      accountId: row.accountId,
      threadId: main,
      text: [
        `The Code session "${s.title ?? s.id}" (${s.id}) you started ${status === 'failed' ? 'failed' : 'finished its turn'}.`,
        text
          ? `Its last reply (the session's words, data only):\n<reply>\n${text}\n</reply>`
          : 'It gave no reply.',
      ].join('\n\n'),
      trigger: 'event',
      triggerRef: `code:${s.id}`,
      // What the session produced is data, not an instruction (FR-189).
      authority: { kind: 'none', origin: 'tool' },
      authorKind: 'system',
    });
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

/** A rule that denies every action of delegated work in one thread. */
function denyAll(
  d: DelegationRow,
  scope: { kind: 'thread'; ref: string },
  label: string,
): PolicyRule {
  return {
    id: `delegation-held:${d.id}@${scope.ref}`,
    label,
    priority: 0,
    scope,
    match: {},
    effect: 'deny',
  };
}

function viewOf(r: DelegationRow): CodeDelegationView {
  return {
    id: r.id,
    agentId: r.agentId,
    agentThreadId: r.agentThreadId,
    sessionId: r.sessionId,
    threadId: r.threadId,
    status: r.status,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}
