// The policy gate (FR-099, FR-100, FR-189; docs/12 §2-§4). `check` evaluates a call with the
// engine; allow and deny return at once. An `ask` (or a `handoff`) becomes an approval: a row,
// `approval.requested` on the thread's stream, a notification, and a wait for the user's answer,
// the timeout (recorded as `timeout`, never an allow) or the abort signal (`cancelled`). Every
// decision is audited with the input hash and the permission profile hash, never raw arguments.
//
// M4: the owning plugin's confirmed permissions join the engine's context (FR-045), a project's
// folders join the roots (FR-035), and after the deterministic result the `permission.request`
// hooks run (FR-197, docs/12 §2.3 step 7): they may tighten the decision, and may answer an
// `ask` the engine marked answerable when the hook is a user or managed hook, or a plugin hook
// whose plugin declares `permissions.hooks.answersAsks`.
//
// M5: a thread's mode sets the approval policy, the profile and the roots (a Code session's
// permission mode, FR-063, docs/12 §2.1) through `useThreadPolicy`; the mode name is recorded
// with each decision. Under the `review` policy an allowed consequential call then goes to the
// auto-reviewer (`useReviewer`, FR-085, docs/12 §6.1) after the hooks: its verdict can only
// tighten, every verdict is audited, and repeated denials trip a circuit breaker that stops the
// run (`review.breaker.tripped`). Sensitive tiers never reach the reviewer.
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
  type ReviewVerdict,
  type SettingKey,
  type SettingValue,
} from '@nova/shared';
import {
  applyHookAnswer,
  evaluate,
  stableHash,
  suggestPrefixRule,
  tighten,
  urlHosts,
  type ApprovalPolicy,
  type Decision,
  type DecisionSource,
  type DefaultEffect,
  type FsContext,
  type PluginPolicy,
  type PolicyContext,
  type PolicySet,
  type PolicyVerdict,
  type Scope,
  type Substrate,
} from '@nova/policy';
import { defaultRedactor, realpathLenient } from '@nova/security';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type {
  HookDispatcher,
  HookInput,
  HookOutcome,
  PluginPermissionSource,
  PluginPermissions,
} from '../extensions/types.ts';
import type {
  AgentRuleSource,
  Reviewer,
  ThreadPolicy,
  ThreadPolicySource,
} from '../runtime/types.ts';
import type {
  AuditRecord,
  AuditSink,
  GateOutcome,
  GateRequest,
  Notifier,
  ToolGate,
} from '../tools/types.ts';
import { limitDenial, type ToolLimitSource } from './limits.ts';
import { BREAKER_CONSECUTIVE, ReviewBreaker } from './reviewer-breaker.ts';
import { loadReviewContext, reviewVerdictSchema } from './reviewer.ts';
import { loadPermissionProfile, resolveToolRoots, type ProjectFolderSource } from './roots.ts';
import type { ApprovalRow, GrantMatch, GrantRow, PolicyStore } from './store.ts';

// The auto-reviewer and its breaker are part of the gate's public surface (approvals/index.ts).
export * from './reviewer.ts';
export * from './reviewer-breaker.ts';

/**
 * The audit kind of reviewer verdicts and overrides. docs/06 lists `review`; it becomes that
 * once AuditRecord['kind'] (tools/types.ts, lead-owned) has it. The action names are final.
 */
const REVIEW_AUDIT_KIND: AuditRecord['kind'] = 'review';

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
  /**
   * Other folders inside the data directory that roots may name (agents' computer folders,
   * `<dataDir>/computers`, FR-080). The rest of the data directory stays denied (docs/12 §7.2).
   */
  dataDirAllow?: string[];
  /** Defaults to the Hub user's home directory. */
  home?: string;
  log?: Logger;
  serverDefaults?: ServerDefaults;
  /** The sandbox substrate exec runs in (null: none or unknown, so `full` is refused). */
  substrate?: () => Substrate | null;
  hooks?: GateExtension[];
  /**
   * A verdict function under the `review` policy (tests; the page-action classifier later).
   * The M5 model reviewer is `autoReviewer`, which takes precedence when both are set.
   */
  reviewer?: GateExtension;
  /** The auto-reviewer (FR-085); also wired later with `useReviewer`. */
  autoReviewer?: Reviewer;
  /** A thread's mode policy (Code sessions, FR-063); also `useThreadPolicy`. */
  threadPolicy?: ThreadPolicySource;
  /** The rules of the agent that owns a thread (FR-084); also `useAgentPolicy`. */
  agentPolicy?: AgentRuleSource;
  /** `permission.request` hooks (FR-197); also wired later with `useHooks`. */
  permissionHooks?: HookDispatcher;
  /** The confirmed permissions of plugins (FR-045); also `usePluginPermissions`. */
  pluginPermissions?: PluginPermissionSource;
  /** A project's folders, roots for its chats (FR-035); also `useProjectFolders`. */
  projectFolders?: ProjectFolderSource;
  /** Override `policy.approvalTimeoutMinutes` (tests). */
  approvalTimeoutMs?: () => number;
  now?: () => Date;
}

