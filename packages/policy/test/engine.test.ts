import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/engine.ts';
import { globMatch, hostMatch, isWithinPath } from '../src/match.ts';
import type { PolicyContext, PolicyRule, ToolDescriptor } from '../src/types.ts';

const read: ToolDescriptor = {
  name: 'fs.read',
  source: 'builtin',
  annotations: { readOnly: true },
};
const write: ToolDescriptor = {
  name: 'fs.write',
  source: 'builtin',
  annotations: { destructive: true },
  effects: ['file_write'],
};
const exec: ToolDescriptor = {
  name: 'exec.run',
  source: 'builtin',
  annotations: { destructive: true },
  effects: ['exec'],
};
const email: ToolDescriptor = {
  name: 'email.send',
  source: 'plugin',
  pluginId: 'com.example.mail',
  annotations: { requiresNetwork: true },
  effects: ['external_communication'],
};

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    actor: { kind: 'agent', id: 'a1' },
    scopes: [{ kind: 'session', ref: 's1' }, { kind: 'project', ref: 'p1' }, { kind: 'global' }],
    tool: read,
    environment: { kind: 'local', trusted: true, sandboxed: true },
    intent: { source: 'user_typed', requestActive: true },
    allowedRoots: ['/work/p1'],
    ...over,
  };
}

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'effect'>): PolicyRule => ({
  id: r.id ?? 'r',
  scope: r.scope ?? { kind: 'global' },
  match: r.match ?? {},
  ...r,
});

describe('fallback and modes', () => {
  it('allows read-only actions and asks for changes', () => {
    expect(evaluate(ctx()).effect).toBe('allow');
    const d = evaluate(ctx({ tool: write, resource: { kind: 'path', value: '/work/p1/a.ts' } }));
    expect(d.effect).toBe('ask');
    expect(d.layer).toBe('fallback');
  });

  it('denies unknown non-builtin tools with undeclared effects', () => {
    const d = evaluate(ctx({ tool: { name: 'mcp:x.do', source: 'mcp' } }));
    expect(d).toMatchObject({ effect: 'deny', layer: 'fallback' });
  });

  it('applies permission modes', () => {
    const p = { kind: 'path' as const, value: '/work/p1/a.ts' };
    expect(evaluate(ctx({ tool: write, resource: p, permissionMode: 'plan' })).effect).toBe('deny');
    expect(evaluate(ctx({ tool: write, resource: p, permissionMode: 'manual' })).effect).toBe(
      'ask',
    );
    expect(evaluate(ctx({ tool: write, resource: p, permissionMode: 'accept_edits' })).effect).toBe(
      'allow',
    );
    expect(evaluate(ctx({ tool: exec, permissionMode: 'accept_edits' })).effect).toBe('ask');
    expect(evaluate(ctx({ tool: exec, permissionMode: 'auto' }))).toMatchObject({
      effect: 'allow',
      review: true,
    });
    expect(evaluate(ctx({ tool: read, permissionMode: 'plan' })).effect).toBe('allow');
  });

  it('allows bypass only in a VM or container', () => {
    expect(evaluate(ctx({ tool: exec, permissionMode: 'bypass' }))).toMatchObject({
      effect: 'deny',
      layer: 'builtin',
    });
    const vm = { kind: 'vm', trusted: true, sandboxed: true };
    expect(evaluate(ctx({ tool: exec, permissionMode: 'bypass', environment: vm })).effect).toBe(
      'allow',
    );
  });
});

