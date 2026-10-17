// The policy gate in M4 (docs/12 §2.3 step 7, FR-045, FR-197, FR-035): `permission.request`
// hooks tighten any decision and answer an eligible ask (user, managed and plugin hooks whose
// plugin declares answersAsks; never project hooks), never a deny, a managed or built-in ask;
// failures deny; plugin permissions (declared hosts, undeclared hosts denied with the reason,
// per-tool defaults, undeclared tools, unreadable permissions fail closed); project folder roots.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS, type SettingKey, type ToolDescriptor } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  PolicyGate,
  PolicyStore,
  hookOrigin,
  projectFolderSource,
  type AuditRecord,
  type GateRequest,
  type HookDispatcher,
  type HookOutcome,
  type NotificationInput,
  type PluginPermissions,
} from '../src/index.ts';
import { scriptedHooks } from './loop-env.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';

const tool = (over: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>): ToolDescriptor => ({
  title: over.name,
  description: '',
  source: 'builtin',
  inputSchema: { type: 'object' },
  ...over,
});
const execTool = tool({ name: 'exec.run', annotations: { destructive: true }, effects: ['exec'] });
const readTool = tool({ name: 'fs.read', annotations: { readOnly: true } });
const fetchStatus = tool({
  name: 'plugin:com.example.sample.fetch_status',
  source: 'plugin',
  pluginId: 'com.example.sample',
  description: 'Report the status of a URL',
  annotations: { requiresNetwork: true },
});
const panel = tool({
  name: 'plugin:com.example.sample.panel_action',
  source: 'plugin',
  pluginId: 'com.example.sample',
  description: 'Apply a value',
});
const stray = tool({
  name: 'plugin:com.example.sample.stray',
  source: 'plugin',
  pluginId: 'com.example.sample',
  description: 'Not in the manifest',
});

const SAMPLE: PluginPermissions = {
  pluginId: 'com.example.sample',
  network: ['api.example.com'],
  fs: [],
  tools: {
    'plugin:com.example.sample.fetch_status': { action: 'read', default: 'allow' },
    'plugin:com.example.sample.panel_action': { action: 'write' },
  },
  actionDefaults: { read: 'allow', write: 'ask' },
  hooksAnswerAsks: true,
};

let dir: string;
let db: NovaDatabase;
let store: PolicyStore;
let events: MemoryEventSink;
let audit: AuditRecord[];
let settings: Partial<Record<SettingKey, unknown>>;
let gate: PolicyGate;

function makeGate(extra: Partial<ConstructorParameters<typeof PolicyGate>[0]> = {}): PolicyGate {
  return new PolicyGate({
    store,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: () => Promise.resolve() },
    setting: (key) => Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    approvalTimeoutMs: () => 60_000,
    ...extra,
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-gate-m4-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'chat', 'streaming', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  store = new PolicyStore({ db });
  events = new MemoryEventSink();
  audit = [];
  settings = {};
  gate = makeGate();
});

