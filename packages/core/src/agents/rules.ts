// Agent custom rules (FR-084, docs/12 §3): the user's act / act on request / ask / hand off rules
// over tools, hosts, action classes and channels, optionally a command prefix rule (FR-191). The
// engine sees each as policy rules scoped to the agent (`{kind: 'agent', ref}`), so built-in
// safety, the confirmation tiers and intent provenance still apply: a rule can tighten or allow
// pre-approvable actions, never pre-approve a floor (docs/12 §2.2). Pure functions.
import {
  NovaError,
  type AgentRuleCommand,
  type AgentRuleEffect,
  type AgentRuleMatch,
} from '@nova/shared';
import {
  checkCommandRule,
  globMatch,
  hostMatch,
  type ActionEffect,
  type CommandRule,
  type PolicyRule,
  type RuleEffect,
  type RuleMatch,
} from '@nova/policy';

export interface AgentRuleLike {
  id: string;
  agentId: string;
  description: string;
  effect: AgentRuleEffect;
  match: AgentRuleMatch;
  command: AgentRuleCommand | null;
  priority: number;
  enabled: boolean;
}

/** The engine effect of each agent rule effect (docs/12 §3). */
export const RULE_EFFECT: Record<AgentRuleEffect, RuleEffect> = {
  act: 'allow',
  act_on_request: 'act_on_request',
  ask: 'ask',
  handoff: 'handoff',
};

const EFFECT_WORDS: Record<AgentRuleEffect, string> = {
  act: 'Take action without asking',
  act_on_request: 'Take action only when the user says so',
  ask: 'Ask before taking action',
  handoff: 'Hand off to the user',
};

/**
 * The gate resource a channel send names (the channels area's convention): an `account`
 * resource `<kind>:<conversation>`, for example `slack:#general` or `email:ops@example.com`.
 */
export function channelResource(kind: string, conversation?: string | null): string {
  return `${kind}:${conversation?.trim() || '*'}`;
}

/** Throws `validation` when a rule cannot be stored (a command rule's examples are checked). */
export function checkAgentRule(input: {
  effect: AgentRuleEffect;
  match: AgentRuleMatch;
  command: AgentRuleCommand | null;
}): void {
  const m = input.match;
  if (m.hosts?.length && m.channels?.length)
    throw new NovaError('validation', 'a rule names hosts or channels, not both', {
      details: { field: 'match', reason: 'hosts_and_channels' },
    });
  const c = input.command;
  if (!c) return;
  if (input.effect !== 'act' && input.effect !== 'ask')
    throw new NovaError(
      'validation',
      'a command prefix rule can only take action without asking or ask first',
      { details: { field: 'effect', reason: 'command_effect' } },
    );
  const problem = checkCommandRule({
    pattern: c.pattern,
    decision: input.effect === 'act' ? 'allow' : 'ask',
    matchExamples: c.matchExamples,
    notMatchExamples: c.notMatchExamples,
  });
  if (problem)
    throw new NovaError('validation', problem.message, {
      details: { field: 'command', reason: problem.kind },
    });
}

/** What each action class means as engine matchers (`write` is any change, FR-045 classes). */
function actionMatchers(m: AgentRuleMatch): Pick<RuleMatch, 'effect' | 'readOnly'>[] {
  const out: Pick<RuleMatch, 'effect' | 'readOnly'>[] = [];
  const effects = new Set<ActionEffect>(m.effects ?? []);
  for (const a of m.actions ?? []) {
    if (a === 'read') out.push({ readOnly: true });
    else if (a === 'write') out.push({ readOnly: false });
    else if (a === 'send') effects.add('external_communication');
    else if (a === 'delete') effects.add('data_delete');
    else effects.add('exec');
  }
  if (effects.size) out.push({ effect: [...effects] });
  return out.length ? out : [{}];
}

function resourceMatchers(m: AgentRuleMatch): (RuleMatch['resource'] | undefined)[] {
  if (m.hosts?.length) return m.hosts.map((h) => ({ host: h }));
  if (m.channels?.length)
    return m.channels.map((c) => ({
      kind: 'account' as const,
      pattern: channelResource(c.kind, c.conversation),
    }));
  return [undefined];
}

/**
 * The rule as engine policy rules scoped to its agent. Lists inside one dimension are
 * alternatives, so a rule naming two hosts and two action classes becomes four engine rules
 * (ids `<id>`, `<id>:1`, …); the dimensions combine with AND. A pure command prefix rule (no
 * other matcher) has no policy rules.
 */
