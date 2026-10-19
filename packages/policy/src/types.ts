// Policy engine types (docs/12 §2-§4, §7; contracts/schemas/{policy-rule,command-rule,
// permission-profile,tool-descriptor}.json; FR-048, FR-099, FR-189, FR-190, FR-191).

export type Effect = 'allow' | 'ask' | 'handoff' | 'deny';

/** Severity order used to combine layers: a stricter effect always wins. */
export const SEVERITY: Record<Effect, number> = { allow: 0, ask: 1, handoff: 2, deny: 3 };

/** Effect classes (contracts/schemas/tool-descriptor.json `effects`). */
export type ActionEffect =
  | 'external_communication'
  | 'purchase'
  | 'account_change'
  | 'credential_change'
  | 'data_delete'
  | 'file_write'
  | 'exec'
  | 'network'
  | 'install'
  | 'security_bypass'
  | 'captcha'
  | 'policy_change'
  | 'secret_access';

export type ToolSource = 'builtin' | 'mcp' | 'plugin' | 'computer' | 'browser' | 'page' | 'device';

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  requiresNetwork?: boolean;
  requiresUser?: boolean;
  costClass?: 'free' | 'metered';
  /** Per-action permission class (FR-045). */
  action?: ActionClass;
}

/** The per-action permission classes of plugin tools (FR-045, docs/08 §3.1). */
export type ActionClass = 'read' | 'write' | 'send' | 'delete' | 'execute';

/** The parts of a tool descriptor the engine reads. */
export interface ToolDescriptor {
  name: string;
  source: ToolSource;
  title?: string;
  description?: string;
  annotations?: ToolAnnotations;
  /** What the call does in the world; drives the confirmation tiers (FR-189). */
  effects?: ActionEffect[];
  pluginId?: string;
  serverId?: string;
  /**
   * Set by Nova for an MCP tool the owner declared read-only in Settings (the server's
   * `readOnlyTools`); never from the server's hints. See `isReadOnly` for what it can cover.
   */
  userReadOnly?: boolean;
}

export type ScopeKind =
  'global' | 'project' | 'thread' | 'run' | 'session' | 'agent' | 'tool' | 'plugin' | 'site';

export interface Scope {
  kind: ScopeKind;
  ref?: string;
}

/** Where an instruction or a piece of context came from (docs/12 §2, FR-189). */
export type Origin =
  | 'user'
  | 'tool'
  | 'page'
  | 'file'
  | 'email'
  | 'channel'
  | 'mcp'
  | 'plugin'
  | 'memory'
  | 'capture'
  | 'external_agent'
  | 'system';

/** Intent provenance (FR-189, docs/12 §2.2). Only `userInstruction` authorizes. */
export interface Provenance {
  /** The authenticated user typed (or dictated) the instruction behind this call. */
  userInstruction?: { messageId: string; accountId: string };
  /** Untrusted origins that shaped the arguments. */
  taint: Origin[];
  /** External agents the user named for this task (FR-194). */
  namedAgents?: string[];
}

export type ApprovalPolicyKind = 'ask_always' | 'defaults' | 'review' | 'never_ask';

/** When to ask (docs/12 §2.1, ADR-059). */
export interface ApprovalPolicy {
  kind: ApprovalPolicyKind;
  autoAccept?: 'file_edit'[];
}

export type Substrate = 'os_sandbox' | 'container' | 'micro_vm' | 'cloud';

export type FsAccess = 'read' | 'write' | 'deny';

/** A filesystem grant the turn's profile resolved to (absolute, canonical paths). */
export interface FsEntry {
  path: string;
  access: FsAccess;
}

/** What the engine knows about the filesystem for this call (FR-190, docs/12 §7.1-§7.2). */
export interface FsContext {
  /** Roots and denied paths from the permission profile, the turn's roots and settings. */
  entries: FsEntry[];
  /** The Nova data directory: denied, except `dataDirAllow` (the Hub workspace). */
  dataDir?: string;
  dataDirAllow?: string[];
  /** The user's home directory; credential locations under it are denied. */
  home?: string;
}

