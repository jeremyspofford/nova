// An agent's tools for the files of its connected computer (FR-081, FR-210): canonical names under
// the `computer` source, listed only in a private thread of an agent with an active connection
// (reading tools alone in proactive research or without staged writes); reads inside the agent's
// folders only; a write staged with its diff and committed through a gate that asks under the
// default policy; a path outside the grants files a folder-access request and writes nothing; a
// changed target is a conflict; every call audited (kind `device`) with its thread, turn and call.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluate, type PolicyContext } from '@nova/policy';
import { Logger } from '@nova/telemetry';
import {
  DEVICE_FILE_TOOL_NAMES,
  deviceFileTools,
  deviceToolSource,
  type DeviceAgentThread,
  type FakeDevice,
} from '../src/index.ts';
import { TOOL_NAME } from '../src/tools/registry.ts';
import type { BuiltinTool } from '../src/tools/builtin.ts';
import type { ToolContext, ToolResult } from '../src/tools/types.ts';
import { ACCOUNT, devicesEnv, type DevicesEnv } from './devices-env.ts';

const AGENT_ID = 'agent-1';
const THREAD = 'thread-1';
const AGENT = { kind: 'agent' as const, id: AGENT_ID };

let env: DevicesEnv;
let fake: FakeDevice;
let proj: string;
let links: Map<string, DeviceAgentThread>;
let tools: Map<string, BuiltinTool>;

beforeEach(async () => {
  env = await devicesEnv();
  fake = await env.enroll({ name: 'Laptop' });
  proj = join(env.dir, 'proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'src', 'notes.md'), '# Notes\n\nfirst\n');
  links = new Map([[THREAD, { agentId: AGENT_ID, kind: 'main', audience: 'private' }]]);
  tools = new Map(
    deviceFileTools({
      service: env.svc,
      agentOf: () => (_a, threadId) => Promise.resolve(links.get(threadId) ?? null),
      audit: () => ({
        append: (r) => {
          env.audit.push(r);
          return Promise.resolve();
        },
      }),
    }).map((t) => [t.descriptor.name, t]),
  );
});

afterEach(async () => {
  await env.close();
});

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    callId: 'call-1',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [],
    sandbox: {} as never,
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
    ...over,
  };
}

const call = (name: string, args: unknown, over: Partial<ToolContext> = {}) =>
  tools.get(name)!.handler(args, ctx(over));
const text = (r: ToolResult) =>
  r.ok ? r.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : r.error.message;
const code = (r: ToolResult) => (r.ok ? 'ok' : r.error.code);
const stagedIdOf = (r: ToolResult) => (r.ok ? String(r.meta?.stagedId) : '');
interface AccessDetails {
  status: string;
  requestId: string;
  approvalId: string;
  path: string;
  access: string;
}
const accessOf = (r: ToolResult) =>
  r.ok ? ({} as AccessDetails) : (r.error.details as AccessDetails);

/** Connect the agent and share the project's src folder with it, read and change. */
async function connectAndShare(capabilities = ['files', 'staged_writes', 'exec']) {
  await env.svc.connect(ACCOUNT, { agentId: AGENT_ID, deviceId: fake.deviceId!, capabilities });
  await env.svc.grant(ACCOUNT, fake.deviceId!, {
    grantee: AGENT,
    kind: 'folder',
    target: join(proj, 'src'),
    access: 'write',
  });
}

/** What the policy engine decides for an agent's call the user typed (docs/12 §2.3). */
function decide(name: string, over: Partial<PolicyContext> = {}) {
  return evaluate({
    actor: { kind: 'agent', id: 'agent' },
    scopes: [{ kind: 'global' }],
    approvalPolicy: { kind: 'defaults' },
    permissionProfile: { id: 'workspace', hash: 'h' },
    environment: { kind: 'hub', trusted: true, substrate: null },
    fs: { entries: [] },
    provenance: { taint: [], userInstruction: { messageId: 'm', accountId: ACCOUNT } },
    tool: tools.get(name)!.descriptor,
    ...over,
  });
}

/**
 * A call through a gate like the runtime's: the engine decides; an ask waits for the owner,
 * who allows it here. Returns what the gate asked and the result.
 */
async function gated(name: string, args: unknown, over: Partial<PolicyContext> = {}) {
  const d = decide(name, over);
  if (d.effect === 'deny') return { asked: false, effect: d.effect, result: null };
  return { asked: d.effect === 'ask', effect: d.effect, result: await call(name, args) };
}

