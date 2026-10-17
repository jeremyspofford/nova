// The policy gate (FR-099, FR-100, FR-189; docs/12 §2-§4). `check` evaluates a call with the
// engine; allow and deny return at once. An `ask` (or a `handoff`) becomes an approval: a row,
// `approval.requested` on the thread's stream, a notification, and a wait for the user's answer,
// the timeout (recorded as `timeout`, never an allow) or the abort signal (`cancelled`). Every
// decision is audited with the input hash and the permission profile hash, never raw arguments.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  NovaError,
  uuidv7,
  type ApprovalDecisionKind,
  type ApprovalView,
  type ConfirmationTier,
  type DecideApprovalRequest,
  type PolicyPreview,
  type SettingKey,
  type SettingValue,
} from '@nova/shared';
import {
  evaluate,
  stableHash,
  suggestPrefixRule,
  tighten,
  type Decision,
  type DefaultEffect,
  type FsContext,
  type PolicyContext,
  type PolicySet,
  type PolicyVerdict,
  type Scope,
  type Substrate,
} from '@nova/policy';
import { defaultRedactor, realpathLenient } from '@nova/security';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink, GateOutcome, GateRequest, Notifier, ToolGate } from '../tools/types.ts';
import { loadPermissionProfile, resolveToolRoots } from './roots.ts';
import type { ApprovalRow, GrantMatch, GrantRow, PolicyStore } from './store.ts';

export type SettingReader = <K extends SettingKey>(
  key: K,
  projectId?: string | null,
) => Promise<SettingValue<K>>;

/** A preview has no call, turn or arguments preview. */
export type PreviewRequest = Omit<GateRequest, 'callId' | 'turnId' | 'argsPreview'>;

/**
 * A hook (M4) or reviewer (M5) consulted after the engine. Its verdict can only tighten the
 * decision (docs/12 §2.3 steps 7-8); a thrown error counts as a deny (fail closed).
 */
export type GateExtension = (
  req: PreviewRequest,
  decision: Decision,
) => Promise<PolicyVerdict | null>;

/** The user's default for an MCP server or plugin (FR-048), wired from the MCP area. */
export type ServerDefaults = (accountId: string, serverId: string) => Promise<DefaultEffect | null>;

export interface PolicyGateOptions {
  store: PolicyStore;
  events: EventSink;
  audit: AuditSink;
  notifier: Notifier;
  setting: SettingReader;
  dataDir: string;
  /** Defaults to `<dataDir>/workspace`. */
  workspaceDir?: string;
  /** Defaults to the Hub user's home directory. */
  home?: string;
  log?: Logger;
  serverDefaults?: ServerDefaults;
  /** The sandbox substrate exec runs in (null: none or unknown, so `full` is refused). */
  substrate?: () => Substrate | null;
  hooks?: GateExtension[];
  reviewer?: GateExtension;
  /** Override `policy.approvalTimeoutMinutes` (tests). */
  approvalTimeoutMs?: () => number;
  now?: () => Date;
}

type AlwaysScope = ApprovalView['alwaysScopes'][number];

interface Built {
  ctx: PolicyContext;
  set: PolicySet;
  command: string | undefined;
  argsHash: string;
  profileHash: string;
}

interface Waiter {
  accountId: string;
  threadId: string | null;
  turnId: string;
  callId: string;
  tier: ConfirmationTier;
  stage: 'decision' | 'handoff';
  session: { match: GrantMatch; host: string | null; label: string };
  timer: ReturnType<typeof setTimeout> | null;
  settle: (o: GateOutcome) => void;
}

const MEDIUM_EFFECTS = new Set([
  'exec',
  'data_delete',
  'file_write',
  'network',
  'external_communication',
]);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function redact(text: string): string {
  return defaultRedactor.redactString(text);
}

/** The command line of an exec call: `exec.run {cmd}` or a line sent with `exec.write {text}`. */
export function commandOf(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  if (typeof a.cmd === 'string') return a.cmd;
  if (tool === 'exec.write' && typeof a.text === 'string') return a.text;
  return undefined;
}

export class PolicyGate implements ToolGate {
  readonly #o: PolicyGateOptions;
  readonly #workspace: string;
  readonly #home: string;
  readonly #waiters = new Map<string, Waiter>();
  readonly #waitingThreads = new Map<string, number>();
  #serverDefaults: ServerDefaults | undefined;
  #substrate: () => Substrate | null;