afterEach(async () => {
  await gate.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

let calls = 0;
function req(over: Partial<GateRequest> = {}): GateRequest {
  calls++;
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: `call-${calls}`,
    projectId: null,
    mode: 'chat',
    tool: execTool,
    args: { cmd: 'npm test' },
    argsPreview: '{"cmd":"npm test"}',
    provenance: { userInstruction: { messageId: 'm1', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: 'h' },
    ...over,
  };
}

const answering = (effect: 'allow' | 'deny', hookId = 'hook:user.guard') =>
  scriptedHooks({
    'permission.request': () => ({
      context: [],
      decision: { effect, reason: `${effect}ed by ${hookId}`, hookId },
    }),
  });

const approvals = () => events.events.filter((e) => e.name === 'approval.requested').length;

/** Check and expect an approval card: the decision stayed `ask`. Cancels it afterwards. */
async function expectAsk(r: GateRequest) {
  const ctl = new AbortController();
  const before = approvals();
  const out = gate.check(r, ctl.signal);
  await vi.waitFor(() => expect(approvals()).toBe(before + 1));
  ctl.abort();
  await out;
}

describe('permission.request hooks (FR-197, docs/12 §2.3 step 7)', () => {
  it('runs after the deterministic result with the decision, the tool and redacted args', async () => {
    const hooks = scriptedHooks();
    gate.useHooks(hooks);
    await gate.check(
      req({
        tool: readTool,
        args: { path: 'a', token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' },
        roots: [{ path: '/work/here', access: 'write', label: 'Workspace' }],
      }),
      new AbortController().signal,
    );
    expect(hooks.calls).toHaveLength(1);
    expect(hooks.calls[0]).toMatchObject({
      event: 'permission.request',
      input: {
        accountId: ACCOUNT,
        threadId: THREAD,
        turnId: 'turn-1',
        callId: `call-${calls}`,
        tool: { name: 'fs.read' },
        decision: { effect: 'allow', source: 'fallback' },
        cwd: '/work/here',
      },
    });
    expect(JSON.stringify(hooks.calls[0]!.input.args)).not.toContain('abcdefghijklmnop');
  });

  it("a user hook answers a tool default's ask: allowed without asking, the hook recorded", async () => {
    gate.useHooks(answering('allow'));
    const out = await gate.check(req(), new AbortController().signal);
    expect(out).toMatchObject({ effect: 'allow', reason: 'allowed by hook:user.guard' });
    expect(approvals()).toBe(0);
    const rec = audit.find((a) => a.kind === 'policy')!;
    expect(rec).toMatchObject({ decision: 'allow' });
    expect(rec.detail).toMatchObject({ source: 'hook', hookId: 'hook:user.guard' });
  });

  it('a user hook answers an ask from a user rule; managed hooks may too', async () => {
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'fs.read' },
      effect: 'ask',
    });
    gate.useHooks(answering('allow', 'hook:managed.audit'));
    const out = await gate.check(
      req({ tool: readTool, args: { path: 'a' } }),
      new AbortController().signal,
    );
    expect(out.effect).toBe('allow');
  });

  it('never answers a managed ask, an approval-policy ask or a provenance floor', async () => {
    gate.useHooks(answering('allow'));
    const m = await store.createRule(
      ACCOUNT,
      { scopeKind: 'global', match: { tool: 'exec.run' }, effect: 'ask' },
      'managed',
    );
    await expectAsk(req());
    await store.db.transaction(() =>
      store.db.raw.prepare('DELETE FROM policy_rule WHERE id = ?').run(m.id),
    );
    settings['tools.approvalPolicy'] = 'ask_always';
    await expectAsk(req());
    settings['tools.approvalPolicy'] = 'defaults';
    await expectAsk(req({ provenance: { taint: ['page'] } }));
  });

  it('project hooks never answer asks; plugin hooks only with answersAsks', async () => {
    gate.useHooks(answering('allow', 'hook:project.fmt'));
    await expectAsk(req());

    const perms = { ...SAMPLE, hooksAnswerAsks: false };
    const forTool = vi.fn((_a: string, t: ToolDescriptor) =>
      Promise.resolve(t.pluginId === 'com.example.sample' ? perms : null),
    );
    gate.usePluginPermissions({ forTool });
    gate.useHooks(answering('allow', 'hook:com.example.sample.check'));
    await expectAsk(req());
    expect(forTool).toHaveBeenCalledWith(
      ACCOUNT,
      expect.objectContaining({ pluginId: 'com.example.sample', source: 'plugin' }),
    );
    perms.hooksAnswerAsks = true;
    expect((await gate.check(req(), new AbortController().signal)).effect).toBe('allow');
    // A plugin whose permissions cannot be read cannot answer either.
    gate.usePluginPermissions({ forTool: () => Promise.reject(new Error('gone')) });
    await expectAsk(req());
    // An extension's hook has no plugin permissions: it may only tighten.
    gate.useHooks(answering('allow', 'hook:ext.tool'));
    await expectAsk(req());
  });

  it("trusts the dispatcher's allow for a hook id it cannot place (the HookDispatcher contract)", async () => {
    gate.useHooks(answering('allow', '01920000-0000-7000-8000-00000000f00d'));
    expect((await gate.check(req(), new AbortController().signal)).effect).toBe('allow');
  });

  it('tightens an allow to a deny with the reason; never changes a deny', async () => {
    gate.useHooks(answering('deny'));
    const out = await gate.check(
      req({ tool: readTool, args: { path: 'a' } }),
      new AbortController().signal,
    );
    expect(out).toMatchObject({ effect: 'deny', reason: 'denyed by hook:user.guard', stop: false });
    expect(events.events.find((e) => e.name === 'policy.denied')!.payload).toMatchObject({
      reason: 'denyed by hook:user.guard',
    });

    const hooks = answering('allow');
    gate.useHooks(hooks);
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'exec.run' },
      effect: 'deny',
    });
    expect((await gate.check(req(), new AbortController().signal)).effect).toBe('deny');
    expect(hooks.calls).toHaveLength(0);
  });

  it('a block, or a dispatcher that fails, denies (fail closed)', async () => {
    gate.useHooks(
      scriptedHooks({
        'permission.request': (): HookOutcome => ({
          context: [],
          block: { reason: 'hook timed out', hookId: 'hook:user.slow' },
        }),
      }),
    );
    expect(
      await gate.check(req({ tool: readTool, args: {} }), new AbortController().signal),
    ).toMatchObject({
      effect: 'deny',
      reason: 'hook timed out',
    });
    const broken: HookDispatcher = { dispatch: () => Promise.reject(new Error('down')) };
    gate.useHooks(broken);
    expect(
      await gate.check(req({ tool: readTool, args: {} }), new AbortController().signal),
    ).toMatchObject({
      effect: 'deny',
      reason: 'the permission hooks could not run, so the call was not allowed',
    });
  });

  it('calls made by hooks and previews fire no hooks', async () => {
    const hooks = answering('deny');
    gate.useHooks(hooks);
    expect(
      (
        await gate.check(
          req({ tool: readTool, args: {}, origin: 'hook' }),
          new AbortController().signal,
        )
      ).effect,
    ).toBe('allow');
    const p = await gate.preview({
      accountId: ACCOUNT,
      threadId: THREAD,
      projectId: null,
      mode: 'chat',
      tool: readTool,
      args: {},
      provenance: { taint: [] },
      profile: { id: 'workspace', hash: '' },
    });
    expect(p.effect).toBe('allow');
    expect(hooks.calls).toHaveLength(0);
  });

  it('places hooks by their canonical id or the fields the dispatcher reports', () => {
    expect(hookOrigin({ hookId: 'hook:user.x' })).toEqual({ source: 'user', pluginId: null });
    expect(hookOrigin({ hookId: 'hook:project.fmt-on-edit' })).toEqual({
      source: 'project',
      pluginId: null,
    });
    expect(hookOrigin({ hookId: 'hook:com.example.dev-tools.check' })).toEqual({
      source: 'plugin',
      pluginId: 'com.example.dev-tools',
    });
    expect(hookOrigin({ hookId: 'hook:ext.x' })).toEqual({ source: 'extension', pluginId: null });
    expect(hookOrigin({ hookId: 'opaque', source: 'plugin', pluginId: 'a.b' })).toEqual({
      source: 'plugin',
      pluginId: 'a.b',
    });
    expect(hookOrigin({ hookId: 'opaque', source: 'nonsense' })).toBeNull();
  });
});

