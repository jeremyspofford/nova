// Managed policy at the policy gate (FR-106, ADR-097 D4): a tightening layer only. Tools the
// policy refuses are denied with source `managed` and audited (and hidden by a deny preview); an
// approval policy whose mode is turned off runs as Manual's `ask_always` wherever it was chosen;
// folders outside the policy are no roots; network tools are denied while egress is off; a policy
// that could not be read denies every agent tool (fail closed).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, type ManagedRestrict, type SettingKey, type ToolDescriptor } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  MemoryEventSink,
  PolicyGate,
  PolicyStore,
  type AuditRecord,
  type GateRequest,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';

const tool = (over: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>): ToolDescriptor => ({
  title: over.name,
  description: '',
  source: 'builtin',
  inputSchema: { type: 'object' },
  ...over,
});
const readTool = tool({ name: 'fs.read', annotations: { readOnly: true } });
const screenTool = tool({ name: 'screen.capture', annotations: { readOnly: true } });
const fetchTool = tool({
  name: 'web.fetch',
  annotations: { readOnly: true, requiresNetwork: true },
});
const mcpTool = tool({
  name: 'mcp:shell-anything.run',
  source: 'mcp',
  serverId: 's1',
  annotations: { readOnly: true },
});

let dir: string;
let db: NovaDatabase;
let audit: AuditRecord[];
let settings: Partial<Record<SettingKey, unknown>>;
let gate: PolicyGate;
let policyOf: { approvalPolicy: 'never_ask' | 'review' | 'defaults'; roots: string[] | null };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-managed-gate-'));
  mkdirSync(join(dir, 'data', 'workspace'), { recursive: true });
  mkdirSync(join(dir, 'home', 'src'), { recursive: true });
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'chat', 'streaming', ?, ?)",
    )
    .run(THREAD, ACCOUNT, now, now);
  audit = [];
  settings = {};
  policyOf = { approvalPolicy: 'never_ask', roots: null };
  gate = new PolicyGate({
    store: new PolicyStore({ db }),
    events: new MemoryEventSink(),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    notifier: { notify: () => Promise.resolve() },
    setting: (key) => Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    dataDir: join(dir, 'data'),
    home: join(dir, 'home'),
    substrate: () => 'container',
    threadPolicy: {
      forThread: () =>
        Promise.resolve({
          approvalPolicy: policyOf.approvalPolicy,
          profileId: null,
          roots: policyOf.roots
            ? policyOf.roots.map((p) => ({ path: p, access: 'write' as const, label: 'x' }))
            : null,
          permissionMode: null,
          autoAcceptEdits: false,
        }),
    },
  });
});