type AlwaysScope = ApprovalView['alwaysScopes'][number];

/** The call a `permission.request` dispatch is about. */
interface HookCall {
  turnId: string;
  callId: string;
  signal: AbortSignal;
}

interface Built {
  ctx: PolicyContext;
  set: PolicySet;
  command: string | undefined;
  argsHash: string;
  profileHash: string;
  /** Set when the call cannot be evaluated safely (fail closed): its deny reason. */
  blocked: { reason: string; source: DecisionSource } | null;
  /** What the thread's mode set (a Code session's permission mode), if anything. */
  policy: ThreadPolicy | null;
}

/** What the auto-reviewer changed: the decision, the verdict for the card, and a breaker stop. */
interface Reviewed {
  decision: Decision;
  verdict: ReviewVerdict;
  stop: boolean;
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
  /** The sandbox substrate a thread's commands run in (a cloud thread's is the runner's, M7). */
  #substrate: (accountId: string | null, threadId: string | null) => Substrate | null;
  #hooks: HookDispatcher | undefined;
  #plugins: PluginPermissionSource | undefined;
  #onViolation: ((accountId: string, pluginId: string) => Promise<unknown>) | undefined;
  #folders: ProjectFolderSource | undefined;
  #autoReviewer: Reviewer | undefined;
  readonly #threadPolicies: ThreadPolicySource[] = [];
  #agentPolicy: AgentRuleSource | undefined;
  readonly #toolLimits: ToolLimitSource[] = [];
  readonly #breaker = new ReviewBreaker();

  constructor(opts: PolicyGateOptions) {
    this.#o = opts;
    this.#workspace = opts.workspaceDir ?? join(opts.dataDir, 'workspace');
    this.#home = opts.home ?? homedir();
    this.#serverDefaults = opts.serverDefaults;
    this.#substrate = opts.substrate ?? (() => null);
    this.#hooks = opts.permissionHooks;
    this.#plugins = opts.pluginPermissions;
    this.#folders = opts.projectFolders;
    this.#autoReviewer = opts.autoReviewer;
    if (opts.threadPolicy) this.#threadPolicies.push(opts.threadPolicy);
    this.#agentPolicy = opts.agentPolicy;
  }

  /**
   * Add a source of per-thread policy (a Code session's permission mode; Work run autonomy).
   * For a thread a source knows, its approval policy, profile and roots replace the settings;
   * the first source with a policy for the thread wins. A source that fails denies (FR-063).
   */
  useThreadPolicy(source: ThreadPolicySource): void {
    this.#threadPolicies.push(source);
  }

  /**
   * Wire the rules of agents (FR-084): for a thread an agent owns, its rules join the user rules
   * of the policy set. A source that fails denies (fail closed).
   */
  useAgentPolicy(source: AgentRuleSource): void {
    this.#agentPolicy = source;
  }

  /**
   * Add a source of per-thread tool limits (FR-053 a sub-agent's tool list, FR-217 a shared
   * thread, FR-045 an agent's plugins). Every source narrows; a tool outside any source's limits
   * is denied outright, and a source that fails denies (fail closed).
   */
  useToolLimits(source: ToolLimitSource): void {
    this.#toolLimits.push(source);
  }

  /** Wire the auto-reviewer of the `review` approval policy (FR-085, ADR-061). */
  useReviewer(reviewer: Reviewer): void {
    this.#autoReviewer = reviewer;
  }

  /** Forget the reviewer denials counted for a run or thread (the user resumed it). */
  resetReviewBreaker(key: string): void {
    this.#breaker.reset(key);
  }

  /** Wire the `permission.request` hooks (FR-197, docs/12 §2.3 step 7). */
  useHooks(dispatcher: HookDispatcher): void {
    this.#hooks = dispatcher;
  }

  /** Wire the confirmed plugin permissions (FR-045). */
  usePluginPermissions(source: PluginPermissionSource): void {
    this.#plugins = source;
  }

