import { describe, expect, it } from 'vitest';
import { evaluate, tighten } from '../src/engine.ts';
import type {
  CommandRule,
  PolicyContext,
  PolicyGrant,
  PolicyRule,
  ToolDescriptor,
} from '../src/types.ts';

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
const del: ToolDescriptor = {
  name: 'fs.delete',
  source: 'builtin',
  annotations: { destructive: true, action: 'delete' },
  effects: ['data_delete'],
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
const post: ToolDescriptor = {
  name: 'web.post',
  source: 'builtin',
  annotations: { requiresNetwork: true },
  effects: ['network'],
};
const fetchTool: ToolDescriptor = {
  name: 'web.fetch',
  source: 'builtin',
  annotations: { readOnly: true, requiresNetwork: true },
  effects: ['network'],
};
const mcpTool: ToolDescriptor = {
  name: 'mcp:files.list_items',
  source: 'mcp',
  serverId: 'files',
  annotations: { readOnly: true },
};

const USER = { messageId: 'm1', accountId: 'acc' };

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    actor: { kind: 'agent', id: 'a1' },
    scopes: [
      { kind: 'session', ref: 's1' },
      { kind: 'thread', ref: 's1' },
      { kind: 'project', ref: 'p1' },
      { kind: 'global' },
    ],
    approvalPolicy: { kind: 'defaults' },
    permissionProfile: { id: 'workspace', hash: 'h' },
    provenance: { userInstruction: USER, taint: [] },
    tool: read,
    environment: { kind: 'local', trusted: true, substrate: 'os_sandbox' },
    fs: {
      entries: [
        { path: '/work/p1', access: 'write' },
        { path: '/ref', access: 'read' },
      ],
      dataDir: '/data/nova',
      dataDirAllow: ['/data/nova/workspace'],
      home: '/home/u',
    },
    ...over,
  };
}

const rule = (r: Partial<PolicyRule> & Pick<PolicyRule, 'effect'>): PolicyRule => ({
  id: r.id ?? 'r',
  scope: r.scope ?? { kind: 'global' },
  match: r.match ?? {},
  ...r,
});

const cmdRule = (
  r: Partial<CommandRule> & Pick<CommandRule, 'pattern' | 'decision'>,
): CommandRule => ({
  id: r.id ?? 'c',
  scope: r.scope ?? { kind: 'global' },
  matchExamples: ['x'],
  notMatchExamples: ['y'],
  source: 'user',
  ...r,
});

const inP1 = { kind: 'path' as const, value: '/work/p1/a.ts' };