export function engineRules(rule: AgentRuleLike): PolicyRule[] {
  if (!rule.enabled) return [];
  const m = rule.match;
  const hasMatcher = !!(
    m.tools?.length ||
    m.hosts?.length ||
    m.actions?.length ||
    m.effects?.length ||
    m.channels?.length
  );
  if (rule.command && !hasMatcher) return [];
  const out: PolicyRule[] = [];
  for (const resource of resourceMatchers(m)) {
    for (const action of actionMatchers(m)) {
      const match: RuleMatch = { ...action };
      if (m.tools?.length) match.tool = [...m.tools];
      if (resource) match.resource = resource;
      out.push({
        id: out.length ? `${rule.id}:${out.length}` : rule.id,
        label: rule.description,
        priority: rule.priority,
        enabled: true,
        source: 'user',
        scope: { kind: 'agent', ref: rule.agentId },
        match,
        effect: RULE_EFFECT[rule.effect],
      });
    }
  }
  return out;
}

/** The rule's command prefix rule, scoped to its agent (FR-191), or null. */
export function engineCommandRule(rule: AgentRuleLike): CommandRule | null {
  const c = rule.command;
  if (!c || !rule.enabled) return null;
  const out: CommandRule = {
    id: `${rule.id}:command`,
    scope: { kind: 'agent', ref: rule.agentId },
    tools: c.tools?.length ? [...c.tools] : ['exec.run'],
    pattern: c.pattern,
    decision: rule.effect === 'act' ? 'allow' : 'ask',
    priority: rule.priority,
    matchExamples: c.matchExamples,
    notMatchExamples: c.notMatchExamples,
    source: 'user',
    enabled: true,
  };
  if (c.justification) out.justification = c.justification;
  return out;
}

/** One line per enabled rule, for the agent's context (its rules are Nova-enforced, not hints). */
export function rulesSummary(rules: readonly AgentRuleLike[]): string | null {
  const lines = rules
    .filter((r) => r.enabled)
    .map((r) => {
      const scope: string[] = [];
      const m = r.match;
      if (m.tools?.length) scope.push(`tools ${m.tools.join(', ')}`);
      if (m.hosts?.length) scope.push(`hosts ${m.hosts.join(', ')}`);
      if (m.channels?.length)
        scope.push(
          `channels ${m.channels.map((c) => channelResource(c.kind, c.conversation)).join(', ')}`,
        );
      if (m.actions?.length) scope.push(`${m.actions.join(', ')} actions`);
      if (m.effects?.length) scope.push(`effects ${m.effects.join(', ')}`);
      if (r.command)
        scope.push(
          `commands starting ${r.command.pattern
            .map((p) => (typeof p === 'string' ? p : `(${p.join('|')})`))
            .join(' ')}`,
        );
      return `- ${EFFECT_WORDS[r.effect]}: ${r.description}${scope.length ? ` [${scope.join('; ')}]` : ' [everything]'}`;
    });
  return lines.length ? lines.join('\n') : null;
}

/** A recent tool call, for the rule preview. */
export interface PreviewCall {
  tool: string;
  args: unknown;
}

function argText(args: unknown): string {
  try {
    return JSON.stringify(args ?? null).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Whether a recorded call looks like one the rule names (the preview, docs/12 §3): by tool,
 * by a host or channel in its arguments. Action classes need the live descriptor, so a rule
 * that names only action classes previews every call; the gate decides exactly.
 */
export function previewMatches(rule: AgentRuleLike, call: PreviewCall): boolean {
  const m = rule.match;
  if (m.tools?.length && !m.tools.some((t) => globMatch(t, call.tool))) return false;
  const text = argText(call.args);
  if (m.hosts?.length) {
    const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((x) => x[1] ?? '');
    if (!m.hosts.some((h) => hosts.some((host) => hostMatch(h, host)))) return false;
  }
  if (m.channels?.length) {
    const ok = m.channels.some(
      (c) =>
        text.includes(c.kind.toLowerCase()) &&
        (!c.conversation || text.includes(c.conversation.toLowerCase())),
    );
    if (!ok) return false;
  }
  if (rule.command) {
    const a = (call.args ?? {}) as { cmd?: unknown };
    const first = rule.command.pattern[0];
    const words = typeof first === 'string' ? [first] : (first ?? []);
    if (
      typeof a.cmd !== 'string' ||
      !words.some((w) => a.cmd === w || String(a.cmd).startsWith(`${w} `))
    )
      return false;
  }
  return true;
}
