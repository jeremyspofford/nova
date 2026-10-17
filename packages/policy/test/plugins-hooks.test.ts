// Plugin permissions in the engine (FR-045, docs/08 §3.1) and permission-hook answers (FR-197,
// docs/12 §2.3 step 7): declared hosts allowed, undeclared hosts denied with a clear reason,
// per-tool and per-action defaults below the user's own, undeclared tools ask; a hook tightens
// anything but a deny or a handoff, and answers only an ask from steps 3-4 with no floor behind it.
import { describe, expect, it } from 'vitest';
import { actionEffect, effectiveEffects } from '../src/classify.ts';
import { applyHookAnswer, evaluate } from '../src/engine.ts';
import { hostPattern, urlHosts } from '../src/match.ts';
import type { PluginPolicy, PolicyContext, PolicyRule, ToolDescriptor } from '../src/types.ts';

const USER = { messageId: 'm1', accountId: 'acc' };

const fetchStatus: ToolDescriptor = {
  name: 'plugin:com.example.sample.fetch_status',
  source: 'plugin',
  pluginId: 'com.example.sample',
  title: 'Fetch status',
  description: 'Report the status of a URL',
  annotations: { requiresNetwork: true },
};
const panel: ToolDescriptor = {
  name: 'plugin:com.example.sample.panel_action',
  source: 'plugin',
  pluginId: 'com.example.sample',
  title: 'Panel action',
  description: 'Apply a value',
};
const undeclared: ToolDescriptor = {
  name: 'plugin:com.example.sample.other_thing',
  source: 'plugin',
  pluginId: 'com.example.sample',
  title: 'Other',
  description: 'Another tool',
};
const mcpOfPlugin: ToolDescriptor = {
  name: 'mcp:sample.fetch_status',
  source: 'mcp',
  serverId: 'sample',
  title: 'Fetch status',
  description: 'Report the status of a URL',
};
const exec: ToolDescriptor = {
  name: 'exec.run',
  source: 'builtin',
  annotations: { destructive: true },
  effects: ['exec'],
};

const plugin: PluginPolicy = {
  pluginId: 'com.example.sample',
  network: ['api.example.com', '*.cdn.example.net'],
  tools: {
    'plugin:com.example.sample.fetch_status': { action: 'read', default: 'allow' },
    'plugin:com.example.sample.panel_action': { action: 'write' },
  },
  actionDefaults: { read: 'allow', write: 'ask', send: 'ask', delete: 'deny' },
};

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    actor: { kind: 'agent', id: 'chat' },
    scopes: [{ kind: 'thread', ref: 't1' }, { kind: 'global' }],
    approvalPolicy: { kind: 'defaults' },
    permissionProfile: { id: 'workspace', hash: 'h' },
    provenance: { userInstruction: USER, taint: [] },
    tool: fetchStatus,
    environment: { kind: 'hub', trusted: true, substrate: null },
    fs: { entries: [{ path: '/work', access: 'write' }] },
    plugin,
    ...over,
  };
}

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'effect'>): PolicyRule => ({
  id: r.id ?? 'r',
  scope: r.scope ?? { kind: 'global' },
  match: r.match ?? {},
  ...r,
});

describe('plugin network permissions (FR-045)', () => {
  it('allows a declared host and needs no allowlist entry for it', () => {
    const d = evaluate(ctx({ args: { url: 'https://api.example.com/status' } }));
    expect(d).toMatchObject({ effect: 'allow', source: 'plugin' });
    // The same host as the call's resource, with the tool asking for the network.
    const r = evaluate(
      ctx({
        args: { url: 'https://api.example.com/x' },
        resource: { kind: 'host', value: 'api.example.com' },
      }),
    );
    expect(r.effect).toBe('allow');
    expect(evaluate(ctx({ args: { url: 'https://img.cdn.example.net/a.png' } })).effect).toBe(
      'allow',
    );
  });

  it('denies an undeclared host with a clear reason, whatever the rules say', () => {
    const d = evaluate(ctx({ args: { url: 'https://evil.example.org/steal' } }), {
      rules: [rule({ effect: 'allow', match: { tool: [fetchStatus.name] } })],
    });
    expect(d).toMatchObject({
      effect: 'deny',
      source: 'plugin',
      reason: 'evil.example.org is not a host this plugin declared',
      persistable: false,
    });
    expect(d.answerable).toBeUndefined();
    // Nested and later URLs count too, and so does a host resource.
    expect(
      evaluate(
        ctx({ args: { a: 'https://api.example.com', more: [{ b: 'http://cdn.example.net/x' }] } }),
      ).reason,
    ).toBe('cdn.example.net is not a host this plugin declared');
    expect(evaluate(ctx({ resource: { kind: 'host', value: 'Other.Example' } })).reason).toBe(
      'other.example is not a host this plugin declared',
    );
  });

  it('keeps built-in hard denies first', () => {
    const d = evaluate(
      ctx({
        args: { url: 'https://evil.example.org' },
        resource: { kind: 'host', value: 'evil.example.org' },
        egress: { deny: ['evil.example.org'] },
      }),
    );
    expect(d).toMatchObject({ effect: 'deny', source: 'builtin' });
  });

  it('does not touch tools without plugin permissions', () => {
    const d = evaluate(ctx({ plugin: undefined, args: { url: 'https://evil.example.org' } }));
    expect(d).toMatchObject({ effect: 'ask', source: 'tool_default' });
  });
});

