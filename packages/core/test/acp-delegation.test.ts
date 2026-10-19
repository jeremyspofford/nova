// External agent delegation (FR-203) end to end with a fake agent process speaking the Agent
// Client Protocol, the real tool runtime and the real policy gate: every permission request the
// agent makes becomes a decision of the engine (previewed for what Nova then performs, decided by
// the gate with an approval for what it does not), every file and terminal operation is a tool
// call through the gate in the Code session, an adapter that cannot route permissions is refused,
// and the flag hides it all.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import {
  ExternalAgentService,
  execTools,
  fsTools,
  type AgentLaunch,
  type AgentLauncher,
  type ExecResult,
  type LineTransport,
  type SandboxClient,
} from '../src/index.ts';
import { ACCOUNT, THREAD, flaggedEnv, type FlaggedEnv } from './flagged-env.ts';

const AGENT = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

/** Test-only: the fake agent as a plain child process (production always uses the sandbox). */
function processLauncher(extraEnv: Record<string, string> = {}): AgentLauncher & {
  launches: AgentLaunch[];
} {
  const launches: AgentLaunch[] = [];
  const launcher = (l: AgentLaunch): Promise<LineTransport> => {
    launches.push(l);
    const child = spawn(process.execPath, [AGENT], {
      env: { PATH: process.env.PATH ?? '', ...l.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const rl = createInterface({ input: child.stdout });
    const closers: ((r: string) => void)[] = [];
    child.on('exit', (code) => closers.forEach((cb) => cb(`the agent exited with code ${code}`)));
    child.stdin.on('error', () => undefined);
    return Promise.resolve({
      send: (line) => void child.stdin.write(`${line}\n`),
      onLine: (cb) => void rl.on('line', cb),
      onClose: (cb) => void closers.push(cb),
      close: () => {
        child.kill('SIGKILL');
        return Promise.resolve();
      },
    });
  };
  return Object.assign(launcher, { launches });
}

/** A sandbox whose commands "run" at once and echo themselves. */
const echoSandbox: SandboxClient = {
  substrate: 'container',
  available: () => Promise.resolve({ ok: true, detail: '' }),
  exec: (req): Promise<ExecResult> =>
    Promise.resolve({ status: 'exited', exitCode: 0, output: `ran: ${req.cmd}` }),
  poll: () => Promise.reject(new Error('nothing is running')),
  write: () => Promise.resolve(),
  killTurn: () => Promise.resolve(),
};

let env: FlaggedEnv;
let service: ExternalAgentService;
let launcher: ReturnType<typeof processLauncher>;
let secrets: MemorySecretStore;

async function setup(extraEnv: Record<string, string> = {}) {
  // Nova's real file and command tools, over a sandbox that echoes commands.
  env = await flaggedEnv({
    mode: 'code',
    tools: ({ dir, workspace }) => {
      const paths = { denied: [join(dir, 'data')], allowed: [workspace] };
      return [...fsTools({ paths }), ...execTools({ paths })];
    },
    sandbox: echoSandbox,
  });
  const now = new Date().toISOString();
  env.db.raw
    .prepare(
      'INSERT INTO code_session (id, account_id, thread_id, folder_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(uuidv7(), ACCOUNT, THREAD, env.workspace, now, now);
  launcher = processLauncher(extraEnv);
  secrets = new MemorySecretStore();
  service = new ExternalAgentService({
    db: env.db,
    events: env.events,
    audit: { append: (r) => Promise.resolve(void env.audit.push(r)) },
    secrets,
    enabled: () => env.setting('externalAgents.enabled'),
    launcher,
    runtime: () => env.runtime,
    gate: () => env.gate,
    startTimeoutMs: 10_000,
  });
  env.settings['externalAgents.enabled'] = true;
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await service.close();
  await env.close();
});

async function adapter(extra: Record<string, unknown> = {}) {
  return service.createAdapter(ACCOUNT, {
    name: 'Fake agent',
    command: 'fake-agent',
    args: ['--acp'],
    env: { FAKE_TOKEN: 'tok-123' },
    permissionRouting: 'client',
    ...extra,
  });
}

/** Delegate and answer each approval with `answers` in order; returns the finished delegation. */
async function delegate(prompt: string, answers: ('allow_once' | 'deny_continue')[] = []) {
  const a = (await service.listAdapters(ACCOUNT))[0] ?? (await adapter());
  let before = env.approvals();
  const d = await service.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt });
  for (const decision of answers) {
    const approvalId = await env.nextApproval(before);
    before = env.approvals();
    await env.gate.decide(ACCOUNT, { approvalId, decision });
  }
  await service.whenDone(d.id);
  return service.getDelegation(ACCOUNT, d.id);
}

describe('adapters', () => {
  it('refuses an adapter that cannot route its permission requests to Nova', async () => {
    await expect(adapter({ permissionRouting: 'agent' })).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'permission_routing' },
    });
    expect(await service.listAdapters(ACCOUNT)).toEqual([]);
  });

  it('keeps only secret references, edits, deletes and audits', async () => {
    const a = await adapter();
    expect(a.env).toEqual({ FAKE_TOKEN: `secret://agent-adapter/${a.id}/env/FAKE_TOKEN` });
    expect(await secrets.get(a.env.FAKE_TOKEN!)).toBe('tok-123');
    const row = env.db.raw.prepare('SELECT env_json FROM agent_adapter WHERE id = ?').get(a.id) as {
      env_json: string;
    };
    expect(row.env_json).not.toContain('tok-123');
    await expect(adapter()).rejects.toMatchObject({ code: 'conflict' });
    // A reference to any secret but the adapter's own is refused (it would hand that secret to
    // the agent's process).
    await expect(
      service.updateAdapter(ACCOUNT, a.id, { env: { OTHER: 'secret://elsewhere/x' } }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'foreign_secret' } });
    const b = await service.updateAdapter(ACCOUNT, a.id, {
      enabled: false,
      env: { FAKE_TOKEN: '', OWN: `secret://agent-adapter/${a.id}/env/FAKE_TOKEN` },
      args: [],
    });
    expect(b).toMatchObject({ enabled: false, args: [] });
    expect(b.env).toEqual({
      FAKE_TOKEN: `secret://agent-adapter/${a.id}/env/FAKE_TOKEN`,
      OWN: `secret://agent-adapter/${a.id}/env/FAKE_TOKEN`,
    });
    await expect(
      service.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await service.deleteAdapter(ACCOUNT, a.id);
    expect(await secrets.list(`secret://agent-adapter/${a.id}/`)).toEqual([]);
    await expect(service.getAdapter(ACCOUNT, a.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(env.audit.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'agent_adapter.create',
        'agent_adapter.update',
        'agent_adapter.delete',
      ]),
    );
    expect(JSON.stringify(env.audit)).not.toContain('tok-123');
  });

  it('is absent while externalAgents.enabled is off', async () => {
    const a = await adapter();
    env.settings['externalAgents.enabled'] = false;
    await expect(service.listAdapters(ACCOUNT)).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      service.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'edit /x y' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(launcher.launches).toEqual([]);
  });

  it('checks the handshake and records the agent', async () => {
    const a = await adapter();
    const check = await service.checkAdapter(ACCOUNT, a.id, THREAD);
    expect(check).toMatchObject({
      ok: true,
      protocolVersion: 1,
      agent: { name: 'fake-agent', version: '1.0.0' },
    });
    expect((await service.getAdapter(ACCOUNT, a.id)).lastCheck).toMatchObject({ ok: true });
    // The launch carried the resolved secret, the read-only session folder and no network.
    expect(launcher.launches[0]).toMatchObject({
      command: 'fake-agent',
      args: ['--acp'],
      env: { FAKE_TOKEN: 'tok-123' },
      folder: env.workspace,
      hosts: [],
    });
  });
});

