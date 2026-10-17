// Agent rules in the gate (FR-084, docs/13 §3): for a thread an agent owns, the agent's rules
// join the user rules of the policy set; they never join the managed layer, whatever source they
// carry; a source that fails denies (fail closed).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, type SettingKey, type ToolDescriptor } from '@nova/shared';
import type { CommandRule, PolicyRule } from '@nova/policy';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { PolicyGate, PolicyStore } from '../src/approvals/index.ts';
import { MemoryEventSink } from '../src/events.ts';
import type { ThreadPolicy, ThreadPolicySource } from '../src/runtime/types.ts';
import type { AuditRecord, GateRequest, NotificationInput } from '../src/tools/types.ts';

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

/** What the gate would decide (no approval, no side effects). */
async function decide(r: GateRequest) {
  const { callId: _c, turnId: _t, argsPreview: _a, ...preview } = r;
  return gate.preview(preview);
}

let agentRules: Map<string, { rules: PolicyRule[]; commandRules: CommandRule[] }>;
let agentFails: boolean;

beforeEach(() => {
  agentRules = new Map();
  agentFails = false;
  gate.useAgentPolicy({
    forThread: (_a, threadId) =>
      agentFails
        ? Promise.reject(new Error('storage failure'))
        : Promise.resolve(agentRules.get(threadId) ?? null),
  });
});

const denyReads: PolicyRule = {
  id: 'agent-rule-1',
  label: 'never read',
  scope: { kind: 'thread', ref: THREAD },
  match: { tool: ['fs.read'] },
  effect: 'deny',
};

describe('agent rules (FR-084)', () => {
  it("apply to the agent's threads only", async () => {
    agentRules.set(THREAD, { rules: [denyReads], commandRules: [] });
    expect((await decide(req({ tool: readTool, args: {} }))).effect).toBe('deny');
    // The same call in a thread no agent owns is untouched.
    expect((await decide(req({ threadId: CHAT, tool: readTool, args: {} }))).effect).toBe('allow');
  });

  it('deny when the agent rules cannot be read', async () => {
    agentFails = true;
    expect(await decide(req({ tool: readTool, args: {} }))).toMatchObject({
      effect: 'deny',
      reason: "the agent's rules could not be read, so the call was not allowed",
    });
  });

  it('never join the managed layer, whatever source they carry', async () => {
    // The user's own rule for this session asks before `rm`; an agent rule claiming to be
    // managed (which would win over every user rule) allows it.
    await store.createCommandRule(ACCOUNT, {
      scopeKind: 'session',
      scopeRef: THREAD,
      pattern: ['rm'],
      decision: 'ask',
      matchExamples: ['rm -rf x'],
      notMatchExamples: ['ls'],
    });
    agentRules.set(THREAD, {
      rules: [],
      commandRules: [
        {
          id: 'agent-cmd-1',
          scope: { kind: 'thread', ref: THREAD },
          pattern: ['rm'],
          decision: 'allow',
          matchExamples: ['rm -rf x'],
          notMatchExamples: ['ls'],
          source: 'managed',
        },
      ],
    });
    expect((await decide(req({ args: { cmd: 'rm -rf build' } }))).effect).toBe('ask');
  });
});

describe('the network deny list (FR-193)', () => {
  const fetchTool = tool({ name: 'web.fetch', annotations: { readOnly: true } });

  it("denies a tool's call to a host on network.egressDeny, not only the proxy's", async () => {
    settings['network.egressDeny'] = ['*.evil.test'];
    const call = (host: string) =>
      decide(
        req({
          threadId: CHAT,
          mode: 'chat',
          tool: fetchTool,
          args: { url: `https://${host}/` },
          resource: { kind: 'host', value: host },
        }),
      );
    expect(await call('api.evil.test')).toMatchObject({
      effect: 'deny',
      reason: 'api.evil.test is on the network deny list',
    });
    expect((await call('docs.example.com')).effect).not.toBe('deny');
  });
});