describe('descriptors and the policy engine', () => {
  it('names the tools canonically under the computer source, with the device as untrusted content', () => {
    expect([...tools.keys()]).toEqual([...DEVICE_FILE_TOOL_NAMES]);
    for (const t of tools.values()) {
      expect(TOOL_NAME.test(t.descriptor.name), t.descriptor.name).toBe(true);
      expect(t.descriptor.source).toBe('computer');
    }
    expect(tools.get('device.files.list')!.origin).toBe('file');
    expect(tools.get('device.files.read')!.origin).toBe('file');
    expect(tools.get('device.files.stage_write')!.origin).toBe('file');
    expect(tools.get('device.files.commit')!.descriptor).toMatchObject({
      annotations: { readOnly: false, action: 'write' },
      effects: ['file_write'],
    });
    expect(tools.get('device.files.read')!.descriptor.annotations).toMatchObject({
      readOnly: true,
    });
  });

  it('reads and stages without a card; a commit asks under the default policy, only what policy allows', () => {
    for (const name of [
      'device.files.list',
      'device.files.read',
      'device.files.stage_write',
      'device.files.discard',
    ])
      expect(decide(name).effect, name).toBe('allow');
    expect(decide('device.files.commit')).toMatchObject({ effect: 'ask', effects: ['file_write'] });
    // Device content never authorizes the commit; the owner's own policy can.
    expect(decide('device.files.commit', { provenance: { taint: ['file'] } }).effect).toBe('ask');
    expect(decide('device.files.commit', { approvalPolicy: { kind: 'ask_always' } }).effect).toBe(
      'ask',
    );
    expect(decide('device.files.commit', { approvalPolicy: { kind: 'never_ask' } }).effect).toBe(
      'allow',
    );
    // The proactive research deny (match readOnly: false) refuses the commit.
    const research = {
      rules: [
        {
          id: 'r',
          scope: { kind: 'global' as const },
          match: { readOnly: false },
          effect: 'deny' as const,
        },
      ],
    };
    expect(
      evaluate(
        {
          actor: { kind: 'agent', id: 'agent' },
          scopes: [{ kind: 'global' }],
          approvalPolicy: { kind: 'never_ask' },
          permissionProfile: { id: 'workspace', hash: 'h' },
          environment: { kind: 'hub', trusted: true, substrate: null },
          fs: { entries: [] },
          provenance: { taint: [] },
          tool: tools.get('device.files.commit')!.descriptor,
        },
        research,
      ).effect,
    ).toBe('deny');
  });
});