describe('plugin per-tool and per-action defaults (FR-045, FR-048)', () => {
  it('applies a per-tool default, then the action default, then asks for undeclared tools', () => {
    expect(evaluate(ctx())).toMatchObject({
      effect: 'allow',
      source: 'plugin',
      reason: `the plugin's default for ${fetchStatus.name}`,
    });
    expect(evaluate(ctx({ tool: panel }))).toMatchObject({
      effect: 'ask',
      source: 'plugin',
      reason: "the plugin's default for write actions",
      answerable: true,
    });
    expect(evaluate(ctx({ tool: undeclared }))).toMatchObject({
      effect: 'ask',
      source: 'plugin',
      reason: `${undeclared.name} is not a tool its plugin declared`,
    });
    // An action class without a default falls through to the approval policy.
    const noDefaults = { ...plugin, actionDefaults: {} };
    expect(evaluate(ctx({ tool: panel, plugin: noDefaults }))).toMatchObject({
      effect: 'ask',
      source: 'tool_default',
    });
  });

  it('matches a manifest entry by the local tool name (plugin MCP servers)', () => {
    expect(evaluate(ctx({ tool: mcpOfPlugin }))).toMatchObject({
      effect: 'allow',
      source: 'plugin',
    });
    const bare: PluginPolicy = { ...plugin, tools: { fetch_status: { action: 'delete' } } };
    expect(evaluate(ctx({ tool: mcpOfPlugin, plugin: bare }))).toMatchObject({
      effect: 'deny',
      reason: "the plugin's default for delete actions",
    });
  });

  it("the manifest's action class adds its effect: a send tool is confirmed every time", () => {
    const sends: PluginPolicy = {
      ...plugin,
      tools: { [panel.name]: { action: 'send', default: 'allow' } },
    };
    const d = evaluate(ctx({ tool: panel, plugin: sends }));
    expect(d).toMatchObject({ effect: 'ask', tier: 'confirm_at_action', source: 'builtin' });
    expect(d.answerable).toBeUndefined();
    expect(effectiveEffects(panel, 'execute')).toContain('exec');
    expect(actionEffect('write')).toBeNull();
  });

  it("the user's own defaults and rules win over the plugin's", () => {
    expect(
      evaluate(ctx({ tool: panel }), { toolDefaults: { [panel.name]: 'allow' } }),
    ).toMatchObject({ effect: 'allow', source: 'tool_default' });
    expect(evaluate(ctx(), { toolDefaults: { [fetchStatus.name]: 'deny' } }).effect).toBe('deny');
    expect(
      evaluate(ctx({ tool: undeclared }), {
        rules: [rule({ effect: 'allow', match: { tool: [undeclared.name] } })],
      }),
    ).toMatchObject({ effect: 'allow', source: 'rule' });
  });

  it('a plugin deny wins under every approval policy; its asks are kept', () => {
    const denies: PluginPolicy = { ...plugin, actionDefaults: { write: 'deny' } };
    for (const kind of ['ask_always', 'defaults', 'review', 'never_ask'] as const) {
      expect(evaluate(ctx({ tool: panel, plugin: denies, approvalPolicy: { kind } })).effect).toBe(
        'deny',
      );
      expect(evaluate(ctx({ tool: undeclared, approvalPolicy: { kind } })).effect).toBe('ask');
    }
    expect(evaluate(ctx({ approvalPolicy: { kind: 'ask_always' } })).effect).toBe('ask');
    expect(evaluate(ctx({ approvalPolicy: { kind: 'never_ask' } })).effect).toBe('allow');
  });

  it('keeps the intent-provenance floor: no instruction, no allow', () => {
    const d = evaluate(ctx({ provenance: { taint: ['tool'] } }));
    expect(d).toMatchObject({ effect: 'ask', source: 'builtin' });
    expect(d.answerable).toBeUndefined();
  });
});