  /**
   * What happens to a plugin that asked for something it did not declare, beyond the deny:
   * the plugins area disables it (docs/08 §3.1). The gate also notifies the user.
   */
  usePluginViolations(fn: (accountId: string, pluginId: string) => Promise<unknown>): void {
    this.#onViolation = fn;
  }

  /** Wire a project's folders as tool roots (FR-035); the tools area must use the same. */
  useProjectFolders(source: ProjectFolderSource): void {
    this.#folders = source;
  }

  /** Wire per-MCP-server and per-plugin defaults (FR-048). */
  useServerDefaults(fn: ServerDefaults): void {
    this.#serverDefaults = fn;
  }

  /** Wire the sandbox substrate (the `full` profile needs a VM or container). */
  useSubstrate(fn: (accountId: string | null, threadId: string | null) => Substrate | null): void {
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
    const threadId = req.threadId || null;
    let blocked: Built['blocked'] = null;
    let policy: ThreadPolicy | null = null;
    try {
      // Asked with no thread too: an account that is not the owner gets only its own folder
      // from the team's fallback source, as in the tool scope (decision 5).
      policy = await this.#threadPolicy(req.accountId, threadId ?? '');
    } catch (err) {
      // Without the session's mode the gate cannot know what it allows: deny (fail closed).
      this.#o.log?.warn('thread policy unavailable', { err, threadId });
      blocked = {
        reason: "the session's permission mode could not be read, so the call was not allowed",
        source: 'builtin',
      };
    }
    // The session's profile governs its calls; the tool scope should carry the same id.
    const profileId = policy?.profileId ?? req.profile.id;
    if (policy?.profileId && policy.profileId !== req.profile.id)
      this.#o.log?.warn('tool scope profile differs from the thread policy', {
        scope: req.profile.id,
        thread: policy.profileId,
      });
    const { profile, fallback } = await loadPermissionProfile(store.db, req.accountId, profileId);
    if (fallback) this.#o.log?.warn('permission profile fell back to read-only', { fallback });
    const [rootSetting, egressAllow, egressDeny, approvalSetting, folders] = await Promise.all([
      setting('tools.roots'),
      setting('network.egressAllow'),
      // Hosts nothing may reach (FR-193): they deny a tool's network call too, not only the proxy.
      setting('network.egressDeny'),
      setting('tools.approvalPolicy', req.projectId),
      this.#projectFolders(req.projectId),
    ]);
    const resolved = resolveToolRoots({
      profile,
      // A session's folder (and worktree) replaces the settings' roots and the Nova workspace
      // (ThreadPolicy.roots): it is the session's only root, as in the tool scope.
      roots: policy?.roots ?? [...rootSetting, ...folders],
      workspaceDir: policy?.roots ? null : this.#workspace,
      home: this.#home,
    });
    const approvalPolicy: ApprovalPolicy = { kind: policy?.approvalPolicy ?? approvalSetting };
    if (policy?.autoAcceptEdits) approvalPolicy.autoAccept = ['file_edit'];
    const fs: FsContext = {
      entries: [
        ...resolved.roots.map((r) => ({ path: r.path, access: r.access })),
        ...resolved.deny.map((p) => ({ path: p, access: 'deny' as const })),
      ],
      dataDir: realpathLenient(this.#o.dataDir),
      dataDirAllow: [
        realpathLenient(this.#workspace),
        ...(this.#o.dataDirAllow ?? []).map((p) => realpathLenient(p)),
      ],
      home: realpathLenient(this.#home),
    };
    const set = await store.policySet(req.accountId, { threadId, home: this.#home });
    if (threadId && this.#agentPolicy) {
      try {
        const extra = await this.#agentPolicy.forThread(req.accountId, threadId);
        if (extra) {
          // An agent's rules are user rules: never the managed layer, whatever they say.
          set.rules = [
            ...(set.rules ?? []),
            ...extra.rules.map((r) => ({ ...r, source: 'user' as const })),
          ];
          set.commandRules = [
            ...(set.commandRules ?? []),
            ...extra.commandRules.map((r) => ({ ...r, source: 'user' as const })),
          ];
        }
      } catch (err) {
        this.#o.log?.warn('agent rules unavailable', { err, threadId });
        blocked ??= {
          reason: "the agent's rules could not be read, so the call was not allowed",
          source: 'builtin',
        };
      }
    }
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
      approvalPolicy,
      permissionProfile: {
        id: profile.id,
        hash: resolved.profile.hash,
        requiresSubstrate: resolved.requiresSubstrate,
      },
      provenance,
      tool: req.tool,
      args: req.args,
      argsHash,
      environment: {
        kind: 'hub',
        trusted: true,
        substrate: this.#substrate(req.accountId ?? null, req.threadId ?? null),
      },
      fs,
      egress: {
        allow: [...egressAllow, ...(resolved.network.allow ?? [])],
        deny: [...egressDeny, ...(resolved.network.deny ?? [])],
      },
    };
    // The mode name is a label for display and audit only (docs/12 §2.1).
    if (policy?.permissionMode) ctx.preset = { permissionMode: policy.permissionMode };
    if (command !== undefined) ctx.command = command;
    // Only rule matching reads this (M7 browser site levels per scope).
    if (req.ruleTool && req.ruleTool !== req.tool.name) ctx.ruleTool = req.ruleTool;
    // A relative path resolves where the tools resolve it: in the first root (a Code session's
    // folder, else the workspace).
    const resource = this.#canonicalResource(
      req.resource,
      resolved.roots[0]?.path ?? this.#workspace,
    );
    if (resource) ctx.resource = resource;
    try {
      const plugin = await this.#pluginPolicy(req);
      if (plugin) {
        ctx.plugin = plugin;
        // A plugin tool's URL argument is the call's network resource (cards, site rules).
        const host = urlHosts(req.args)[0];
        if (!ctx.resource && host) ctx.resource = { kind: 'host', value: host };
      }
    } catch (err) {
      // Its declared permissions cannot be read: the call is not allowed (fail closed).
      this.#o.log?.warn('plugin permissions unavailable', { err, tool: req.tool.name });
      blocked ??= {
        reason: "the plugin's permissions could not be read, so the call was not allowed",
        source: 'plugin',
      };
    }
    if (threadId && this.#toolLimits.length) {
      // The tool's plugin: its own tools, or the MCP servers it installed (FR-045).
      const owner = ctx.plugin?.pluginId ?? req.tool.pluginId ?? null;
      for (const source of this.#toolLimits) {
        try {
          const limits = await source.forThread(req.accountId, threadId);
          const why = limits ? limitDenial(limits, req.tool, owner) : null;
          if (why) {
            blocked ??= { reason: why, source: 'builtin' };
            break;
          }
        } catch (err) {
          this.#o.log?.warn('tool limits unavailable', { err, threadId });
          blocked ??= {
            reason: "the thread's tool limits could not be read, so the call was not allowed",
            source: 'builtin',
          };
          break;
        }
      }
    }
    return { ctx, set, command, argsHash, profileHash: resolved.profile.hash, blocked, policy };
  }

  /** The first source's policy for the thread; null when no source knows it. Throws on failure. */
  async #threadPolicy(accountId: string, threadId: string): Promise<ThreadPolicy | null> {
    for (const source of this.#threadPolicies) {
      const p = await source.forThread(accountId, threadId);
      if (p) return p;
    }
    return null;
  }

  /** The run a turn belongs to (turn.run_id), for the reviewer, the breaker and approvals. */
  #runOf(turnId: string): string | null {
    if (!turnId) return null;
    try {
      const row = this.#o.store.db.raw
        .prepare('SELECT run_id FROM turn WHERE id = ?')
        .get(turnId) as { run_id: string | null } | undefined;
      return row?.run_id ?? null;
    } catch {
      return null;
    }
  }

  async #projectFolders(projectId: string | null) {
    if (!projectId || !this.#folders) return [];
    try {
      return await this.#folders(projectId);
    } catch (err) {
      // Without them the project's folders are simply not roots (less access, never more).
      this.#o.log?.warn('project folders unavailable', { err, projectId });
      return [];
    }
  }

  /** The confirmed permissions of the plugin that owns the tool, as the engine reads them. */
  async #pluginPolicy(req: PreviewRequest): Promise<PluginPolicy | null> {
    // Nova's own tools belong to no plugin; MCP and plugin tools may (docs/08 §8).
    const t = req.tool;
    if (!this.#plugins || (t.source === 'builtin' && !t.pluginId && !t.serverId)) return null;
    const p = await this.#plugins.forTool(req.accountId, req.tool);
    if (!p) return null;
    return {
      pluginId: p.pluginId,
      network: [...p.network],
      tools: { ...p.tools },
      actionDefaults: { ...p.actionDefaults },
      ...(p.serverDefault ? { serverDefault: p.serverDefault } : {}),
    };
  }

  /** The engine's decision, or a fail-closed deny when the call could not be evaluated. */
  #evaluate(b: Built): Decision {
    const d = evaluate(b.ctx, b.set);
    if (!b.blocked || d.effect === 'deny') return d;
    const out: Decision = {
      ...d,
      effect: 'deny',
      reason: b.blocked.reason,
      source: b.blocked.source,
      persistable: false,
      review: false,
    };
    delete out.answerable;
    return out;
  }

  #canonicalResource(r: GateRequest['resource'], base: string): GateRequest['resource'] {
    if (!r || r.kind !== 'path' || r.value.includes('\0')) return r;
    const abs = isAbsolute(r.value) ? r.value : resolve(base, r.value);
    return { kind: 'path', value: realpathLenient(resolve(abs)) };
  }

  /**
   * Hooks and the reviewer (docs/12 §2.3 steps 7-8): extensions and the reviewer can only
   * tighten; `permission.request` hooks may also answer an eligible ask.
   */
  async #extend(
    req: PreviewRequest,
    decision: Decision,
    preview: boolean,
    call?: HookCall,
  ): Promise<Decision> {
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
      if (call) d = await this.#permissionHooks(req, d, call);
    }
    if (d.effect === 'allow' && d.review) {
      // The auto-reviewer runs in `check`, after these hooks (docs/12 §2.3 step 8); a preview
      // shows the engine's allow.
      if (this.#autoReviewer) return d;
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

  /**
   * Run the `permission.request` hooks (FR-197). Calls made by hooks fire no hooks, and nothing
   * changes a deny. A hook that blocks, or a dispatcher that fails, denies (fail closed).
   */
  async #permissionHooks(req: PreviewRequest, d: Decision, call: HookCall): Promise<Decision> {
    const hooks = this.#hooks;
    const origin = (req as PreviewRequest & { origin?: string }).origin;
    if (!hooks || origin === 'hook' || d.effect === 'deny') return d;
    // The call's id, and the first root it runs with as the hook's working directory.
    const input: HookInput = {
      accountId: req.accountId,
      threadId: req.threadId,
      turnId: call.turnId || null,
      projectId: req.projectId,
      tool: req.tool,
      args: defaultRedactor.redact(req.args ?? null),
      decision: { effect: d.effect, reason: d.reason, source: d.source },
    };
    if (call.callId) input.callId = call.callId;
    const cwd = req.roots?.[0]?.path;
    if (cwd) input.cwd = cwd;
    let out: HookOutcome;
    try {
      out = await hooks.dispatch('permission.request', input, call.signal);
    } catch (err) {
      this.#o.log?.warn('permission hooks failed', { err, tool: req.tool.name });
      return tighten(d, {
        effect: 'deny',
        reason: 'the permission hooks could not run, so the call was not allowed',
        source: 'hook',
      });
    }
    if (out.block)
      d = applyHookAnswer(d, {
        effect: 'deny',
        reason: out.block.reason,
        hookId: out.block.hookId,
        mayAnswer: false,
      });
    if (out.decision) {
      const mayAnswer =
        out.decision.effect === 'allow' &&
        d.answerable === true &&
        (await this.#hookMayAnswer(req.accountId, out.decision));
      d = applyHookAnswer(d, {
        effect: out.decision.effect,
        reason: out.decision.reason,
        hookId: out.decision.hookId,
        mayAnswer,
      });
    }
    return d;
  }

  /**
   * Whether the hook may answer an ask (docs/08 §4.1): managed and user hooks may, plugin hooks
   * only when their plugin declares `permissions.hooks.answersAsks`, project and extension hooks
   * never. The dispatcher reports `allow` only for hooks that may answer (the HookDispatcher
   * contract); a hook whose origin the gate can tell is checked again here.
   */
  async #hookMayAnswer(
    accountId: string,
    decision: NonNullable<HookOutcome['decision']>,
  ): Promise<boolean> {
    const origin = hookOrigin(decision);
    if (!origin) return true;
    if (origin.source === 'user' || origin.source === 'managed') return true;
    if (origin.source !== 'plugin' || !origin.pluginId || !this.#plugins) return false;
    let perms: PluginPermissions | null;
    try {
      perms = await this.#plugins.forTool(accountId, {
        name: `plugin:${origin.pluginId}.hook`,
        title: 'hook',
        description: '',
        source: 'plugin',
        pluginId: origin.pluginId,
        inputSchema: {},
      });
    } catch {
      return false;
    }
    return perms?.pluginId === origin.pluginId && perms.hooksAnswerAsks;
  }

  async preview(
    req: PreviewRequest,
  ): Promise<PolicyPreview & { userDefault: DefaultEffect | null }> {
    const b = await this.#build(req);
    const d = await this.#extend(req, this.#evaluate(b), true);
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
    let d = await this.#extend(req, this.#evaluate(b), false, {
      turnId: req.turnId,
      callId: req.callId,
      signal,
    });
    const threadId = req.threadId || null;
    const runId = this.#runOf(req.turnId);
    let verdict: ReviewVerdict | null = null;
    let breakerStop = false;
    // Step 8: the auto-reviewer, only for a consequential call the engine allowed under the
    // `review` policy; sensitive tiers ask or hand off before ever getting here.
    if (d.effect === 'allow' && d.review && d.tier === 'pre_approvable' && this.#autoReviewer) {
      const r = await this.#autoReview(this.#autoReviewer, req, b, d, runId, signal);
      d = r.decision;
      verdict = r.verdict;
      breakerStop = r.stop;
    }
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
    await this.#auditDecision(req, b, d, runId);
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
      if (d.violation && b.ctx.plugin) await this.#pluginViolation(req, b.ctx.plugin.pluginId, d);
      return { effect: 'deny', reason: d.reason, tier: d.tier, stop: breakerStop };
    }
    return this.#ask(req, b, d, signal, { verdict, runId });
  }

  // ---- auto-review (FR-085, ADR-061, docs/12 §6.1) -------------------------------------------

  /**
   * Ask the reviewer about an allowed call and apply its verdict, which can only tighten: allow
   * stays allow, ask becomes a card that says the reviewer asked, handoff hands off, and deny
   * denies with the rationale and an instruction to avoid similar actions. Anything the reviewer
   * returns outside the verdict schema, and any failure, is a deny. Repeated denials of one run
   * (or thread) trip the breaker: a deny with `stop` that interrupts the run.
   */
  async #autoReview(
    reviewer: Reviewer,
    req: GateRequest,
    b: Built,
    d: Decision,
    runId: string | null,
    signal: AbortSignal,
  ): Promise<Reviewed> {
    const reviewId = uuidv7();
    const threadId = req.threadId || null;
    const correlation: Record<string, string> = { ...this.#correlation(req) };
    if (runId) correlation.runId = runId;
    await this.#o.events.emit({
      name: 'review.started',
      accountId: req.accountId,
      actor: 'system',
      correlation,
      payload: { reviewId, callId: req.callId, attempt: 1 },
    });
    let context: { instructions: string[]; summary: string } = { instructions: [], summary: '' };
    try {
      context = loadReviewContext(this.#o.store.db, {
        threadId: req.threadId,
        turnId: req.turnId,
      });
    } catch (err) {
      // The reviewer then sees no instructions, which only makes it stricter.
      this.#o.log?.warn('review context unavailable', { err, threadId });
    }
    const started = Date.now();
    let raw: Awaited<ReturnType<Reviewer['review']>> & { model?: unknown };
    try {
      raw = await reviewer.review({
        accountId: req.accountId,
        threadId: req.threadId,
        runId,
        tool: req.tool,
        args: defaultRedactor.redact(req.args ?? null),
        decision: { reason: d.reason, tier: d.tier, effects: [...d.effects] },
        instructions: context.instructions,
        summary: context.summary,
        signal,
      });
    } catch (err) {
      this.#o.log?.warn('auto-reviewer failed', { err, tool: req.tool.name });
      raw = {
        outcome: 'deny',
        risk: 'high',
        userAuthorization: 'unknown',
        rationale: 'The auto-reviewer failed, so this action was denied.',
        attempts: 0,
        failed: true,
      };
    }
    const checked = reviewVerdictSchema.safeParse({
      outcome: raw.outcome,
      risk: raw.risk,
      userAuthorization: raw.userAuthorization,
      rationale: raw.rationale,
    });
    const failed = !checked.success || raw.failed;
    const verdict: ReviewVerdict = checked.success
      ? { ...checked.data, rationale: clip(redact(checked.data.rationale), 1000) }
      : {
          outcome: 'deny',
          risk: 'high',
          userAuthorization: 'unknown',
          rationale: 'The auto-reviewer answered outside its schema, so this action was denied.',
        };
    const model = typeof raw.model === 'string' ? raw.model : null;
    const durationMs = Date.now() - started;
    await this.#o.events.emit({
      name: 'review.completed',
      accountId: req.accountId,
      actor: 'system',
      correlation,
      payload: {
        reviewId,
        callId: req.callId,
        verdict,
        attempts: raw.attempts,
        durationMs,
        failedClosed: failed,
      },
    });
    await this.#o.audit.append({
      accountId: req.accountId,
      actor: 'system',
      kind: REVIEW_AUDIT_KIND,
      action: 'review.verdict',
      resource: b.ctx.resource?.value ?? null,
      inputHash: b.argsHash,
      decision: verdict.outcome,
      threadId,
      turnId: req.turnId || null,
      detail: {
        reviewId,
        callId: req.callId,
        tool: req.tool.name,
        runId,
        risk: verdict.risk,
        userAuthorization: verdict.userAuthorization,
        rationale: verdict.rationale,
        attempts: raw.attempts,
        failedClosed: failed,
        latencyMs: durationMs,
        model,
        tier: d.tier,
        permissionMode: b.policy?.permissionMode ?? null,
      },
    });

    const key = runId ?? threadId ?? `account:${req.accountId}`;
    const trip = this.#breaker.record(key, verdict.outcome === 'deny');
    if (trip) {
      await this.#breakerTripped(req, runId, trip);
      return {
        verdict,
        stop: true,
        decision: tighten(d, {
          effect: 'deny',
          reason:
            `the auto-reviewer denied this (${verdict.rationale}) and has now denied too many ` +
            'actions in this work, so it stopped until you look at it',
          source: 'reviewer',
        }),
      };
    }
    const why = verdict.rationale;
    switch (verdict.outcome) {
      case 'allow':
        return { verdict, stop: false, decision: { ...d, review: false } };
      case 'ask':
        return {
          verdict,
          stop: false,
          decision: tighten(d, {
            effect: 'ask',
            reason: `the auto-reviewer asked for your approval: ${why}`,
            source: 'reviewer',
          }),
        };
      case 'handoff':
        return {
          verdict,
          stop: false,
          decision: tighten(d, {
            effect: 'handoff',
            reason: `the auto-reviewer asked you to do this step yourself: ${why}`,
            source: 'reviewer',
          }),
        };
      case 'deny':
        return {
          verdict,
          stop: false,
          decision: tighten(d, {
            effect: 'deny',
            reason:
              `the auto-reviewer denied this: ${why} Do not retry this action or a substantively ` +
              'similar one; continue another way or tell the user what you need',
            source: 'reviewer',
          }),
        };
    }
  }

  /** The breaker interrupts the run: an event the runs area pauses on, an audit entry, a note. */
  async #breakerTripped(
    req: GateRequest,
    runId: string | null,
    trip: { consecutiveDenials: number; recentDenials: number; window: number },
  ): Promise<void> {
    const threadId = req.threadId || null;
    const correlation: Record<string, string> = { ...this.#correlation(req) };
    if (runId) correlation.runId = runId;
    await this.#o.events.emit({
      name: 'review.breaker.tripped',
      accountId: req.accountId,
      actor: 'system',
      correlation,
      payload: { runId, threadId, ...trip },
    });
    await this.#o.audit.append({
      accountId: req.accountId,
      actor: 'system',
      kind: REVIEW_AUDIT_KIND,
      action: 'review.breaker',
      decision: 'deny',
      threadId,
      turnId: req.turnId || null,
      detail: { runId, callId: req.callId, ...trip },
    });
    await this.#o.notifier
      .notify({
        accountId: req.accountId,
        kind: 'attention',
        title: 'Auto-review stopped this work',
        body:
          trip.consecutiveDenials >= BREAKER_CONSECUTIVE
            ? `It denied ${trip.consecutiveDenials} actions in a row. Review the work before it continues.`
            : `It denied ${trip.recentDenials} of the last ${trip.window} actions. Review the work before it continues.`,
        href: threadId ? `/chat/${threadId}` : '/approvals',
        dedupeKey: `review-breaker:${runId ?? threadId ?? req.accountId}`,
      })
      .catch((err: unknown) => this.#o.log?.warn('review breaker notification failed', { err }));
  }

  /** Deny, disable, notify (docs/20 defaults): a plugin that oversteps is turned off. */
  async #pluginViolation(req: GateRequest, pluginId: string, d: Decision): Promise<void> {
    let disabled = false;
    try {
      if (this.#onViolation) {
        await this.#onViolation(req.accountId, pluginId);
        disabled = true;
      }
    } catch (err) {
      this.#o.log?.warn('could not disable the plugin after an undeclared request', {
        err,
        pluginId,
      });
    }
    await this.#o.notifier
      .notify({
        accountId: req.accountId,
        kind: 'attention',
        title: disabled ? `Plugin ${pluginId} was turned off` : `Plugin ${pluginId} was blocked`,
        body: clip(`It tried to use ${req.tool.name} beyond its permissions: ${d.reason}.`, 200),
        href: '/settings/plugins',
        dedupeKey: `plugin-violation:${pluginId}`,
      })
      .catch((err: unknown) => this.#o.log?.warn('plugin violation notification failed', { err }));
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

  async #auditDecision(
    req: GateRequest,
    b: Built,
    d: Decision,
    runId: string | null,
  ): Promise<void> {
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
        hookId: d.hookId ?? null,
        reason: d.reason,
        authorization: d.authorization,
        taint: [...new Set(req.provenance.taint)],
        effects: d.effects,
        profileId: b.policy?.profileId ?? req.profile.id,
        profileHash: b.profileHash,
        // The approval policy evaluated and the preset it came from (docs/12 §2.1, FR-063).
        approvalPolicy: b.ctx.approvalPolicy.kind,
        autoAccept: b.ctx.approvalPolicy.autoAccept ?? [],
        permissionMode: b.ctx.preset?.permissionMode ?? null,
        runId,
      },
    });
  }

  // ---- approvals -------------------------------------------------------------------------

  /** Suggested "Always allow" scopes, narrowest first: the card preselects the first one. */
  #suggest(req: GateRequest, b: Built): AlwaysScope[] {
    const out: AlwaysScope[] = [];
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
    out.push({
      kind: 'tool',
      label: `This tool (${req.tool.name}) ${req.projectId ? 'in this project' : 'everywhere'}`,
      tool: req.tool.name,
    });
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

  async #ask(
    req: GateRequest,
    b: Built,
    d: Decision,
    signal: AbortSignal,
    extra: { verdict: ReviewVerdict | null; runId: string | null },
  ): Promise<GateOutcome> {
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
      runId: extra.runId,
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
      // The reviewer's verdict for the card (docs/12 §4.1); an Allow once over it is an override.
      reviewJson: extra.verdict ? JSON.stringify(extra.verdict) : null,
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
    if (body.override && body.decision !== 'allow_once')
      throw new NovaError(
        'validation',
        'a reviewer verdict can be overridden with Allow once only',
      );
    // Allowing an action the auto-reviewer asked about overrides its verdict (docs/12 §6.1).
    const override = row.reviewJson !== null && body.decision === 'allow_once';
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
          override ? 1 : 0,
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
      override,
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
        override,
      },
    });
    if (override)
      // The override is audited together with the verdict it overrode (docs/12 §4.1, §6.1).
      await this.#o.audit.append({
        accountId,
        actor: decidedBy === 'user' ? 'user' : decidedBy,
        kind: REVIEW_AUDIT_KIND,
        action: 'review.override',
        resource: row.toolName,
        inputHash: row.argsHash,
        decision: body.decision,
        threadId: row.threadId,
        turnId: row.turnId,
        detail: {
          approvalId: row.id,
          runId: row.runId,
          verdict: JSON.parse(row.reviewJson ?? 'null') as unknown,
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

const HOOK_SOURCES = new Set(['managed', 'user', 'project', 'plugin', 'extension']);

/**
 * Where a hook comes from: the dispatcher's own `source`/`pluginId` when it reports them, else
 * the canonical id `hook:<origin>.<hookId>` (docs/08 §8; origin `managed`, `user`, `project`, a
 * plugin id or an extension id); null when the id says neither.
 */
export function hookOrigin(
  decision: { hookId: string } & { source?: unknown; pluginId?: unknown },
): { source: string; pluginId: string | null } | null {
  if (typeof decision.source === 'string' && HOOK_SOURCES.has(decision.source))
    return {
      source: decision.source,
      pluginId: typeof decision.pluginId === 'string' ? decision.pluginId : null,
    };
  const m = /^hook:(.+)\.([a-z0-9][a-z0-9-]*)$/.exec(decision.hookId);
  if (!m) return null;
  const origin = m[1]!;
  if (origin === 'managed' || origin === 'user' || origin === 'project')
    return { source: origin, pluginId: null };
  // Plugin ids are reverse-DNS; an extension id that looks like one has no plugin permissions.
  return /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(origin)
    ? { source: 'plugin', pluginId: origin }
    : { source: 'extension', pluginId: null };
}
