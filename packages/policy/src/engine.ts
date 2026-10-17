// The policy engine (docs/12 §2, FR-048, FR-099, FR-189, FR-190, FR-191). Pure and deterministic:
// the same context and policy set always give the same decision. Steps (docs/12 §2.3):
//   1. Built-in safety: hard denies (agent self-modification, secret access, unnamed external
//      agents, protected and out-of-profile paths, denied hosts, `full` outside a VM or
//      container) and the confirmation tier from the action's effect classes. `handoff_required`
//      and `confirm_at_action` are floors nothing can pre-approve.
//   2. Managed policy rules, then 3. user rules (policy and command prefix rules, most specific
//      scope first, then priority), then remembered grants. Any matching deny wins outright.
//   4. Per-tool and per-server defaults the user set, 5. the approval policy, 6. the fallback
//      (read-only actions allow, everything else asks).
// Intent provenance: only a typed user instruction authorizes. Without one, a consequential
// action asks unless a standing rule or grant covers it; any taint stops "act on request" rules.
// Hooks (M4) and the reviewer (M5) come after, through `tighten`, which can only tighten.
import { effectiveEffects, isReadOnly, writesPath } from './classify.ts';
import { commandCoveredBy, evaluateCommand } from './command.ts';
import { globMatch, hostMatch, isWithinPath } from './match.ts';
import { isProtectedAncestor, pathAccess, type PathCheck } from './paths.ts';
import { isolatedSubstrate } from './profiles.ts';
import type {
  ActionEffect,
  CommandRule,
  ConfirmationTier,
  Decision,
  DefaultEffect,
  Effect,
  PolicyContext,
  PolicyGrant,
  PolicyRule,
  PolicySet,
  PolicyVerdict,
  Scope,
  ScopeKind,
} from './types.ts';
import { SEVERITY } from './types.ts';

const HANDOFF_EFFECTS: readonly ActionEffect[] = [
  'credential_change',
  'security_bypass',
  'captcha',
];

const SCOPE_SPECIFICITY: Record<ScopeKind, number> = {
  site: 6,
  tool: 6,
  plugin: 6,
  session: 5,
  run: 5,
  thread: 5,
  agent: 4,
  project: 3,
  global: 1,
};

type Step = Pick<Decision, 'effect' | 'reason' | 'source'> & {
  ruleId?: string;
  grantId?: string;
  userSet?: boolean;
  /** The rule or grant names the call's host (it satisfies the network allowlist). */
  namesHost?: boolean;
};

interface Candidate extends Step {
  layer: 'managed' | 'user';
  allowLike: boolean;
  specificity: number;
  priority: number;
  id: string;
  /** A user-created allow that names the message recipient (docs/12 §2.2). */
  namesRecipient: boolean;
}