describe('permission hook answers (FR-197, docs/12 §2.3 step 7)', () => {
  const answer = (effect: 'allow' | 'ask' | 'handoff' | 'deny', mayAnswer = true) => ({
    effect,
    reason: `hook says ${effect}`,
    hookId: 'hook:user.guard',
    mayAnswer,
  });

  it('marks asks from user rules, tool defaults and plugin defaults as answerable', () => {
    const fromRule = evaluate(ctx({ tool: exec, plugin: undefined }), {
      rules: [rule({ effect: 'ask', match: { tool: ['exec.run'] } })],
    });
    expect(fromRule).toMatchObject({ effect: 'ask', source: 'rule', answerable: true });
    const fromDefault = evaluate(ctx({ tool: exec, plugin: undefined }));
    expect(fromDefault).toMatchObject({ source: 'tool_default', answerable: true });
    expect(evaluate(ctx({ tool: panel }))).toMatchObject({ source: 'plugin', answerable: true });
  });

  it('never marks managed, approval-policy, floor or act-on-request asks as answerable', () => {
    const managed = evaluate(ctx({ tool: exec, plugin: undefined }), {
      managed: [rule({ id: 'm', effect: 'ask', source: 'managed' })],
    });
    expect(managed).toMatchObject({ effect: 'ask', source: 'managed' });
    expect(managed.answerable).toBeUndefined();
    const always = evaluate(
      ctx({ tool: exec, plugin: undefined, approvalPolicy: { kind: 'ask_always' } }),
    );
    expect(always.answerable).toBeUndefined();
    // A user rule asks, and so does the provenance floor: same effect, but not answerable.
    const tainted = evaluate(
      ctx({ tool: exec, plugin: undefined, provenance: { taint: ['page'] } }),
      {
        rules: [rule({ effect: 'ask', match: { tool: ['exec.run'] } })],
      },
    );
    expect(tainted).toMatchObject({ effect: 'ask', source: 'rule' });
    expect(tainted.answerable).toBeUndefined();
    const act = evaluate(
      ctx({
        tool: exec,
        plugin: undefined,
        provenance: { userInstruction: USER, taint: ['file'] },
      }),
      { rules: [rule({ effect: 'act_on_request', match: { tool: ['exec.run'] } })] },
    );
    expect(act).toMatchObject({ effect: 'ask', source: 'rule' });
    expect(act.answerable).toBeUndefined();
  });

  it('lets an eligible hook answer an answerable ask, recorded as the hook', () => {
    const d = evaluate(ctx({ tool: exec, plugin: undefined }));
    expect(applyHookAnswer(d, answer('allow'))).toMatchObject({
      effect: 'allow',
      source: 'hook',
      hookId: 'hook:user.guard',
      reason: 'hook says allow',
      persistable: false,
      review: false,
    });
    expect(applyHookAnswer(d, answer('allow')).answerable).toBeUndefined();
    // Not eligible (a project hook, or a plugin without answersAsks): the ask stays.
    expect(applyHookAnswer(d, answer('allow', false))).toBe(d);
    // An ask that is no answer at all changes nothing.
    expect(applyHookAnswer(d, answer('ask'))).toBe(d);
  });

  it('never loosens a floor, a managed ask, a deny or a handoff', () => {
    // The tool default asks, and so does the provenance floor (no instruction from the user).
    const floor = evaluate(ctx({ tool: exec, plugin: undefined, provenance: { taint: [] } }));
    expect(floor).toMatchObject({ effect: 'ask', source: 'tool_default' });
    expect(floor.answerable).toBeUndefined();
    expect(applyHookAnswer(floor, answer('allow'))).toBe(floor);
    const denied = evaluate(ctx({ tool: exec, plugin: undefined }), {
      rules: [rule({ effect: 'deny' })],
    });
    expect(applyHookAnswer(denied, answer('allow'))).toBe(denied);
    const handoff = evaluate(
      ctx({ tool: { ...exec, annotations: { requiresUser: true } }, plugin: undefined }),
    );
    expect(handoff.effect).toBe('handoff');
    expect(applyHookAnswer(handoff, answer('deny'))).toBe(handoff);
  });

  it('tightens any other decision, managed and built-in ones included', () => {
    const allowed = evaluate(ctx());
    expect(applyHookAnswer(allowed, answer('deny'))).toMatchObject({
      effect: 'deny',
      source: 'hook',
      hookId: 'hook:user.guard',
    });
    expect(applyHookAnswer(allowed, answer('ask', false))).toMatchObject({ effect: 'ask' });
    const floor = evaluate(ctx({ tool: exec, plugin: undefined, provenance: { taint: [] } }));
    expect(applyHookAnswer(floor, answer('handoff', false)).effect).toBe('handoff');
    expect(applyHookAnswer(allowed, answer('allow'))).toBe(allowed);
  });
});