describe('delegation through the policy engine', () => {
  it('previews an edit request, then the write itself asks and lands as a file', async () => {
    const file = join(env.workspace, 'notes.md');
    const d = await delegate(`edit ${file} hello from the agent`, ['allow_once']);
    expect(d).toMatchObject({
      status: 'completed',
      stopReason: 'end_turn',
      output: 'wrote it',
      agent: { name: 'fake-agent' },
      permissionRequests: 1,
      operations: 1,
    });
    expect(readFileSync(file, 'utf8')).toBe('hello from the agent');
    // The permission request was the engine's (previewed); the write was a gated tool call.
    expect(env.audit.find((r) => r.action === 'delegation.permission')).toMatchObject({
      decision: 'allow',
      detail: { kind: 'edit', via: 'preview' },
    });
    const write = env.audit.find((r) => r.kind === 'tool_call' && r.action === 'fs.write');
    expect(write).toMatchObject({
      decision: 'allow',
      result: 'ok',
      detail: { taint: ['external_agent'], userAsked: true, origin: 'model' },
    });
    const call = env.db.raw
      .prepare("SELECT thread_id AS threadId, status FROM tool_call WHERE tool_name = 'fs.write'")
      .get() as { threadId: string; status: string };
    expect(call).toEqual({ threadId: THREAD, status: 'ok' });
    const names = env.events.events.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(['delegation.started', 'delegation.updated', 'delegation.finished']),
    );
    const started = env.events.events.find((e) => e.name === 'delegation.started')!;
    expect(started.correlation).toMatchObject({ threadId: THREAD });
  });

  it('a user who denies the write leaves the file untouched', async () => {
    const file = join(env.workspace, 'kept.md');
    writeFileSync(file, 'original');
    const d = await delegate(`edit ${file} replaced`, ['deny_continue']);
    expect(d.output).toContain('write failed: Denied');
    expect(readFileSync(file, 'utf8')).toBe('original');
  });

  it('a deny rule rejects the request at once, and an agent that writes anyway is denied', async () => {
    await env.store.createRule(ACCOUNT, {
      scopeKind: 'global',
      match: { tool: 'fs.write' },
      effect: 'deny',
      label: 'No writes',
    });
    const file = join(env.workspace, 'nope.md');
    const before = env.approvals();
    const d = await delegate(`edit ${file} x`);
    expect(d.output).toBe('rejected no');
    expect(env.audit.find((r) => r.action === 'delegation.permission')).toMatchObject({
      decision: 'reject',
    });
    const rogue = await delegate(`rogue ${file}`);
    expect(rogue.output).toContain('write failed: Denied');
    expect(existsSync(file)).toBe(false);
    expect(env.approvals()).toBe(before);
  });

  it('decides what Nova does not perform with the gate itself', async () => {
    // fetch: the gate asks; the user's deny rejects it.
    const f = await delegate('fetch https://example.com/x', ['deny_continue']);
    expect(f.output).toBe('fetch no');
    const fetchAudit = env.audit.find((r) => r.kind === 'policy' && r.action === 'acp.fetch');
    expect(fetchAudit).toBeDefined();
    // think: read-only, allowed without asking.
    const before = env.approvals();
    const t = await delegate('think');
    expect(t.output).toBe('think yes');
    expect(env.approvals()).toBe(before);
    // Only "always allow" offered: Nova never gives it, so the answer is a reject.
    const al = await delegate('always', ['allow_once']);
    expect(al.output).toBe('always no');
  });

  it('reads files of the session for the agent, and nothing outside it', async () => {
    writeFileSync(join(env.workspace, 'a.txt'), 'one\ntwo\nthree\n');
    const d = await delegate(`read ${join(env.workspace, 'a.txt')}`);
    expect(d.output).toBe('content: one\ntwo\nthree\n');
    const part = await delegate(`read ${join(env.workspace, 'a.txt')} 2 1`);
    expect(part.output).toBe('content: two');
    const outside = await delegate(`read ${join(env.dir, 'home', 'secret.txt')}`);
    expect(outside.output).toMatch(/^read failed: /);
    const relative = await delegate('read a.txt');
    expect(relative.output).toBe('read failed: paths must be absolute');
  });

  it('runs a command through exec.run in the sandbox after its approval', async () => {
    const d = await delegate('run echo hi', ['allow_once']);
    expect(d.output).toBe("exit 0: ran: sh -c 'echo hi'");
    expect(env.audit.find((r) => r.kind === 'tool_call' && r.action === 'exec.run')).toMatchObject({
      result: 'ok',
      detail: { taint: ['external_agent'] },
    });
    expect(d.operations).toBe(1);
  });

  it('cancels a running delegation', async () => {
    const a = await adapter();
    const d = await service.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'hang' });
    await expect(
      service.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'again' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await new Promise((r) => setTimeout(r, 200));
    const c = await service.cancel(ACCOUNT, d.id);
    expect(c).toMatchObject({ status: 'cancelled' });
    expect(env.audit.some((r) => r.action === 'delegation.cancel')).toBe(true);
    expect((await service.listDelegations(ACCOUNT, THREAD))[0]).toMatchObject({ id: d.id });
  });

  it('fails a crashing agent and refuses one that speaks another protocol version', async () => {
    const crash = await delegate('crash');
    expect(crash.status).toBe('failed');
    expect(crash.error).toMatch(/gone|exited/);
    await service.close();
    await env.close();
    await setup({ FAKE_ACP_VERSION: '7' });
    const v = await delegate('think');
    expect(v).toMatchObject({ status: 'failed' });
    expect(v.error).toMatch(/^refused: the agent speaks protocol version 7/);
  });

  it('refuses a thread that is not a Code session', async () => {
    const a = await adapter();
    env.db.raw.prepare('DELETE FROM code_session').run();
    await expect(
      service.delegate(ACCOUNT, THREAD, { adapterId: a.id, prompt: 'think' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
