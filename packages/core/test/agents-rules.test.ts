// Agent custom rules as the policy engine sees them (FR-084, docs/12 §3): act, act on request,
// ask and hand off over tools, hosts, action classes and channels; command prefix rules (FR-191);
// floors that no rule removes; validation; the context summary and the preview matcher.
import { describe, expect, it } from 'vitest';
import {
  evaluate,
  evaluateCommand,
  type PolicyContext,
  type PolicyRule,
  type ToolDescriptor,
} from '@nova/policy';
import {
  agentCommandRule,
  agentEngineRules,
  agentRulePreviewMatches,
  agentRulesSummary,
  channelResource,
  checkAgentRule,
  type AgentRuleLike,
} from '../src/index.ts';

const AGENT = 'agent-1';
const THREAD = 'thread-1';

function rule(over: Partial<AgentRuleLike>): AgentRuleLike {
  return {
    id: 'r1',
    agentId: AGENT,
    description: 'test rule',
    effect: 'ask',
    match: {},
    command: null,
    priority: 100,
    enabled: true,
    ...over,
  };
}

/** The gate's view: the agent's rules scoped to the thread it acts in. */
function threadRules(r: AgentRuleLike): PolicyRule[] {
  return agentEngineRules(r).map((e) => ({ ...e, scope: { kind: 'thread', ref: THREAD } }));
}

const send: ToolDescriptor = {
  name: 'channel.send',
  source: 'builtin',
  annotations: { readOnly: false, action: 'send' },
  effects: ['external_communication'],
};
const noteTool: ToolDescriptor = {
  name: 'notes.write',
  source: 'builtin',
  annotations: { readOnly: false, action: 'write' },
};
const fetchTool: ToolDescriptor = {
  name: 'web.fetch',
  source: 'builtin',
  annotations: { readOnly: true, requiresNetwork: true },
  effects: ['network'],
};

function ctx(over: Partial<PolicyContext>): PolicyContext {
  return {
    actor: { kind: 'agent', id: 'agent' },
    scopes: [{ kind: 'session', ref: THREAD }, { kind: 'thread', ref: THREAD }, { kind: 'global' }],
    mode: 'agent',
    approvalPolicy: { kind: 'review' },
    permissionProfile: { id: 'workspace', hash: 'h' },
    provenance: { userInstruction: { messageId: 'm', accountId: 'a' }, taint: [] },
    tool: noteTool,
    environment: { kind: 'hub', trusted: true, substrate: 'container' },
    fs: { entries: [] },
    ...over,
  };
}