  constructor(opts: PolicyGateOptions) {
    this.#o = opts;
    this.#workspace = opts.workspaceDir ?? join(opts.dataDir, 'workspace');
    this.#home = opts.home ?? homedir();
    this.#serverDefaults = opts.serverDefaults;
    this.#substrate = opts.substrate ?? (() => null);
  }

  /** Wire per-MCP-server and per-plugin defaults (FR-048). */
  useServerDefaults(fn: ServerDefaults): void {
    this.#serverDefaults = fn;
  }

  /** Wire the sandbox substrate (the `full` profile needs a VM or container). */
  useSubstrate(fn: () => Substrate | null): void {
    this.#substrate = fn;
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  get pending(): number {
    return this.#waiters.size;
  }

  // ---- evaluation ---------------------------------------------------------------------------

  async #build(req: PreviewRequest): Promise<Built> {
    const { store, setting } = this.#o;
    const { profile, fallback } = await loadPermissionProfile(
      store.db,
      req.accountId,
      req.profile.id,
    );
    if (fallback) this.#o.log?.warn('permission profile fell back to read-only', { fallback });
    const [rootSetting, egressAllow, approvalPolicy] = await Promise.all([
      setting('tools.roots'),
      setting('network.egressAllow'),
      setting('tools.approvalPolicy', req.projectId),
    ]);
    const resolved = resolveToolRoots({
      profile,
      roots: rootSetting,
      workspaceDir: this.#workspace,
      home: this.#home,
    });
    const fs: FsContext = {
      entries: [
        ...resolved.roots.map((r) => ({ path: r.path, access: r.access })),
        ...resolved.deny.map((p) => ({ path: p, access: 'deny' as const })),
      ],
      dataDir: realpathLenient(this.#o.dataDir),
      dataDirAllow: [realpathLenient(this.#workspace)],
      home: realpathLenient(this.#home),
    };
    const threadId = req.threadId || null;
    const set = await store.policySet(req.accountId, { threadId, home: this.#home });
    const owner = req.tool.serverId ?? req.tool.pluginId;
    if (owner && this.#serverDefaults) {
      const d = await this.#serverDefaults(req.accountId, owner);
      if (d) set.serverDefaults = { [owner]: d };
    }
    const scopes: Scope[] = [];
    if (threadId)
      scopes.push({ kind: 'session', ref: threadId }, { kind: 'thread', ref: threadId });
    if (req.projectId) scopes.push({ kind: 'project', ref: req.projectId });
    scopes.push({ kind: 'global' });
    const command = commandOf(req.tool.name, req.args);
    const argsHash = stableHash(req.args ?? null);
    const origin = (req as PreviewRequest & { origin?: string }).origin;
    const provenance: PolicyContext['provenance'] = { taint: [...req.provenance.taint] };
    if (req.provenance.userInstruction)
      provenance.userInstruction = { ...req.provenance.userInstruction };
    const ctx: PolicyContext = {
      actor: origin === 'ui' ? { kind: 'user' } : { kind: 'agent', id: req.mode },
      scopes,
      mode: req.mode,
      approvalPolicy: { kind: approvalPolicy },
      permissionProfile: {
        id: profile.id,
        hash: resolved.profile.hash,
        requiresSubstrate: resolved.requiresSubstrate,
      },
      provenance,
      tool: req.tool,
      args: req.args,
      argsHash,
      environment: { kind: 'hub', trusted: true, substrate: this.#substrate() },
      fs,
      egress: {
        allow: [...egressAllow, ...(resolved.network.allow ?? [])],
        deny: resolved.network.deny ?? [],
      },
    };
    if (command !== undefined) ctx.command = command;
    const resource = this.#canonicalResource(req.resource);
    if (resource) ctx.resource = resource;
    return { ctx, set, command, argsHash, profileHash: resolved.profile.hash };
  }

  #canonicalResource(r: GateRequest['resource']): GateRequest['resource'] {
    if (!r || r.kind !== 'path' || r.value.includes('\0')) return r;
    const abs = isAbsolute(r.value) ? r.value : resolve(this.#workspace, r.value);
    return { kind: 'path', value: realpathLenient(resolve(abs)) };
  }

  /** Hooks and the reviewer, which can only tighten (docs/12 §2.3 steps 7-8). */
  async #extend(req: PreviewRequest, decision: Decision, preview: boolean): Promise<Decision> {
    let d = decision;
    if (!preview) {
      for (const hook of this.#o.hooks ?? []) {
        const v = await hook(req, d).catch((): PolicyVerdict => ({
          effect: 'deny',
          reason: 'a permission hook failed',
          source: 'hook',
        }));
        if (v) d = tighten(d, v);
      }
    }
    if (d.effect === 'allow' && d.review) {
      const reviewer = this.#o.reviewer;
      if (!reviewer) {
        // `review` without a reviewer fails closed: the user decides (docs/12 §2.1).
        return {
          ...d,
          effect: 'ask',
          reason: 'auto-review is not set up, so this action needs your approval',
          source: 'reviewer',
          review: false,
          persistable: false,
        };
      }
      if (!preview) {
        const v = await reviewer(req, d).catch(() => null);
        d = tighten(
          { ...d, review: false },
          v ?? { effect: 'deny', reason: 'the reviewer did not answer', source: 'reviewer' },
        );
      }
    }
    return d;
  }

  async preview(
    req: PreviewRequest,
  ): Promise<PolicyPreview & { userDefault: DefaultEffect | null }> {
    const b = await this.#build(req);
    const d = await this.#extend(req, evaluate(b.ctx, b.set), true);
    return {
      effect: d.effect,
      tier: d.tier,
      reason: d.reason,
      source: d.source,
      ruleId: d.ruleId ?? null,
      userDefault: b.set.toolDefaults?.[req.tool.name] ?? null,
    };
  }

  async check(req: GateRequest, signal: AbortSignal): Promise<GateOutcome> {
    if (signal.aborted)
      return {
        effect: 'deny',
        reason: 'the turn was cancelled',
        tier: 'pre_approvable',
        stop: true,
      };
    const b = await this.#build(req);
    let d = await this.#extend(req, evaluate(b.ctx, b.set), false);
    const threadId = req.threadId || null;
    const correlation = this.#correlation(req);
    await this.#o.events.emit({
      name: 'policy.tier',
      accountId: req.accountId,
      actor: 'system',
      correlation,
      payload: {
        callId: req.callId,
        action: req.tool.name,
        tier: d.tier,
        authorization: d.authorization,
        sources: [...new Set(req.provenance.taint)],
      },
    });
    if (d.effect === 'ask' && threadId) {
      // After "Deny and continue", an identical call in the same chat is denied without asking.
      const before = this.#o.store.deniedBefore(req.accountId, threadId, req.tool.name, b.argsHash);
      if (before !== null)
        d = {
          ...d,
          effect: 'deny',
          source: 'grant',
          reason: before
            ? `you denied this earlier: ${before}`
            : 'you denied this identical call earlier',
        };
    }
    await this.#auditDecision(req, b, d);
    if (d.effect === 'allow') return { effect: 'allow', reason: d.reason, tier: d.tier };
    if (d.effect === 'deny') {
      const payload: Record<string, unknown> = {
        callId: req.callId,
        tool: req.tool.name,
        reason: d.reason,
      };
      if (d.ruleId) payload.ruleId = d.ruleId;
      await this.#o.events.emit({
        name: 'policy.denied',
        accountId: req.accountId,
        actor: 'system',
        correlation,
        payload,
      });
      return { effect: 'deny', reason: d.reason, tier: d.tier, stop: false };
    }
    return this.#ask(req, b, d, signal);
  }

  #correlation(req: { threadId: string; turnId: string; callId: string }) {
    const c: { threadId?: string; turnId?: string; callId?: string } = {};
    if (req.threadId) c.threadId = req.threadId;
    if (req.turnId) c.turnId = req.turnId;
    if (req.callId) c.callId = req.callId;
    return c;
  }

  #actor(req: PreviewRequest): string {
    const origin = (req as PreviewRequest & { origin?: string }).origin;
    return origin === 'ui' ? 'user' : `agent:${req.mode}`;
  }

