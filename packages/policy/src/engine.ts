// The policy engine (docs/12 §2, FR-099, FR-189). Pure and deterministic: the same context and
// policy set always give the same decision. Evaluation:
//   1. Built-in safety: hard denies, confirmation tiers and intent provenance set a floor that
//      no later layer can relax.
//   2. Managed rules, then user custom rules, then per-tool defaults, then mode defaults, then a
//      fallback. The first layer that decides wins, except that any matching deny wins outright.
//   3. The final effect is the stricter of the floor and the decision.
import type {
  ActionEffect,
  ConfirmationTier,
  CustomRuleEffect,
  Decision,
  Effect,
  Layer,
  PolicyContext,
  PolicyRule,
  PolicySet,
  Scope,
  ScopeKind,
} from './types.ts';
import { SEVERITY } from './types.ts';
import { globMatch, hostMatch, isWithinPath } from './match.ts';

const TRUSTED_INTENT = new Set(['user_typed', 'user_voice', 'schedule']);
const HANDOFF_EFFECTS: ActionEffect[] = ['captcha', 'security_bypass', 'credential_change'];
const CONFIRM_EFFECTS: ActionEffect[] = ['purchase', 'account_change', 'install'];
const CONSEQUENTIAL: ActionEffect[] = [
  'external_communication',
  'purchase',
  'account_change',
  'credential_change',
  'data_delete',
  'install',
  'network',
  'exec',
  'secret_access',
  'policy_change',
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

interface Floor {
  effect: Effect;
  tier: ConfirmationTier;
  reason: string;
  /** Effects a matching custom rule may not relax below this floor. */
  locked: boolean;
}

export interface EvaluateResult extends Decision {
  /** True when an allowed action is consequential and must pass the auto-reviewer (FR-085). */
  review: boolean;
}

export function evaluate(ctx: PolicyContext, policies: PolicySet = {}): EvaluateResult {
  const effects = new Set(ctx.tool.effects ?? []);
  const readOnly = ctx.tool.annotations?.readOnly === true && !hasAny(effects, CONSEQUENTIAL);
  const scope = ctx.scopes[0] ?? { kind: 'global' };

  // 1. Built-in safety.
  const hard = hardDeny(ctx, effects);
  if (hard)
    return finish(
      { effect: 'deny', reason: hard, layer: 'builtin', tier: 'handoff_required' },
      ctx,
      false,
    );

  const matched = [
    ...matchingRules(ctx, policies.managed ?? [], 'managed'),
    ...matchingRules(ctx, policies.custom ?? [], 'custom'),
  ];
  const floor = builtinFloor(ctx, effects, readOnly, matched);

  // 2. Layers.
  const anyDeny = matched.find((m) => m.effect === 'deny');
  let decision: Omit<Decision, 'tier'>;
  if (anyDeny) {
    decision = {
      effect: 'deny',
      reason: label(anyDeny.rule, 'denied by rule'),
      layer: anyDeny.layer,
      ruleId: anyDeny.rule.id,
    };
  } else {
    decision =
      firstRule(matched, 'managed') ??
      firstRule(matched, 'custom') ??
      toolDefault(ctx, policies) ??
      modeDefault(ctx, effects, readOnly) ??
      fallback(ctx, readOnly);
  }

  // 3. Combine with the floor.
  let final: Decision = { ...decision, tier: floor.tier, scope };
  if (SEVERITY[floor.effect] > SEVERITY[final.effect]) {
    final = {
      effect: floor.effect,
      reason: floor.reason,
      layer: 'builtin',
      tier: floor.tier,
      scope,
    };
  }
  const consequential =
    !readOnly && (hasAny(effects, CONSEQUENTIAL) || !TRUSTED_INTENT.has(ctx.intent.source));
  return finish(final, ctx, consequential);
}

function finish(d: Decision, ctx: PolicyContext, consequential: boolean): EvaluateResult {
  return { ...d, review: d.effect === 'allow' && consequential && ctx.actor.kind === 'agent' };
}

function hardDeny(ctx: PolicyContext, effects: Set<ActionEffect>): string | null {
  if (ctx.actor.kind === 'agent' && effects.has('policy_change')) {
    return 'agents cannot change policy, safety, permission or audit settings';
  }
  if (ctx.actor.kind === 'agent' && effects.has('secret_access')) {
    return 'secret values are never exposed to agents';
  }
  if (
    ctx.resource?.kind === 'path' &&
    (effects.has('file_write') ||
      effects.has('data_delete') ||
      ctx.tool.annotations?.destructive === true) &&
    ctx.allowedRoots !== undefined &&
    !ctx.allowedRoots.some((root) => isWithinPath(root, ctx.resource!.value))
  ) {
    return 'path is outside the allowed file scope';
  }
  if (ctx.permissionMode === 'bypass' && !isIsolated(ctx)) {
    return 'bypass mode requires a VM or container environment';
  }
  return null;
}

function isIsolated(ctx: PolicyContext): boolean {
  return (
    ctx.environment.sandboxed &&
    (ctx.environment.kind === 'container' || ctx.environment.kind === 'vm')
  );
}

function builtinFloor(
  ctx: PolicyContext,
  effects: Set<ActionEffect>,
  readOnly: boolean,
  matched: Matched[],
): Floor {
  if (ctx.tool.annotations?.requiresUser === true || hasAny(effects, HANDOFF_EFFECTS)) {
    return {
      effect: 'handoff',
      tier: 'handoff_required',
      reason: 'only you can do this step',
      locked: true,
    };
  }
  if (hasAny(effects, CONFIRM_EFFECTS)) {
    return {
      effect: 'ask',
      tier: 'confirm_at_action',
      reason: 'this action always needs your confirmation',
      locked: true,
    };
  }
  if (effects.has('data_delete')) {
    const inScope =
      ctx.resource?.kind === 'path' &&
      (ctx.allowedRoots ?? []).some((r) => isWithinPath(r, ctx.resource!.value));
    if (!inScope) {
      return {
        effect: 'ask',
        tier: 'confirm_at_action',
        reason: 'deleting data outside the project needs your confirmation',
        locked: true,
      };
    }
  }
  if (effects.has('external_communication')) {
    const standing = matched.some(
      (m) => m.layer === 'custom' && m.allowLike && namesRecipient(m.rule) && m.trusted,
    );
    if (!standing) {
      return {
        effect: 'ask',
        tier: 'confirm_at_action',
        reason: 'messages to others need your confirmation',
        locked: true,
      };
    }
  }
  if (!readOnly && !TRUSTED_INTENT.has(ctx.intent.source)) {
    const authorizedByRule = matched.some((m) => m.layer === 'custom' && m.allowLike && m.trusted);
    if (!authorizedByRule) {
      return {
        effect: 'ask',
        tier: 'pre_approvable',
        reason: `the request came from ${ctx.intent.source} content, which cannot authorize actions`,
        locked: false,
      };
    }
  }
  if (
    !readOnly &&
    ctx.tool.annotations?.requiresNetwork === true &&
    ctx.resource?.kind === 'host'
  ) {
    const host = ctx.resource.value;
    if (!(ctx.egressAllow ?? []).some((pattern) => hostMatch(pattern, host))) {
      return {
        effect: 'ask',
        tier: 'pre_approvable',
        reason: `${host} is not on the network allowlist`,
        locked: false,
      };
    }
  }
  return { effect: 'allow', tier: 'pre_approvable', reason: '', locked: false };
}

interface Matched {
  rule: PolicyRule;
  layer: 'managed' | 'custom';
  effect: Effect;
  /** The rule grants (allow/act) rather than restricts. */
  allowLike: boolean;
  /** The grant applies to this request's provenance (act_on_request needs an active user request). */
  trusted: boolean;
}

function matchingRules(
  ctx: PolicyContext,
  rules: PolicyRule[],
  layer: 'managed' | 'custom',
): Matched[] {
  return rules
    .filter((r) => r.enabled !== false && scopeApplies(r.scope, ctx) && ruleMatches(r, ctx))
    .sort(
      (a, b) =>
        (a.priority ?? 100) - (b.priority ?? 100) ||
        SCOPE_SPECIFICITY[b.scope.kind] - SCOPE_SPECIFICITY[a.scope.kind],
    )
    .map((rule) => {
      const effect = mapEffect(rule.effect, ctx);
      return {
        rule,
        layer,
        effect,
        allowLike:
          rule.effect === 'allow' ||
          rule.effect === 'act' ||
          (rule.effect === 'act_on_request' && effect === 'allow'),
        trusted: rule.effect !== 'act_on_request' || effect === 'allow',
      };
    });
}

function mapEffect(e: CustomRuleEffect, ctx: PolicyContext): Effect {
  switch (e) {
    case 'act':
    case 'allow':
      return 'allow';
    case 'act_on_request':
      return ctx.intent.requestActive === true && TRUSTED_INTENT.has(ctx.intent.source)
        ? 'allow'
        : 'ask';
    case 'ask':
      return 'ask';
    case 'handoff':
      return 'handoff';
    case 'deny':
      return 'deny';
  }
}

function firstRule(matched: Matched[], layer: 'managed' | 'custom'): Omit<Decision, 'tier'> | null {
  const m = matched.find((x) => x.layer === layer);
  if (!m) return null;
  return {
    effect: m.effect,
    reason: label(m.rule, `${layer} rule`),
    layer: m.layer,
    ruleId: m.rule.id,
  };
}

function label(rule: PolicyRule, fallbackText: string): string {
  return rule.label ? `rule "${rule.label}"` : fallbackText;
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

function ruleMatches(rule: PolicyRule, ctx: PolicyContext): boolean {
  const m = rule.match;
  if (m.tool && !m.tool.some((t) => globMatch(t, ctx.tool.name))) return false;
  if (m.source && !m.source.includes(ctx.tool.source)) return false;
  if (m.readOnly !== undefined && (ctx.tool.annotations?.readOnly === true) !== m.readOnly)
    return false;
  if (m.effect && !m.effect.some((e) => (ctx.tool.effects ?? []).includes(e))) return false;
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

function toolDefault(ctx: PolicyContext, policies: PolicySet): Omit<Decision, 'tier'> | null {
  const defaults = policies.toolDefaults ?? {};
  const exact = defaults[ctx.tool.name];
  if (exact)
    return { effect: exact, reason: `default for ${ctx.tool.name}`, layer: 'tool_default' };
  const glob = Object.keys(defaults)
    .filter((k) => k.includes('*') && globMatch(k, ctx.tool.name))
    .sort((a, b) => b.length - a.length)[0];
  if (glob)
    return { effect: defaults[glob]!, reason: `default for ${glob}`, layer: 'tool_default' };
  return null;
}

function modeDefault(
  ctx: PolicyContext,
  effects: Set<ActionEffect>,
  readOnly: boolean,
): Omit<Decision, 'tier'> | null {
  if (readOnly) return null;
  const layer: Layer = 'mode';
  switch (ctx.permissionMode) {
    case 'plan':
      return { effect: 'deny', reason: 'plan mode only reads and proposes', layer };
    case 'manual':
      return { effect: 'ask', reason: 'manual mode asks before every change', layer };
    case 'accept_edits': {
      const editOnly = effects.size > 0 && [...effects].every((e) => e === 'file_write');
      return editOnly
        ? { effect: 'allow', reason: 'accept-edits mode allows file edits in the project', layer }
        : { effect: 'ask', reason: 'accept-edits mode asks before commands', layer };
    }
    case 'auto':
    case 'bypass':
      return { effect: 'allow', reason: `${ctx.permissionMode} mode`, layer };
    case undefined:
      return null;
  }
}

function fallback(ctx: PolicyContext, readOnly: boolean): Omit<Decision, 'tier'> {
  if (readOnly) return { effect: 'allow', reason: 'read-only action', layer: 'fallback' };
  if (ctx.tool.annotations === undefined && ctx.tool.source !== 'builtin') {
    return { effect: 'deny', reason: 'unknown tool with undeclared effects', layer: 'fallback' };
  }
  return { effect: 'ask', reason: 'this action changes something', layer: 'fallback' };
}

function hasAny<T>(set: Set<T>, values: readonly T[]): boolean {
  return values.some((v) => set.has(v));
}