afterEach(async () => {
  await gate.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function restrict(...layers: ManagedRestrict[]) {
  settings['managed.restrict'] = { layers, failClosed: null };
}

let n = 0;
function req(over: Partial<GateRequest> = {}): GateRequest {
  n++;
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: `call-${n}`,
    projectId: null,
    mode: 'chat',
    tool: readTool,
    args: {},
    argsPreview: '{}',
    provenance: { userInstruction: { messageId: 'm1', accountId: ACCOUNT }, taint: [] },
    profile: { id: 'workspace', hash: 'h' },
    ...over,
  };
}

const check = (r: GateRequest) => gate.check(r, new AbortController().signal);

describe('the managed layer at the gate', () => {
  it('denies a tool the policy refuses, with source managed, and audits it', async () => {
    restrict({ tools: { deny: ['screen.*'] } });
    const out = await check(req({ tool: screenTool }));
    expect(out).toMatchObject({ effect: 'deny' });
    expect(out.reason).toMatch(/screen.capture is not allowed by your organization's policy/);
    expect(audit.at(-1)).toMatchObject({ action: 'screen.capture', decision: 'deny' });
    expect(JSON.stringify(audit.at(-1)!.detail)).toContain('managed');
    const preview = await gate.preview(req({ tool: screenTool }));
    expect(preview).toMatchObject({ effect: 'deny', source: 'managed' });
    // Another tool is untouched.
    expect((await check(req())).effect).toBe('allow');
  });

  it("denies an MCP server's tools and network tools while egress is off", async () => {
    restrict({ mcpServers: { deny: ['shell-*'] } }, { egress: { mode: 'off' } });
    expect((await check(req({ tool: mcpTool }))).reason).toMatch(/MCP server shell-anything/);
    expect((await check(req({ tool: fetchTool }))).reason).toMatch(/network access is turned off/);
  });

  it('counts the tools of an http or sse MCP server as network tools', async () => {
    const now = new Date().toISOString();
    const server = (id: string, name: string, transport: string) =>
      db.raw
        .prepare(
          `INSERT INTO mcp_server (id, account_id, name, transport, command, args_json, url, env_ref_json,
             config_json, source, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, '[]', NULL, '{}', '{}', 'user', 1, ?, ?)`,
        )
        .run(id, ACCOUNT, name, transport, now, now);
    server('remote1', 'docs', 'http');
    server('local1', 'files', 'stdio');
    const remote = tool({
      name: 'mcp:docs.search',
      source: 'mcp',
      serverId: 'remote1',
      annotations: { readOnly: true },
    });
    const local = tool({
      name: 'mcp:files.list',
      source: 'mcp',
      serverId: 'local1',
      annotations: { readOnly: true },
    });
    const unknown = tool({
      name: 'mcp:gone.x',
      source: 'mcp',
      serverId: 'gone',
      annotations: { readOnly: true },
    });
    expect((await check(req({ tool: remote }))).effect).toBe('allow');
    restrict({ egress: { mode: 'off' } });
    expect((await check(req({ tool: remote }))).reason).toMatch(/network access is turned off/);
    expect((await check(req({ tool: unknown }))).effect).toBe('deny');
    expect((await check(req({ tool: local }))).effect).toBe('allow');
  });

  it('fails closed when the policy could not be read', async () => {
    settings['managed.restrict'] = { layers: [], failClosed: 'not valid JSON' };
    const out = await check(req());
    expect(out.effect).toBe('deny');
    expect(out.reason).toMatch(/could not be read \(not valid JSON\)/);
  });

  it('runs a turned-off approval policy as ask_always', async () => {
    // never_ask (Bypass) would allow this write without asking; with Bypass off it asks.
    const write = tool({ name: 'fs.write', effects: ['file_write'] });
    const allowed = await gate.preview(req({ tool: write }));
    expect(allowed.effect).toBe('allow');
    restrict({ permissionModes: { deny: ['bypass'] } });
    const preview = await gate.preview(req({ tool: write }));
    expect(preview.effect).toBe('ask');
  });

  it("narrows a permission profile's own entries (full, ~) to the allowed folders", async () => {
    mkdirSync(join(dir, 'home', 'Documents'), { recursive: true });
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO permission_profile (id, account_id, name, fs_rules_json, network_json, created_at, updated_at) VALUES ('homey', ?, 'homey', ?, ?, ?, ?)",
      )
      .run(
        ACCOUNT,
        JSON.stringify([{ path: '~', access: 'write' }]),
        JSON.stringify({ mode: 'off' }),
        now,
        now,
      );
    const payroll = join(dir, 'home', 'Documents', 'payroll.xlsx');
    const code = join(dir, 'home', 'src', 'a.ts');
    const at = (profile: string, path: string) =>
      gate.preview(
        req({ profile: { id: profile, hash: 'h' }, resource: { kind: 'path', value: path } }),
      );
    policyOf.approvalPolicy = 'defaults';
    expect((await at('homey', payroll)).effect).toBe('allow');
    expect((await at('full', payroll)).effect).toBe('allow');
    restrict({ folders: { allow: ['~/src'] } });
    for (const profile of ['homey', 'full']) {
      expect((await at(profile, payroll)).effect, profile).toBe('deny');
      expect((await at(profile, code)).effect, profile).toBe('allow');
    }
    // A denied folder is denied inside a root that would cover it.
    restrict({ folders: { deny: ['~/src'] } });
    expect((await at('homey', code)).effect).toBe('deny');
    expect((await at('homey', payroll)).effect).toBe('allow');
  });

  it('takes away roots outside the folders the policy allows', async () => {
    policyOf.roots = [join(dir, 'home', 'src')];
    const inside = () =>
      gate.preview(req({ resource: { kind: 'path', value: join(dir, 'home', 'src', 'a.txt') } }));
    expect((await inside()).effect).toBe('allow');
    restrict({ folders: { allow: ['/work'] } });
    expect((await inside()).effect).toBe('deny');
    restrict({ folders: { allow: ['~/src'] } });
    expect((await inside()).effect).toBe('allow');
  });
});