  async #auditDecision(req: GateRequest, b: Built, d: Decision): Promise<void> {
    await this.#o.audit.append({
      accountId: req.accountId,
      actor: this.#actor(req),
      kind: 'policy',
      action: req.tool.name,
      resource: b.ctx.resource?.value ?? null,
      inputHash: b.argsHash,
      decision: d.effect,
      threadId: req.threadId || null,
      turnId: req.turnId || null,
      detail: {
        callId: req.callId,
        tier: d.tier,
        source: d.source,
        ruleId: d.ruleId ?? null,
        grantId: d.grantId ?? null,
        reason: d.reason,
        authorization: d.authorization,
        taint: [...new Set(req.provenance.taint)],
        effects: d.effects,
        profileId: req.profile.id,
        profileHash: b.profileHash,
      },
    });
  }

  // ---- approvals -------------------------------------------------------------------------

  #suggest(req: GateRequest, b: Built): AlwaysScope[] {
    const out: AlwaysScope[] = [
      {
        kind: 'tool',
        label: `This tool (${req.tool.name}) ${req.projectId ? 'in this project' : 'everywhere'}`,
        tool: req.tool.name,
      },
    ];
    if (b.command !== undefined) {
      const s = suggestPrefixRule(redact(b.command));
      if (s)
        out.push({
          kind: 'prefix_rule',
          label: `Commands starting with ${s.pattern.join(' ')}`,
          rule: s,
        });
    }
    const res = b.ctx.resource;
    if (req.tool.annotations?.requiresNetwork === true && res?.kind === 'host')
      out.push({ kind: 'host', label: `Network host ${res.value}`, host: res.value });
    return out;
  }

  #sessionGrant(req: GateRequest, b: Built): Waiter['session'] {
    const res = b.ctx.resource;
    const host =
      req.tool.annotations?.requiresNetwork === true && res?.kind === 'host' ? res.value : null;
    if (b.command !== undefined) {
      const s = suggestPrefixRule(redact(b.command));
      if (s)
        return {
          match: { tool: req.tool.name, command: s.pattern },
          host,
          label: `commands starting with ${s.pattern.join(' ')} in this chat`,
        };
      return {
        match: { tool: req.tool.name, argsHash: b.argsHash },
        host,
        label: 'this exact command in this chat',
      };
    }
    return {
      match: { tool: req.tool.name },
      host,
      label: host ? `${req.tool.name} on ${host} in this chat` : `${req.tool.name} in this chat`,
    };
  }

  async #ask(req: GateRequest, b: Built, d: Decision, signal: AbortSignal): Promise<GateOutcome> {
    const { store, setting } = this.#o;
    const persistent = await setting('policy.allowPersistentGrants');
    const scopes = d.persistable && persistent ? this.#suggest(req, b) : [];
    const options = optionsFor(d, scopes.length > 0);
    const now = this.#now();
    const timeoutMs =
      this.#o.approvalTimeoutMs?.() ?? (await setting('policy.approvalTimeoutMinutes')) * 60_000;
    const id = uuidv7();
    const threadId = req.threadId || null;
    const row: ApprovalRow = {
      id,
      accountId: req.accountId,
      toolCallId: req.callId || null,
      threadId,
      turnId: req.turnId || null,
      runId: null,
      agentId: null,
      toolName: req.tool.name,
      requestedAction: actionLabel(req, b),
      argsPreview: clip(redact(req.argsPreview), 2000),
      argsHash: b.argsHash,
      reason: d.reason,
      scope: req.projectId
        ? `project:${req.projectId}`
        : threadId
          ? `thread:${threadId}`
          : 'global',
      risk: riskOf(d),
      tier: d.tier,
      userAsked: d.authorization === 'user_typed' && req.provenance.taint.length === 0,
      optionsJson: JSON.stringify(options),
      alwaysScopesJson: JSON.stringify(options.includes('allow_always') ? scopes : []),
      reviewJson: null,
      status: 'pending',
      decision: null,
      alwaysScope: null,
      alwaysRef: null,
      denyReason: null,
      override: false,
      decidedBy: null,
      decidedDeviceId: null,
      decidedAt: null,
      handoffNote: null,
      handoffDoneAt: null,
      expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
      ruleId: d.ruleId ?? null,
      ruleLabel: ruleLabelOf(d, b.set),
      alwaysAllowManaged: !persistent && d.persistable,
      createdAt: now.toISOString(),
    };
    let settled = false;
    const outcome = new Promise<GateOutcome>((resolveOutcome) => {
      this.#waiters.set(id, {
        accountId: req.accountId,
        threadId,
        turnId: req.turnId,
        callId: req.callId,
        tier: d.tier,
        stage: 'decision',
        session: this.#sessionGrant(req, b),
        timer: null,
        settle: (o) => {
          if (settled) return;
          settled = true;
          resolveOutcome(o);
        },
      });
    });
    const onAbort = () => void this.#cancel(id, 'the turn was cancelled');
    try {
      await store.insertApproval(row);
      if (threadId) await this.#enterWaiting(threadId);
      await this.#o.audit.append({
        accountId: req.accountId,
        actor: 'system',
        kind: 'approval',
        action: 'approval.requested',
        resource: b.ctx.resource?.value ?? null,
        inputHash: b.argsHash,
        decision: null,
        threadId,
        turnId: req.turnId || null,
        detail: {
          approvalId: id,
          callId: req.callId,
          tool: req.tool.name,
          tier: d.tier,
          reason: d.reason,
        },
      });
      await this.#o.events.emit({
        name: 'approval.requested',
        accountId: req.accountId,
        actor: 'system',
        correlation: this.#correlation(req),
        payload: {
          approvalId: id,
          callId: req.callId,
          action: row.requestedAction,
          reason: d.reason,
          scope: row.scope,
          risk: row.risk,
          tier: d.tier,
        },
      });
      await this.#o.notifier
        .notify({
          accountId: req.accountId,
          kind: 'approval',
          title:
            d.tier === 'handoff_required' || d.effect === 'handoff'
              ? 'Your turn: a step needs you'
              : 'Approval needed',
          body: clip(row.requestedAction, 200),
          href: threadId ? `/chat/${threadId}?approval=${id}` : `/approvals/${id}`,
          dedupeKey: `approval:${id}`,
        })
        .catch((err: unknown) => this.#o.log?.warn('approval notification failed', { err }));
      const waiter = this.#waiters.get(id);
      if (waiter) {
        waiter.timer = setTimeout(() => void this.#expire(id), timeoutMs);
        waiter.timer.unref?.();
      }
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      return await outcome;
    } finally {
      const w = this.#waiters.get(id);
      if (w?.timer) clearTimeout(w.timer);
      signal.removeEventListener('abort', onAbort);
      this.#waiters.delete(id);
      if (threadId) await this.#leaveWaiting(threadId);
    }
  }

  async #enterWaiting(threadId: string): Promise<void> {
    const n = (this.#waitingThreads.get(threadId) ?? 0) + 1;
    this.#waitingThreads.set(threadId, n);
    if (n === 1) {
      await this.#o.store.db.transaction(() => {
        this.#o.store.db.raw
          .prepare(
            "UPDATE thread SET state = 'waiting_approval' WHERE id = ? AND state = 'streaming'",
          )
          .run(threadId);
      });
    }
  }

  async #leaveWaiting(threadId: string): Promise<void> {
    const n = (this.#waitingThreads.get(threadId) ?? 1) - 1;
    if (n > 0) {
      this.#waitingThreads.set(threadId, n);
      return;
    }
    this.#waitingThreads.delete(threadId);
    await this.#o.store.db.transaction(() => {
      this.#o.store.db.raw
        .prepare(
          "UPDATE thread SET state = 'streaming' WHERE id = ? AND state = 'waiting_approval'",
        )
        .run(threadId);
    });
  }

  /**
   * Answer an approval (POST /approvals). The first valid answer wins; a second is `conflict`.
   * Decisions outside the card's options are `validation`; "Always allow" while persistent grants
   * are off is `policy_denied`. Grants and rules commit with the decision.
   */
  async decide(
    accountId: string,
    body: DecideApprovalRequest,
    decidedBy = 'user',
  ): Promise<ApprovalView> {
    const { store } = this.#o;
    const row = await store.approvalRow(accountId, body.approvalId);
    if (row.status !== 'pending' || row.decision !== null) throw answered(row);
    if (
      body.decision === 'allow_always' &&
      !(await this.#o.setting('policy.allowPersistentGrants'))
    )
      throw new NovaError('policy_denied', '"Always allow" is turned off by your organization');
    const options = JSON.parse(row.optionsJson) as ApprovalDecisionKind[];
    if (!options.includes(body.decision))
      throw new NovaError('validation', `this approval does not offer ${body.decision}`, {
        details: { options },
      });
    if (body.decision !== 'allow_always' && body.alwaysScope)
      throw new NovaError('validation', 'alwaysScope goes only with allow_always');
    if (body.override && !row.reviewJson)
      throw new NovaError('validation', 'there is no reviewer verdict to override');
    const waiter = this.#waiters.get(row.id);
    const writes = this.#plan(accountId, row, body, waiter);
    const now = this.#now().toISOString();
    const denyReason =
      body.decision === 'deny_continue' || body.decision === 'deny_stop'
        ? (body.reason?.trim() ?? '')
        : null;
    await store.db.transaction(() => {
      const res = store.db.raw
        .prepare(
          `UPDATE approval SET status = ?, decision = ?, decided_by = ?, decided_at = ?,
             always_scope = ?, always_ref = ?, deny_reason = ?, override = ?
           WHERE id = ? AND status = 'pending' AND decision IS NULL`,
        )
        .run(
          // A handed-off approval stays pending until the step is marked done.
          body.decision === 'handoff' ? 'pending' : 'decided',
          body.decision,
          decidedBy,
          now,
          body.alwaysScope?.kind ?? null,
          writes.alwaysRef ?? null,
          denyReason,
          body.override ? 1 : 0,
          row.id,
        );
      if (Number(res.changes) === 0) throw answered({ ...row, decision: body.decision });
      store.insertSync(writes);
    });
    const decided = await store.approvalRow(accountId, row.id);
    const payload: Record<string, unknown> = {
      approvalId: row.id,
      decision: body.decision,
      decidedBy,
      override: body.override === true,
    };
    if (body.alwaysScope) payload.alwaysScope = body.alwaysScope;
    await this.#o.events.emit({
      name: 'approval.decided',
      accountId,
      actor: decidedBy === 'user' ? 'user' : 'system',
      correlation: this.#correlation({
        threadId: row.threadId ?? '',
        turnId: row.turnId ?? '',
        callId: row.toolCallId ?? '',
      }),
      payload,
    });
    await this.#o.audit.append({
      accountId,
      actor: decidedBy === 'user' ? 'user' : decidedBy,
      kind: 'approval',
      action: 'approval.decided',
      resource: row.toolName,
      inputHash: row.argsHash,
      decision: body.decision,
      threadId: row.threadId,
      turnId: row.turnId,
      detail: {
        approvalId: row.id,
        tier: row.tier,
        alwaysScope: body.alwaysScope?.kind ?? null,
        alwaysRef: writes.alwaysRef ?? null,
        grantId: writes.grant?.id ?? null,
        override: body.override === true,
      },
    });
    if (waiter) {
      const tier = row.tier ?? 'pre_approvable';
      switch (body.decision) {
        case 'allow_once':
        case 'allow_session':
        case 'allow_always':
          waiter.settle({ effect: 'allow', reason: 'you allowed it', tier, approvalId: row.id });
          break;
        case 'deny_continue':
          waiter.settle({
            effect: 'deny',
            reason: denyReason || 'you denied this action',
            tier,
            approvalId: row.id,
            stop: false,
          });
          break;
        case 'deny_stop':
          waiter.settle({
            effect: 'deny',
            reason: denyReason || 'you denied this action and stopped the run',
            tier,
            approvalId: row.id,
            stop: true,
          });
          break;
        case 'handoff':
          // The run waits until the user marks the step done (or cancels the turn).
          waiter.stage = 'handoff';
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.timer = null;
          break;
      }
    }
    return store.getApproval(accountId, decided.id);
  }

  /** The rule and grant an answer writes (validated before anything is stored). */
  #plan(
    accountId: string,
    row: ApprovalRow,
    body: DecideApprovalRequest,
    waiter: Waiter | undefined,
  ): Parameters<PolicyStore['insertSync']>[0] & { alwaysRef?: string } {
    const { store } = this.#o;
    const tool = row.toolName ?? '';
    const expiresAt = body.expiresInMinutes
      ? new Date(this.#now().getTime() + body.expiresInMinutes * 60_000).toISOString()
      : null;
    const projectId = row.scope?.startsWith('project:') ? row.scope.slice('project:'.length) : null;
    const ruleScope: Scope = projectId ? { kind: 'project', ref: projectId } : { kind: 'global' };
    if (body.decision === 'allow_session') {
      const session = waiter?.session ?? {
        match: { tool, argsHash: row.argsHash ?? '' },
        host: null,
        label: 'this exact call in this chat',
      };
      if (!row.threadId) throw new NovaError('validation', 'this approval is not in a chat');
      const grant: GrantRow = store.grantRow(accountId, {
        approvalId: row.id,
        duration: 'session',
        scope: { kind: 'session', ref: row.threadId },
        match: session.match,
        host: session.host,
        label: session.label,
        expiresAt,
      });
      return { grant };
    }
    if (body.decision !== 'allow_always' || !body.alwaysScope) return {};
    const offered = JSON.parse(row.alwaysScopesJson) as AlwaysScope[];
    const scope = body.alwaysScope;
    const suggestion = offered.find((s) => s.kind === scope.kind);
    if (!suggestion)
      throw new NovaError(
        'validation',
        `this approval does not offer "Always allow" for a ${scope.kind}`,
      );
    if (scope.kind === 'tool') {
      if (scope.tool !== tool)
        throw new NovaError('validation', `"Always allow" here covers ${tool} only`);
      const rule = store.ruleRow(accountId, {
        scopeKind: ruleScope.kind as 'global' | 'project',
        scopeRef: ruleScope.ref ?? null,
        match: { tool },
        effect: 'allow',
        label: `Always allow ${tool}`,
      });
      const grant = store.grantRow(accountId, {
        approvalId: row.id,
        ruleId: rule.id,
        duration: 'always',
        scope: ruleScope,
        match: { tool },
        label: `${tool} ${projectId ? 'in this project' : 'everywhere'}`,
        expiresAt,
      });
      return { rule, grant, alwaysRef: tool };
    }
    if (scope.kind === 'host') {
      if (suggestion.kind !== 'host' || scope.host.toLowerCase() !== suggestion.host.toLowerCase())
        throw new NovaError('validation', '"Always allow" here covers the requested host only');
      const host = suggestion.host;
      const rule = store.ruleRow(accountId, {
        scopeKind: 'global',
        match: { tool, resource: host },
        effect: 'allow',
        label: `Always allow ${tool} to reach ${host}`,
      });
      const grant = store.grantRow(accountId, {
        approvalId: row.id,
        ruleId: rule.id,
        duration: 'always',
        scope: { kind: 'global' },
        match: { tool },
        host,
        label: `${tool} on ${host}`,
        expiresAt,
      });
      return { rule, grant, alwaysRef: host };
    }
    const offeredRule = suggestion.kind === 'prefix_rule' ? suggestion.rule : null;
    const matchExamples = [
      ...new Set([...(scope.rule.matchExamples ?? []), ...(offeredRule?.matchExamples ?? [])]),
    ];
    const notMatchExamples = scope.rule.notMatchExamples?.length
      ? scope.rule.notMatchExamples
      : (offeredRule?.notMatchExamples ?? []);
    const command = store.commandRow(
      accountId,
      {
        scopeKind: ruleScope.kind as 'global' | 'project',
        scopeRef: ruleScope.ref ?? null,
        pattern: scope.rule.pattern,
        decision: 'allow',
        justification: 'Allowed from an approval card.',
        matchExamples,
        notMatchExamples,
        tools: [tool],
      },
      'user',
    );
    const words = scope.rule.pattern.map((p) => (typeof p === 'string' ? p : `{${p.join(',')}}`));
    const grant = store.grantRow(accountId, {
      approvalId: row.id,
      commandRuleId: command.id,
      duration: 'always',
      scope: ruleScope,
      match: { tool, command: scope.rule.pattern },
      label: `commands starting with ${words.join(' ')}`,
      expiresAt,
    });
    return { command, grant, alwaysRef: command.id };
  }

  /** The user finished a handed-off step (POST /approvals/:id/handoff-done). */
  async handoffDone(accountId: string, id: string, note?: string): Promise<ApprovalView> {
    const { store } = this.#o;
    const row = await store.approvalRow(accountId, id);
    if (row.decision !== 'handoff' || row.status === 'cancelled')
      throw new NovaError('conflict', 'this approval is not waiting for a handoff');
    if (row.handoffDoneAt || row.status !== 'pending')
      throw new NovaError('conflict', 'this step was already marked done');
    const now = this.#now().toISOString();
    await store.db.transaction(() => {
      const res = store.db.raw
        .prepare(
          `UPDATE approval SET status = 'decided', handoff_done_at = ?, handoff_note = ?
           WHERE id = ? AND decision = 'handoff' AND status = 'pending' AND handoff_done_at IS NULL`,
        )
        .run(now, note?.trim() || null, id);
      if (Number(res.changes) === 0)
        throw new NovaError('conflict', 'this step was already marked done');
    });
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'approval',
      action: 'approval.handoff_done',
      resource: row.toolName,
      decision: 'handoff',
      threadId: row.threadId,
      turnId: row.turnId,
      detail: { approvalId: id },
    });
    await this.#o.events.emit({
      name: 'approval.handoff_done',
      accountId,
      actor: 'user',
      correlation: this.#correlation({
        threadId: row.threadId ?? '',
        turnId: row.turnId ?? '',
        callId: row.toolCallId ?? '',
      }),
      payload: { approvalId: id },
    });
    const waiter = this.#waiters.get(id);
    if (waiter) {
      const out: GateOutcome = {
        effect: 'handoff',
        reason: 'you did this step',
        tier: row.tier ?? 'pre_approvable',
        approvalId: id,
      };
      if (note?.trim()) out.note = note.trim();
      waiter.settle(out);
    }
    return store.getApproval(accountId, id);
  }

  async #expire(id: string): Promise<void> {
    const w = this.#waiters.get(id);
    if (!w) return;
    const now = this.#now().toISOString();
    const changed = await this.#o.store.db.transaction(() => {
      const res = this.#o.store.db.raw
        .prepare(
          `UPDATE approval SET status = 'expired', decision = 'timeout', decided_by = 'system',
             decided_at = ? WHERE id = ? AND status = 'pending' AND decision IS NULL`,
        )
        .run(now, id);
      return Number(res.changes) > 0;
    });
    if (!changed) return;
    try {
      await this.#o.events.emit({
        name: 'approval.decided',
        accountId: w.accountId,
        actor: 'system',
        correlation: this.#correlation({
          threadId: w.threadId ?? '',
          turnId: w.turnId,
          callId: w.callId,
        }),
        payload: { approvalId: id, decision: 'timeout', decidedBy: 'system', override: false },
      });
      await this.#o.audit.append({
        accountId: w.accountId,
        actor: 'system',
        kind: 'approval',
        action: 'approval.decided',
        decision: 'timeout',
        threadId: w.threadId,
        turnId: w.turnId,
        detail: { approvalId: id, tier: w.tier },
      });
    } catch (err) {
      this.#o.log?.error('recording an approval timeout failed', { err, approvalId: id });
    }
    w.settle({
      effect: 'deny',
      reason: 'nobody answered the approval in time',
      tier: w.tier,
      approvalId: id,
      stop: true,
      timeout: true,
    });
  }

  async #cancel(id: string, reason: string): Promise<void> {
    const w = this.#waiters.get(id);
    if (!w) return;
    try {
      const changed = await this.#o.store.db.transaction(() => {
        const res = this.#o.store.db.raw
          .prepare("UPDATE approval SET status = 'cancelled' WHERE id = ? AND status = 'pending'")
          .run(id);
        return Number(res.changes) > 0;
      });
      if (changed) {
        await this.#o.events.emit({
          name: 'approval.cancelled',
          accountId: w.accountId,
          actor: 'system',
          correlation: this.#correlation({
            threadId: w.threadId ?? '',
            turnId: w.turnId,
            callId: w.callId,
          }),
          payload: { approvalId: id, reason },
        });
        await this.#o.audit.append({
          accountId: w.accountId,
          actor: 'system',
          kind: 'approval',
          action: 'approval.cancelled',
          threadId: w.threadId,
          turnId: w.turnId,
          detail: { approvalId: id, reason },
        });
      }
    } catch (err) {
      this.#o.log?.error('recording an approval cancel failed', { err, approvalId: id });
    }
    w.settle({ effect: 'deny', reason, tier: w.tier, approvalId: id, stop: true });
  }

  /** Cancel every waiting approval (Hub shutdown). */
  async close(): Promise<void> {
    await Promise.all(
      [...this.#waiters.keys()].map((id) => this.#cancel(id, 'the Hub is shutting down')),
    );
  }
}