export function evaluate(ctx: PolicyContext, set: PolicySet = {}): Decision {
  const effects = effectiveEffects(ctx.tool);
  const readOnly = isReadOnly(ctx.tool, effects);
  const authorization = ctx.provenance.userInstruction ? 'user_typed' : 'none';
  const scope: Scope = ctx.scopes[0] ?? { kind: 'global' };
  const path = ctx.resource?.kind === 'path' ? pathAccess(ctx.resource.value, ctx.fs) : null;
  const candidates = [
    ...ordered([
      ...policyCandidates(ctx, set.managed ?? [], 'managed', effects, readOnly),
      ...commandCandidates(ctx, set.commandRules ?? [], 'managed'),
    ]),
    ...ordered([
      ...policyCandidates(ctx, set.rules ?? [], 'user', effects, readOnly),
      ...commandCandidates(ctx, set.commandRules ?? [], 'user'),
    ]),
  ];
  const tier = tierFor(ctx, effects, candidates, path);
  const base = {
    tier: tier.tier,
    scope,
    authorization,
    effects,
    review: false,
  } as const;

  // 1. Built-in safety: hard denies.
  const hard = hardDeny(ctx, effects, readOnly, path);
  if (hard) return { ...base, effect: 'deny', reason: hard, source: 'builtin', persistable: false };

  // 2-6. Layers.
  const deny = candidates.find((c) => c.effect === 'deny');
  const grant = (set.grants ?? []).find((g) => grantMatches(g, ctx));
  const decision: Step =
    deny ??
    candidates.find((c) => c.layer === 'managed') ??
    candidates.find((c) => c.layer === 'user') ??
    (grant ? grantDecision(grant, ctx) : null) ??
    defaults(ctx, set, effects, readOnly, path);

  // Floors: the tier is locked; provenance and the network allowlist yield to standing
  // authorization (an allow from a rule or grant; for hosts, one that names the host).
  const standing =
    decision.effect === 'allow' &&
    (decision.source === 'managed' || decision.source === 'rule' || decision.source === 'grant');
  const floors: { effect: Effect; reason: string }[] = [];
  if (tier.tier === 'handoff_required') floors.push({ effect: 'handoff', reason: tier.reason });
  if (tier.tier === 'confirm_at_action') floors.push({ effect: 'ask', reason: tier.reason });
  if (!readOnly && authorization === 'none' && !standing) {
    const from = [...new Set(ctx.provenance.taint)].join(', ');
    floors.push({
      effect: 'ask',
      reason: from
        ? `the request came from ${from} content, which cannot authorize actions`
        : 'no instruction from you authorizes this action',
    });
  }
  const host = ctx.resource?.kind === 'host' ? ctx.resource.value : null;
  if (
    !readOnly &&
    host &&
    ctx.tool.annotations?.requiresNetwork === true &&
    !(ctx.egress?.allow ?? []).some((p) => hostMatch(p, host)) &&
    !(standing && decision.namesHost === true)
  ) {
    floors.push({ effect: 'ask', reason: `${host} is not on the network allowlist` });
  }
  let final: Step = decision;
  for (const f of floors) {
    if (SEVERITY[f.effect] > SEVERITY[final.effect])
      final = { effect: f.effect, reason: f.reason, source: 'builtin' };
  }
  const persistable =
    tier.tier === 'pre_approvable' && final.source !== 'managed' && final.source !== 'rule';
  const out: Decision = {
    ...base,
    effect: final.effect,
    reason: final.reason,
    source: final.source,
    persistable,
    review:
      final.effect === 'allow' &&
      !readOnly &&
      ctx.approvalPolicy.kind === 'review' &&
      ctx.actor.kind === 'agent',
  };
  if (final.ruleId) out.ruleId = final.ruleId;
  if (final.grantId) out.grantId = final.grantId;
  if (final.userSet) out.userSet = true;
  return out;
}

/**
 * Apply a hook or reviewer verdict (docs/12 §2.3 steps 7-8): the stricter of the two wins, and a
 * verdict can never loosen a decision.
 */
export function tighten(decision: Decision, verdict: PolicyVerdict): Decision {
  if (SEVERITY[verdict.effect] <= SEVERITY[decision.effect]) return decision;
  return {
    ...decision,
    effect: verdict.effect,
    reason: verdict.reason,
    source: verdict.source,
    review: false,
    persistable: false,
  };
}