describe('built-in safety (FR-189)', () => {
  it('hard-denies policy changes and secret access by agents', () => {
    const policy: ToolDescriptor = {
      name: 'policy.rules.upsert',
      source: 'builtin',
      effects: ['policy_change'],
    };
    expect(evaluate(ctx({ tool: policy }))).toMatchObject({ effect: 'deny', layer: 'builtin' });
    expect(evaluate(ctx({ tool: policy, actor: { kind: 'user' } })).effect).not.toBe('deny');
    const secret: ToolDescriptor = {
      name: 'secrets.read',
      source: 'builtin',
      effects: ['secret_access'],
    };
    expect(evaluate(ctx({ tool: secret })).effect).toBe('deny');
  });

  it('denies writes outside the allowed roots, even if a rule allows them', () => {
    const allowAll = rule({ effect: 'allow', match: { tool: ['fs.*'] } });
    const d = evaluate(ctx({ tool: write, resource: { kind: 'path', value: '/etc/passwd' } }), {
      custom: [allowAll],
    });
    expect(d).toMatchObject({ effect: 'deny', reason: 'path is outside the allowed file scope' });
    expect(
      evaluate(ctx({ tool: write, resource: { kind: 'path', value: '/work/p1/../../etc/x' } }))
        .effect,
    ).toBe('deny');
  });

  it('hands off CAPTCHAs, credential changes and user-only steps', () => {
    const captcha: ToolDescriptor = {
      name: 'browser.solve',
      source: 'builtin',
      effects: ['captcha'],
    };
    expect(evaluate(ctx({ tool: captcha }))).toMatchObject({
      effect: 'handoff',
      tier: 'handoff_required',
    });
    const user: ToolDescriptor = {
      name: 'site.mfa',
      source: 'builtin',
      annotations: { requiresUser: true },
    };
    expect(evaluate(ctx({ tool: user })).effect).toBe('handoff');
  });

  it('always confirms purchases and installs, whatever the rules say', () => {
    const buy: ToolDescriptor = {
      name: 'shop.buy',
      source: 'plugin',
      annotations: {},
      effects: ['purchase'],
    };
    const allow = rule({ effect: 'act', match: { tool: ['shop.*'] } });
    expect(evaluate(ctx({ tool: buy }), { custom: [allow] })).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
      layer: 'builtin',
    });
    const install: ToolDescriptor = {
      name: 'pkg.install',
      source: 'builtin',
      effects: ['install'],
    };
    expect(evaluate(ctx({ tool: install, permissionMode: 'auto' })).effect).toBe('ask');
  });

  it('confirms deletions outside the project but not inside it', () => {
    const del: ToolDescriptor = {
      name: 'fs.delete',
      source: 'builtin',
      annotations: {},
      effects: ['data_delete'],
    };
    const inside = evaluate(
      ctx({ tool: del, resource: { kind: 'path', value: '/work/p1/tmp' }, permissionMode: 'auto' }),
    );
    expect(inside.tier).toBe('pre_approvable');
    const remote: ToolDescriptor = {
      name: 'drive.delete',
      source: 'plugin',
      annotations: {},
      effects: ['data_delete'],
    };
    expect(evaluate(ctx({ tool: remote, permissionMode: 'auto' }))).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
    });
  });

  it('confirms messages unless a standing rule names the recipient', () => {
    const to = { kind: 'account' as const, value: 'pat@team.example' };
    expect(evaluate(ctx({ tool: email, resource: to }))).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
    });
    const wildcard = rule({
      effect: 'act',
      match: { tool: ['email.send'], resource: { pattern: '*' } },
    });
    expect(evaluate(ctx({ tool: email, resource: to }), { custom: [wildcard] }).effect).toBe('ask');
    const named = rule({
      id: 'team',
      effect: 'act',
      match: { tool: ['email.send'], resource: { host: 'team.example' } },
    });
    const d = evaluate(ctx({ tool: email, resource: to, egressAllow: ['team.example'] }), {
      custom: [named],
    });
    expect(d).toMatchObject({ effect: 'allow', ruleId: 'team', review: true });
  });

  it('never treats tool, page, channel or capture text as authorization', () => {
    for (const source of ['tool', 'page', 'channel', 'capture', 'file', 'agent'] as const) {
      const d = evaluate(ctx({ tool: exec, permissionMode: 'auto', intent: { source } }));
      expect(d.effect, source).toBe('ask');
    }
    expect(evaluate(ctx({ tool: read, intent: { source: 'page' } })).effect).toBe('allow');
    expect(
      evaluate(ctx({ tool: exec, permissionMode: 'auto', intent: { source: 'schedule' } })).effect,
    ).toBe('allow');
  });

  it('lets an explicit user rule authorize work triggered by untrusted content', () => {
    const standing = rule({ effect: 'act', match: { tool: ['exec.run'] } });
    const d = evaluate(ctx({ tool: exec, intent: { source: 'channel' } }), { custom: [standing] });
    expect(d).toMatchObject({ effect: 'allow', review: true });
  });

  it('asks for hosts that are not on the network allowlist', () => {
    const fetch: ToolDescriptor = {
      name: 'web.post',
      source: 'builtin',
      annotations: { requiresNetwork: true },
      effects: ['network'],
    };
    const host = { kind: 'host' as const, value: 'api.unknown.example' };
    expect(evaluate(ctx({ tool: fetch, resource: host, permissionMode: 'auto' })).effect).toBe(
      'ask',
    );
    expect(
      evaluate(
        ctx({
          tool: fetch,
          resource: host,
          permissionMode: 'auto',
          egressAllow: ['*.unknown.example'],
        }),
      ).effect,
    ).toBe('allow');
  });
});