describe('defaults and approval policies (docs/12 §2.1)', () => {
  it('allows read-only built-ins and asks for changes by default', () => {
    expect(evaluate(ctx())).toMatchObject({ effect: 'allow', source: 'fallback' });
    const d = evaluate(ctx({ tool: write, resource: inP1 }));
    expect(d).toMatchObject({ effect: 'ask', source: 'tool_default', persistable: true });
    expect(d.userSet).toBeUndefined();
  });

  it('never trusts an MCP read-only hint: MCP tools without a default ask (docs/08 §1)', () => {
    expect(evaluate(ctx({ tool: mcpTool }))).toMatchObject({
      effect: 'ask',
      tier: 'pre_approvable',
    });
  });

  it('applies user-set defaults: exact, then server, then the most specific glob', () => {
    const toolDefaults = { 'exec.run': 'allow', 'mcp:*': 'ask', 'mcp:files.*': 'allow' } as const;
    expect(evaluate(ctx({ tool: exec }), { toolDefaults })).toMatchObject({
      effect: 'allow',
      source: 'tool_default',
      userSet: true,
    });
    expect(evaluate(ctx({ tool: mcpTool }), { toolDefaults }).reason).toBe(
      'your default for mcp:files.*',
    );
    expect(
      evaluate(ctx({ tool: mcpTool }), { toolDefaults, serverDefaults: { files: 'deny' } }),
    ).toMatchObject({ effect: 'deny', reason: 'your default for files' });
    expect(
      evaluate(ctx({ tool: mcpTool }), { toolDefaults: { 'mcp:files.list_items': 'allow' } })
        .effect,
    ).toBe('allow');
    const plugin: ToolDescriptor = {
      name: 'plugin:com.x.lint',
      source: 'plugin',
      pluginId: 'com.x',
    };
    expect(evaluate(ctx({ tool: plugin }), { serverDefaults: { 'com.x': 'allow' } }).effect).toBe(
      'allow',
    );
  });

  it('lets a user default make even a read-only tool ask or deny', () => {
    expect(evaluate(ctx(), { toolDefaults: { 'fs.read': 'ask' } }).effect).toBe('ask');
    expect(evaluate(ctx(), { toolDefaults: { 'fs.read': 'deny' } }).effect).toBe('deny');
  });

  it('ask_always asks for every change, whatever the default', () => {
    const c = ctx({ tool: exec, approvalPolicy: { kind: 'ask_always' } });
    expect(evaluate(c, { toolDefaults: { 'exec.run': 'allow' } })).toMatchObject({
      effect: 'ask',
      source: 'approval_policy',
    });
    expect(evaluate(ctx({ approvalPolicy: { kind: 'ask_always' } })).effect).toBe('allow');
  });

  it('defaults with autoAccept allows file edits inside writable folders only', () => {
    const policy = { kind: 'defaults' as const, autoAccept: ['file_edit' as const] };
    expect(evaluate(ctx({ tool: write, resource: inP1, approvalPolicy: policy })).effect).toBe(
      'allow',
    );
    expect(evaluate(ctx({ tool: exec, approvalPolicy: policy })).effect).toBe('ask');
    expect(
      evaluate(ctx({ tool: write, resource: inP1, approvalPolicy: { kind: 'defaults' } })).effect,
    ).toBe('ask');
  });

  it('review allows pre-approvable actions and flags them for the reviewer', () => {
    const d = evaluate(ctx({ tool: exec, approvalPolicy: { kind: 'review' } }));
    expect(d).toMatchObject({ effect: 'allow', review: true });
    expect(
      evaluate(ctx({ tool: exec, approvalPolicy: { kind: 'review' } }), {
        toolDefaults: { 'exec.run': 'ask' },
      }),
    ).toMatchObject({ effect: 'ask', userSet: true });
    expect(
      evaluate(ctx({ tool: exec, approvalPolicy: { kind: 'review' }, actor: { kind: 'user' } }))
        .review,
    ).toBe(false);
  });

  it('never_ask turns built-in default asks into allows but keeps user asks and tiers', () => {
    const c = ctx({ tool: exec, approvalPolicy: { kind: 'never_ask' } });
    expect(evaluate(c).effect).toBe('allow');
    expect(evaluate(c, { toolDefaults: { 'exec.run': 'ask' } }).effect).toBe('ask');
    expect(
      evaluate(c, { rules: [rule({ effect: 'ask', match: { tool: ['exec.run'] } })] }).effect,
    ).toBe('ask');
    const buy: ToolDescriptor = { name: 'shop.buy', source: 'builtin', effects: ['purchase'] };
    expect(evaluate({ ...c, tool: buy })).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
    });
  });
});