describe('listing', () => {
  it('lists the tools only in a private thread of an agent with an active connection', async () => {
    const source = deviceToolSource({
      service: env.svc,
      agentOf: () => (_a, threadId) =>
        threadId === 'broken'
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(links.get(threadId) ?? null),
    });
    const names = async (threadId: string | null, mode: 'agent' | 'work' | 'chat' = 'agent') =>
      (await source.list(ACCOUNT, { threadId, mode })).map((t) => t.descriptor.name);
    expect(source.source).toBe('computer');
    // Catalogs (no scope) list them all; the handlers check the thread.
    expect(await source.list(ACCOUNT)).toHaveLength(5);
    // Not connected yet: nothing.
    expect(await names(THREAD)).toEqual([]);
    await connectAndShare();
    expect(await names(THREAD)).toEqual([...DEVICE_FILE_TOOL_NAMES]);
    expect(await names('other-thread')).toEqual([]);
    expect(await names('broken')).toEqual([]);
    expect(await names(null)).toEqual([]);
    // Proactive research only reads; a shared channel thread gets none (the files are the owner's).
    links.set('research', { agentId: AGENT_ID, kind: 'proactive', audience: 'private' });
    expect(await names('research')).toEqual(['device.files.list', 'device.files.read']);
    links.set('channel', { agentId: AGENT_ID, kind: 'binding', audience: 'shared' });
    expect(await names('channel')).toEqual([]);
    // Without the late-bound resolver, no thread gets them.
    expect(
      await deviceToolSource({ service: env.svc }).list(ACCOUNT, {
        threadId: THREAD,
        mode: 'agent',
      }),
    ).toEqual([]);
    // A connection without staged writes reads only; one without files only stages.
    await env.svc.connect(ACCOUNT, {
      agentId: AGENT_ID,
      deviceId: fake.deviceId!,
      capabilities: ['files'],
    });
    expect(await names(THREAD)).toEqual(['device.files.list', 'device.files.read']);
    await env.svc.connect(ACCOUNT, {
      agentId: AGENT_ID,
      deviceId: fake.deviceId!,
      capabilities: ['staged_writes'],
    });
    expect(await names(THREAD, 'work')).toEqual([
      'device.files.stage_write',
      'device.files.commit',
      'device.files.discard',
    ]);
    // Disconnected: nothing again.
    const c = (await env.svc.activeConnection(ACCOUNT, AGENT_ID))!;
    await env.svc.disconnect(ACCOUNT, c.id);
    expect(await names(THREAD)).toEqual([]);
  });

  it('refuses in the handlers outside an agent thread, without a connection and in research', async () => {
    expect(code(await call('device.files.list', { path: proj }, { threadId: 'nope' }))).toBe(
      'not_available',
    );
    expect(code(await call('device.files.list', { path: proj }))).toBe('not_connected');
    await connectAndShare(['files']);
    expect(
      code(await call('device.files.stage_write', { path: join(proj, 'src', 'x'), content: 'x' })),
    ).toBe('capability_missing');
    links.set('research', { agentId: AGENT_ID, kind: 'proactive' });
    expect(
      code(
        await call(
          'device.files.stage_write',
          { path: join(proj, 'src', 'x'), content: 'x' },
          { threadId: 'research' },
        ),
      ),
    ).toBe('read_only');
    links.set('channel', { agentId: AGENT_ID, kind: 'binding', audience: 'shared' });
    expect(code(await call('device.files.read', { path: proj }, { threadId: 'channel' }))).toBe(
      'not_available',
    );
    expect(
      env.audit.filter((a) => a.action === 'device.files.refused').map((a) => a.result),
    ).toEqual([
      'not_available',
      'not_connected',
      'capability_missing',
      'read_only',
      'not_available',
    ]);
  });
});

describe('reading', () => {
  beforeEach(() => connectAndShare());

  it('lists and reads inside the agent’s folders, audited with the thread, turn and call', async () => {
    const l = await call('device.files.list', { path: join(proj, 'src') });
    expect(l.ok).toBe(true);
    expect(text(l)).toContain(`${join(proj, 'src')} on Laptop:`);
    expect(text(l)).toContain('notes.md (15 bytes)');
    const r = await call('device.files.read', { path: join(proj, 'src', 'notes.md') });
    expect(text(r)).toContain('# Notes\n\nfirst\n');
    expect(text(r)).toMatch(/\(15 bytes, sha256 [0-9a-f]{64}\)/);
    const part = await call('device.files.read', {
      path: join(proj, 'src', 'notes.md'),
      maxBytes: 7,
    });
    expect(text(part)).toContain('the first 7 shown');
    expect(text(part)).not.toContain('first\n');
    writeFileSync(join(proj, 'src', 'bin.dat'), Buffer.from([1, 0, 2]));
    expect(text(await call('device.files.read', { path: join(proj, 'src', 'bin.dat') }))).toContain(
      '(binary content, not shown)',
    );
    const reads = env.audit.filter((a) => a.action.startsWith('device.fs.'));
    expect(reads.map((a) => a.action)).toEqual([
      'device.fs.list',
      'device.fs.read',
      'device.fs.read',
      'device.fs.read',
    ]);
    expect(reads[0]).toMatchObject({
      kind: 'device',
      actor: `agent:${AGENT_ID}`,
      resource: fake.deviceId,
      threadId: THREAD,
      turnId: 'turn-1',
      result: 'ok',
      detail: { callId: 'call-1', agentId: AGENT_ID },
    });
  });

  it('refuses folders not shared with the agent without filing a request', async () => {
    const r = await call('device.files.read', { path: join(proj, 'docs', 'x.md') });
    expect(code(r)).toBe('folder_access_required');
    expect(text(r)).toContain('Only the folders the owner shared with you on Laptop');
    expect(code(await call('device.files.list', { path: proj }))).toBe('folder_access_required');
    expect(
      (await env.svc.grants(ACCOUNT, fake.deviceId!)).filter((g) => g.status === 'pending'),
    ).toEqual([]);
    expect(env.audit.filter((a) => a.action.startsWith('device.fs.')).map((a) => a.result)).toEqual(
      ['folder_access_required', 'folder_access_required'],
    );
  });
});