export interface NetworkBlock {
  mode: 'off' | 'allowlist' | 'limited';
  allow?: string[];
  deny?: string[];
  socks5?: boolean;
  allowLocalBinding?: boolean;
}

export interface PolicyContext {
  actor: { kind: 'user' } | { kind: 'agent'; id: string };
  /** The scopes this call happens in, most specific first (e.g. session, thread, project, global). */
  scopes: Scope[];
  mode?: 'chat' | 'work' | 'code' | 'agent';
  /** Labels for the UI and audit only; the engine evaluates the two axes below. */
  preset?: {
    permissionMode?: 'manual' | 'accept_edits' | 'plan' | 'auto' | 'bypass';
    autonomy?: 'ask_first' | 'standard' | 'autonomous';
  };
  approvalPolicy: ApprovalPolicy;
  permissionProfile: { id: string; hash: string; requiresSubstrate?: 'vm_or_container' | null };
  provenance: Provenance;
  tool: ToolDescriptor;
  args?: unknown;
  /** SHA-256 of the canonical arguments (identical-call grants, FR-100). */
  argsHash?: string;
  /** The command line of an exec tool (exec.run `cmd`, exec.write `text`), FR-191. */
  command?: string;
  resource?: { kind: 'path' | 'host' | 'account'; value: string };
  /** The counterpart when it is an external AI agent (FR-194). */
  counterpart?: { externalAgent: boolean; id: string };
  environment: { kind: string; trusted: boolean; substrate: Substrate | null };
  fs: FsContext;
  /** Hosts reachable without asking and hosts always denied (FR-102). */
  egress?: { allow?: string[]; deny?: string[] };
  /** The confirmed permissions of the plugin that owns the tool (FR-045). */
  plugin?: PluginPolicy;
  /**
   * The name policy rules match instead of `tool.name` (their `tool` match and `tool` scope),
   * when it differs: a browser write under a project's or agent's site level
   * (M7) is matched by that level's rule, while hooks, limits, grants, audit and events still
   * see the tool's own name.
   */
  ruleTool?: string;
}

/**
 * A plugin's permissions as the user confirmed them at install (FR-045, docs/08 §3.1,
 * contracts/schemas/plugin-manifest.json `permissions`). Declared permissions are enforced: a
 * host the plugin did not declare is denied, an undeclared tool asks, and the per-tool and
 * per-action defaults apply at step 4, below the user's own defaults.
 */
export interface PluginPolicy {
  pluginId: string;
  /** Hosts its tools may reach (exact or `*.example.com`); any other host is denied. */
  network: readonly string[];
  /** Per-tool action class and default, keyed by canonical (or bare) tool name. */
  tools: Readonly<Record<string, { action: ActionClass; default?: DefaultEffect }>>;
  /** Defaults per action class; a per-tool default overrides them. */
  actionDefaults: Partial<Record<ActionClass, DefaultEffect>>;
  /** The manifest default of the plugin server the tool comes from; below the two above. */
  serverDefault?: DefaultEffect;
}

/** A policy rule effect; `act_on_request` is "take action when you say so" (docs/12 §3). */
export type RuleEffect = Effect | 'act_on_request';

export interface RuleMatch {
  tool?: string[];
  source?: ToolSource[];
  resource?: {
    kind?: 'path' | 'host' | 'account';
    host?: string;
    pathPrefix?: string;
    pattern?: string;
  };
  effect?: ActionEffect[];
  readOnly?: boolean;
}

export type RuleOrigin = 'user' | 'managed' | 'plugin';

export interface PolicyRule {
  id: string;
  label?: string;
  /** Lower numbers are evaluated first among rules of the same scope specificity. Default 100. */
  priority?: number;
  enabled?: boolean;
  source?: RuleOrigin;
  scope: Scope;
  match: RuleMatch;
  effect: RuleEffect;
}

/** A command prefix element: a literal word or a list of alternatives (FR-191). */
export type CommandPatternElement = string | readonly string[];
export type CommandExample = string | readonly string[];