describe('built-in safety: hard denies (docs/12 §2.2)', () => {
  it('denies policy changes and secret access by agents, not by the user', () => {
    const policy: ToolDescriptor = {
      name: 'policy.rules.upsert',
      source: 'builtin',
      effects: ['policy_change'],
    };
    expect(evaluate(ctx({ tool: policy }))).toMatchObject({ effect: 'deny', source: 'builtin' });
    expect(evaluate(ctx({ tool: policy, actor: { kind: 'user' } })).effect).toBe('ask');
    const secret: ToolDescriptor = {
      name: 'secrets.read',
      source: 'builtin',
      effects: ['secret_access'],
    };
    expect(evaluate(ctx({ tool: secret })).effect).toBe('deny');
  });

  it('denies contact with an external agent the user did not name (FR-194)', () => {
    const counterpart = { externalAgent: true, id: 'bot@x' };
    expect(evaluate(ctx({ tool: email, counterpart })).reason).toContain('did not name');
    const named = ctx({
      tool: email,
      counterpart,
      provenance: { userInstruction: USER, taint: [], namedAgents: ['bot@x'] },
    });
    expect(evaluate(named).effect).toBe('ask');
    expect(
      evaluate(ctx({ tool: email, counterpart: { externalAgent: false, id: 'p' } })).effect,
    ).toBe('ask');
  });

  it('runs the full profile only inside a VM or container', () => {
    const full = { id: 'full', hash: 'h', requiresSubstrate: 'vm_or_container' as const };
    expect(evaluate(ctx({ permissionProfile: full }))).toMatchObject({
      effect: 'deny',
      source: 'builtin',
    });
    const vm = { kind: 'vm', trusted: true, substrate: 'micro_vm' as const };
    expect(evaluate(ctx({ permissionProfile: full, environment: vm })).effect).toBe('allow');
  });

  it('denies writes outside writable roots and to protected paths, whatever the rules say', () => {
    const allowAll = rule({ effect: 'allow', match: { tool: ['fs.*'] } });
    const at = (value: string, tool = write) =>
      evaluate(ctx({ tool, resource: { kind: 'path', value } }), { rules: [allowAll] });
    expect(at('/etc/passwd')).toMatchObject({ effect: 'deny', source: 'builtin' });
    expect(at('/ref/notes.md').reason).toBe('this folder is read-only for tools');
    expect(at('/work/p1/.git/config').reason).toBe('.git stays read-only');
    expect(at('/work/p1/.GIT/config').effect).toBe('deny');
    expect(at('/work/p1/src/../.git/config').reason).toContain('absolute');
    expect(at('/work/p1/.ssh/id_rsa', read).effect).toBe('deny');
    expect(at('/data/nova/vault.db', read).effect).toBe('deny');
    expect(at('/work/p1/a.ts').effect).toBe('allow');
    expect(at('/ref/notes.md', read).effect).toBe('allow');
    expect(at('/elsewhere/x', read).reason).toContain('outside');
  });

  it('denies deleting a root or an ancestor of a protected location', () => {
    const at = (value: string) => evaluate(ctx({ tool: del, resource: { kind: 'path', value } }));
    expect(at('/work/p1')).toMatchObject({
      effect: 'deny',
      reason: 'deleting this would remove a protected folder or a whole root',
    });
    expect(at('/work/p1/build').effect).toBe('ask');
    const wide = (value: string) =>
      evaluate(
        ctx({
          tool: del,
          resource: { kind: 'path', value },
          fs: { entries: [{ path: '/home', access: 'write' }], home: '/home/u' },
        }),
      );
    expect(wide('/home/u').reason).toContain('protected');
    expect(wide('/home/other/tmp').effect).toBe('ask');
  });

  it('denies hosts on the network deny list', () => {
    const d = evaluate(
      ctx({
        tool: fetchTool,
        resource: { kind: 'host', value: 'paste.example' },
        egress: { deny: ['paste.example'] },
      }),
    );
    expect(d).toMatchObject({
      effect: 'deny',
      reason: 'paste.example is on the network deny list',
    });
  });
});

