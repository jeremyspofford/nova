// Per-thread tool limits at the gate (FR-053 a sub-agent's tool list, FR-217 a shared thread,
// FR-045 the plugins connected to an agent): every source narrows, a tool outside any source's
// limits is denied outright (so the turn's listing hides it), a failing source denies, and a
// thread no source knows is untouched.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, type ToolDescriptor } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  PolicyGate,
  PolicyStore,
  limitDenial,
  type ThreadToolLimits,
} from '../src/approvals/index.ts';
import { MemoryEventSink } from '../src/events.ts';
import type { GateRequest } from '../src/tools/types.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000d1';
const OTHER = '01920000-0000-7000-8000-0000000000d2';

const tool = (over: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>): ToolDescriptor => ({
  title: over.name,
  description: '',
  source: 'builtin',
  inputSchema: { type: 'object' },
  annotations: { readOnly: true },
  ...over,
});

let dir: string;
let db: NovaDatabase;
let gate: PolicyGate;
let limits: Map<string, ThreadToolLimits>;
let failing: boolean;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-gate-m7-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  for (const id of [THREAD, OTHER])
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'work', 'streaming', ?, ?)",
      )
      .run(id, ACCOUNT, now, now);
  gate = new PolicyGate({
    store: new PolicyStore({ db }),
    events: new MemoryEventSink(),
    audit: { append: () => Promise.resolve() },
    notifier: { notify: () => Promise.resolve() },
    setting: (key) => Promise.resolve(SETTINGS[key].default as never),
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    approvalTimeoutMs: () => 60_000,
    // A plugin's own tools and the MCP servers it installed belong to it.
    pluginPermissions: {
      forTool: (_a, t) =>
        Promise.resolve(
          t.pluginId || t.serverId === 'srv-of-acme'
            ? {
                pluginId: t.pluginId ?? 'acme',
                network: [],
                fs: [],
                tools: {},
                actionDefaults: {},
                hooksAnswerAsks: false,
              }
            : null,
        ),
    },
  });
  limits = new Map();
  failing = false;
  gate.useToolLimits({
    forThread: (_a, threadId) =>
      failing ? Promise.reject(new Error('down')) : Promise.resolve(limits.get(threadId) ?? null),
  });
});

afterEach(async () => {
  await gate.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function decide(t: ToolDescriptor, threadId = THREAD) {
  const r: Omit<GateRequest, 'callId' | 'turnId' | 'argsPreview'> = {
    accountId: ACCOUNT,
    threadId,
    projectId: null,
    mode: 'work',
    tool: t,
    args: {},
    provenance: { userInstruction: { messageId: 'm', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: 'h' },
  };
  return gate.preview(r);
}

describe('tool limits at the gate', () => {
  it("deny tools outside a sub-agent's list, in its thread only (FR-053)", async () => {
    limits.set(THREAD, { allow: ['web.search', 'run.*'], reason: 'not in the list' });
    expect((await decide(tool({ name: 'web.search' }))).effect).toBe('allow');
    expect((await decide(tool({ name: 'run.complete' }))).effect).toBe('allow');
    expect(await decide(tool({ name: 'fs.read' }))).toMatchObject({
      effect: 'deny',
      reason: 'not in the list',
      source: 'builtin',
    });
    expect((await decide(tool({ name: 'fs.read' }), OTHER)).effect).toBe('allow');
  });

  it('keep shared threads to built-in tools and away from connectors (FR-217)', async () => {
    limits.set(THREAD, { sources: ['builtin'], deny: ['channel.*'], reason: 'shared' });
    expect((await decide(tool({ name: 'mcp.x', source: 'mcp', serverId: 's1' }))).effect).toBe(
      'deny',
    );
    expect((await decide(tool({ name: 'channel.send' }))).effect).toBe('deny');
    expect((await decide(tool({ name: 'web.fetch' }))).effect).toBe('allow');
  });

  it("allow only the agent's connected plugins, also for their MCP servers (FR-045)", async () => {
    limits.set(THREAD, { plugins: ['other'], reason: 'the plugin is not connected to this agent' });
    expect(
      await decide(tool({ name: 'acme.do', source: 'plugin', pluginId: 'acme' })),
    ).toMatchObject({
      effect: 'deny',
      reason: 'the plugin is not connected to this agent',
    });
    expect(
      (await decide(tool({ name: 'srv.do', source: 'mcp', serverId: 'srv-of-acme' }))).effect,
    ).toBe('deny');
    // The account's own server is outside any plugin: the limits leave it to the policy.
    expect(
      (await decide(tool({ name: 'mine.do', source: 'mcp', serverId: 'own' }))).effect,
    ).not.toBe('deny');
    limits.set(THREAD, { plugins: ['acme'], reason: 'x' });
    expect(
      (await decide(tool({ name: 'acme.do', source: 'plugin', pluginId: 'acme' }))).effect,
    ).not.toBe('deny');
  });

  it('deny when a source fails, and narrow with every source', async () => {
    failing = true;
    expect(await decide(tool({ name: 'web.search' }))).toMatchObject({
      effect: 'deny',
      reason: "the thread's tool limits could not be read, so the call was not allowed",
    });
    failing = false;
    limits.set(THREAD, { allow: ['web.search', 'fs.read'], reason: 'first' });
    gate.useToolLimits({
      forThread: () => Promise.resolve({ deny: ['fs.read'], reason: 'second' }),
    });
    expect((await decide(tool({ name: 'web.search' }))).effect).toBe('allow');
    expect(await decide(tool({ name: 'fs.read' }))).toMatchObject({ reason: 'second' });
  });

  it('are plain checks', () => {
    const l: ThreadToolLimits = { allow: ['a.*'], reason: 'r' };
    expect(limitDenial(l, { name: 'a.b', source: 'builtin' }, null)).toBeNull();
    expect(limitDenial(l, { name: 'ab', source: 'builtin' }, null)).toBe('r');
    expect(limitDenial({ plugins: [], reason: 'p' }, { name: 'x', source: 'plugin' }, 'acme')).toBe(
      'p',
    );
    expect(
      limitDenial({ plugins: [], reason: 'p' }, { name: 'x', source: 'builtin' }, null),
    ).toBeNull();
  });
});