function tierFor(
  ctx: PolicyContext,
  effects: readonly ActionEffect[],
  candidates: readonly Candidate[],
  path: PathCheck | null,
): { tier: ConfirmationTier; reason: string } {
  const has = (e: ActionEffect) => effects.includes(e);
  if (ctx.tool.annotations?.requiresUser === true || HANDOFF_EFFECTS.some(has))
    return { tier: 'handoff_required', reason: 'you need to do this step yourself' };
  if (has('purchase'))
    return { tier: 'confirm_at_action', reason: 'purchases and payments are confirmed every time' };
  if (has('account_change'))
    return {
      tier: 'confirm_at_action',
      reason: 'new accounts, permissions, API keys and OAuth grants are confirmed every time',
    };
  if (has('install'))
    return { tier: 'confirm_at_action', reason: 'installing software is confirmed every time' };
  if (has('data_delete') && path?.access !== 'write')
    return {
      tier: 'confirm_at_action',
      reason: 'deleting data outside the project is confirmed every time',
    };
  if (has('external_communication') && !candidates.some((c) => c.allowLike && c.namesRecipient))
    return {
      tier: 'confirm_at_action',
      reason: 'messages to others are confirmed every time unless a rule you made names them',
    };
  return { tier: 'pre_approvable', reason: '' };
}

function hardDeny(
  ctx: PolicyContext,
  effects: readonly ActionEffect[],
  readOnly: boolean,
  path: PathCheck | null,
): string | null {
  const agent = ctx.actor.kind === 'agent';
  if (agent && effects.includes('policy_change'))
    return 'agents cannot change policy, safety, permission or audit settings';
  if (agent && effects.includes('secret_access')) return 'secret values are never given to agents';
  if (
    ctx.counterpart?.externalAgent === true &&
    !(ctx.provenance.namedAgents ?? []).includes(ctx.counterpart.id)
  )
    return `you did not name the external agent ${ctx.counterpart.id} for this task`;
  if (
    ctx.permissionProfile.requiresSubstrate === 'vm_or_container' &&
    !isolatedSubstrate(ctx.environment.substrate)
  )
    return `the ${ctx.permissionProfile.id} profile runs only inside a VM or container`;
  if (path && ctx.resource) {
    const writes = writesPath(ctx.tool, effects) && !readOnly;
    if (path.access === 'deny') return path.reason;
    if (writes && path.access !== 'write')
      return path.reason || 'this folder is read-only for tools';
    if (!writes && path.access === 'none') return path.reason;
    const deletes = effects.includes('data_delete') || ctx.tool.annotations?.action === 'delete';
    if (deletes && isProtectedAncestor(ctx.resource.value, ctx.fs))
      return 'deleting this would remove a protected folder or a whole root';
  }
  if (ctx.resource?.kind === 'host') {
    const host = ctx.resource.value;
    if ((ctx.egress?.deny ?? []).some((p) => hostMatch(p, host)))
      return `${host} is on the network deny list`;
  }
  return null;
}