describe('agent rules in the engine', () => {
  it('maps each effect and scopes every rule to the agent', () => {
    expect(agentEngineRules(rule({ effect: 'act' }))[0]).toMatchObject({
      scope: { kind: 'agent', ref: AGENT },
      effect: 'allow',
      label: 'test rule',
    });
    expect(agentEngineRules(rule({ effect: 'act_on_request' }))[0]?.effect).toBe('act_on_request');
    expect(agentEngineRules(rule({ effect: 'handoff' }))[0]?.effect).toBe('handoff');
    expect(agentEngineRules(rule({ enabled: false }))).toEqual([]);
  });

  it('expands alternatives: two hosts and two action classes are four rules', () => {
    const out = agentEngineRules(
      rule({ match: { hosts: ['a.example.com', '*.b.example.com'], actions: ['read', 'send'] } }),
    );
    expect(out.map((r) => r.id)).toEqual(['r1', 'r1:1', 'r1:2', 'r1:3']);
    expect(out[0]?.match).toEqual({ readOnly: true, resource: { host: 'a.example.com' } });
    expect(out[1]?.match).toEqual({
      effect: ['external_communication'],
      resource: { host: 'a.example.com' },
    });
    expect(
      agentEngineRules(rule({ match: { actions: ['write', 'delete', 'execute'] } })).map(
        (r) => r.match,
      ),
    ).toEqual([{ readOnly: false }, { effect: ['data_delete', 'exec'] }]);
  });

  it('an ask rule forces approval of what auto-review would allow', () => {
    const base = evaluate(ctx({}));
    expect(base.effect).toBe('allow');
    const d = evaluate(ctx({}), { rules: threadRules(rule({ match: { tools: ['notes.*'] } })) });
    expect(d).toMatchObject({ effect: 'ask', source: 'rule', ruleId: 'r1' });
    expect(d.reason).toContain('test rule');
  });

  it('a rule forces approval for messaging a channel, even one a standing rule allowed', () => {
    const channel = { kind: 'account' as const, value: channelResource('slack', '#general') };
    const allowRule = threadRules(
      rule({
        id: 'allow',
        effect: 'act',
        match: { channels: [{ kind: 'slack', conversation: '#general' }] },
      }),
    );
    // A user rule that names the channel lifts the third-party floor (docs/12 §2.2)...
    const allowed = evaluate(ctx({ tool: send, resource: channel }), { rules: allowRule });
    expect(allowed.effect).toBe('allow');
    // ...and the agent's ask rule for the same channel forces approval again.
    const ask = threadRules(
      rule({
        id: 'ask',
        priority: 10,
        effect: 'ask',
        match: { tools: ['channel.*'], channels: [{ kind: 'slack', conversation: '#general' }] },
      }),
    );
    const d = evaluate(ctx({ tool: send, resource: channel }), { rules: [...ask, ...allowRule] });
    expect(d).toMatchObject({ effect: 'ask', ruleId: 'ask' });
    // Another channel does not match it.
    const other = evaluate(
      ctx({ tool: send, resource: { kind: 'account', value: 'slack:#random' } }),
      { rules: ask },
    );
    expect(other.ruleId).toBeUndefined();
  });

  it('act on request allows only with a clean user instruction in the turn', () => {
    const rules = threadRules(
      rule({ effect: 'act_on_request', match: { tools: ['notes.write'] } }),
    );
    const asked = { approvalPolicy: { kind: 'ask_always' as const } };
    expect(evaluate(ctx(asked), { rules }).effect).toBe('allow');
    expect(evaluate(ctx({ ...asked, provenance: { taint: [] } }), { rules }).effect).toBe('ask');
    expect(
      evaluate(
        ctx({
          ...asked,
          provenance: { userInstruction: { messageId: 'm', accountId: 'a' }, taint: ['memory'] },
        }),
        { rules },
      ).effect,
    ).toBe('ask');
  });

  it('hands off, and never removes a floor (a purchase still asks)', () => {
    const handoff = threadRules(rule({ effect: 'handoff', match: { tools: ['notes.write'] } }));
    expect(evaluate(ctx({}), { rules: handoff }).effect).toBe('handoff');
    const buy: ToolDescriptor = { ...noteTool, name: 'shop.buy', effects: ['purchase'] };
    const act = threadRules(rule({ effect: 'act', match: { tools: ['shop.*'] } }));
    expect(evaluate(ctx({ tool: buy }), { rules: act })).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
    });
  });

  it('a rule for another thread or agent does not apply', () => {
    const rules = agentEngineRules(rule({ match: { tools: ['notes.write'] } })).map((e) => ({
      ...e,
      scope: { kind: 'thread' as const, ref: 'another-thread' },
    }));
    expect(evaluate(ctx({}), { rules }).effect).toBe('allow');
  });

  it('host rules match the call resource', () => {
    const rules = threadRules(rule({ effect: 'ask', match: { hosts: ['*.example.com'] } }));
    const d = evaluate(
      ctx({ tool: fetchTool, resource: { kind: 'host', value: 'api.example.com' } }),
      { rules },
    );
    expect(d.effect).toBe('ask');
  });

  it('carries command prefix rules (FR-191), and a pure command rule has no policy rules', () => {
    const r = rule({
      effect: 'act',
      command: {
        pattern: ['git', ['status', 'log']],
        matchExamples: ['git status'],
        notMatchExamples: ['git push'],
      },
    });
    expect(agentEngineRules(r)).toEqual([]);
    const c = agentCommandRule(r);
    expect(c).toMatchObject({
      id: 'r1:command',
      decision: 'allow',
      tools: ['exec.run'],
      scope: { kind: 'agent', ref: AGENT },
    });
    expect(evaluateCommand('git status', [c!]).decision).toBe('allow');
    expect(evaluateCommand('git push origin main', [c!]).decision).toBeNull();
    expect(agentCommandRule(rule({ effect: 'ask' }))).toBeNull();
  });

  it('refuses rules it cannot store', () => {
    expect(() =>
      checkAgentRule({
        effect: 'handoff',
        match: {},
        command: { pattern: ['ls'], matchExamples: ['ls'], notMatchExamples: ['rm'] },
      }),
    ).toThrow(/command prefix rule/);
    expect(() =>
      checkAgentRule({
        effect: 'act',
        match: {},
        command: { pattern: ['ls'], matchExamples: ['rm -rf x'], notMatchExamples: ['cat'] },
      }),
    ).toThrow(/should match/);
    expect(() =>
      checkAgentRule({
        effect: 'ask',
        match: { hosts: ['a.com'], channels: [{ kind: 'slack' }] },
        command: null,
      }),
    ).toThrow(/hosts or channels/);
    expect(() =>
      checkAgentRule({ effect: 'ask', match: { tools: ['x.y'] }, command: null }),
    ).not.toThrow();
  });

  it('summarizes enabled rules for the context and previews recent calls', () => {
    const summary = agentRulesSummary([
      rule({
        description: 'Ask before posting',
        match: { tools: ['channel.send'], channels: [{ kind: 'slack' }] },
      }),
      rule({ id: 'r2', effect: 'act', description: 'Read freely', match: { actions: ['read'] } }),
      rule({ id: 'r3', enabled: false, description: 'off' }),
      rule({
        id: 'r4',
        effect: 'act',
        description: 'git reads',
        command: {
          pattern: ['git', ['status', 'log']],
          matchExamples: ['git status'],
          notMatchExamples: ['git push'],
        },
      }),
      rule({ id: 'r5', description: 'everything' }),
    ]);
    expect(summary).toContain(
      'Ask before taking action: Ask before posting [tools channel.send; channels slack:*]',
    );
    expect(summary).toContain('Take action without asking: Read freely [read actions]');
    expect(summary).toContain('commands starting git (status|log)');
    expect(summary).toContain('everything [everything]');
    expect(summary).not.toContain('off');
    expect(agentRulesSummary([])).toBeNull();

    const r = rule({
      match: { tools: ['channel.*'], channels: [{ kind: 'slack', conversation: '#ops' }] },
    });
    expect(
      agentRulePreviewMatches(r, { tool: 'channel.send', args: { channel: 'slack', to: '#ops' } }),
    ).toBe(true);
    expect(agentRulePreviewMatches(r, { tool: 'channel.send', args: { to: '#dev' } })).toBe(false);
    expect(agentRulePreviewMatches(r, { tool: 'fs.write', args: {} })).toBe(false);
    const h = rule({ match: { hosts: ['*.example.com'] } });
    expect(
      agentRulePreviewMatches(h, { tool: 'web.fetch', args: { url: 'https://x.example.com/a' } }),
    ).toBe(true);
    expect(
      agentRulePreviewMatches(h, { tool: 'web.fetch', args: { url: 'https://other.org' } }),
    ).toBe(false);
    const c = rule({
      command: { pattern: ['git'], matchExamples: ['git status'], notMatchExamples: ['ls'] },
    });
    expect(agentRulePreviewMatches(c, { tool: 'exec.run', args: { cmd: 'git status' } })).toBe(
      true,
    );
    expect(agentRulePreviewMatches(c, { tool: 'exec.run', args: { cmd: 'ls' } })).toBe(false);
  });
});
