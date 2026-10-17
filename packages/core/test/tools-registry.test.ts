// Tool registry, deferral and tool search (FR-196), argument validation, artifacts (FR-038),
// mentions (FR-022), text helpers and the runtime's UI-facing parts (tool views, UI invokes).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger, MemorySink } from '@nova/telemetry';
import { defaultRedactor } from '@nova/security';
import type { ToolDescriptor } from '@nova/shared';
import {
  MemoryEventSink,
  ToolRegistry,
  allowAllGate,
  artifactTool,
  builtinSource,
  capHeadTail,
  inputHash,
  isDeferrable,
  mentionCandidates,
  planListing,
  previewOf,
  rankTools,
  resolveMentions,
  schemaTokens,
  sourceGroup,
  stableJson,
  tokenize,
  toolSearchTool,
  validateArgs,
  type ArtifactService,
  type BuiltinTool,
  type ToolDefinition,
  type ToolGate,
  type ToolRoot,
} from '../src/index.ts';
import { ACCOUNT, makeToolEnv, type ToolEnv } from './helpers.ts';

let env: ToolEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

const desc = (name: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor => ({
  name,
  title: name,
  description: `does ${name}`,
  source: name.startsWith('mcp:') ? 'mcp' : 'builtin',
  inputSchema: { type: 'object' },
  ...extra,
});
const def = (name: string, extra: Partial<ToolDescriptor> = {}): ToolDefinition => ({
  descriptor: desc(name, extra),
  handler: () => Promise.resolve({ ok: true, content: [{ type: 'text', text: name }] }),
});

describe('ToolRegistry', () => {
  it('merges sources in order, keeps the first of a name, skips bad names and failing sources', async () => {
    const sink = new MemorySink();
    const reg = new ToolRegistry({
      sources: [
        { source: 'builtin', list: () => Promise.resolve([def('fs.read')]) },
        { source: 'mcp', list: () => Promise.reject(new Error('down')) },
        {
          source: 'mcp',
          list: () =>
            Promise.resolve([
              def('fs.read', { title: 'shadow' }),
              def('mcp:files.search'),
              def('Not A Name'),
            ]),
        },
      ],
      log: new Logger({ module: 't', sinks: [sink] }),
    });
    const names = (await reg.list(ACCOUNT)).map((t) => t.descriptor.name);
    expect(names).toEqual(['fs.read', 'mcp:files.search']);
    expect((await reg.find(ACCOUNT, 'fs.read'))!.descriptor.title).toBe('fs.read');
    expect(await reg.find(ACCOUNT, 'nope')).toBeNull();
    expect(sink.records.map((e) => e.msg)).toEqual(
      expect.arrayContaining([
        'tool source failed to list',
        'tool with a non-canonical name ignored',
      ]),
    );
  });

  it('lists web.search only while a search service is configured (FR-029)', async () => {
    const tools = [def('web.search'), def('fs.read')] as unknown as BuiltinTool[];
    let url: string | null = null;
    const src = builtinSource(tools, () => Promise.resolve(url));
    expect((await src.list(ACCOUNT)).map((t) => t.descriptor.name)).toEqual(['fs.read']);
    url = 'http://searx';
    expect((await src.list(ACCOUNT)).map((t) => t.descriptor.name)).toEqual([
      'web.search',
      'fs.read',
    ]);
    const broken = builtinSource(tools, () => Promise.reject(new Error('x')));
    expect(await broken.list(ACCOUNT)).toHaveLength(1);
  });
});

describe('deferral and tool search (FR-196)', () => {
  const builtins = ['fs.read', 'fs.write', 'tool.search'].map((n) => desc(n));
  const mcp = (server: string, n: number) =>
    Array.from({ length: n }, (_, i) => desc(`mcp:${server}.t${i}`, { description: `tool ${i}` }));

  it('offers everything under budget', () => {
    const l = planListing({
      tools: [...builtins, ...mcp('a', 3)],
      budget: { tools: 40, schemaTokens: 8000 },
      pinned: new Set(),
      loaded: [],
    });
    expect(l.deferred).toEqual([]);
    expect(l.offered).toHaveLength(6);
  });

  it('defers MCP and plugin tools over the tool or token budget, never built-ins or pinned tools', () => {
    const tools = [
      ...builtins,
      ...mcp('a', 30),
      ...mcp('b', 15),
      desc('plugin:x.y', { source: 'plugin' }),
    ];
    const l = planListing({
      tools,
      budget: { tools: 40, schemaTokens: 8000 },
      pinned: new Set(['mcp:b.t0']),
      loaded: [],
    });
    expect(l.offered).toEqual(['fs.read', 'fs.write', 'tool.search', 'mcp:b.t0']);
    expect(l.deferred).toHaveLength(45);
    expect(l.summary).toEqual([
      'mcp:a: 30 tools, deferred',
      'mcp:b: 14 tools, deferred',
      'plugin:x: 1 tool, deferred',
    ]);
    const tokens = planListing({
      tools: [
        ...builtins,
        desc('mcp:big.one', { inputSchema: { description: 'x'.repeat(40_000) } }),
      ],
      budget: { tools: 40, schemaTokens: 8000 },
      pinned: new Set(),
      loaded: [],
    });
    expect(tokens.deferred).toEqual(['mcp:big.one']);
  });

  it('keeps the newest search loads within budget and unloads the oldest', () => {
    const l = planListing({
      tools: [...builtins, ...mcp('a', 50)],
      budget: { tools: 5, schemaTokens: 8000 },
      pinned: new Set(),
      loaded: ['mcp:a.t1', 'mcp:a.t2', 'mcp:a.t3', 'gone'],
    });
    expect(l.offered).toEqual(['fs.read', 'fs.write', 'tool.search', 'mcp:a.t2', 'mcp:a.t3']);
    expect(l.unloaded).toEqual(['mcp:a.t1']);
  });

  it('ranks by name, title and description with BM25, deterministically', () => {
    const tools = [
      desc('mcp:wx.getWeather', { description: 'Current weather for a city' }),
      desc('mcp:cal.createEvent', { description: 'Create a calendar event' }),
      desc('mcp:wx.getForecast', { description: 'Weather forecast for the week' }),
    ];
    expect(tokenize('mcp:wx.getWeather_now-HTTPServer')).toEqual([
      'mcp',
      'wx',
      'get',
      'weather',
      'now',
      'http',
      'server',
    ]);
    const hits = rankTools(tools, 'weather', 5);
    expect(hits.map((h) => h.name)).toEqual(['mcp:wx.getWeather', 'mcp:wx.getForecast']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(rankTools(tools, 'calendar event', 1).map((h) => h.name)).toEqual([
      'mcp:cal.createEvent',
    ]);
    expect(rankTools(tools, '', 5)).toEqual([]);
    expect(rankTools(tools, 'zebra', 5)).toEqual([]);
  });

  it('knows what is deferrable and how sources group', () => {
    expect(isDeferrable(desc('fs.read'))).toBe(false);
    expect(isDeferrable(desc('mcp:a.b'))).toBe(true);
    expect(isDeferrable(desc('mcp:a.b', { loading: 'always' }))).toBe(false);
    expect(sourceGroup(desc('mcp:linear.search'))).toBe('mcp:linear');
    expect(sourceGroup(desc('x.y', { source: 'device', serverId: 'd1' }))).toBe('device:d1');
    expect(schemaTokens(desc('a.b'))).toBeGreaterThan(0);
  });

  it('tool.search needs a turn', async () => {
    const r = await toolSearchTool().handler({ query: 'x' }, {} as never);
    expect(r).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });
});

describe('validateArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 5, pattern: '^[a-z]+$' },
      n: { type: 'integer', minimum: 1, maximum: 3 },
      x: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      mode: { enum: ['a', 'b'] },
      k: { const: 7 },
      list: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
      nested: { type: 'object', additionalProperties: { type: 'boolean' } },
      either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      one: { oneOf: [{ type: 'integer' }, { type: 'number' }] },
      both: { allOf: [{ type: 'string' }, { minLength: 2 }] },
    },
    required: ['path'],
    additionalProperties: false,
  };

  it('accepts valid arguments', () => {
    expect(
      validateArgs(schema, {
        path: 'abc',
        n: 2,
        x: 0.5,
        mode: 'a',
        k: 7,
        list: ['q'],
        nested: { a: true },
        either: null,
        one: 1.5,
        both: 'ok',
      }),
    ).toEqual([]);
  });

  it('names each problem with its path', () => {
    const errors = validateArgs(schema, {
      n: 9,
      x: 1,
      mode: 'c',
      k: 8,
      list: ['a', 'b', 'c'],
      nested: { a: 'no' },
      either: 3,
      one: 2,
      both: 'x',
      extra: true,
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        'path: is required',
        'n: above the maximum 3',
        'x: must be below 1',
        'mode: must be one of "a", "b"',
        'k: must be 7',
        'list: more than 2 items',
        'nested.a: expected boolean, got string',
        'either: matches none of the allowed shapes',
        'one: must match exactly one allowed shape',
      ]),
    );
    expect(errors.length).toBeLessThanOrEqual(10);
    expect(validateArgs(schema, { path: 'a', list: [1] })).toEqual([
      'list[0]: expected string, got integer',
    ]);
    expect(validateArgs(schema, 'text')).toEqual(['(arguments): expected object, got string']);
    expect(validateArgs(schema, { path: 'ABC' })).toEqual(['path: does not match ^[a-z]+$']);
    expect(validateArgs(schema, { path: '' })).toEqual([
      'path: shorter than 1 characters',
      'path: does not match ^[a-z]+$',
    ]);
    expect(
      validateArgs({ type: 'object', properties: { p: { pattern: '(' } } }, { p: 'x' }),
    ).toEqual([]);
    expect(validateArgs({ type: ['string', 'null'] }, null)).toEqual([]);
    expect(validateArgs({ properties: { a: false } }, { a: 1 })).toEqual(['a: not allowed']);
  });
});