describe('confirmation tiers (FR-189)', () => {
  it('hands off CAPTCHAs, credential changes and user-only steps', () => {
    const captcha: ToolDescriptor = {
      name: 'browser.solve',
      source: 'builtin',
      effects: ['captcha'],
    };
    expect(evaluate(ctx({ tool: captcha }))).toMatchObject({
      effect: 'handoff',
      tier: 'handoff_required',
      persistable: false,
    });
    const mfa: ToolDescriptor = {
      name: 'site.mfa',
      source: 'builtin',
      annotations: { requiresUser: true },
    };
    expect(evaluate(ctx({ tool: mfa }), { rules: [rule({ effect: 'allow' })] }).effect).toBe(
      'handoff',
    );
    expect(evaluate(ctx({ tool: mfa }), { rules: [rule({ effect: 'deny' })] }).effect).toBe('deny');
  });

  it('confirms purchases, account changes and installs at the moment of action, whatever allows them', () => {
    const buy: ToolDescriptor = {
      name: 'shop.buy',
      source: 'plugin',
      annotations: {},
      effects: ['purchase'],
    };
    const allow = rule({ effect: 'allow', match: { tool: ['shop.*'] } });
    const grant: PolicyGrant = { id: 'g', scope: { kind: 'global' }, tool: 'shop.buy' };
    expect(
      evaluate(ctx({ tool: buy, approvalPolicy: { kind: 'never_ask' } }), {
        rules: [allow],
        grants: [grant],
        toolDefaults: { 'shop.buy': 'allow' },
      }),
    ).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
      source: 'builtin',
      persistable: false,
    });
    const acct: ToolDescriptor = {
      name: 'iam.grant',
      source: 'builtin',
      effects: ['account_change'],
    };
    expect(evaluate(ctx({ tool: acct })).tier).toBe('confirm_at_action');
    const install: ToolDescriptor = {
      name: 'pkg.install',
      source: 'builtin',
      effects: ['install'],
    };
    expect(evaluate(ctx({ tool: install, approvalPolicy: { kind: 'review' } })).effect).toBe('ask');
  });

  it('classifies an MCP purchase tool from its name, so pasted approval text never authorizes it', () => {
    const purchase: ToolDescriptor = {
      name: 'mcp:shop.purchase_item',
      source: 'mcp',
      serverId: 'shop',
    };
    const c = ctx({ tool: purchase, provenance: { userInstruction: USER, taint: ['tool'] } });
    expect(evaluate(c, { serverDefaults: { shop: 'allow' } })).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
      persistable: false,
    });
  });

  it('confirms deletions outside the project but not inside it', () => {
    expect(
      evaluate(ctx({ tool: del, resource: { kind: 'path', value: '/work/p1/tmp' } })).tier,
    ).toBe('pre_approvable');
    const remote: ToolDescriptor = {
      name: 'drive.delete',
      source: 'plugin',
      annotations: {},
      effects: ['data_delete'],
    };
    expect(evaluate(ctx({ tool: remote, approvalPolicy: { kind: 'never_ask' } }))).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
    });
  });

  it('confirms messages unless a rule the user made names the recipient', () => {
    const to = { kind: 'account' as const, value: 'pat@team.example' };
    expect(evaluate(ctx({ tool: email, resource: to }))).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
    });
    const wildcard = rule({
      effect: 'allow',
      match: { tool: ['email.send'], resource: { pattern: '*' } },
    });
    expect(evaluate(ctx({ tool: email, resource: to }), { rules: [wildcard] }).effect).toBe('ask');
    const named = rule({
      id: 'team',
      effect: 'allow',
      match: { tool: ['email.send'], resource: { host: 'team.example' } },
    });
    expect(evaluate(ctx({ tool: email, resource: to }), { rules: [named] })).toMatchObject({
      effect: 'allow',
      ruleId: 'team',
    });
    const fromPlugin = { ...named, source: 'plugin' as const };
    expect(evaluate(ctx({ tool: email, resource: to }), { rules: [fromPlugin] }).effect).toBe(
      'ask',
    );
    expect(evaluate(ctx({ tool: email, resource: to }), { managed: [named] }).tier).toBe(
      'confirm_at_action',
    );
  });
});