function answered(row: ApprovalRow): NovaError {
  return new NovaError('conflict', 'this approval was already answered', {
    details: { status: row.status, decision: row.decision },
  });
}

/** Which decisions a card offers (docs/12 §4.1, FR-189). */
export function optionsFor(d: Decision, always: boolean): ApprovalDecisionKind[] {
  if (d.effect === 'handoff' || d.tier === 'handoff_required')
    return ['handoff', 'deny_continue', 'deny_stop'];
  if (d.tier === 'confirm_at_action' || !d.persistable)
    return ['allow_once', 'deny_continue', 'deny_stop', 'handoff'];
  return [
    'allow_once',
    'allow_session',
    ...(always ? (['allow_always'] as const) : []),
    'deny_continue',
    'deny_stop',
    'handoff',
  ];
}

/** The label of the rule behind a decision, for the card's "Rule" line (docs/04 §2.6). */
function ruleLabelOf(d: Decision, set: PolicySet): string | null {
  if (!d.ruleId) return null;
  const rule = [...(set.managed ?? []), ...(set.rules ?? [])].find((r) => r.id === d.ruleId);
  if (rule) return rule.label ?? null;
  const command = (set.commandRules ?? []).find((r) => r.id === d.ruleId);
  if (!command) return null;
  const words = command.pattern.map((p) => (typeof p === 'string' ? p : `{${p.join(',')}}`));
  return `Commands starting with ${words.join(' ')}`;
}

function riskOf(d: Decision): 'low' | 'medium' | 'high' {
  if (d.tier !== 'pre_approvable') return 'high';
  return d.effects.some((e) => MEDIUM_EFFECTS.has(e)) ? 'medium' : 'low';
}

function actionLabel(req: GateRequest, b: Built): string {
  const title = req.tool.title || req.tool.name;
  if (b.command !== undefined) return `Run \`${clip(redact(b.command), 160)}\``;
  if (req.resource) return `${title}: ${clip(redact(req.resource.value), 160)}`;
  return title;
}