export interface CommandRule {
  id: string;
  scope: { kind: 'global' | 'project' | 'thread' | 'session' | 'agent'; ref?: string };
  /** Exec tools the rule applies to; default `["exec.run"]` (exec.write lines too). */
  tools?: string[];
  pattern: readonly CommandPatternElement[];
  decision: 'allow' | 'ask' | 'deny';
  priority?: number;
  justification?: string;
  hostExecutables?: string[];
  matchExamples: readonly CommandExample[];
  notMatchExamples: readonly CommandExample[];
  source: RuleOrigin;
  pluginId?: string;
  enabled?: boolean;
}

/** A remembered approval (docs/12 §4.2). "Always allow" grants are represented by their rule. */
export interface PolicyGrant {
  id: string;
  scope: Scope;
  /** Tool name or glob. */
  tool: string;
  host?: string;
  /** For exec tools: the command prefix the grant covers (allow semantics, §3.1). */
  command?: readonly CommandPatternElement[];
  /** An identical-call grant (same tool and argument hash). */
  argsHash?: string;
  label?: string;
}

export type DefaultEffect = 'allow' | 'ask' | 'deny';

export interface PolicySet {
  /** Managed policy rules (docs/12 §10); evaluated before user rules. */
  managed?: PolicyRule[];
  /** User (and plugin) rules. */
  rules?: PolicyRule[];
  /** Command prefix rules of every source; `source: 'managed'` ones join the managed layer. */
  commandRules?: CommandRule[];
  /** Active remembered grants (expired and revoked ones are filtered by the caller). */
  grants?: PolicyGrant[];
  /** User-set per-tool defaults, keyed by tool name or glob (e.g. "mcp:linear.*"). */
  toolDefaults?: Record<string, DefaultEffect>;
  /** User-set per-MCP-server / per-plugin defaults, keyed by server or plugin id. */
  serverDefaults?: Record<string, DefaultEffect>;
}

export type ConfirmationTier = 'handoff_required' | 'confirm_at_action' | 'pre_approvable';

export type DecisionSource =
  | 'builtin'
  | 'managed'
  | 'rule'
  | 'grant'
  | 'tool_default'
  | 'approval_policy'
  | 'fallback'
  | 'plugin'
  | 'user_action'
  | 'hook'
  | 'reviewer';

export interface Decision {
  effect: Effect;
  /** The "why" on the approval card. */
  reason: string;
  tier: ConfirmationTier;
  source: DecisionSource;
  ruleId?: string;
  grantId?: string;
  /** The most specific scope of the call (what "Always allow" would default to). */
  scope: Scope;
  /** False: no session or "always" option may be offered (confirm_at_action, handoff, rules). */
  persistable: boolean;
  /** An allowed consequential action that must pass the auto-reviewer (FR-085). */
  review: boolean;
  /** Whether the authenticated user typed the instruction behind the call (FR-189). */
  authorization: 'user_typed' | 'none';
  /** Effect classes the engine used: declared ones plus any inferred for untrusted tools. */
  effects: ActionEffect[];
  /** Set when an `ask` came from a user-set default or rule, which approval policies keep. */
  userSet?: boolean;
  /**
   * A permission hook may answer this `ask` with allow (FR-197, docs/12 §2.3 step 7): it came
   * from a user rule, a per-tool default or plugin permissions (steps 3-4), and no built-in
   * floor (tier, intent provenance, network allowlist) asks as well.
   */
  answerable?: boolean;
  /** The hook that decided, when `source` is `hook`. */
  hookId?: string;
  /**
   * A plugin asked for something it did not declare (FR-045, docs/08 §3.1): the call is denied,
   * and the caller disables the plugin and tells the user.
   */
  violation?: 'undeclared_host';
}

/** A hook (M4) or reviewer (M5) verdict; it can only tighten a decision (docs/12 §2.3). */
export interface PolicyVerdict {
  effect: Effect;
  reason: string;
  source: 'hook' | 'reviewer';
}

/** What a `permission.request` hook answered (FR-197); see `applyHookAnswer`. */
export interface HookAnswer {
  effect: Effect;
  reason: string;
  hookId: string;
  /**
   * The hook may answer asks: user and managed hooks, and plugin hooks whose plugin declares
   * `permissions.hooks.answersAsks`. Project hooks never may (docs/08 §4.1).
   */
  mayAnswer: boolean;
}