describe('intent provenance (FR-189)', () => {
  it('asks for consequential actions without a typed instruction, naming the taint', () => {
    for (const taint of [
      ['tool'],
      ['page'],
      ['channel'],
      ['capture'],
      ['file'],
      ['memory'],
    ] as const) {
      const d = evaluate(
        ctx({
          tool: exec,
          approvalPolicy: { kind: 'never_ask' },
          provenance: { taint: [...taint] },
        }),
      );
      expect(d.effect, taint[0]).toBe('ask');
      expect(d.reason).toContain(taint[0]);
      expect(d.authorization).toBe('none');
    }
    expect(
      evaluate(
        ctx({ tool: exec, approvalPolicy: { kind: 'never_ask' }, provenance: { taint: [] } }),
      ).reason,
    ).toBe('no instruction from you authorizes this action');
    expect(evaluate(ctx({ provenance: { taint: ['page'] } })).effect).toBe('allow');
  });

  it('lets a standing rule or grant authorize work without a typed instruction', () => {
    const c = ctx({ tool: exec, provenance: { taint: ['channel'] } });
    expect(
      evaluate(c, { rules: [rule({ effect: 'allow', match: { tool: ['exec.run'] } })] }),
    ).toMatchObject({
      effect: 'allow',
      source: 'rule',
    });
    const g: PolicyGrant = {
      id: 'g1',
      scope: { kind: 'session', ref: 's1' },
      tool: 'exec.run',
      label: 'exec.run in this chat',
    };
    expect(evaluate(c, { grants: [g] })).toMatchObject({
      effect: 'allow',
      source: 'grant',
      grantId: 'g1',
    });
  });

  it('applies "act on request" rules only to an untainted typed instruction', () => {
    const r = rule({ id: 'aor', effect: 'act_on_request', match: { tool: ['exec.run'] } });
    expect(evaluate(ctx({ tool: exec }), { rules: [r] }).effect).toBe('allow');
    expect(
      evaluate(ctx({ tool: exec, provenance: { userInstruction: USER, taint: ['file'] } }), {
        rules: [r],
      }),
    ).toMatchObject({ effect: 'ask', reason: 'your rule acts only when you ask for it' });
    expect(evaluate(ctx({ tool: exec, provenance: { taint: [] } }), { rules: [r] }).effect).toBe(
      'ask',
    );
  });
});