describe('rule layers', () => {
  it('lets any matching deny win over allows in earlier layers', () => {
    const managedAllow = rule({ id: 'm', effect: 'allow', match: { tool: ['exec.run'] } });
    const userDeny = rule({ id: 'u', effect: 'deny', match: { tool: ['exec.*'] } });
    const d = evaluate(ctx({ tool: exec }), { managed: [managedAllow], custom: [userDeny] });
    expect(d).toMatchObject({ effect: 'deny', ruleId: 'u', layer: 'custom' });
  });

  it('prefers managed rules over custom rules', () => {
    const managed = rule({ id: 'm', effect: 'ask', match: { tool: ['exec.run'] } });
    const custom = rule({ id: 'c', effect: 'allow', match: { tool: ['exec.run'] } });
    expect(evaluate(ctx({ tool: exec }), { managed: [managed], custom: [custom] })).toMatchObject({
      ruleId: 'm',
      effect: 'ask',
    });
  });

  it('orders by priority, then by scope specificity', () => {
    const globalAsk = rule({ id: 'g', effect: 'ask', match: { tool: ['exec.run'] } });
    const sessionAllow = rule({
      id: 's',
      effect: 'allow',
      scope: { kind: 'session', ref: 's1' },
      match: { tool: ['exec.run'] },
    });
    expect(evaluate(ctx({ tool: exec }), { custom: [globalAsk, sessionAllow] }).ruleId).toBe('s');
    const urgentGlobal = { ...globalAsk, id: 'g2', priority: 10 };
    expect(evaluate(ctx({ tool: exec }), { custom: [urgentGlobal, sessionAllow] }).ruleId).toBe(
      'g2',
    );
  });

  it('honours scopes: session, project, tool, plugin and site', () => {
    const other = rule({ effect: 'allow', scope: { kind: 'session', ref: 'other' }, match: {} });
    expect(evaluate(ctx({ tool: exec }), { custom: [other] }).layer).toBe('fallback');
    const project = rule({ id: 'p', effect: 'allow', scope: { kind: 'project' }, match: {} });
    expect(evaluate(ctx({ tool: exec }), { custom: [project] }).ruleId).toBe('p');
    const tool = rule({
      id: 't',
      effect: 'deny',
      scope: { kind: 'tool', ref: 'exec.*' },
      match: {},
    });
    expect(evaluate(ctx({ tool: exec }), { custom: [tool] }).ruleId).toBe('t');
    const plugin = rule({
      id: 'pl',
      effect: 'handoff',
      scope: { kind: 'plugin', ref: 'com.example.mail' },
      match: {},
    });
    expect(evaluate(ctx({ tool: email }), { custom: [plugin] }).effect).toBe('handoff');
    const site = rule({
      id: 'si',
      effect: 'deny',
      scope: { kind: 'site', ref: '*.bank.example' },
      match: {},
    });
    const browse: ToolDescriptor = {
      name: 'browser.navigate',
      source: 'builtin',
      annotations: { readOnly: true },
    };
    expect(
      evaluate(ctx({ tool: browse, resource: { kind: 'host', value: 'www.bank.example' } }), {
        custom: [site],
      }).effect,
    ).toBe('deny');
    expect(
      evaluate(ctx({ tool: browse, resource: { kind: 'host', value: 'bank.example' } }), {
        custom: [site],
      }).effect,
    ).toBe('allow');
  });

  it('matches by source, read-only flag, effect and resource', () => {
    const bySource = rule({ id: 'src', effect: 'deny', match: { source: ['plugin'] } });
    expect(evaluate(ctx({ tool: email }), { custom: [bySource] }).ruleId).toBe('src');
    expect(evaluate(ctx({ tool: exec }), { custom: [bySource] }).ruleId).toBeUndefined();
    const ro = rule({ id: 'ro', effect: 'ask', match: { readOnly: true } });
    expect(evaluate(ctx({ tool: read }), { custom: [ro] }).effect).toBe('ask');
    const eff = rule({ id: 'eff', effect: 'deny', match: { effect: ['exec'] } });
    expect(evaluate(ctx({ tool: exec }), { custom: [eff] }).ruleId).toBe('eff');
    const pathRule = rule({
      id: 'pp',
      effect: 'allow',
      match: { resource: { kind: 'path', pathPrefix: '/work/p1/src' } },
    });
    expect(
      evaluate(ctx({ tool: write, resource: { kind: 'path', value: '/work/p1/src/a.ts' } }), {
        custom: [pathRule],
      }).effect,
    ).toBe('allow');
    expect(
      evaluate(ctx({ tool: write, resource: { kind: 'path', value: '/work/p1/b.ts' } }), {
        custom: [pathRule],
      }).effect,
    ).toBe('ask');
    expect(evaluate(ctx({ tool: write }), { custom: [pathRule] }).ruleId).toBeUndefined();
    const kindRule = rule({ id: 'k', effect: 'deny', match: { resource: { kind: 'host' } } });
    expect(
      evaluate(ctx({ tool: write, resource: { kind: 'path', value: '/work/p1/x' } }), {
        custom: [kindRule],
      }).ruleId,
    ).toBeUndefined();
    const hostRule = rule({ id: 'h', effect: 'deny', match: { resource: { host: 'x.example' } } });
    expect(
      evaluate(ctx({ tool: write, resource: { kind: 'path', value: '/work/p1/x' } }), {
        custom: [hostRule],
      }).ruleId,
    ).toBeUndefined();
  });

  it('skips disabled rules', () => {
    const off = rule({ effect: 'deny', enabled: false, match: {} });
    expect(evaluate(ctx(), { custom: [off] }).effect).toBe('allow');
  });

  it('maps act-on-request to allow only during an explicit user request', () => {
    const r = rule({ id: 'aor', effect: 'act_on_request', match: { tool: ['exec.run'] } });
    expect(evaluate(ctx({ tool: exec }), { custom: [r] }).effect).toBe('allow');
    expect(
      evaluate(ctx({ tool: exec, intent: { source: 'user_typed', requestActive: false } }), {
        custom: [r],
      }).effect,
    ).toBe('ask');
    expect(
      evaluate(ctx({ tool: exec, intent: { source: 'channel', requestActive: true } }), {
        custom: [r],
      }).effect,
    ).toBe('ask');
  });

  it('supports handoff and ask rules and labels reasons', () => {
    const h = rule({
      id: 'h',
      label: 'Hand off deploys',
      effect: 'handoff',
      match: { tool: ['exec.run'] },
    });
    expect(evaluate(ctx({ tool: exec }), { custom: [h] })).toMatchObject({
      effect: 'handoff',
      reason: 'rule "Hand off deploys"',
    });
  });

  it('applies per-tool defaults, exact before the most specific glob', () => {
    const defaults = { 'exec.run': 'allow', 'mcp:*': 'ask', 'mcp:linear.*': 'allow' } as const;
    expect(evaluate(ctx({ tool: exec }), { toolDefaults: { ...defaults } }).effect).toBe('allow');
    const linear: ToolDescriptor = { name: 'mcp:linear.create', source: 'mcp', annotations: {} };
    expect(evaluate(ctx({ tool: linear }), { toolDefaults: { ...defaults } })).toMatchObject({
      effect: 'allow',
      reason: 'default for mcp:linear.*',
    });
  });

  it('records the most specific scope for "always allow"', () => {
    expect(evaluate(ctx({ tool: exec })).scope).toEqual({ kind: 'session', ref: 's1' });
    expect(evaluate(ctx({ tool: exec, scopes: [] })).scope).toEqual({ kind: 'global' });
  });

  it('does not ask the reviewer about user actions', () => {
    expect(
      evaluate(ctx({ tool: exec, permissionMode: 'auto', actor: { kind: 'user' } })).review,
    ).toBe(false);
  });
});

describe('matchers', () => {
  it('globs dotted names', () => {
    expect(globMatch('fs.*', 'fs.read')).toBe(true);
    expect(globMatch('fs.*', 'fs.read.more')).toBe(false);
    expect(globMatch('mcp:**', 'mcp:a.b')).toBe(true);
    expect(globMatch('**', 'anything')).toBe(true);
    expect(globMatch('a+b', 'a+b')).toBe(true);
  });

  it('matches hosts', () => {
    expect(hostMatch('*.example.com', 'api.example.com')).toBe(true);
    expect(hostMatch('*.example.com', 'example.com')).toBe(false);
    expect(hostMatch('Example.com', 'example.com.')).toBe(true);
    expect(hostMatch('*', 'x')).toBe(true);
  });

  it('checks path containment for POSIX and Windows paths', () => {
    expect(isWithinPath('/a/b', '/a/b/c')).toBe(true);
    expect(isWithinPath('/a/b', '/a/bc')).toBe(false);
    expect(isWithinPath('C:\\work', 'C:\\work\\x.txt')).toBe(true);
    expect(isWithinPath('/', '/etc')).toBe(true);
    expect(isWithinPath('/a', '/a/../etc')).toBe(false);
  });
});