describe('plugin permissions in the gate (FR-045)', () => {
  beforeEach(() => {
    gate.usePluginPermissions({
      forTool: (_a, t) => Promise.resolve(t.pluginId === 'com.example.sample' ? SAMPLE : null),
    });
  });

  it('allows a declared host and denies an undeclared one with a clear reason', async () => {
    const ok = await gate.check(
      req({ tool: fetchStatus, args: { url: 'https://api.example.com/health' } }),
      new AbortController().signal,
    );
    expect(ok).toMatchObject({ effect: 'allow' });
    const audited = audit.find((a) => a.kind === 'policy')!;
    expect(audited.resource).toBe('api.example.com');

    const no = await gate.check(
      req({ tool: fetchStatus, args: { url: 'https://evil.example.org/x' } }),
      new AbortController().signal,
    );
    expect(no).toMatchObject({
      effect: 'deny',
      reason: 'evil.example.org is not a host this plugin declared',
    });
  });

  it('an undeclared request also disables the plugin and tells the user; previews do not', async () => {
    const notes: NotificationInput[] = [];
    gate = makeGate({ notifier: { notify: (n) => (notes.push(n), Promise.resolve()) } });
    gate.usePluginPermissions({
      forTool: (_a, t) => Promise.resolve(t.pluginId === 'com.example.sample' ? SAMPLE : null),
    });
    const disabled: [string, string][] = [];
    gate.usePluginViolations((a, p) => (disabled.push([a, p]), Promise.resolve()));
    await gate.preview({
      accountId: ACCOUNT,
      threadId: THREAD,
      projectId: null,
      mode: 'chat',
      tool: fetchStatus,
      args: { url: 'https://nope.example' },
      provenance: { userInstruction: { messageId: 'x', accountId: ACCOUNT }, taint: [] },
      profile: { id: 'workspace', hash: '' },
    });
    // A declared host, or a plugin default's deny, is not a violation.
    await gate.check(
      req({ tool: fetchStatus, args: { url: 'https://api.example.com/x' } }),
      new AbortController().signal,
    );
    expect(disabled).toEqual([]);
    expect(notes).toEqual([]);
    const no = await gate.check(
      req({ tool: fetchStatus, args: { url: 'https://evil.example.org/x' } }),
      new AbortController().signal,
    );
    expect(no.effect).toBe('deny');
    expect(disabled).toEqual([[ACCOUNT, 'com.example.sample']]);
    expect(notes).toEqual([
      expect.objectContaining({
        kind: 'attention',
        title: 'Plugin com.example.sample was turned off',
        href: '/settings/plugins',
      }),
    ]);
    // When disabling fails, the call is still denied and the user is still told.
    gate.usePluginViolations(() => Promise.reject(new Error('busy')));
    const again = await gate.check(
      req({ tool: fetchStatus, args: { url: 'https://evil.example.org/y' } }),
      new AbortController().signal,
    );
    expect(again.effect).toBe('deny');
    expect(notes.at(-1)?.title).toBe('Plugin com.example.sample was blocked');
  });

  it('applies per-tool and per-action defaults; an undeclared tool asks', async () => {
    await expectAsk(req({ tool: panel, args: { value: 1 } }));
    const rows = await store.listApprovals(ACCOUNT, { status: 'all' });
    expect(rows[0]!.reason).toBe("the plugin's default for write actions");
    await expectAsk(req({ tool: stray, args: {} }));
    const all = await store.listApprovals(ACCOUNT, { status: 'all' });
    expect(all.map((a) => a.reason)).toContain(`${stray.name} is not a tool its plugin declared`);
    // A plugin hook with answersAsks may answer the plugin default's ask.
    gate.useHooks(answering('allow', 'hook:com.example.sample.check'));
    expect(
      (await gate.check(req({ tool: panel, args: {} }), new AbortController().signal)).effect,
    ).toBe('allow');
  });

  it('previews show the plugin decision too', async () => {
    const p = await gate.preview({
      accountId: ACCOUNT,
      threadId: THREAD,
      projectId: null,
      mode: 'chat',
      tool: fetchStatus,
      args: { url: 'https://nope.example' },
      provenance: { userInstruction: { messageId: 'x', accountId: ACCOUNT }, taint: [] },
      profile: { id: 'workspace', hash: '' },
    });
    expect(p).toMatchObject({ effect: 'deny', source: 'plugin' });
  });

  it('fails closed when the permissions cannot be read', async () => {
    gate.usePluginPermissions({ forTool: () => Promise.reject(new Error('db locked')) });
    expect(
      await gate.check(req({ tool: fetchStatus, args: {} }), new AbortController().signal),
    ).toMatchObject({
      effect: 'deny',
      reason: "the plugin's permissions could not be read, so the call was not allowed",
    });
    // A deny the engine reached itself keeps its own reason.
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'fs.read' },
      effect: 'deny',
    });
    expect(
      (await gate.check(req({ tool: readTool, args: {} }), new AbortController().signal)).reason,
    ).not.toContain('plugin');
  });
});

