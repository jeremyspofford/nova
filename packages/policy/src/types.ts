// Policy engine types (docs/12 §2, contracts/schemas/policy-rule.json, FR-099, FR-189).

export type Effect = 'allow' | 'ask' | 'handoff' | 'deny';

/** Severity order used to combine layers: a stricter effect always wins. */
export const SEVERITY: Record<Effect, number> = { allow: 0, ask: 1, handoff: 2, deny: 3 };

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

export type ToolSource = 'builtin' | 'mcp' | 'plugin' | 'computer';

export interface ToolAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  requiresNetwork?: boolean;
  requiresUser?: boolean;
  costClass?: 'free' | 'metered';
}

export interface ToolDescriptor {
  name: string;
  source: ToolSource;
  annotations?: ToolAnnotations;
  /** What the call does in the world; drives built-in safety tiers. */
  effects?: ActionEffect[];
  pluginId?: string;
  serverId?: string;
}

export type ScopeKind =
  'global' | 'project' | 'thread' | 'run' | 'session' | 'agent' | 'tool' | 'plugin' | 'site';

export interface Scope {
  kind: ScopeKind;
  ref?: string;
}

/** Where the instruction behind this action came from (FR-189 intent provenance). */
export type IntentSource =
  | 'user_typed'
  | 'user_voice'
  | 'tool'
  | 'page'
  | 'file'
  | 'channel'
  | 'capture'
  | 'schedule'
  | 'agent';

export type PermissionMode = 'manual' | 'accept_edits' | 'plan' | 'auto' | 'bypass';
export type Autonomy = 'ask_first' | 'standard' | 'autonomous';

export interface PolicyContext {
  actor: { kind: 'user' } | { kind: 'agent'; id: string };
  /** The scopes this call happens in, most specific first (e.g. session, project, global). */
  scopes: Scope[];
  mode?: 'chat' | 'work' | 'code' | 'agent';
  autonomy?: Autonomy;
  permissionMode?: PermissionMode;
  tool: ToolDescriptor;
  args?: unknown;
  resource?: { kind: 'path' | 'host' | 'account'; value: string };
  environment: { kind: string; trusted: boolean; sandboxed: boolean };
  intent: { source: IntentSource; requestActive?: boolean };
  /** Paths the action may touch (resolved by the caller); writes outside are denied. */
  allowedRoots?: string[];
  /** Hosts reachable without asking; checked when the tool needs the network. */
  egressAllow?: string[];
}

export type CustomRuleEffect = 'act' | 'act_on_request' | 'ask' | 'handoff' | Effect;

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

export interface PolicyRule {
  id: string;
  label?: string;
  /** Lower numbers are evaluated first. Default 100. */
  priority?: number;
  enabled?: boolean;
  scope: Scope;
  match: RuleMatch;
  effect: CustomRuleEffect;
}

export type ConfirmationTier = 'handoff_required' | 'confirm_at_action' | 'pre_approvable';

export type Layer = 'builtin' | 'managed' | 'custom' | 'tool_default' | 'mode' | 'fallback';

export interface Decision {
  effect: Effect;
  reason: string;
  layer: Layer;
  tier: ConfirmationTier;
  ruleId?: string;
  /** Scope an "Always allow" from this decision would apply to. */
  scope?: Scope;
}

export interface PolicySet {
  managed?: PolicyRule[];
  custom?: PolicyRule[];
  /** Per-tool default effects, keyed by tool name or glob (e.g. "mcp:linear.*"). */
  toolDefaults?: Record<string, Effect>;
}
