// External agent adapters and delegations (FR-203; flagged, off by default). The owner registers an
// adapter (a command that speaks the Agent Client Protocol on stdio); an adapter that would decide
// permissions itself is refused. A Code session delegates a task to one: Nova starts the agent in
// the session's sandbox (launcher.ts), hands it the session folder, sends the prompt and answers
// its requests through the policy engine (host.ts), streams its progress as events, and keeps the
// agent's reply. Its file changes are the session's own diffs, because every write is Nova's
// `fs.write` in that session. One delegation runs per session at a time.
//
// Security (M7 review): an adapter's environment may hold and resolve only its own vault entries
// (`secret://agent-adapter/<id>/…`); what the agent says about itself is redacted, with its own
// secret values removed, and clipped; turning `externalAgents.enabled` off stops running
// delegations (reading and cancelling one works either way); the agent's commands are stopped
// when the delegation ends; its progress events are coalesced.
import { createHash } from 'node:crypto';
import {
  NovaError,
  createAgentAdapterSchema,
  updateAgentAdapterSchema,
  uuidv7,
  type AgentAdapterCheck,
  type AgentAdapterView,
  type CreateAgentAdapterRequest,
  type CreateDelegationRequest,
  type DelegationStatus,
  type DelegationView,
  type UpdateAgentAdapterRequest,
} from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { ToolRuntime } from '../tools/runtime.ts';
import { clip } from '../tools/text.ts';
import type { AuditSink, ToolGate } from '../tools/types.ts';
import { AcpClient, AgentRefused } from './client.ts';
import { policyAcpHost, type PermissionDecision } from './host.ts';
import type { AgentLauncher } from './launcher.ts';
import { contentText, type SessionUpdate } from './protocol.ts';

/** The secrets an adapter's environment references (the Hub's vault). */
export interface AdapterSecrets {
  put(ref: string, value: string): Promise<void>;
  get(ref: string): Promise<string | null>;
  delete(ref: string): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
}

export interface ExternalAgentServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  audit?: AuditSink;
  secrets: AdapterSecrets;
  /** `externalAgents.enabled`. */
  enabled: () => Promise<boolean>;
  launcher: AgentLauncher;
  runtime: () => ToolRuntime | null;
  gate: () => ToolGate | null;
  redactor?: Redactor;
  log?: Logger;
  now?: () => Date;
  /** Wall-clock limit of one delegation (default 2 h). */
  maxDelegationMs?: number;
  /** Handshake and session start (default 30 s). */
  startTimeoutMs?: number;
  /** Time a stopped agent gets to end its turn before it is closed (default 10 s). */
  cancelGraceMs?: number;
  clientInfo?: { name: string; version: string };
}

interface AdapterRow {
  id: string;
  account_id: string;
  name: string;
  command: string;
  args_json: string;
  env_json: string;
  network_json: string;
  permission_routing: 'client';
  enabled: number;
  last_check_json: string | null;
  created_at: string;
  updated_at: string;
}

interface DelegationRow {
  id: string;
  account_id: string;
  thread_id: string;
  adapter_id: string;
  status: DelegationStatus;
  prompt: string;
  output: string | null;
  stop_reason: string | null;
  error: string | null;
  agent_json: string | null;
  permission_requests: number;
  operations: number;
  created_at: string;
  ended_at: string | null;
  adapter_name?: string | null;
}

const MAX_OUTPUT_CHARS = 20_000;
/** How often a delegation's progress is published, at most (its events are coalesced). */
export const DELEGATION_EVENT_INTERVAL_MS = 250;
/** Characters of text one coalesced progress event carries. */
const MAX_EVENT_TEXT = 4000;
/** Tool-call updates one progress interval may carry; more are counted, not sent. */
const MAX_TOOL_UPDATES_PER_EVENT = 10;