function ordered(cs: Candidate[]): Candidate[] {
  return cs.sort(
    (a, b) =>
      b.specificity - a.specificity ||
      a.priority - b.priority ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function policyCandidates(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
  layer: 'managed' | 'user',
  effects: readonly ActionEffect[],
  readOnly: boolean,
): Candidate[] {
  const actOk = ctx.provenance.userInstruction !== undefined && ctx.provenance.taint.length === 0;
  return rules
    .filter(
      (r) =>
        r.enabled !== false && scopeApplies(r.scope, ctx) && ruleMatches(r, ctx, effects, readOnly),
    )
    .map((rule) => {
      let effect: Effect;
      let reason = rule.label
        ? `rule "${rule.label}"`
        : `${layer === 'managed' ? 'managed' : 'your'} rule`;
      if (rule.effect === 'act_on_request') {
        effect = actOk ? 'allow' : 'ask';
        if (!actOk) reason = `${reason} acts only when you ask for it`;
      } else {
        effect = rule.effect;
      }
      const host = ctx.resource?.kind === 'host' ? ctx.resource.value : null;
      return {
        layer,
        effect,
        reason,
        source: layer === 'managed' ? 'managed' : 'rule',
        ruleId: rule.id,
        userSet: true,
        allowLike: effect === 'allow',
        specificity: SCOPE_SPECIFICITY[rule.scope.kind],
        priority: rule.priority ?? 100,
        id: rule.id,
        namesRecipient:
          layer === 'user' && (rule.source ?? 'user') === 'user' && namesRecipient(rule),
        namesHost:
          host !== null &&
          ((rule.scope.kind === 'site' && rule.scope.ref !== undefined && rule.scope.ref !== '*') ||
            (rule.match.resource?.host !== undefined && rule.match.resource.host !== '*')),
      };
    });
}

function commandCandidates(
  ctx: PolicyContext,
  rules: readonly CommandRule[],
  layer: 'managed' | 'user',
): Candidate[] {
  if (ctx.command === undefined) return [];
  const applicable = rules.filter(
    (r) =>
      r.enabled !== false &&
      (r.source === 'managed') === (layer === 'managed') &&
      appliesToTool(r, ctx.tool.name) &&
      scopeApplies(r.scope, ctx),
  );
  if (applicable.length === 0) return [];
  const sorted = [...applicable].sort(
    (a, b) =>
      SCOPE_SPECIFICITY[b.scope.kind] - SCOPE_SPECIFICITY[a.scope.kind] ||
      (a.priority ?? 100) - (b.priority ?? 100) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const ev = evaluateCommand(ctx.command, sorted);
  if (ev.decision === null || ev.ruleId === null) return [];
  const rule = sorted.find((r) => r.id === ev.ruleId)!;
  return [
    {
      layer,
      effect: ev.decision,
      reason: ev.reason,
      source: layer === 'managed' ? 'managed' : 'rule',
      ruleId: rule.id,
      userSet: true,
      allowLike: ev.decision === 'allow',
      specificity: SCOPE_SPECIFICITY[rule.scope.kind],
      priority: rule.priority ?? 100,
      id: rule.id,
      namesRecipient: false,
      namesHost: false,
    },
  ];
}

function appliesToTool(rule: CommandRule, tool: string): boolean {
  const tools = rule.tools ?? ['exec.run'];
  return tools.includes(tool) || (tool === 'exec.write' && tools.includes('exec.run'));
}

function scopeApplies(scope: Scope, ctx: PolicyContext): boolean {
  if (scope.kind === 'global') return true;
  if (scope.kind === 'tool') return scope.ref !== undefined && globMatch(scope.ref, ctx.tool.name);
  if (scope.kind === 'plugin') return scope.ref !== undefined && scope.ref === ctx.tool.pluginId;
  if (scope.kind === 'site') {
    return (
      scope.ref !== undefined &&
      ctx.resource?.kind === 'host' &&
      hostMatch(scope.ref, ctx.resource.value)
    );
  }
  return ctx.scopes.some(
    (s) => s.kind === scope.kind && (scope.ref === undefined || s.ref === scope.ref),
  );
}

function ruleMatches(
  rule: PolicyRule,
  ctx: PolicyContext,
  effects: readonly ActionEffect[],
  readOnly: boolean,
): boolean {
  const m = rule.match;
  if (m.tool && !m.tool.some((t) => globMatch(t, ctx.tool.name))) return false;
  if (m.source && !m.source.includes(ctx.tool.source)) return false;
  if (m.readOnly !== undefined && readOnly !== m.readOnly) return false;
  if (m.effect && !m.effect.some((e) => effects.includes(e))) return false;
  if (m.resource) {
    const res = ctx.resource;
    if (!res) return false;
    if (m.resource.kind && m.resource.kind !== res.kind) return false;
    if (m.resource.host && !(res.kind === 'host' || res.kind === 'account')) return false;
    if (m.resource.host && !hostMatch(m.resource.host, hostOf(res.value))) return false;
    if (
      m.resource.pathPrefix &&
      !(res.kind === 'path' && isWithinPath(m.resource.pathPrefix, res.value))
    )
      return false;
    if (m.resource.pattern && !globMatch(m.resource.pattern, res.value)) return false;
  }
  return true;
}

function hostOf(value: string): string {
  const at = value.lastIndexOf('@');
  return at >= 0 ? value.slice(at + 1) : value;
}

/** A standing rule for messages must name who or where (not a bare wildcard). */
function namesRecipient(rule: PolicyRule): boolean {
  const r = rule.match.resource;
  const target = r?.host ?? r?.pattern;
  return target !== undefined && target !== '*' && target !== '**';
}

function grantMatches(g: PolicyGrant, ctx: PolicyContext): boolean {
  if (!scopeApplies(g.scope, ctx) || !globMatch(g.tool, ctx.tool.name)) return false;
  if (g.host !== undefined) {
    if (ctx.resource?.kind !== 'host' || !hostMatch(g.host, ctx.resource.value)) return false;
  }
  if (g.command !== undefined) {
    if (ctx.command === undefined || !commandCoveredBy(g.command, ctx.command)) return false;
  }
  if (g.argsHash !== undefined && g.argsHash !== ctx.argsHash) return false;
  return true;
}

function grantDecision(g: PolicyGrant, ctx: PolicyContext): Step {
  return {
    effect: 'allow',
    reason: g.label ? `you allowed ${g.label}` : 'you allowed this earlier',
    source: 'grant',
    grantId: g.id,
    namesHost: g.host !== undefined && g.host !== '*' && ctx.resource?.kind === 'host',
  };
}

function userDefault(
  ctx: PolicyContext,
  set: PolicySet,
): { effect: DefaultEffect; reason: string } | null {
  const name = ctx.tool.name;
  const exact = set.toolDefaults?.[name];
  if (exact) return { effect: exact, reason: `your default for ${name}` };
  const owner = ctx.tool.serverId ?? ctx.tool.pluginId;
  const server = owner ? set.serverDefaults?.[owner] : undefined;
  if (server) return { effect: server, reason: `your default for ${owner}` };
  const glob = Object.keys(set.toolDefaults ?? {})
    .filter((k) => k.includes('*') && globMatch(k, name))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0];
  if (glob) return { effect: set.toolDefaults![glob]!, reason: `your default for ${glob}` };
  return null;
}

/** Steps 4-6: user defaults, the approval policy (docs/12 §2.1) and the fallback. */
function defaults(
  ctx: PolicyContext,
  set: PolicySet,
  effects: readonly ActionEffect[],
  readOnly: boolean,
  path: PathCheck | null,
): Step {
  const user = userDefault(ctx, set);
  const fromUser: Step | null = user
    ? { effect: user.effect, reason: user.reason, source: 'tool_default', userSet: true }
    : null;
  if (fromUser?.effect === 'deny') return fromUser;
  if (readOnly)
    return fromUser ?? { effect: 'allow', reason: 'read-only action', source: 'fallback' };
  const builtin: Step = {
    effect: 'ask',
    reason: `the default for ${ctx.tool.name} is to ask`,
    source: 'tool_default',
  };
  switch (ctx.approvalPolicy.kind) {
    case 'ask_always':
      return {
        effect: 'ask',
        reason: 'your approval policy asks before every change',
        source: 'approval_policy',
        userSet: true,
      };
    case 'defaults': {
      if (fromUser) return fromUser;
      const edit =
        effects.length > 0 &&
        effects.every((e) => e === 'file_write') &&
        path?.access === 'write' &&
        (ctx.approvalPolicy.autoAccept ?? []).includes('file_edit');
      if (edit)
        return {
          effect: 'allow',
          reason: 'file edits inside writable folders are accepted automatically',
          source: 'approval_policy',
        };
      return builtin;
    }
    case 'review':
      return (
        fromUser ?? {
          effect: 'allow',
          reason: 'allowed under auto-review',
          source: 'approval_policy',
        }
      );
    case 'never_ask':
      return (
        fromUser ?? {
          effect: 'allow',
          reason: 'your approval policy does not ask for this',
          source: 'approval_policy',
        }
      );
  }
}
