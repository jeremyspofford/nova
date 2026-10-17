// Per-thread policy in the gate (FR-063, docs/10 §3, docs/12 §2.1): a Code session's permission
// mode sets the approval policy, the profile and the roots; the mode name is audited; a source
// that fails denies. Also the approval timeout (FR-058): unanswered approvals end the turn.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS, type PermissionMode, type SettingKey, type ToolDescriptor } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
// Imported by module, so these tests do not depend on the chat loop's module graph.
import { PolicyGate, PolicyStore } from '../src/approvals/index.ts';
import { MemoryEventSink } from '../src/events.ts';
import type { ThreadPolicy, ThreadPolicySource } from '../src/runtime/types.ts';
import type { AuditRecord, GateRequest, NotificationInput, ToolRoot } from '../src/tools/types.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000c1';
const CHAT = '01920000-0000-7000-8000-0000000000c2';

const tool = (over: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>): ToolDescriptor => ({
  title: over.name,
  description: '',
  source: 'builtin',
  inputSchema: { type: 'object' },
  ...over,
});
const execTool = tool({ name: 'exec.run', annotations: { destructive: true }, effects: ['exec'] });
const readTool = tool({ name: 'fs.read', annotations: { readOnly: true } });
const writeTool = tool({
  name: 'fs.write',
  annotations: { destructive: true },
  effects: ['file_write'],
});
const purchase = tool({ name: 'mcp:shop.purchase_item', source: 'mcp', serverId: 'shop' });

let dir: string;
let proj: string;
let db: NovaDatabase;
let store: PolicyStore;
let events: MemoryEventSink;
let audit: AuditRecord[];
let notes: NotificationInput[];
let settings: Partial<Record<SettingKey, unknown>>;
let policies: Map<string, ThreadPolicy>;
let gate: PolicyGate;

const source: ThreadPolicySource = {
  forThread: (_accountId, threadId) => Promise.resolve(policies.get(threadId) ?? null),
};

function makeGate(extra: Partial<ConstructorParameters<typeof PolicyGate>[0]> = {}): PolicyGate {
  return new PolicyGate({
    store,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: (n) => (notes.push(n), Promise.resolve()) },
    setting: (key) => Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    approvalTimeoutMs: () => 60_000,
    ...extra,
  });
}