describe('project folders as roots (FR-035)', () => {
  it("a project's folders are roots for its chats, capped by the profile", async () => {
    const folder = join(dir, 'proj-folder');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'a.txt'), 'x');
    const read = (projectId: string | null) =>
      req({
        projectId,
        tool: readTool,
        args: { path: join(folder, 'a.txt') },
        resource: { kind: 'path', value: join(folder, 'a.txt') },
      });
    // No folder source: outside the roots.
    expect((await gate.check(read(PROJECT), new AbortController().signal)).effect).toBe('deny');
    gate.useProjectFolders((id) =>
      Promise.resolve(id === PROJECT ? [{ path: folder, access: 'read' as const }] : []),
    );
    expect((await gate.check(read(PROJECT), new AbortController().signal)).effect).toBe('allow');
    expect((await gate.check(read(null), new AbortController().signal)).effect).toBe('deny');
    // A failing source adds no roots.
    gate.useProjectFolders(() => Promise.reject(new Error('locked')));
    expect((await gate.check(read(PROJECT), new AbortController().signal)).effect).toBe('deny');
  });

  it("reads the project's folders through the workspace module, else nothing", async () => {
    const source = projectFolderSource(db);
    expect(await source(PROJECT)).toEqual([]);
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, 'P', ?, ?)",
      )
      .run(PROJECT, ACCOUNT, now, now);
    const add = db.raw.prepare(
      'INSERT INTO project_folder (id, project_id, path, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    add.run('f1', PROJECT, '/srv/code', 'write', now, now);
    add.run('f2', PROJECT, '/srv/docs', 'read', `${now}z`, now);
    expect(await source(PROJECT)).toEqual([
      { path: '/srv/code', access: 'write', label: 'code' },
      { path: '/srv/docs', access: 'read', label: 'docs' },
    ]);
    // A database without the table (or any failed read) gives no folders.
    const bare = openDatabase({ path: ':memory:' });
    expect(await projectFolderSource(bare)(PROJECT)).toEqual([]);
    bare.close();
  });
});

describe("the user's own actions in a Nova client (FR-189)", () => {
  const writeTool = tool({
    name: 'fs.write',
    annotations: { destructive: true },
    effects: ['file_write'],
  });
  const save = (over: Partial<GateRequest> = {}) => {
    const path = join(dir, 'data', 'workspace', 'notes.md');
    return req({
      tool: writeTool,
      origin: 'ui',
      args: { path, content: 'x' },
      resource: { kind: 'path', value: path },
      threadId: '',
      ...over,
    });
  };

  it('an editor save the user pressed is allowed without a card, as their action', async () => {
    const out = await gate.check(save(), new AbortController().signal);
    expect(out).toMatchObject({ effect: 'allow', reason: 'you did this yourself in Nova' });
    expect(approvals()).toBe(0);
    expect(audit.find((a) => a.kind === 'policy')).toMatchObject({
      actor: 'user',
      decision: 'allow',
      detail: { source: 'user_action' },
    });
  });

  it("an app's own call (no instruction) and the agent's call still ask", async () => {
    await expectAsk(save({ provenance: { taint: ['mcp'] }, threadId: THREAD }));
    await expectAsk(save({ origin: 'model', threadId: THREAD }));
  });
});