describe('URL hosts and declared host patterns', () => {
  it('collects http(s) and ws(s) hosts from nested arguments, once each', () => {
    expect(
      urlHosts({
        url: 'https://API.example.com/x',
        list: ['http://b.example', 'ftp://c.example', 'not a url', 'https://api.example.com/y'],
        deep: { ws: 'wss://d.example:8443/s' },
        n: 3,
      }),
    ).toEqual(['api.example.com', 'b.example', 'd.example']);
    expect(urlHosts('https://')).toEqual([]);
    expect(urlHosts(null)).toEqual([]);
    let deep: unknown = 'https://too.deep.example';
    for (let i = 0; i < 10; i++) deep = { deep };
    expect(urlHosts(deep)).toEqual([]);
  });

  it('normalizes declared hosts written as URLs or with ports', () => {
    expect(hostPattern('https://api.example.com/v1')).toBe('api.example.com');
    expect(hostPattern('api.example.com:443')).toBe('api.example.com');
    expect(hostPattern(' *.Example.com ')).toBe('*.example.com');
    expect(hostPattern('[::1]:80')).toBe('[::1]:80');
    expect(hostPattern('https://*.bad host')).toBe('*.bad host');
  });
});

describe("the user's own actions in a Nova client (docs/12 §2.3, FR-189)", () => {
  const write: ToolDescriptor = {
    name: 'fs.write',
    source: 'builtin',
    annotations: { destructive: true },
    effects: ['file_write'],
  };
  const inWork = { kind: 'path' as const, value: '/work/a.md' };
  const userCtx = (over: Partial<PolicyContext> = {}) =>
    ctx({ actor: { kind: 'user' }, tool: write, resource: inWork, plugin: undefined, ...over });

  it('allows a pre-approvable action inside the profile without a card', () => {
    expect(evaluate(userCtx())).toMatchObject({
      effect: 'allow',
      source: 'user_action',
      reason: 'you did this yourself in Nova',
      tier: 'pre_approvable',
    });
    // Even under "ask before every change", which is about what agents do.
    expect(evaluate(userCtx({ approvalPolicy: { kind: 'ask_always' } })).effect).toBe('allow');
    // A plugin tool's declared ask, too, when the user clicked it themselves.
    expect(evaluate(userCtx({ tool: panel, plugin, resource: undefined })).effect).toBe('allow');
  });

  it('keeps asking when an app acts on its own, an agent acts, or content shaped it', () => {
    // An MCP App's own call: origin `ui`, but no instruction from the user.
    expect(evaluate(userCtx({ provenance: { taint: ['mcp'] } })).effect).toBe('ask');
    expect(
      evaluate(userCtx({ provenance: { userInstruction: USER, taint: ['page'] } })).effect,
    ).toBe('ask');
    expect(evaluate(userCtx({ actor: { kind: 'agent', id: 'chat' } })).effect).toBe('ask');
  });

  it('keeps floors, rules, denies, built-in safety and sensitive effects', () => {
    const send: ToolDescriptor = {
      ...write,
      name: 'mail.send',
      effects: ['external_communication'],
    };
    expect(evaluate(userCtx({ tool: send, resource: undefined }))).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
    });
    const handoff: ToolDescriptor = { ...write, effects: ['captcha'] };
    expect(evaluate(userCtx({ tool: handoff })).effect).toBe('handoff');
    expect(
      evaluate(userCtx(), { rules: [rule({ effect: 'ask', match: { tool: ['fs.write'] } })] }),
    ).toMatchObject({ effect: 'ask', source: 'rule' });
    expect(
      evaluate(userCtx(), { managed: [rule({ id: 'm', effect: 'ask', source: 'managed' })] })
        .effect,
    ).toBe('ask');
    expect(evaluate(userCtx(), { toolDefaults: { 'fs.write': 'deny' } }).effect).toBe('deny');
    // Outside the profile's roots: denied whoever asks.
    expect(evaluate(userCtx({ resource: { kind: 'path', value: '/etc/passwd' } })).effect).toBe(
      'deny',
    );
    // A host that is not on the allowlist still asks.
    const post: ToolDescriptor = {
      name: 'web.post',
      source: 'builtin',
      annotations: { requiresNetwork: true },
      effects: ['network'],
    };
    expect(
      evaluate(userCtx({ tool: post, resource: { kind: 'host', value: 'x.example' } })),
    ).toMatchObject({ effect: 'ask', reason: 'x.example is not on the network allowlist' });
    const policy: ToolDescriptor = {
      name: 'policy.set',
      source: 'builtin',
      effects: ['policy_change'],
    };
    expect(evaluate(userCtx({ tool: policy, resource: undefined })).effect).toBe('ask');
  });
});