describe('text helpers', () => {
  it('caps head and tail, previews redacted, hashes canonically', () => {
    expect(capHeadTail('short', 100)).toEqual({ text: 'short', truncated: false });
    const c = capHeadTail('a'.repeat(500) + 'END', 200);
    expect(c.truncated).toBe(true);
    expect(c.text.endsWith('END')).toBe(true);
    expect(
      previewOf({ token: 'sk-ant-api03-abcdefghijklmnopqrstu', path: 'x' }, defaultRedactor),
    ).toBe('{"token":"[REDACTED]","path":"x"}');
    expect(previewOf({ s: 'x'.repeat(1000) }, defaultRedactor, 50)).toHaveLength(50);
    expect(stableJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
    expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
  });
});

describe('ArtifactService (FR-038)', () => {
  it('creates, versions, lists and serves artifacts of a thread', async () => {
    env = await makeToolEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const a = await env.artifacts.save({
      accountId: ACCOUNT,
      threadId: t.id,
      messageId: null,
      kind: 'code',
      title: 'main.ts',
      content: 'let a = 1;',
      language: 'ts',
    });
    expect(a).toMatchObject({
      kind: 'code',
      language: 'ts',
      version: 1,
      size: 10,
      mime: 'text/plain; charset=utf-8',
    });
    const b = await env.artifacts.save({
      accountId: ACCOUNT,
      threadId: t.id,
      messageId: null,
      kind: 'code',
      title: null,
      content: 'let a = 2;',
      artifactId: a.id,
    });
    expect(b).toMatchObject({ id: a.id, version: 2, title: 'main.ts' });
    expect((await env.artifacts.content(ACCOUNT, a.id)).bytes.toString()).toBe('let a = 2;');
    expect((await env.artifacts.content(ACCOUNT, a.id, 1)).bytes.toString()).toBe('let a = 1;');
    await expect(env.artifacts.content(ACCOUNT, a.id, 9)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await env.artifacts.list(ACCOUNT, t.id)).toHaveLength(1);
    expect(await env.artifacts.latest(ACCOUNT, t.id)).toHaveLength(1);
    await expect(env.artifacts.get('someone-else', a.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(env.events.names().filter((n) => n.startsWith('artifact.'))).toEqual([
      'artifact.created',
      'artifact.updated',
    ]);
    await expect(
      env.artifacts.save({
        accountId: ACCOUNT,
        threadId: t.id,
        messageId: null,
        kind: 'markdown',
        title: 'x',
        content: 'y',
        artifactId: a.id,
      }),
    ).rejects.toThrow('keep its kind');
    const other = await env.threads.create(ACCOUNT, {});
    await expect(
      env.artifacts.save({
        accountId: ACCOUNT,
        threadId: other.id,
        messageId: null,
        kind: 'code',
        title: 'x',
        content: 'y',
        artifactId: a.id,
      }),
    ).rejects.toThrow('another chat');
  });

  it('validates content per kind', async () => {
    env = await makeToolEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const save = (
      kind: Parameters<ArtifactService['save']>[0]['kind'],
      content: string,
      extra = {},
    ) =>
      env!.artifacts.save({
        accountId: ACCOUNT,
        threadId: t.id,
        messageId: null,
        kind,
        title: kind,
        content,
        ...extra,
      });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString(
      'base64',
    );
    expect((await save('image', png)).mime).toBe('image/png');
    await expect(save('image', Buffer.from('nope').toString('base64'))).rejects.toThrow(
      'PNG, JPEG',
    );
    await expect(save('image', 'not base64!')).rejects.toThrow('base64');
    expect((await save('pdf', Buffer.from('%PDF-1.7').toString('base64'))).mime).toBe(
      'application/pdf',
    );
    await expect(save('pdf', Buffer.from('x').toString('base64'))).rejects.toThrow('not a PDF');
    expect((await save('svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>')).mime).toBe(
      'image/svg+xml',
    );
    await expect(save('svg', '<div/>')).rejects.toThrow('<svg>');
    expect((await save('chart', '{"type":"bar"}')).mime).toBe('application/json');
    await expect(save('chart', '[1,2]')).rejects.toThrow('JSON object');
    expect((await save('html', '<p>x</p>')).mime).toBe('text/html; charset=utf-8');
    expect((await save('file', 'a,b', { mime: 'text/csv' })).mime).toBe('text/csv');
    expect((await save('file', 'abc', { mime: 'bad mime!' })).mime).toBe('text/plain');
    expect(
      (await save('file', Buffer.from('x').toString('base64'), { encoding: 'base64' })).mime,
    ).toBe('application/octet-stream');
    await expect(save('markdown', '')).rejects.toThrow('empty');
    const r = await artifactTool(env.artifacts).handler(
      { kind: 'chart', title: 'c', content: 'no' },
      { accountId: ACCOUNT, threadId: t.id, turnId: '' } as never,
    );
    expect(r).toMatchObject({ ok: false, error: { code: 'validation' } });
  });
});

describe('mentions (FR-022)', () => {
  it('offers files, folders, MCP servers and tools, and resolves them inside the roots', async () => {
    env = await makeToolEnv();
    mkdirSync(join(env.workspace, 'docs'));
    writeFileSync(join(env.workspace, 'docs', 'plan.md'), 'the plan');
    writeFileSync(join(env.workspace, 'planning.txt'), 'x');
    mkdirSync(join(env.workspace, '.ssh'));
    writeFileSync(join(env.workspace, '.ssh', 'plan_key'), 'secret');
    const roots: ToolRoot[] = [{ path: env.workspace, access: 'write', label: 'Workspace' }];
    const tools = [def('fs.read'), def('mcp:planner.make'), def('mcp:planner.list')];
    const c = mentionCandidates('plan', roots, tools);
    expect(c.map((x) => [x.kind, x.label])).toEqual([
      ['file', 'planning.txt'],
      ['file', 'plan.md'],
      ['mcp_server', 'planner'],
      ['tool', 'mcp:planner.list'],
      ['tool', 'mcp:planner.make'],
    ]);
    const plan = c.find((x) => x.label === 'plan.md')!;
    expect(plan).toMatchObject({
      ref: `file:${join(env.workspace, 'docs', 'plan.md')}`,
      detail: 'docs/plan.md',
    });
    expect(c[2]).toMatchObject({ ref: 'mcp:planner', detail: 'MCP server, 2 tools' });
    const top = mentionCandidates('', roots, tools);
    expect(top.map((x) => x.label)).toEqual(
      expect.arrayContaining(['docs', 'planning.txt', 'planner', 'mcp:planner.make']),
    );

    const resolved = resolveMentions(
      [
        { kind: 'file', ref: plan.ref },
        { kind: 'file', ref: plan.ref },
        { kind: 'folder', ref: `folder:${join(env.workspace, 'docs')}` },
        { kind: 'mcp_server', ref: 'planner' },
        { kind: 'tool', ref: 'tool:fs.read' },
        { kind: 'tool', ref: 'tool:nope' },
        { kind: 'skill', ref: 'skill:x' },
        { kind: 'file', ref: `file:${join(env.workspace, '.ssh', 'plan_key')}` },
        { kind: 'folder', ref: plan.ref },
      ],
      roots,
      tools,
    );
    expect(resolved.map((r) => [r.kind, r.label, r.tools])).toEqual([
      ['file', 'docs/plan.md', []],
      ['folder', 'docs', []],
      ['mcp_server', 'mcp:planner', ['mcp:planner.make', 'mcp:planner.list']],
      ['tool', 'fs.read', ['fs.read']],
      ['tool', 'nope', []],
      ['skill', 'skill:x', []],
      ['file', join(env.workspace, '.ssh', 'plan_key'), []],
      ['folder', join(env.workspace, 'docs', 'plan.md'), []],
    ]);
    expect(resolved[0]!.text).toBe('Mentioned file docs/plan.md:\nthe plan');
    expect(resolved[1]!.text).toBe('Mentioned folder docs:\nplan.md');
    expect(resolved[6]!.text).toContain('not available');
    expect(resolved[7]!.text).toContain('not available');
  });
});

describe('ToolRuntime (UI side)', () => {
  it('lists tool views with the effective decision and the user default', async () => {
    const gate: ToolGate = {
      ...allowAllGate,
      preview: (req) =>
        Promise.resolve(
          req.tool.name === 'fs.list'
            ? {
                effect: 'allow' as const,
                tier: 'pre_approvable' as const,
                reason: 'a rule',
                source: 'custom',
                ruleId: 'r1',
                userDefault: 'ask' as const,
              }
            : req.tool.name === 'fs.write'
              ? {
                  effect: 'deny',
                  tier: 'pre_approvable',
                  reason: 'your default',
                  source: 'tool_default',
                  ruleId: null,
                }
              : {
                  effect: 'ask',
                  tier: 'confirm_at_action',
                  reason: 'careful',
                  source: 'builtin',
                  ruleId: null,
                },
        ),
    };
    env = await makeToolEnv({
      gate,
      sources: [{ source: 'mcp', list: () => Promise.resolve([def('mcp:a.b')]) }],
    });
    const views = await env.runtime.views(ACCOUNT, null);
    const write = views.find((v) => v.name === 'fs.write')!;
    expect(write).toMatchObject({
      userDefault: 'deny',
      effective: { effect: 'deny', reason: 'your default' },
    });
    // The gate's own report of the user default wins over the deciding layer.
    expect(views.find((v) => v.name === 'fs.list')).toMatchObject({
      userDefault: 'ask',
      effective: { effect: 'allow' },
    });
    const read = views.find((v) => v.name === 'fs.read')!;
    expect(read).toMatchObject({
      userDefault: null,
      effective: { effect: 'ask', tier: 'confirm_at_action' },
    });
    expect(views.find((v) => v.name === 'mcp:a.b')).toMatchObject({
      deferred: false,
      source: 'mcp',
    });
    expect(views.map((v) => v.name)).not.toContain('web.search');
    await expect(env.runtime.views(ACCOUNT, 'no-such-thread')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('runs a UI invoke through the gate with origin ui and audits it', async () => {
    const seen: string[] = [];
    const gate: ToolGate = {
      ...allowAllGate,
      check: (req) => {
        seen.push(
          `${req.tool.name}:${req.provenance.userInstruction?.messageId.startsWith('ui:')}`,
        );
        return allowAllGate.check(req, new AbortController().signal);
      },
    };
    env = await makeToolEnv({ gate });
    writeFileSync(join(env.workspace, 'n.txt'), 'note');
    const { callId, done } = await env.runtime.invoke({
      accountId: ACCOUNT,
      name: 'fs.read',
      args: { path: 'n.txt' },
    });
    const r = await done;
    expect(r).toEqual({ callId, ok: true, text: 'note' });
    expect(seen).toEqual(['fs.read:true']);
    const row = env.db.raw.prepare('SELECT * FROM tool_call WHERE id = ?').get(callId) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ origin: 'ui', status: 'ok', thread_id: null, message_id: null });
    expect(env.audit[0]).toMatchObject({ actor: 'user', detail: { origin: 'ui' } });
    const bad = await (
      await env.runtime.invoke({ accountId: ACCOUNT, name: 'fs.read', args: {} })
    ).done;
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    await expect(
      env.runtime.invoke({ accountId: ACCOUNT, name: 'zz.top', args: {} }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(env.runtime.pendingApproval(callId)).toBeNull();
  });

  it('finds the approval a UI call waits for in the policy area table', async () => {
    env = await makeToolEnv();
    expect(env.runtime.pendingApproval('x')).toBeNull();
    // The approval table belongs to the policy area (0007); a minimal one stands in without it.
    const hasTable = env.db.raw
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'approval'")
      .get();
    if (hasTable)
      env.db.raw
        .prepare(
          `INSERT INTO approval (id, account_id, tool_call_id, requested_action, options_json, created_at)
           VALUES (?, ?, ?, 'x', '[]', ?)`,
        )
        .run('ap1', ACCOUNT, 'call-9', new Date().toISOString());
    else {
      env.db.raw.exec('CREATE TABLE approval (id TEXT PRIMARY KEY, tool_call_id TEXT)');
      env.db.raw
        .prepare('INSERT INTO approval (id, tool_call_id) VALUES (?, ?)')
        .run('ap1', 'call-9');
    }
    expect(env.runtime.pendingApproval('call-9')).toBe('ap1');
  });

  it('resolves mention candidates for a thread and records nothing for empty mentions', async () => {
    env = await makeToolEnv();
    writeFileSync(join(env.workspace, 'abc.md'), 'x');
    const t = await env.threads.create(ACCOUNT, {});
    const c = await env.runtime.mentionCandidates(ACCOUNT, 'abc', t.id);
    expect(c.map((x) => x.label)).toEqual(['abc.md']);
    expect(await env.runtime.resolveMentions(ACCOUNT, t.id, null, [])).toEqual([]);
    expect(new MemoryEventSink().names()).toEqual([]);
  });
});