describe('rule layers (docs/12 §2.3)', () => {
  it('lets any matching deny win over allows in earlier layers', () => {
    const managedAllow = rule({ id: 'm', effect: 'allow', match: { tool: ['exec.run'] } });
    const userDeny = rule({ id: 'u', effect: 'deny', match: { tool: ['exec.*'] } });
    expect(
      evaluate(ctx({ tool: exec }), { managed: [managedAllow], rules: [userDeny] }),
    ).toMatchObject({
      effect: 'deny',
      ruleId: 'u',
      source: 'rule',
    });
  });

  it('prefers managed rules over user rules, and user rules over grants', () => {
    const managed = rule({ id: 'm', effect: 'ask', match: { tool: ['exec.run'] } });
    const user = rule({ id: 'c', effect: 'allow', match: { tool: ['exec.run'] } });
    expect(evaluate(ctx({ tool: exec }), { managed: [managed], rules: [user] })).toMatchObject({
      ruleId: 'm',
      effect: 'ask',
      source: 'managed',
      persistable: false,
    });
    const ask = rule({ id: 'a', effect: 'ask', match: { tool: ['exec.run'] } });
    const g: PolicyGrant = { id: 'g', scope: { kind: 'global' }, tool: 'exec.run' };
    expect(evaluate(ctx({ tool: exec }), { rules: [ask], grants: [g] }).ruleId).toBe('a');
  });

  it('orders by scope specificity first, then by priority, then id', () => {
    const globalAsk = rule({ id: 'g', effect: 'ask', priority: 1, match: { tool: ['exec.run'] } });
    const sessionAllow = rule({
      id: 's',
      effect: 'allow',
      scope: { kind: 'session', ref: 's1' },
      match: { tool: ['exec.run'] },
    });
    expect(evaluate(ctx({ tool: exec }), { rules: [globalAsk, sessionAllow] }).ruleId).toBe('s');
    const a = rule({ id: 'a', effect: 'allow', priority: 50, match: { tool: ['exec.run'] } });
    const b = rule({ id: 'b', effect: 'ask', priority: 10, match: { tool: ['exec.run'] } });
    expect(evaluate(ctx({ tool: exec }), { rules: [a, b] }).ruleId).toBe('b');
    const b2 = { ...b, id: 'b2', priority: 50 };
    expect(evaluate(ctx({ tool: exec }), { rules: [b2, a] }).ruleId).toBe('a');
  });

  it('honours scopes: session, project, tool, plugin and site', () => {
    const other = rule({ effect: 'allow', scope: { kind: 'session', ref: 'other' } });
    expect(evaluate(ctx({ tool: exec }), { rules: [other] }).source).toBe('tool_default');
    const project = rule({ id: 'p', effect: 'allow', scope: { kind: 'project' } });
    expect(evaluate(ctx({ tool: exec }), { rules: [project] }).ruleId).toBe('p');
    const tool = rule({ id: 't', effect: 'deny', scope: { kind: 'tool', ref: 'exec.*' } });
    expect(evaluate(ctx({ tool: exec }), { rules: [tool] }).ruleId).toBe('t');
    const noRef = rule({ id: 'nr', effect: 'deny', scope: { kind: 'tool' } });
    expect(evaluate(ctx({ tool: exec }), { rules: [noRef] }).ruleId).toBeUndefined();
    const plugin = rule({
      id: 'pl',
      effect: 'handoff',
      scope: { kind: 'plugin', ref: 'com.example.mail' },
    });
    expect(evaluate(ctx({ tool: email }), { rules: [plugin] }).effect).toBe('handoff');
    const site = rule({ id: 'si', effect: 'deny', scope: { kind: 'site', ref: '*.bank.example' } });
    const browse: ToolDescriptor = {
      name: 'browser.navigate',
      source: 'builtin',
      annotations: { readOnly: true },
    };
    expect(
      evaluate(ctx({ tool: browse, resource: { kind: 'host', value: 'www.bank.example' } }), {
        rules: [site],
      }).effect,
    ).toBe('deny');
    expect(
      evaluate(ctx({ tool: browse, resource: { kind: 'host', value: 'bank.example' } }), {
        rules: [site],
      }).effect,
    ).toBe('allow');
    expect(evaluate(ctx({ tool: browse }), { rules: [site] }).effect).toBe('allow');
  });

  it('matches by source, read-only flag, effect and resource', () => {
    const bySource = rule({ id: 'src', effect: 'deny', match: { source: ['plugin'] } });
    expect(evaluate(ctx({ tool: email }), { rules: [bySource] }).ruleId).toBe('src');
    expect(evaluate(ctx({ tool: exec }), { rules: [bySource] }).ruleId).toBeUndefined();
    const ro = rule({ id: 'ro', effect: 'ask', match: { readOnly: true } });
    expect(evaluate(ctx(), { rules: [ro] }).effect).toBe('ask');
    expect(evaluate(ctx({ tool: mcpTool }), { rules: [ro] }).ruleId).toBeUndefined();
    const eff = rule({ id: 'eff', effect: 'deny', match: { effect: ['exec'] } });
    expect(evaluate(ctx({ tool: exec }), { rules: [eff] }).ruleId).toBe('eff');
    expect(evaluate(ctx(), { rules: [eff] }).ruleId).toBeUndefined();
    const pathRule = rule({
      id: 'pp',
      effect: 'allow',
      match: { resource: { kind: 'path', pathPrefix: '/work/p1/src' } },
    });
    expect(
      evaluate(ctx({ tool: write, resource: { kind: 'path', value: '/work/p1/src/a.ts' } }), {
        rules: [pathRule],
      }).effect,
    ).toBe('allow');
    expect(evaluate(ctx({ tool: write, resource: inP1 }), { rules: [pathRule] }).effect).toBe(
      'ask',
    );
    expect(evaluate(ctx({ tool: write }), { rules: [pathRule] }).ruleId).toBeUndefined();
    const kindRule = rule({ id: 'k', effect: 'deny', match: { resource: { kind: 'host' } } });
    expect(
      evaluate(ctx({ tool: write, resource: inP1 }), { rules: [kindRule] }).ruleId,
    ).toBeUndefined();
    const hostRule = rule({ id: 'h', effect: 'deny', match: { resource: { host: 'x.example' } } });
    expect(
      evaluate(ctx({ tool: write, resource: inP1 }), { rules: [hostRule] }).ruleId,
    ).toBeUndefined();
    const pat = rule({ id: 'pat', effect: 'deny', match: { resource: { pattern: 'pat@*' } } });
    expect(
      evaluate(ctx({ tool: email, resource: { kind: 'account', value: 'pat@x' } }), {
        rules: [pat],
      }).ruleId,
    ).toBe('pat');
    expect(
      evaluate(ctx({ tool: email, resource: { kind: 'account', value: 'sam@x' } }), {
        rules: [pat],
      }).ruleId,
    ).toBeUndefined();
  });

  it('skips disabled rules and labels reasons', () => {
    const off = rule({ effect: 'deny', enabled: false });
    expect(evaluate(ctx(), { rules: [off] }).effect).toBe('allow');
    const h = rule({
      id: 'h',
      label: 'Hand off deploys',
      effect: 'handoff',
      match: { tool: ['exec.run'] },
    });
    expect(evaluate(ctx({ tool: exec }), { rules: [h] })).toMatchObject({
      effect: 'handoff',
      reason: 'rule "Hand off deploys"',
    });
    expect(evaluate(ctx({ tool: exec }), { managed: [rule({ effect: 'deny' })] }).reason).toBe(
      'managed rule',
    );
  });
});

