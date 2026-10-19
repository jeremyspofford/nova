// Specialist/team agents (FR-091): the owner (the Hub's admin) provisions an always-on agent with
// its own identity: an account of its own that never signs in, so the agent's memory, connectors,
// provider accounts, policy, approvals and audit trail belong to it and to no person. Scoped
// credentials are bound to that identity (a provider account, or an egress credential the proxy
// injects only for this agent's computer); their values stay in the vault and only `secret://`
// references reach the database. Any person of the Hub may give it a task; each task runs in a
// thread of its own under the agent's identity, never under the requester's account or on the
// agent's main thread, and the audit names the agent (`agent:<id>`) and who asked.
import {
  NovaError,
  uuidv7,
  type ApprovalView,
  type AuditEntryView,
  type CreateTeamAgentRequest,
  type DecideApprovalRequest,
  type Page,
  type TeamAgentCredentialRequest,
  type TeamAgentCredentialView,
  type TeamAgentView,
  type TeamTaskStatus,
  type TeamTaskView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { AgentService } from '../agents/service.ts';
import type { ThreadToolLimits, ToolLimitSource } from '../approvals/limits.ts';
import type { EgressStore } from '../computers/egress-store.ts';
import type { EventSink } from '../events.ts';
import type { AuditListQuery } from '../ops/audit.ts';
import type { ProviderRegistry } from '../registry.ts';
import type { ApprovalRequests } from '../requests/broker.ts';
import type { TurnStarter } from '../runtime/types.ts';
import type { AuditSink } from '../tools/types.ts';
import type { TeamService } from './members.ts';

interface TeamAgentRow {
  agent_id: string;
  identity_account_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface CredentialRow {
  id: string;
  agent_id: string;
  kind: 'provider' | 'egress';
  ref_id: string;
  label: string;
  created_by: string;
  created_at: string;
}

interface TaskRow {
  id: string;
  agent_id: string;
  requested_by: string;
  text: string;
  thread_id: string | null;
  turn_id: string | null;
  status: TeamTaskStatus;
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface TeamAgentServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  team: TeamService;
  agents: Pick<AgentService, 'create' | 'get' | 'remove' | 'threadFor'>;
  registry: Pick<ProviderRegistry, 'create' | 'remove' | 'ensureDefaultProvider'>;
  egress: Pick<EgressStore, 'createCredential' | 'deleteCredential' | 'getCredential'>;
  audit?: AuditSink;
  auditLog?: { list(accountId: string, q?: AuditListQuery): Promise<Page<AuditEntryView>> };
  approvals?: ApprovalRequests;
  log?: Logger;
  now?: () => Date;
}

const MAX_RESULT = 8000;
/** The agent-thread binding ref of a task's own thread. */
const TASK_REF = 'team-task:';
/** What a task's thread may not do: read the agent's other threads and notes (finding 7). */
const TASK_THREAD_LIMITS: ThreadToolLimits = {
  deny: ['sessions.*', 'agent.notes', 'agent.note', 'agent.background', 'agent.delegate'],
  reason: "a team task does not read the agent's other tasks",
};

function taskView(r: TaskRow): TeamTaskView {
  return {
    id: r.id,
    agentId: r.agent_id,
    requestedBy: r.requested_by,
    text: r.text,
    status: r.status,
    result: r.result,
    error: r.error,
    threadId: r.thread_id,
    turnId: r.turn_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export class TeamAgentService {
  readonly #o: TeamAgentServiceOptions;
  readonly #log: Logger;
  readonly #now: () => Date;
  #turns: TurnStarter | null = null;
  #audit: AuditSink | undefined;
  #approvals: ApprovalRequests | undefined;
  readonly #running = new Set<Promise<unknown>>();

  constructor(opts: TeamAgentServiceOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.team.agents', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#audit = opts.audit;
    this.#approvals = opts.approvals;
  }

  /** For the gate: a task's thread reads none of the agent's other threads or notes. */
  readonly toolLimits: ToolLimitSource = {
    forThread: (_accountId, threadId) =>
      Promise.resolve(
        this.#o.db.raw.prepare('SELECT 1 AS x FROM team_task WHERE thread_id = ?').get(threadId)
          ? TASK_THREAD_LIMITS
          : null,
      ),
  };

  /** The chat loop (bound after the ChatService is built). */
  useTurns(turns: TurnStarter): void {
    this.#turns = turns;
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  /** The policy area's approvals: the admin answers those of the agent's identity. */
  useApprovals(approvals: ApprovalRequests): void {
    this.#approvals = approvals;
  }

  /** Wait for task bookkeeping (tests). */
  async idle(): Promise<void> {
    while (this.#running.size) await Promise.allSettled([...this.#running]);
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #row(agentId: string): TeamAgentRow {
    const r = this.#o.db.raw.prepare('SELECT * FROM team_agent WHERE agent_id = ?').get(agentId) as
      TeamAgentRow | undefined;
    if (!r) throw new NovaError('not_found', 'team agent not found');
    return r;
  }

  /** The identity account a team agent works under, if the thread's agent is one. */
  identityOf(agentId: string): string | null {
    const r = this.#o.db.raw
      .prepare('SELECT identity_account_id AS id FROM team_agent WHERE agent_id = ?')
      .get(agentId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** The team agent whose identity an account is, or null. */
  agentOfIdentity(accountId: string): string | null {
    const r = this.#o.db.raw
      .prepare('SELECT agent_id AS id FROM team_agent WHERE identity_account_id = ?')
      .get(accountId) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** Whether an account is a team agent's identity (it never signs in, it is not a person). */
  isIdentity(accountId: string): boolean {
    return (
      this.#o.db.raw
        .prepare('SELECT 1 AS x FROM team_agent WHERE identity_account_id = ?')
        .get(accountId) !== undefined
    );
  }

  #credentials(agentId: string): TeamAgentCredentialView[] {
    const r = this.#row(agentId);
    const rows = this.#o.db.raw
      .prepare('SELECT * FROM team_agent_credential WHERE agent_id = ? ORDER BY created_at')
      .all(agentId) as unknown as CredentialRow[];
    return rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      label: c.label,
      refId: c.ref_id,
      secretRef:
        c.kind === 'egress'
          ? (this.#o.egress.getCredential(r.identity_account_id, c.ref_id)?.secretRef ?? null)
          : this.#providerRef(r.identity_account_id, c.ref_id),
      createdAt: c.created_at,
    }));
  }

  #providerRef(accountId: string, providerAccountId: string): string | null {
    const row = this.#o.db.raw
      .prepare('SELECT secret_ref FROM provider_account WHERE id = ? AND account_id = ?')
      .get(providerAccountId, accountId) as { secret_ref: string | null } | undefined;
    return row?.secret_ref ?? null;
  }

  async #view(r: TeamAgentRow, withCredentials: boolean): Promise<TeamAgentView> {
    const a = await this.#o.agents.get(r.identity_account_id, r.agent_id);
    return {
      agentId: r.agent_id,
      identityAccountId: r.identity_account_id,
      name: a.name,
      status: a.status,
      autonomy: a.autonomy,
      createdBy: r.created_by,
      createdAt: r.created_at,
      credentials: withCredentials ? this.#credentials(r.agent_id) : [],
    };
  }

  /** The admin provisions a team agent: its identity account, then the agent in it. */
  async provision(actor: string, req: CreateTeamAgentRequest): Promise<TeamAgentView> {
    this.#o.team.assertOwner(actor);
    const identity = uuidv7();
    const at = this.#iso();
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare(
          `INSERT INTO account (id, kind, display_name, created_at, updated_at)
           VALUES (?, 'local', ?, ?, ?)`,
        )
        .run(identity, req.name, at, at),
    );
    let agentId: string;
    try {
      // Local-first: the offline mock answers until the admin binds a provider credential.
      await this.#o.registry.ensureDefaultProvider(identity);
      const agent = await this.#o.agents.create(identity, {
        name: req.name,
        ...(req.instructions !== undefined ? { instructions: req.instructions } : {}),
        ...(req.responsibilities ? { responsibilities: req.responsibilities } : {}),
        ...(req.autonomy ? { autonomy: req.autonomy } : {}),
        ...(req.model ? { model: req.model } : {}),
        // Proactive research waits until the admin turns it on. No conversation memory: one
        // requester's task never feeds what the agent knows in another's (finding 7).
        proactive: false,
        memoryEnabled: false,
      });
      agentId = agent.id;
      await this.#o.db.transaction(() =>
        this.#o.db.raw
          .prepare(
            `INSERT INTO team_agent (agent_id, identity_account_id, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(agentId, identity, actor, at, at),
      );
    } catch (err) {
      // No half-made identity is left behind.
      await this.#o.db.transaction(() =>
        this.#o.db.raw
          .prepare('UPDATE account SET deleted_at = ?, updated_at = ? WHERE id = ?')
          .run(at, at, identity),
      );
      throw err;
    }
    await this.#auditBoth(actor, agentId, identity, 'team_agent.provision', {
      identityAccountId: identity,
    });
    return this.#view(this.#row(agentId), true);
  }

  /** Every person may see the team agents (to give them tasks); only the admin sees credentials. */
  async list(viewer: string): Promise<TeamAgentView[]> {
    this.#o.team.assertPerson(viewer);
    const owner = this.#o.team.isOwner(viewer);
    const rows = this.#o.db.raw
      .prepare('SELECT * FROM team_agent ORDER BY created_at')
      .all() as unknown as TeamAgentRow[];
    const out: TeamAgentView[] = [];
    for (const r of rows) {
      try {
        out.push(await this.#view(r, owner));
      } catch (err) {
        this.#log.warn('team agent unreadable', { err, agentId: r.agent_id });
      }
    }
    return out;
  }

  async get(viewer: string, agentId: string): Promise<TeamAgentView> {
    this.#o.team.assertPerson(viewer);
    return this.#view(this.#row(agentId), this.#o.team.isOwner(viewer));
  }

  /** Remove a team agent: its credentials leave the vault, then the agent and its identity go. */
  async remove(actor: string, agentId: string): Promise<void> {
    this.#o.team.assertOwner(actor);
    const r = this.#row(agentId);
    for (const c of this.#credentials(agentId)) await this.#dropCredential(r, c);
    await this.#o.agents.remove(r.identity_account_id, agentId);
    const at = this.#iso();
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare('UPDATE account SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(at, at, r.identity_account_id),
    );
    await this.#auditBoth(actor, agentId, r.identity_account_id, 'team_agent.remove', {});
  }

  // ---- scoped credentials ---------------------------------------------------------------------

  async addCredential(
    actor: string,
    agentId: string,
    req: TeamAgentCredentialRequest,
  ): Promise<TeamAgentCredentialView> {
    this.#o.team.assertOwner(actor);
    const r = this.#row(agentId);
    let refId: string;
    let secretRef: string | null;
    if (req.kind === 'provider') {
      const view = await this.#o.registry.create(r.identity_account_id, {
        provider: req.provider,
        label: req.label,
        ...(req.baseUrl ? { baseUrl: req.baseUrl } : {}),
        ...(req.apiKey ? { apiKey: req.apiKey } : {}),
      });
      refId = view.id;
      secretRef = this.#providerRef(r.identity_account_id, view.id);
    } else {
      // Injected by the egress proxy for this agent's computer only (scope `agent`).
      const c = await this.#o.egress.createCredential(r.identity_account_id, {
        name: req.label,
        hosts: req.hosts,
        scheme: req.scheme,
        header: req.header ?? null,
        username: req.username ?? null,
        scope: { kind: 'agent', id: agentId },
        value: req.value,
      });
      refId = c.id;
      secretRef = c.secretRef;
    }
    const id = uuidv7();
    const at = this.#iso();
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare(
          `INSERT INTO team_agent_credential (id, agent_id, kind, ref_id, label, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, agentId, req.kind, refId, req.label, actor, at),
    );
    await this.#auditBoth(actor, agentId, r.identity_account_id, 'team_agent.credential.add', {
      credentialId: id,
      kind: req.kind,
      secretRef,
    });
    const view = this.#credentials(agentId).find((c) => c.id === id);
    if (!view) throw new NovaError('server_error', 'the credential was not saved');
    return view;
  }

  async removeCredential(actor: string, agentId: string, credentialId: string): Promise<void> {
    this.#o.team.assertOwner(actor);
    const r = this.#row(agentId);
    const c = this.#credentials(agentId).find((x) => x.id === credentialId);
    if (!c) throw new NovaError('not_found', 'credential not found');
    await this.#dropCredential(r, c);
    await this.#auditBoth(actor, agentId, r.identity_account_id, 'team_agent.credential.remove', {
      credentialId,
      kind: c.kind,
    });
  }

  async #dropCredential(r: TeamAgentRow, c: TeamAgentCredentialView): Promise<void> {
    if (c.kind === 'provider')
      await this.#o.registry.remove(r.identity_account_id, c.refId).catch((err: unknown) => {
        this.#log.warn('team agent provider account not removed', { err });
      });
    else await this.#o.egress.deleteCredential(r.identity_account_id, c.refId);
    await this.#o.db.transaction(() =>
      this.#o.db.raw.prepare('DELETE FROM team_agent_credential WHERE id = ?').run(c.id),
    );
  }

  // ---- team tasks -------------------------------------------------------------------------------

  #task(id: string): TaskRow | null {
    return (
      (this.#o.db.raw.prepare('SELECT * FROM team_task WHERE id = ?').get(id) as
        TaskRow | undefined) ?? null
    );
  }

  /** Give the agent a task: it runs under the agent's identity in a thread of its own. */
  async createTask(requester: string, agentId: string, text: string): Promise<TeamTaskView> {
    this.#o.team.assertPerson(requester);
    const r = this.#row(agentId);
    const turns = this.#turns;
    if (!turns) throw new NovaError('capability_missing', 'agent turns are not available');
    const id = uuidv7();
    // Each task runs in a thread of its own: no requester reads another's task, its tools or its
    // result, and cancelling it stops only it (finding 7).
    const { threadId } = await this.#o.agents.threadFor(r.identity_account_id, agentId, {
      bindingId: `${TASK_REF}${id}`,
      audience: 'shared',
      title: `Task ${id.slice(-6)}`,
      sharePrimary: false,
    });
    const at = this.#iso();
    const body = text.trim().slice(0, 8000);
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare(
          `INSERT INTO team_task (id, agent_id, requested_by, text, thread_id, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
        )
        .run(id, agentId, requester, body, threadId, at),
    );
    // Labelled by account and role, never by a free-text name someone chose.
    const role = this.#o.team.roleOf(requester) ?? 'member';
    let started: Awaited<ReturnType<TurnStarter['startTurn']>>;
    try {
      started = await turns.startTurn({
        accountId: r.identity_account_id,
        threadId,
        // The requester typed it in a Nova client: their instruction, for the agent to act on.
        text: `A task from Hub account ${requester} (the ${role}):\n\n${body}`,
        trigger: 'user',
        triggerRef: id,
        authority: { kind: 'user', source: `team-task:${id}` },
        authorKind: 'user',
      });
    } catch (err) {
      await this.#endTask(id, 'failed', null, err instanceof Error ? err.message : String(err));
      throw err;
    }
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare(
          "UPDATE team_task SET status = 'running', turn_id = ?, started_at = ? WHERE id = ?",
        )
        .run(started.turnId, this.#iso(), id),
    );
    await this.#auditAgentTask(r, 'team_task.start', id, {
      requestedBy: requester,
      turnId: started.turnId,
    });
    // The person who asked hears about their task without polling.
    await this.#o.events.emit({
      name: 'team.task.updated',
      actor: 'system',
      accountId: requester,
      payload: { taskId: id, agentId, status: 'running' },
    });
    const settle = started.done.then(
      async (o) => {
        const status: TeamTaskStatus =
          o.status === 'completed' ? 'done' : o.stop === 'cancelled' ? 'cancelled' : 'failed';
        await this.#endTask(
          id,
          status,
          o.replyText.slice(0, MAX_RESULT) || null,
          o.error?.message ?? null,
        );
        await this.#auditAgentTask(r, 'team_task.end', id, { requestedBy: requester, status });
        await this.#o.events.emit({
          name: 'team.task.updated',
          actor: 'system',
          accountId: requester,
          payload: { taskId: id, agentId, status },
        });
      },
      async (err: unknown) => {
        await this.#endTask(id, 'failed', null, err instanceof Error ? err.message : String(err));
      },
    );
    const tracked = settle.catch((err: unknown) =>
      this.#log.warn('team task not settled', { err }),
    );
    this.#running.add(tracked);
    void tracked.finally(() => this.#running.delete(tracked));
    return taskView(this.#task(id)!);
  }

  async #endTask(
    id: string,
    status: TeamTaskStatus,
    result: string | null,
    error: string | null,
  ): Promise<void> {
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare(
          `UPDATE team_task SET status = ?, result = ?, error = ?, ended_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(status, result, error ? error.slice(0, 2000) : null, this.#iso(), id),
    );
  }

  /** The requester's own tasks; the admin sees every task. */
  tasks(viewer: string, agentId?: string): TeamTaskView[] {
    this.#o.team.assertPerson(viewer);
    const owner = this.#o.team.isOwner(viewer);
    const where: string[] = [];
    const params: string[] = [];
    if (!owner) {
      where.push('requested_by = ?');
      params.push(viewer);
    }
    if (agentId) {
      where.push('agent_id = ?');
      params.push(agentId);
    }
    const rows = this.#o.db.raw
      .prepare(
        `SELECT * FROM team_task ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(...params) as unknown as TaskRow[];
    return rows.map(taskView);
  }

  task(viewer: string, id: string): TeamTaskView {
    this.#o.team.assertPerson(viewer);
    const t = this.#task(id);
    if (!t || (t.requested_by !== viewer && !this.#o.team.isOwner(viewer)))
      throw new NovaError('not_found', 'task not found');
    return taskView(t);
  }

  async cancelTask(viewer: string, id: string): Promise<TeamTaskView> {
    const t = this.task(viewer, id);
    if (t.status === 'queued' || t.status === 'running') {
      const r = this.#row(t.agentId);
      // Only a thread that is this task's alone is stopped: never another requester's work.
      const own = t.threadId
        ? (
            this.#o.db.raw
              .prepare('SELECT COUNT(*) AS n FROM team_task WHERE thread_id = ?')
              .get(t.threadId) as { n: number }
          ).n === 1
        : false;
      if (own && t.threadId) await this.#turns?.cancel(r.identity_account_id, t.threadId);
      await this.#endTask(id, 'cancelled', null, null);
    }
    return this.task(viewer, id);
  }

  // ---- the admin's view of the agent's identity -----------------------------------------------

  /** The audit trail of the agent's identity: every action it took (FR-091, FR-104). */
  async audit(
    actor: string,
    agentId: string,
    q: AuditListQuery = {},
  ): Promise<Page<AuditEntryView>> {
    this.#o.team.assertOwner(actor);
    const r = this.#row(agentId);
    if (!this.#o.auditLog) return { items: [], nextCursor: null };
    return this.#o.auditLog.list(r.identity_account_id, q);
  }

  /** Approvals the agent waits for; the admin answers them for its identity. */
  async approvals(actor: string, agentId: string): Promise<ApprovalView[]> {
    this.#o.team.assertOwner(actor);
    const r = this.#row(agentId);
    return this.#approvals ? this.#approvals.pending(r.identity_account_id) : [];
  }

  async decide(actor: string, agentId: string, body: DecideApprovalRequest): Promise<ApprovalView> {
    this.#o.team.assertOwner(actor);
    const r = this.#row(agentId);
    if (!this.#approvals) throw new NovaError('capability_missing', 'approvals are not available');
    return this.#approvals.decide(r.identity_account_id, body, 'user');
  }

  // ---- audit ------------------------------------------------------------------------------------

  /** In the admin's trail (who did it) and the agent's (what happened to it). */
  async #auditBoth(
    actor: string,
    agentId: string,
    identity: string,
    action: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#audit?.append({
        accountId: actor,
        actor: 'user',
        kind: 'agent',
        action,
        resource: `agent:${agentId}`,
        detail,
      });
      await this.#audit?.append({
        accountId: identity,
        actor: `owner:${actor}`,
        kind: 'agent',
        action,
        resource: `agent:${agentId}`,
        detail,
      });
    } catch (err) {
      this.#log.warn('team agent audit not recorded', { err, action });
    }
  }

  async #auditAgentTask(
    r: TeamAgentRow,
    action: string,
    taskId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#audit?.append({
        accountId: r.identity_account_id,
        actor: `agent:${r.agent_id}`,
        kind: 'agent',
        action,
        resource: `team-task:${taskId}`,
        detail,
      });
    } catch (err) {
      this.#log.warn('team task audit not recorded', { err, action });
    }
  }
}