/** The presets of docs/12 §2.1 as the Code area would report them. */
function preset(
  mode: PermissionMode,
  roots: ToolRoot[] = [{ path: proj, access: 'write', label: 'proj' }],
): ThreadPolicy {
  const base = { roots, permissionMode: mode, autoAcceptEdits: false };
  switch (mode) {
    case 'manual':
      return { ...base, approvalPolicy: 'ask_always', profileId: 'workspace' };
    case 'accept_edits':
      return { ...base, approvalPolicy: 'defaults', profileId: 'workspace', autoAcceptEdits: true };
    case 'plan':
      return { ...base, approvalPolicy: 'ask_always', profileId: 'read-only' };
    case 'auto':
      return { ...base, approvalPolicy: 'review', profileId: 'workspace' };
    case 'bypass':
      return { ...base, approvalPolicy: 'never_ask', profileId: 'full' };
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-gate-m5-'));
  proj = join(dir, 'proj');
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  mkdirSync(join(proj, '.git'), { recursive: true });
  mkdirSync(join(dir, 'other'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  for (const [id, mode] of [
    [THREAD, 'code'],
    [CHAT, 'chat'],
  ] as const)
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, ?, 'streaming', ?, ?)",
      )
      .run(id, ACCOUNT, mode, now, now);
  store = new PolicyStore({ db });
  events = new MemoryEventSink();
  audit = [];
  notes = [];
  settings = {};
  policies = new Map();
  gate = makeGate();
  gate.useThreadPolicy(source);
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
    mode: 'code',
    tool: execTool,
    args: { cmd: 'npm test' },
    argsPreview: '{"cmd":"npm test"}',
    provenance: { userInstruction: { messageId: 'm1', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: 'h' },
    ...over,
  };
}

const write = (path: string, over: Partial<GateRequest> = {}) =>
  req({ tool: writeTool, args: { path }, resource: { kind: 'path', value: path }, ...over });

/** What the gate would decide (no approval, no side effects). */
async function decide(r: GateRequest) {
  const { callId: _c, turnId: _t, argsPreview: _a, ...preview } = r;
  return gate.preview(preview);
}

describe('permission modes as presets (FR-063, docs/12 §2.1)', () => {
  it('Manual asks before every change and lets reads through', async () => {
    policies.set(THREAD, preset('manual'));
    expect(await decide(req())).toMatchObject({
      effect: 'ask',
      reason: 'your approval policy asks before every change',
    });
    expect((await decide(write(join(proj, 'a.ts')))).effect).toBe('ask');
    expect((await decide(req({ tool: readTool, args: {} }))).effect).toBe('allow');
  });

  it('Accept edits allows file edits inside writable roots only', async () => {
    policies.set(THREAD, preset('accept_edits'));
    expect(await decide(write(join(proj, 'src', 'a.ts')))).toMatchObject({
      effect: 'allow',
      reason: 'file edits inside writable folders are accepted automatically',
    });
    // Outside the session's roots, protected paths, read-only roots: never accepted.
    expect((await decide(write(join(dir, 'other', 'x.ts')))).effect).toBe('deny');
    expect(await decide(write(join(proj, '.git', 'config')))).toMatchObject({
      effect: 'deny',
      reason: '.git stays read-only',
    });
    policies.set(THREAD, preset('accept_edits', [{ path: proj, access: 'read', label: 'proj' }]));
    expect((await decide(write(join(proj, 'a.ts')))).effect).toBe('deny');
    // Commands still follow the per-tool default.
    policies.set(THREAD, preset('accept_edits'));
    expect(await decide(req())).toMatchObject({
      effect: 'ask',
      reason: 'the default for exec.run is to ask',
    });
  });

  it('Plan reads and explores only: the read-only profile denies edits', async () => {
    policies.set(THREAD, preset('plan'));
    expect(await decide(write(join(proj, 'a.ts')))).toMatchObject({
      effect: 'deny',
      reason: 'this folder is read-only for tools',
    });
    expect((await decide(req({ tool: readTool, args: {} }))).effect).toBe('allow');
    expect((await decide(req())).effect).toBe('ask');
  });

  it('Auto allows consequential actions only through the reviewer', async () => {
    policies.set(THREAD, preset('auto'));
    const seen: string[] = [];
    gate.useReviewer({
      review: (input) => {
        seen.push(input.tool.name);
        return Promise.resolve({
          outcome: 'allow',
          risk: 'low',
          userAuthorization: 'high',
          rationale: 'the user asked to run the tests',
          attempts: 1,
          failed: false,
        });
      },
    });
    expect((await gate.check(req(), new AbortController().signal)).effect).toBe('allow');
    expect(seen).toEqual(['exec.run']);
    // Reads are not consequential: no review.
    expect(
      (await gate.check(req({ tool: readTool, args: {} }), new AbortController().signal)).effect,
    ).toBe('allow');
    expect(seen).toEqual(['exec.run']);
  });

  it('Bypass needs a VM or container, and still asks for confirm-at-action steps', async () => {
    policies.set(THREAD, preset('bypass'));
    expect(await decide(req())).toMatchObject({
      effect: 'deny',
      reason: 'the full profile runs only inside a VM or container',
    });
    gate.useSubstrate(() => 'container');
    expect(await decide(req())).toMatchObject({
      effect: 'allow',
      reason: 'your approval policy does not ask for this',
    });
    expect(await decide(req({ tool: purchase, args: {} }))).toMatchObject({
      effect: 'ask',
      tier: 'confirm_at_action',
    });
    // A user rule that asks still reaches the user.
    await store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'exec.run' },
      effect: 'ask',
      label: 'Always ask for commands',
    });
    expect((await decide(req())).effect).toBe('ask');
  });
});

