// An agent's tools for the files of its connected computer through the fully wired Hub (FR-081,
// FR-210): a fake novad enrolls against a listening Hub, the owner connects the agent and shares a
// folder; in the agent's thread the Mock provider reads a file and stages a write (a diff, nothing
// on disk), the commit waits for the owner's approval card and then lands; a write outside the
// folder files a folder-access request instead; another thread has no device tools; every call
// is in the audit log (kind `device`) with its thread and turn.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeDevice } from '@nova/core';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { EventStore } from '../src/event-store.ts';

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let hubUrl: string;
let cookie: string;
let fakes: FakeDevice[];
let proj: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nova-hub-device-tools-')));
  const web = join(dir, 'web');
  mkdirSync(web);
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  const config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const mock = new MockProvider({ id: 'mock', timing: 'instant' });
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets: new MemorySecretStore(),
    events: new EventStore(db),
    providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
  });
  hubUrl = await hub.app.listen({ port: 0, host: '127.0.0.1' });
  const code = await hub.auth.issueSetupCode();
  const res = await fetch(`${hubUrl}/api/v1/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))!
    .split(';')[0]!;
  fakes = [];
  proj = join(dir, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'src', 'notes.md'), '# Notes\n\nfirst\n');
});

afterEach(async () => {
  for (const f of fakes) await f.close();
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${hubUrl}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Json };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > 15_000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const tool = (name: string, args: unknown) => `/tool ${name} ${JSON.stringify(args)}`;

/** Send a message in a thread and wait for the Mock's report of the tool's result. */
async function turn(threadId: string, text: string, expectReport: string): Promise<string> {
  const sent = await api('POST', `/api/v1/threads/${threadId}/messages`, { text });
  expect(sent.status, JSON.stringify(sent.json)).toBe(202);
  return until(expectReport, async () => {
    const t = JSON.stringify((await api('GET', `/api/v1/threads/${threadId}`)).json);
    return t.includes(expectReport) ? t : null;
  });
}

async function setUp() {
  const agent = await api('POST', '/api/v1/agents', { name: 'Scout', proactive: false });
  expect(agent.status, JSON.stringify(agent.json)).toBe(201);
  const agentId = agent.json.id as string;
  const threadId = agent.json.primaryThreadId as string;
  const t = await api('POST', '/api/v1/devices/novad/enroll', { roles: ['client'] });
  const fake = new FakeDevice({ name: 'Laptop' });
  fakes.push(fake);
  await fake.enroll(hubUrl, t.json.token as string);
  const c = await api('POST', '/api/v1/devices/connections', {
    agentId,
    deviceId: fake.deviceId,
  });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  const g = await api('POST', `/api/v1/devices/${fake.deviceId!}/grants`, {
    kind: 'folder',
    grantee: { kind: 'agent', id: agentId },
    path: join(proj, 'src'),
    access: 'write',
  });
  expect(g.status, JSON.stringify(g.json)).toBe(201);
  return { agentId, threadId, deviceId: fake.deviceId! };
}

describe("an agent's device file tools through the Hub", () => {
  it('reads, stages a write and commits it once the owner approves (FR-081, FR-210)', async () => {
    const { agentId, threadId, deviceId } = await setUp();
    const notes = join(proj, 'src', 'notes.md');
    await turn(
      threadId,
      tool('device.files.read', { path: notes }),
      'Tool device.files.read returned:',
    );
    const staged = await turn(
      threadId,
      tool('device.files.stage_write', { path: notes, content: '# Notes\n\nsecond\n' }),
      'Tool device.files.stage_write returned:',
    );
    expect(staged).toContain(`Staged a write to ${notes} on Laptop`);
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nfirst\n');
    const writes = (await api('GET', `/api/v1/devices/${deviceId}/staged?status=staged`)).json
      .items as { id: string; path: string; grantee: { kind: string; id: string } }[];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: notes, grantee: { kind: 'agent', id: agentId } });

    // The commit is a write: the gate asks the owner on a card; allowed once, it lands.
    const sent = await api('POST', `/api/v1/threads/${threadId}/messages`, {
      text: tool('device.files.commit', { stagedId: writes[0]!.id }),
    });
    expect(sent.status).toBe(202);
    const card = await until('the commit approval card', async () => {
      const items = (await api('GET', '/api/v1/approvals?status=pending')).json.items as {
        id: string;
        tool: string | null;
        threadId: string | null;
      }[];
      return items.find((a) => a.tool === 'device.files.commit' && a.threadId === threadId);
    });
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nfirst\n');
    const decided = await api('POST', '/api/v1/approvals', {
      approvalId: card.id,
      decision: 'allow_once',
    });
    expect(decided.status, JSON.stringify(decided.json)).toBe(200);
    await until('the commit result', async () => {
      const t = JSON.stringify((await api('GET', `/api/v1/threads/${threadId}`)).json);
      return t.includes('Tool device.files.commit returned: Wrote');
    });
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nsecond\n');

    // Every call is in the audit log as a device action of this thread.
    const audit = (await api('GET', `/api/v1/audit?kind=device&threadId=${threadId}&limit=200`))
      .json.items as { action: string; actor: string }[];
    const actions = audit.map((a) => a.action);
    for (const a of ['device.fs.read', 'device.write.stage', 'device.write.commit'])
      expect(actions).toContain(a);
    expect(audit.find((a) => a.action === 'device.write.stage')?.actor).toBe(`agent:${agentId}`);
  }, 60_000);

  it('a write outside the shared folder files an access request and writes nothing', async () => {
    const { threadId, deviceId } = await setUp();
    const plan = join(proj, 'docs', 'plan.md');
    const out = await turn(
      threadId,
      tool('device.files.stage_write', { path: plan, content: 'plan\n' }),
      'Tool device.files.stage_write returned:',
    );
    expect(out).toContain('folder_access_required');
    expect(out).toContain('is pending');
    const requests = (await api('GET', `/api/v1/devices/${deviceId}/grants`)).json.items as {
      status: string;
      target: string;
      approvalId: string | null;
    }[];
    const pending = requests.find((r) => r.status === 'pending')!;
    expect(pending.target).toBe(join(proj, 'docs'));
    const card = (await api('GET', `/api/v1/approvals/${pending.approvalId!}`)).json;
    expect(card).toMatchObject({ tool: 'device.fs.request_access', threadId });
    expect(() => readFileSync(plan)).toThrow();
    // Allowed on the Hub, the next staging works.
    await api('POST', '/api/v1/approvals', {
      approvalId: pending.approvalId,
      decision: 'allow_once',
    });
    await until('the folder grant', async () => {
      const items = (await api('GET', `/api/v1/devices/${deviceId}/grants`)).json.items as {
        status: string;
        target: string;
      }[];
      return items.some((r) => r.status === 'granted' && r.target === join(proj, 'docs'));
    });
    const again = await turn(
      threadId,
      tool('device.files.stage_write', { path: plan, content: 'plan\n' }),
      `Staged a write to ${plan} on Laptop`,
    );
    expect(again).toContain('1 line added, 0 removed');
  }, 60_000);

  it('offers no device tools in a thread that is not the agent’s', async () => {
    await setUp();
    const chat = await api('POST', '/api/v1/threads', { mode: 'chat' });
    expect(chat.status, JSON.stringify(chat.json)).toBe(201);
    const t = await turn(
      chat.json.id as string,
      tool('device.files.list', { path: join(proj, 'src') }),
      'Tool device.files.list returned:',
    );
    expect(t).toContain('There is no tool named device.files.list');
  }, 60_000);
});