describe('command prefix rules in the engine (FR-191)', () => {
  const npmTest = cmdRule({ id: 'npm', pattern: ['npm', 'test'], decision: 'allow' });
  const noRm = cmdRule({
    id: 'rm',
    pattern: ['rm', ['-rf', '-r']],
    decision: 'deny',
    justification: 'Use fs.delete.',
  });
  const run = (command: string, rules: CommandRule[], over: Partial<PolicyContext> = {}) =>
    evaluate(ctx({ tool: exec, command, ...over }), { commandRules: rules });

  it('allows a covered command and asks when any part is not covered', () => {
    expect(run('npm test', [npmTest])).toMatchObject({
      effect: 'allow',
      ruleId: 'npm',
      source: 'rule',
    });
    expect(run('npm test && curl https://x.example', [npmTest])).toMatchObject({
      effect: 'ask',
      source: 'tool_default',
    });
    expect(run('sudo npm test', [npmTest]).effect).toBe('ask');
  });

  it('denies with the justification when any part matches a deny rule', () => {
    expect(run('npm test; sudo rm -rf /', [npmTest, noRm])).toMatchObject({
      effect: 'deny',
      reason: 'Use fs.delete.',
    });
  });

  it('applies managed command rules before user ones, to exec.write lines, and only in scope', () => {
    const managedAsk = {
      ...cmdRule({ id: 'mask', pattern: ['npm'], decision: 'ask' }),
      source: 'managed' as const,
    };
    expect(run('npm test', [npmTest, managedAsk])).toMatchObject({
      effect: 'ask',
      ruleId: 'mask',
      source: 'managed',
    });
    const write: ToolDescriptor = {
      name: 'exec.write',
      source: 'builtin',
      annotations: { destructive: true },
    };
    expect(run('npm test', [npmTest], { tool: write }).effect).toBe('allow');
    const other: ToolDescriptor = {
      name: 'git.commit',
      source: 'builtin',
      annotations: { destructive: true },
    };
    expect(run('npm test', [npmTest], { tool: other }).effect).toBe('ask');
    const projectOnly = cmdRule({
      id: 'p2',
      pattern: ['ls'],
      decision: 'allow',
      scope: { kind: 'project', ref: 'p2' },
    });
    expect(run('ls', [projectOnly]).effect).toBe('ask');
    const disabled = { ...npmTest, enabled: false };
    expect(run('npm test', [disabled]).effect).toBe('ask');
    expect(evaluate(ctx({ tool: exec }), { commandRules: [npmTest] }).effect).toBe('ask');
  });

  it('prefers the more specific command rule', () => {
    const globalAsk = cmdRule({ id: 'ga', pattern: ['git', 'push'], decision: 'ask' });
    const projAllow = cmdRule({
      id: 'pa',
      pattern: ['git', 'push'],
      decision: 'allow',
      scope: { kind: 'project', ref: 'p1' },
    });
    expect(run('git push', [globalAsk, projAllow]).ruleId).toBe('pa');
  });
});