/** The adapter's own part of the vault. */
function ownPrefix(adapterId: string): string {
  return `secret://agent-adapter/${adapterId}/`;
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function adapterView(r: AdapterRow): AgentAdapterView {
  return {
    id: r.id,
    name: r.name,
    command: r.command,
    args: parse<string[]>(r.args_json, []),
    env: parse<Record<string, string>>(r.env_json, {}),
    network: parse<string[]>(r.network_json, []),
    permissionRouting: 'client',
    enabled: r.enabled === 1,
    lastCheck: parse<AgentAdapterCheck | null>(r.last_check_json, null),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function delegationView(r: DelegationRow): DelegationView {
  return {
    id: r.id,
    threadId: r.thread_id,
    adapterId: r.adapter_id,
    adapterName: r.adapter_name ?? null,
    status: r.status,
    prompt: r.prompt,
    output: r.output,
    stopReason: r.stop_reason,
    error: r.error,
    agent: parse<DelegationView['agent']>(r.agent_json, null),
    permissionRequests: r.permission_requests,
    operations: r.operations,
    createdAt: r.created_at,
    endedAt: r.ended_at,
  };
}

/** One session update as a client sees it. */
interface ProgressUpdate {
  kind: 'message' | 'thought' | 'tool_call' | 'plan';
  text?: string;
  title?: string;
  status?: string;
}

interface Running {
  accountId: string;
  threadId: string;
  stop: AbortController;
  done: Promise<void>;
  /** Why it was stopped from outside (cancelled, turned off), recorded as its error. */
  reason: string | null;
}

export class ExternalAgentService {
  readonly #o: ExternalAgentServiceOptions;
  readonly #log: Logger;
  readonly #redactor: Redactor;
  readonly #running = new Map<string, Running>();

  constructor(opts: ExternalAgentServiceOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.acp', sinks: [] });
    this.#redactor = opts.redactor ?? defaultRedactor;
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }

  async #audit(
    accountId: string,
    action: string,
    resource: string | null,
    detail: Record<string, unknown>,
    extra: {
      threadId?: string | null;
      decision?: string | null;
      result?: string | null;
      /** Who acted when the action alone does not say (a cancel by the user or by Nova). */
      actor?: 'user' | 'system';
    } = {},
  ): Promise<void> {
    try {
      await this.#o.audit?.append({
        accountId,
        actor: extra.actor ?? (action.startsWith('delegation.permission') ? 'system' : 'user'),
        kind: 'code',
        action,
        resource,
        decision: extra.decision ?? null,
        result: extra.result ?? null,
        threadId: extra.threadId ?? null,
        detail,
      });
    } catch (err) {
      this.#log.warn('could not audit an external agent action', { err, action });
    }
  }

  async #requireEnabled(): Promise<void> {
    if (!(await this.#o.enabled()))
      throw new NovaError('not_found', 'external agent adapters are turned off');
  }

  // ---- adapters ---------------------------------------------------------------------------------

  async listAdapters(accountId: string): Promise<AgentAdapterView[]> {
    await this.#requireEnabled();
    const rows = this.#o.db.raw
      .prepare(
        'SELECT * FROM agent_adapter WHERE account_id = ? AND deleted_at IS NULL ORDER BY name',
      )
      .all(accountId) as unknown as AdapterRow[];
    return rows.map(adapterView);
  }

  #adapterRow(accountId: string, id: string): AdapterRow {
    const row = this.#o.db.raw
      .prepare('SELECT * FROM agent_adapter WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .get(id, accountId) as AdapterRow | undefined;
    if (!row) throw new NovaError('not_found', 'no such agent adapter');
    return row;
  }

  async getAdapter(accountId: string, id: string): Promise<AgentAdapterView> {
    await this.#requireEnabled();
    return adapterView(this.#adapterRow(accountId, id));
  }

  /**
   * Values that are not references go to the vault; the row keeps only references. A reference
   * may only be the adapter's own (`secret://agent-adapter/<id>/…`): any other would hand that
   * secret to a process the owner registered, so it is refused, like MCP servers' env.
   */
  async #storeEnv(
    id: string,
    env: Record<string, string>,
    saved: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(env))
      if (value.startsWith('secret://') && !value.startsWith(ownPrefix(id)))
        throw new NovaError('validation', `env ${name}: enter the value, not a secret reference`, {
          details: { field: `env.${name}`, reason: 'foreign_secret' },
        });
    for (const [name, value] of Object.entries(env)) {
      if (value.startsWith('secret://')) out[name] = value;
      else if (value === '' && saved[name]) out[name] = saved[name];
      else {
        const ref = `secret://agent-adapter/${id}/env/${name}`;
        await this.#o.secrets.put(ref, value);
        out[name] = ref;
      }
    }
    // Vault entries of variables that are gone are removed.
    for (const ref of await this.#o.secrets.list(`secret://agent-adapter/${id}/`).catch(() => []))
      if (!Object.values(out).includes(ref)) await this.#o.secrets.delete(ref).catch(() => false);
    return out;
  }

  async createAdapter(
    accountId: string,
    body: CreateAgentAdapterRequest,
  ): Promise<AgentAdapterView> {
    await this.#requireEnabled();
    const input = createAgentAdapterSchema.parse(body);
    // FR-203: an adapter must route every permission request to Nova; one that decides on its own
    // is refused.
    if (input.permissionRouting !== 'client')
      throw new NovaError(
        'validation',
        'this adapter cannot route its permission requests to Nova, so it cannot be added',
        { details: { reason: 'permission_routing' } },
      );
    const dup = this.#o.db.raw
      .prepare(
        'SELECT 1 FROM agent_adapter WHERE account_id = ? AND name = ? AND deleted_at IS NULL',
      )
      .get(accountId, input.name);
    if (dup) throw new NovaError('conflict', 'an adapter with this name exists');
    const id = uuidv7();
    const env = await this.#storeEnv(id, input.env);
    const now = this.#now();
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare(
          `INSERT INTO agent_adapter (id, account_id, name, command, args_json, env_json, network_json,
             permission_routing, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'client', ?, ?, ?)`,
        )
        .run(
          id,
          accountId,
          input.name,
          input.command,
          JSON.stringify(input.args),
          JSON.stringify(env),
          JSON.stringify(input.network),
          input.enabled ? 1 : 0,
          now,
          now,
        ),
    );
    await this.#audit(accountId, 'agent_adapter.create', id, {
      name: input.name,
      command: input.command,
      network: input.network,
      env: Object.keys(env),
    });
    return adapterView(this.#adapterRow(accountId, id));
  }

  async updateAdapter(
    accountId: string,
    id: string,
    body: UpdateAgentAdapterRequest,
  ): Promise<AgentAdapterView> {
    await this.#requireEnabled();
    const patch = updateAgentAdapterSchema.parse(body);
    const row = this.#adapterRow(accountId, id);
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (patch.name !== undefined && patch.name !== row.name) {
      const dup = this.#o.db.raw
        .prepare(
          'SELECT 1 FROM agent_adapter WHERE account_id = ? AND name = ? AND id != ? AND deleted_at IS NULL',
        )
        .get(accountId, patch.name, id);
      if (dup) throw new NovaError('conflict', 'an adapter with this name exists');
      sets.push('name = ?');
      vals.push(patch.name);
    }
    if (patch.args) {
      sets.push('args_json = ?');
      vals.push(JSON.stringify(patch.args));
    }
    if (patch.network) {
      sets.push('network_json = ?');
      vals.push(JSON.stringify(patch.network));
    }
    if (patch.env) {
      const env = await this.#storeEnv(id, patch.env, parse(row.env_json, {}));
      sets.push('env_json = ?');
      vals.push(JSON.stringify(env));
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = ?');
      vals.push(patch.enabled ? 1 : 0);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      vals.push(this.#now());
      await this.#o.db.transaction(() =>
        this.#o.db.raw
          .prepare(`UPDATE agent_adapter SET ${sets.join(', ')} WHERE id = ?`)
          .run(...vals, id),
      );
      await this.#audit(accountId, 'agent_adapter.update', id, {
        changed: Object.keys(patch),
      });
    }
    return adapterView(this.#adapterRow(accountId, id));
  }

  async deleteAdapter(accountId: string, id: string): Promise<void> {
    await this.#requireEnabled();
    this.#adapterRow(accountId, id);
    for (const [did, r] of this.#running) {
      const row = this.#delegationRow(accountId, did);
      if (row?.adapter_id === id) r.stop.abort();
    }
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare('UPDATE agent_adapter SET deleted_at = ?, enabled = 0 WHERE id = ?')
        .run(this.#now(), id),
    );
    for (const ref of await this.#o.secrets.list(`secret://agent-adapter/${id}/`).catch(() => []))
      await this.#o.secrets.delete(ref).catch(() => false);
    await this.#audit(accountId, 'agent_adapter.delete', id, {});
  }

  /** Start the agent in a sandbox and run the handshake only; records the result. */
  async checkAdapter(accountId: string, id: string, threadId: string): Promise<AgentAdapterCheck> {
    await this.#requireEnabled();
    const row = this.#adapterRow(accountId, id);
    const session = await this.#session(accountId, threadId);
    const stop = new AbortController();
    const at = this.#now();
    let check: AgentAdapterCheck;
    let client: AcpClient | null = null;
    try {
      const env = await this.#env(row);
      const transport = await this.#o.launcher({
        accountId,
        threadId,
        delegationId: `check-${uuidv7()}`,
        command: row.command,
        args: parse(row.args_json, []),
        env,
        folder: session.folder,
        hosts: parse<string[]>(row.network_json, []),
        signal: stop.signal,
      });
      client = new AcpClient({
        transport,
        host: refusingHost,
        startTimeoutMs: this.#o.startTimeoutMs ?? 30_000,
        log: this.#log,
        ...(this.#o.clientInfo ? { clientInfo: this.#o.clientInfo } : {}),
      });
      const init = await client.initialize();
      check = {
        ok: true,
        at,
        agent: this.#agentInfo(init.agentInfo, env),
        protocolVersion: init.protocolVersion,
        reason: null,
      };
    } catch (err) {
      check = { ok: false, at, agent: null, protocolVersion: null, reason: this.#reason(err) };
    } finally {
      stop.abort();
      await client?.close('check done').catch(() => undefined);
    }
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare('UPDATE agent_adapter SET last_check_json = ? WHERE id = ?')
        .run(JSON.stringify(check), id),
    );
    await this.#audit(accountId, 'agent_adapter.check', id, { ok: check.ok, reason: check.reason });
    return check;
  }

  /** The adapter's environment: only its own vault entries are ever resolved (fail closed). */
  async #env(row: AdapterRow): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, ref] of Object.entries(parse<Record<string, string>>(row.env_json, {}))) {
      if (!ref.startsWith(ownPrefix(row.id)))
        throw new NovaError(
          'validation',
          `env ${name} refers to a secret this adapter does not own`,
          {
            details: { field: `env.${name}`, reason: 'foreign_secret' },
          },
        );
      const value = await this.#o.secrets.get(ref);
      if (value === null)
        throw new NovaError('validation', `the secret for ${name} is missing from the vault`);
      out[name] = value;
    }
    return out;
  }

  #reason(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return clip(this.#redactor.redactString(msg), 500);
  }

  /**
   * What the agent says it is, as stored and shown: the adapter's own secret values removed,
   * then redacted and clipped (the agent's process holds those values and could echo them).
   */
  #agentInfo(
    info: { name?: string | undefined; version?: string | undefined } | undefined,
    env: Record<string, string>,
  ): { name: string | null; version: string | null } {
    const clean = (v: string | undefined, max: number): string | null => {
      if (typeof v !== 'string') return null;
      let text = v;
      for (const secret of Object.values(env))
        if (secret.length >= 4) text = text.split(secret).join('[REDACTED]');
      return clip(this.#redactor.redactString(text), max);
    };
    return { name: clean(info?.name, 100), version: clean(info?.version, 50) };
  }

  // ---- delegations ------------------------------------------------------------------------------

  /** The Code session behind a thread: its folder is the first root of its scope. */
  async #session(
    accountId: string,
    threadId: string,
  ): Promise<{ folder: string; projectId: string | null }> {
    const row = this.#o.db.raw
      .prepare(
        `SELECT cs.status AS status, t.project_id AS projectId FROM code_session cs
         JOIN thread t ON t.id = cs.thread_id
         WHERE cs.thread_id = ? AND cs.account_id = ? AND t.deleted_at IS NULL`,
      )
      .get(threadId, accountId) as { status: string; projectId: string | null } | undefined;
    if (!row) throw new NovaError('not_found', 'no such Code session');
    if (row.status !== 'active') throw new NovaError('conflict', 'the Code session is archived');
    const runtime = this.#o.runtime();
    if (!runtime) throw new NovaError('server_error', 'tools are not available yet');
    const scope = await runtime.scopeFor(accountId, threadId, row.projectId);
    const folder = scope.roots[0]?.path;
    if (!folder) throw new NovaError('conflict', 'the Code session has no folder');
    return { folder, projectId: row.projectId };
  }

  #delegationRow(accountId: string, id: string): DelegationRow | null {
    return (
      (this.#o.db.raw
        .prepare(
          `SELECT d.*, a.name AS adapter_name FROM agent_delegation d
           LEFT JOIN agent_adapter a ON a.id = d.adapter_id
           WHERE d.id = ? AND d.account_id = ?`,
        )
        .get(id, accountId) as DelegationRow | undefined) ?? null
    );
  }

  async listDelegations(accountId: string, threadId: string): Promise<DelegationView[]> {
    await this.#requireEnabled();
    const rows = this.#o.db.raw
      .prepare(
        `SELECT d.*, a.name AS adapter_name FROM agent_delegation d
         LEFT JOIN agent_adapter a ON a.id = d.adapter_id
         WHERE d.account_id = ? AND d.thread_id = ? ORDER BY d.created_at DESC LIMIT 100`,
      )
      .all(accountId, threadId) as unknown as DelegationRow[];
    return rows.map(delegationView);
  }

  /** Reading a delegation works whether or not the feature is on (to see one it stopped). */
  getDelegation(accountId: string, id: string): Promise<DelegationView> {
    const row = this.#delegationRow(accountId, id);
    if (!row) return Promise.reject(new NovaError('not_found', 'no such delegation'));
    return Promise.resolve(delegationView(row));
  }

  /** Delegate the session's task to an adapter; the agent runs in the background. */
  async delegate(
    accountId: string,
    threadId: string,
    body: CreateDelegationRequest,
  ): Promise<DelegationView> {
    await this.#requireEnabled();
    const adapter = this.#adapterRow(accountId, body.adapterId);
    if (adapter.enabled !== 1) throw new NovaError('conflict', 'the adapter is turned off');
    const session = await this.#session(accountId, threadId);
    for (const r of this.#running.values())
      if (r.threadId === threadId)
        throw new NovaError('conflict', 'an external agent is already working in this session');
    const runtime = this.#o.runtime();
    const gate = this.#o.gate();
    if (!runtime || !gate)
      throw new NovaError('server_error', 'the policy engine is not available yet');
    const id = uuidv7();
    const now = this.#now();
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare(
          `INSERT INTO agent_delegation (id, account_id, thread_id, adapter_id, status, prompt, created_at)
           VALUES (?, ?, ?, ?, 'starting', ?, ?)`,
        )
        .run(id, accountId, threadId, adapter.id, body.prompt, now),
    );
    await this.#audit(
      accountId,
      'delegation.start',
      id,
      { adapterId: adapter.id, adapter: adapter.name, promptSha256: sha256(body.prompt) },
      { threadId },
    );
    await this.#emit(accountId, threadId, 'delegation.started', {
      delegationId: id,
      threadId,
      adapterId: adapter.id,
    });
    const stop = new AbortController();
    const entry: Running = {
      accountId,
      threadId,
      stop,
      done: Promise.resolve(),
      reason: null,
    };
    const limit = setTimeout(
      () => {
        entry.reason ??= 'the delegation ran out of time';
        stop.abort();
      },
      this.#o.maxDelegationMs ?? 2 * 60 * 60 * 1000,
    );
    const done = this.#run(
      id,
      accountId,
      threadId,
      adapter,
      session,
      body.prompt,
      runtime,
      gate,
      entry,
    )
      .catch((err: unknown) => this.#log.error('delegation failed', { err, id }))
      .finally(() => {
        clearTimeout(limit);
        this.#running.delete(id);
      });
    entry.done = done;
    this.#running.set(id, entry);
    return delegationView(this.#delegationRow(accountId, id)!);
  }

  /** Cancelling works whether or not the feature is on (the owner can always stop an agent). */
  async cancel(accountId: string, id: string): Promise<DelegationView> {
    const row = this.#delegationRow(accountId, id);
    if (!row) throw new NovaError('not_found', 'no such delegation');
    const r = this.#running.get(id);
    if (r) {
      r.reason ??= 'cancelled';
      r.stop.abort();
      await this.#audit(accountId, 'delegation.cancel', id, {}, { threadId: row.thread_id });
      await r.done;
    }
    return delegationView(this.#delegationRow(accountId, id)!);
  }

  /** Wait for a delegation to end (tests, shutdown). */
  async whenDone(id: string): Promise<void> {
    await this.#running.get(id)?.done;
  }

  async close(): Promise<void> {
    for (const r of this.#running.values()) r.stop.abort();
    await Promise.allSettled([...this.#running.values()].map((r) => r.done));
  }

  /**
   * Stop every running delegation now (the feature was turned off): each ends cancelled, with the
   * reason, and its commands are stopped. Resolves when they have ended.
   */
  async stopAll(reason = 'external agents were turned off'): Promise<number> {
    const running = [...this.#running.entries()];
    for (const [id, r] of running) {
      r.reason ??= reason;
      r.stop.abort();
      // Nova stopped it, not a person: the system actor, as for other automatic stops.
      await this.#audit(
        r.accountId,
        'delegation.cancel',
        id,
        { reason },
        { threadId: r.threadId, actor: 'system' },
      );
    }
    await Promise.allSettled(running.map(([, r]) => r.done));
    return running.length;
  }

  /** Delegations running now (diagnostics, tests). */
  get running(): number {
    return this.#running.size;
  }

  async #emit(
    accountId: string,
    threadId: string,
    name: string,
    payload: Record<string, unknown>,
    ephemeral = false,
  ): Promise<void> {
    const e = { name, accountId, correlation: { threadId }, payload };
    try {
      if (ephemeral) this.#o.events.emitEphemeral(e);
      else await this.#o.events.emit(e);
    } catch (err) {
      this.#log.warn('could not publish a delegation event', { err, name });
    }
  }

  async #run(
    id: string,
    accountId: string,
    threadId: string,
    adapter: AdapterRow,
    session: { folder: string; projectId: string | null },
    prompt: string,
    runtime: ToolRuntime,
    gate: ToolGate,
    entry: Running,
  ): Promise<void> {
    const stop = entry.stop;
    let client: AcpClient | null = null;
    let host: ReturnType<typeof policyAcpHost> | null = null;
    let output = '';
    let status: DelegationStatus = 'failed';
    let stopReason: string | null = null;
    let error: string | null = null;
    let agent: DelegationView['agent'] = null;
    const decisions: PermissionDecision[] = [];
    const progress = this.#progress(accountId, threadId, id);
    try {
      const env = await this.#env(adapter);
      const transport = await this.#o.launcher({
        accountId,
        threadId,
        delegationId: id,
        command: adapter.command,
        args: parse(adapter.args_json, []),
        env,
        folder: session.folder,
        hosts: parse<string[]>(adapter.network_json, []),
        signal: stop.signal,
      });
      host = policyAcpHost({
        runtime,
        gate,
        accountId,
        threadId,
        projectId: session.projectId,
        delegationId: id,
        adapterName: adapter.name,
        folder: session.folder,
        signal: stop.signal,
        active: () => this.#o.enabled(),
        onInactive: () => {
          entry.reason ??= 'external agents were turned off';
          stop.abort();
        },
        onDecision: (d) => {
          decisions.push(d);
          void this.#audit(
            accountId,
            'delegation.permission',
            id,
            {
              kind: d.kind,
              title: d.title ? clip(this.#redactor.redactString(d.title), 200) : null,
              via: d.via,
              reason: clip(d.reason, 300),
            },
            { threadId, decision: d.answer },
          );
        },
      });
      client = new AcpClient({
        transport,
        host,
        startTimeoutMs: this.#o.startTimeoutMs ?? 30_000,
        ...(this.#o.cancelGraceMs !== undefined ? { cancelGraceMs: this.#o.cancelGraceMs } : {}),
        log: this.#log,
        ...(this.#o.clientInfo ? { clientInfo: this.#o.clientInfo } : {}),
        onUpdate: (u) => {
          const update = this.#update(u);
          if (!update) return;
          if (update.kind === 'message' && update.text && output.length < MAX_OUTPUT_CHARS)
            output = (output + update.text).slice(0, MAX_OUTPUT_CHARS);
          progress.push(update);
        },
      });
      const init = await client.initialize();
      agent = this.#agentInfo(init.agentInfo, env);
      await client.newSession(session.folder);
      await this.#o.db.transaction(() =>
        this.#o.db.raw
          .prepare("UPDATE agent_delegation SET status = 'running', agent_json = ? WHERE id = ?")
          .run(JSON.stringify(agent), id),
      );
      stopReason = await client.prompt(prompt, stop.signal);
      status = stop.signal.aborted || stopReason === 'cancelled' ? 'cancelled' : 'completed';
    } catch (err) {
      if (stop.signal.aborted) status = 'cancelled';
      else {
        status = 'failed';
        error = err instanceof AgentRefused ? `refused: ${this.#reason(err)}` : this.#reason(err);
      }
    } finally {
      // The agent's commands end with it (they would otherwise run on in the sandbox).
      await host?.closeAll().catch(() => undefined);
      await client?.close('delegation ended').catch(() => undefined);
      progress.flush();
    }
    if (status === 'cancelled' && entry.reason && entry.reason !== 'cancelled')
      error ??= entry.reason;
    const redacted = output ? this.#redactor.redactString(output) : null;
    await this.#o.db.transaction(() =>
      this.#o.db.raw
        .prepare(
          `UPDATE agent_delegation SET status = ?, output = ?, stop_reason = ?, error = ?, agent_json = ?,
             permission_requests = ?, operations = ?, ended_at = ? WHERE id = ?`,
        )
        .run(
          status,
          redacted,
          stopReason,
          error,
          agent ? JSON.stringify(agent) : null,
          client?.counts.permission ?? 0,
          client?.counts.operations ?? 0,
          this.#now(),
          id,
        ),
    );
    await this.#audit(
      accountId,
      'delegation.finish',
      id,
      {
        status,
        stopReason,
        permissionRequests: client?.counts.permission ?? 0,
        operations: client?.counts.operations ?? 0,
        rejected: decisions.filter((d) => d.answer !== 'allow').length,
      },
      { threadId, result: status },
    );
    await this.#emit(accountId, threadId, 'delegation.finished', {
      delegationId: id,
      threadId,
      status,
      stopReason,
    });
  }

  /**
   * Progress events of one delegation, coalesced: message and thought text is joined, tool-call
   * updates are kept up to a few per event, and at most one event goes out per interval.
   */
  #progress(accountId: string, threadId: string, delegationId: string) {
    let text = { message: '', thought: '' };
    let tools: { title?: string; status?: string }[] = [];
    let dropped = 0;
    let plan = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!text.message && !text.thought && !tools.length && !plan && !dropped) return;
      const payload: Record<string, unknown> = { delegationId };
      if (text.message) payload.message = text.message;
      if (text.thought) payload.thought = text.thought;
      if (tools.length) payload.toolCalls = tools;
      if (dropped) payload.droppedToolCalls = dropped;
      if (plan) payload.plan = true;
      text = { message: '', thought: '' };
      tools = [];
      dropped = 0;
      plan = false;
      void this.#emit(accountId, threadId, 'delegation.updated', payload, true);
    };
    return {
      push: (u: ProgressUpdate) => {
        if (u.kind === 'message' || u.kind === 'thought') {
          const cur = text[u.kind];
          if (cur.length < MAX_EVENT_TEXT)
            text[u.kind] = (cur + (u.text ?? '')).slice(0, MAX_EVENT_TEXT);
        } else if (u.kind === 'tool_call') {
          if (tools.length < MAX_TOOL_UPDATES_PER_EVENT) {
            const t: { title?: string; status?: string } = {};
            if (u.title) t.title = u.title;
            if (u.status) t.status = u.status;
            tools.push(t);
          } else dropped++;
        } else plan = true;
        timer ??= setTimeout(flush, DELEGATION_EVENT_INTERVAL_MS);
      },
      flush,
    };
  }

  /** The parts of an agent's session update a client shows (redacted, capped). */
  #update(u: SessionUpdate): ProgressUpdate | null {
    const kind = u.sessionUpdate;
    const r = (s: string) => clip(this.#redactor.redactString(s), 4000);
    if (kind === 'agent_message_chunk') return { kind: 'message', text: r(contentText(u.content)) };
    if (kind === 'agent_thought_chunk') return { kind: 'thought', text: r(contentText(u.content)) };
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const out: { kind: 'tool_call'; title?: string; status?: string } = { kind: 'tool_call' };
      if (typeof u.title === 'string') out.title = r(u.title);
      if (typeof u.status === 'string') out.status = clip(u.status, 50);
      return out;
    }
    if (kind === 'plan') return { kind: 'plan' };
    return null;
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** The handshake asks nothing of Nova; a check answers any request with a refusal. */
const refusingHost = {
  requestPermission: () => Promise.resolve('reject' as const),
  readTextFile: () => Promise.reject(new Error('not during a check')),
  writeTextFile: () => Promise.reject(new Error('not during a check')),
  createTerminal: () => Promise.reject(new Error('not during a check')),
  terminalOutput: () => Promise.reject(new Error('not during a check')),
  waitForExit: () => Promise.reject(new Error('not during a check')),
  killTerminal: () => Promise.reject(new Error('not during a check')),
  releaseTerminal: () => Promise.reject(new Error('not during a check')),
};