describe('writing', () => {
  beforeEach(() => connectAndShare());

  it('stages with a diff, writes nothing, then commits through a gate that asks', async () => {
    const notes = join(proj, 'src', 'notes.md');
    const staged = await gated('device.files.stage_write', {
      path: notes,
      content: '# Notes\n\nsecond\n',
    });
    expect(staged.asked).toBe(false);
    const s = staged.result!;
    expect(s.ok, text(s)).toBe(true);
    expect(text(s)).toContain(`Staged a write to ${notes} on Laptop`);
    expect(text(s)).toContain('1 line added, 1 removed');
    expect(text(s)).toContain('-first\n+second');
    const stagedId = stagedIdOf(s);
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nfirst\n');
    expect(await env.svc.stagedWrite(ACCOUNT, stagedId)).toMatchObject({
      status: 'staged',
      grantee: AGENT,
    });
    // The commit is a write: the gate asks the owner, who allows it; then it lands.
    const committed = await gated('device.files.commit', { stagedId });
    expect(committed).toMatchObject({ asked: true, effect: 'ask' });
    expect(text(committed.result!)).toContain(`Wrote ${notes} on Laptop`);
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nsecond\n');
    expect(code(await call('device.files.commit', { stagedId }))).toBe('conflict');
    // The service's audits and events carry the thread, the turn and the call.
    const stage = env.audit.find((a) => a.action === 'device.write.stage')!;
    expect(stage).toMatchObject({
      kind: 'device',
      actor: `agent:${AGENT_ID}`,
      threadId: THREAD,
      turnId: 'turn-1',
      detail: { callId: 'call-1', grantee: AGENT },
    });
    expect(env.audit.find((a) => a.action === 'device.write.commit')).toMatchObject({
      result: 'committed',
      turnId: 'turn-1',
    });
    expect(
      env.events.events.find((e) => e.name === 'device.write.committed')?.correlation,
    ).toMatchObject({ threadId: THREAD, turnId: 'turn-1', callId: 'call-1', agentId: AGENT_ID });
  });

  it('a path outside the grants files a folder-access request and never writes', async () => {
    const plan = join(proj, 'docs', 'plan.md');
    const r = await call('device.files.stage_write', { path: plan, content: 'plan\n' });
    expect(code(r)).toBe('folder_access_required');
    expect(text(r)).toContain(`${join(proj, 'docs')} on Laptop is outside the folders shared`);
    expect(text(r)).toContain('is pending');
    const details = accessOf(r);
    expect(details).toMatchObject({
      status: 'pending',
      path: join(proj, 'docs'),
      access: 'write',
    });
    const card = env.db.raw
      .prepare('SELECT status, tool_name, thread_id, agent_id FROM approval WHERE id = ?')
      .get(details.approvalId) as Record<string, unknown>;
    expect(card).toMatchObject({
      status: 'pending',
      tool_name: 'device.fs.request_access',
      thread_id: THREAD,
      agent_id: AGENT_ID,
    });
    expect(readdirSync(join(proj, 'docs'))).toEqual([]);
    expect(await env.svc.stagedWrites(ACCOUNT, fake.deviceId!, { status: 'staged' })).toEqual([]);
    expect(env.audit.find((a) => a.action === 'device.access.request')).toMatchObject({
      threadId: THREAD,
      turnId: 'turn-1',
    });
    // The owner allows it on the Hub; staging again works and commits.
    env.db.raw
      .prepare("UPDATE approval SET status = 'decided', decision = 'allow_once' WHERE id = ?")
      .run(details.approvalId);
    await env.svc.onApprovalDecided(ACCOUNT, details.approvalId, 'allow_once');
    const again = await call('device.files.stage_write', { path: plan, content: 'plan\n' });
    expect(again.ok, text(again)).toBe(true);
    const stagedId = stagedIdOf(again);
    expect((await call('device.files.commit', { stagedId })).ok).toBe(true);
    expect(readFileSync(plan, 'utf8')).toBe('plan\n');
  });

  it('says so when the owner denied the folder, and a new request after a denial is pending', async () => {
    const plan = join(proj, 'docs', 'plan.md');
    const r = await call('device.files.stage_write', { path: plan, content: 'plan\n' });
    const details = accessOf(r);
    env.db.raw
      .prepare("UPDATE approval SET status = 'decided', decision = 'deny_continue' WHERE id = ?")
      .run(details.approvalId);
    await env.svc.onApprovalDecided(ACCOUNT, details.approvalId, 'deny_continue');
    expect((await env.svc.accessRequest(ACCOUNT, details.requestId)).status).toBe('denied');
    // novad may answer with the decided request: the tool reports the denial.
    const svc = env.svc;
    const denying = new Proxy(svc, {
      get(target, key) {
        if (key === 'accessRequest')
          return (accountId: string, requestId: string) =>
            target
              .accessRequest(accountId, requestId)
              .then((v) => ({ ...v, status: 'denied' as const, approvalId: null }));
        const v = Reflect.get(target, key, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const strict = deviceFileTools({
      service: denying,
      agentOf: () => (_a, threadId) => Promise.resolve(links.get(threadId) ?? null),
    }).find((t) => t.descriptor.name === 'device.files.stage_write')!;
    const denied = await strict.handler({ path: plan, content: 'plan\n' }, ctx());
    expect(code(denied)).toBe('folder_access_denied');
    expect(text(denied)).toContain('the owner did not grant access');
    // The fake novad files a new request instead: it is pending again, and nothing is written.
    const again = await call('device.files.stage_write', { path: plan, content: 'plan\n' });
    expect(code(again)).toBe('folder_access_required');
    expect(text(again)).toContain('is pending');
    expect(readdirSync(join(proj, 'docs'))).toEqual([]);
  });

  it('a target changed after staging is a conflict and nothing is written', async () => {
    const notes = join(proj, 'src', 'notes.md');
    const s = await call('device.files.stage_write', { path: notes, content: 'mine\n' });
    const stagedId = stagedIdOf(s);
    writeFileSync(notes, 'theirs\n');
    const c = await call('device.files.commit', { stagedId });
    expect(code(c)).toBe('conflict');
    expect(text(c)).toContain('changed on Laptop after the write was staged');
    expect(readFileSync(notes, 'utf8')).toBe('theirs\n');
    expect((await env.svc.stagedWrite(ACCOUNT, stagedId)).status).toBe('conflict');
    expect(env.audit.find((a) => a.action === 'device.write.commit')).toMatchObject({
      result: 'conflict',
      turnId: 'turn-1',
    });
  });

  it('discards its own staged writes and never touches another grantee’s', async () => {
    const notes = join(proj, 'src', 'notes.md');
    const s = await call('device.files.stage_write', { path: notes, content: 'x\n' });
    const stagedId = stagedIdOf(s);
    const d = await call('device.files.discard', { stagedId });
    expect(text(d)).toBe(`Discarded the staged write to ${notes}.`);
    expect((await env.svc.stagedWrite(ACCOUNT, stagedId)).status).toBe('discarded');
    expect(code(await call('device.files.discard', { stagedId }))).toBe('conflict');
    // The owner's own staged write is not the agent's to commit or discard.
    await env.svc.requestAccess(
      ACCOUNT,
      fake.deviceId!,
      { kind: 'user', id: ACCOUNT },
      {
        path: proj,
        access: 'write',
      },
    );
    const owners = await env.svc.stage(
      ACCOUNT,
      fake.deviceId!,
      { kind: 'user', id: ACCOUNT },
      {
        path: notes,
        contentBase64: Buffer.from('owner\n').toString('base64'),
      },
    );
    expect(code(await call('device.files.commit', { stagedId: owners.id }))).toBe('not_found');
    expect(code(await call('device.files.discard', { stagedId: owners.id }))).toBe('not_found');
    expect(code(await call('device.files.commit', { stagedId: 'missing' }))).toBe('not_found');
    expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nfirst\n');
    expect((await env.svc.stagedWrite(ACCOUNT, owners.id)).status).toBe('staged');
  });

  it('refuses protected paths and reports an unreachable device', async () => {
    const r = await call('device.files.stage_write', {
      path: join(proj, 'src', '.git', 'config'),
      content: 'x',
    });
    expect(code(r)).toBe('policy_denied');
    await fake.close();
    const down = await call('device.files.read', { path: join(proj, 'src', 'notes.md') });
    expect(code(down)).toBe('device_unavailable');
    expect(text(down)).toContain('Laptop is not reachable now');
  });
});