describe('grants', () => {
  it('covers the tool, an exec prefix, a host or an identical call', () => {
    const s = { kind: 'session' as const, ref: 's1' };
    const byPrefix: PolicyGrant = {
      id: 'gp',
      scope: s,
      tool: 'exec.run',
      command: ['npm', 'test'],
    };
    expect(
      evaluate(ctx({ tool: exec, command: 'npm test -- --watch' }), { grants: [byPrefix] }).grantId,
    ).toBe('gp');
    expect(
      evaluate(ctx({ tool: exec, command: 'npm publish' }), { grants: [byPrefix] }).grantId,
    ).toBeUndefined();
    expect(evaluate(ctx({ tool: exec }), { grants: [byPrefix] }).grantId).toBeUndefined();
    const byHash: PolicyGrant = { id: 'gh', scope: s, tool: 'exec.run', argsHash: 'abc' };
    expect(evaluate(ctx({ tool: exec, argsHash: 'abc' }), { grants: [byHash] }).effect).toBe(
      'allow',
    );
    expect(evaluate(ctx({ tool: exec, argsHash: 'abd' }), { grants: [byHash] }).effect).toBe('ask');
    const other: PolicyGrant = {
      id: 'go',
      scope: { kind: 'session', ref: 's2' },
      tool: 'exec.run',
    };
    expect(evaluate(ctx({ tool: exec }), { grants: [other] }).effect).toBe('ask');
  });

  it('satisfies the network allowlist only when the grant or rule names the host', () => {
    const host = { kind: 'host' as const, value: 'api.unknown.example' };
    const c = ctx({ tool: post, resource: host, approvalPolicy: { kind: 'never_ask' } });
    expect(evaluate(c)).toMatchObject({
      effect: 'ask',
      reason: 'api.unknown.example is not on the network allowlist',
    });
    expect(evaluate({ ...c, egress: { allow: ['*.unknown.example'] } }).effect).toBe('allow');
    const toolOnly: PolicyGrant = { id: 'g1', scope: { kind: 'global' }, tool: 'web.post' };
    expect(evaluate(c, { grants: [toolOnly] }).effect).toBe('ask');
    const withHost: PolicyGrant = { ...toolOnly, id: 'g2', host: 'api.unknown.example' };
    expect(evaluate(c, { grants: [withHost] }).effect).toBe('allow');
    expect(
      evaluate({ ...c, resource: { kind: 'host', value: 'other.example' } }, { grants: [withHost] })
        .effect,
    ).toBe('ask');
    const anyHost: PolicyGrant = { ...toolOnly, id: 'g3', host: '*' };
    expect(evaluate(c, { grants: [anyHost] }).effect).toBe('ask');
    const siteRule = rule({
      id: 'site',
      effect: 'allow',
      scope: { kind: 'site', ref: 'api.unknown.example' },
    });
    expect(evaluate(c, { rules: [siteRule] }).effect).toBe('allow');
    const hostRule = rule({
      id: 'hr',
      effect: 'allow',
      match: { resource: { kind: 'host', host: 'api.unknown.example' } },
    });
    expect(evaluate(c, { rules: [hostRule] }).effect).toBe('allow');
    expect(evaluate(ctx({ tool: fetchTool, resource: host })).effect).toBe('allow');
  });
});

describe('tighten (hooks and reviewer extension points)', () => {
  it('only ever tightens', () => {
    const d = evaluate(ctx({ tool: exec, approvalPolicy: { kind: 'review' } }));
    expect(tighten(d, { effect: 'allow', reason: 'fine', source: 'reviewer' })).toBe(d);
    expect(tighten(d, { effect: 'deny', reason: 'risky', source: 'reviewer' })).toMatchObject({
      effect: 'deny',
      source: 'reviewer',
      review: false,
    });
    const denied = evaluate(ctx({ tool: exec }), { rules: [rule({ effect: 'deny' })] });
    expect(tighten(denied, { effect: 'allow', reason: 'x', source: 'hook' }).effect).toBe('deny');
  });
});