describe('what the thread policy replaces', () => {
  it('keeps the settings for threads no source knows', async () => {
    policies.set(THREAD, preset('manual'));
    settings['tools.roots'] = [{ path: join(dir, 'other'), access: 'write' }];
    const chat = { threadId: CHAT, mode: 'chat' as const };
    expect(await decide(req(chat))).toMatchObject({
      effect: 'ask',
      reason: 'the default for exec.run is to ask',
    });
    // The settings' root is a root in the chat ...
    expect((await decide(write(join(dir, 'other', 'x.ts'), chat))).effect).toBe('ask');
    // ... but the session's roots replace it.
    expect((await decide(write(join(dir, 'other', 'x.ts')))).effect).toBe('deny');
  });

  it("replaces the Nova workspace too: the session's folder is its only root", async () => {
    policies.set(THREAD, preset('accept_edits'));
    const inWorkspace = join(dir, 'data', 'workspace', 'a.md');
    // A chat may write to the workspace (it asks by default) ...
    expect((await decide(write(inWorkspace, { threadId: CHAT, mode: 'chat' }))).effect).toBe('ask');
    // ... a Code session may not: its folder is the only root, so nothing is auto-accepted there.
    expect((await decide(write(inWorkspace))).effect).toBe('deny');
    expect((await decide(write(join(proj, 'a.md')))).effect).toBe('allow');
  });

  it("resolves a relative path in the session's folder, where its tools resolve it", async () => {
    policies.set(THREAD, preset('accept_edits'));
    const rel = (path: string) => write(path);
    expect((await decide(rel('src/a.ts'))).effect).toBe('allow');
    // A tool passes the raw path when its own containment check refuses it (a protected path):
    // the gate still names the protection, inside the session's folder.
    expect(await decide(rel('.git/config'))).toMatchObject({
      effect: 'deny',
      reason: '.git stays read-only',
    });
    expect(await decide(rel('.nova/x'))).toMatchObject({
      effect: 'deny',
      reason: '.nova stays read-only',
    });
  });

  it("uses the session's profile even when the tool scope names another", async () => {
    policies.set(THREAD, { ...preset('accept_edits'), profileId: 'read-only' });
    expect(
      await decide(write(join(proj, 'a.ts'), { profile: { id: 'workspace', hash: 'h' } })),
    ).toMatchObject({ effect: 'deny', reason: 'this folder is read-only for tools' });
  });

  it('applies auto-accept on top of the settings policy when only that is set', async () => {
    policies.set(THREAD, {
      approvalPolicy: null,
      profileId: null,
      roots: null,
      permissionMode: null,
      autoAcceptEdits: true,
    });
    expect((await decide(write(join(dir, 'data', 'workspace', 'a.md')))).effect).toBe('allow');
  });

  it('asks the next source when one has no policy, and takes the constructor source', async () => {
    const g = makeGate({ threadPolicy: { forThread: () => Promise.resolve(null) } });
    g.useThreadPolicy(source);
    policies.set(THREAD, preset('manual'));
    const { callId: _c, turnId: _t, argsPreview: _a, ...preview } = write(join(proj, 'a.ts'));
    expect((await g.preview(preview)).reason).toBe('your approval policy asks before every change');
    await g.close();
  });

  it('denies every call when the thread policy cannot be read (fail closed)', async () => {
    const g = makeGate({ threadPolicy: { forThread: () => Promise.reject(new Error('locked')) } });
    const out = await g.check(req({ tool: readTool, args: {} }), new AbortController().signal);
    expect(out).toMatchObject({
      effect: 'deny',
      reason: "the session's permission mode could not be read, so the call was not allowed",
    });
    expect(audit.at(-1)).toMatchObject({ decision: 'deny', detail: { source: 'builtin' } });
    await g.close();
  });

  it('records the permission mode and the approval policy with each decision', async () => {
    policies.set(THREAD, preset('accept_edits'));
    await gate.check(write(join(proj, 'a.ts')), new AbortController().signal);
    expect(audit.at(-1)).toMatchObject({
      kind: 'policy',
      action: 'fs.write',
      decision: 'allow',
      detail: {
        permissionMode: 'accept_edits',
        approvalPolicy: 'defaults',
        autoAccept: ['file_edit'],
        profileId: 'workspace',
        runId: null,
      },
    });
    await gate.check(
      req({ tool: readTool, args: {}, threadId: CHAT }),
      new AbortController().signal,
    );
    expect(audit.at(-1)!.detail).toMatchObject({
      permissionMode: null,
      approvalPolicy: 'defaults',
      autoAccept: [],
    });
  });
});

describe('approval timeouts (FR-058, docs/09 §12)', () => {
  it('ends an unanswered approval after the default 24 h as a timeout that stops the turn', async () => {
    vi.useFakeTimers();
    try {
      const g = makeGate({ approvalTimeoutMs: undefined });
      g.useThreadPolicy(source);
      policies.set(THREAD, preset('manual'));
      let settled: unknown = null;
      const outcome = g.check(req(), new AbortController().signal).then((o) => (settled = o));
      await vi.waitFor(() => expect(events.names()).toContain('approval.requested'));
      await vi.advanceTimersByTimeAsync(24 * 3_600_000 - 1_000);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(2_000);
      await outcome;
      expect(settled).toMatchObject({ effect: 'deny', stop: true, timeout: true });
      const id = events.events.find((e) => e.name === 'approval.requested')!.payload
        .approvalId as string;
      expect(await store.getApproval(ACCOUNT, id)).toMatchObject({
        status: 'expired',
        decision: 'timeout',
      });
      await g.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
