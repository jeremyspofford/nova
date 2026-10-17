// Lifecycle hooks end to end (FR-197, ADR-068): discovery from each source, trust by hash and
// re-trust on change, matchers, both handlers with fakes, result combination and the fail-closed
// rules, the one-continuation limit, events and audit.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, uuidv7, type ToolDescriptor } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  HookService,
  MemoryEventSink,
  noHooks,
  type AuditRecord,
  type ExecRequest,
  type ExecResult,
  type GateOutcome,
  type GateRequest,
  type HookDefinition,
  type HookInput,
  type HookMcpClient,
  type HookServiceOptions,
  type SandboxClient,
  type ToolGate,
  type ToolResult,
  type ToolScope,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const THREAD = '01920000-0000-7000-8000-0000000000a1';
const PROJECT = '01920000-0000-7000-8000-0000000000b1';

const tool = (name: string): ToolDescriptor => ({
  name,
  title: name,
  description: name,
  source: name.startsWith('mcp:') ? 'mcp' : 'builtin',
  inputSchema: { type: 'object' },
});

/** A sandbox that answers each command from a script, reading the stdin it was given. */
class FakeSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  ok = true;
  readonly runs: { req: ExecRequest; stdin: string; terminated: boolean }[] = [];
  readonly #sessions = new Map<string, { req: ExecRequest; stdin: string; terminated: boolean }>();
  answer: (stdin: string, req: ExecRequest) => { output: string; exitCode?: number } | 'hang' =
    () => ({
      output: '',
    });

  available() {
    return Promise.resolve({ ok: this.ok, detail: this.ok ? 'fake' : 'engine is not running' });
  }
  exec(req: ExecRequest): Promise<ExecResult> {
    const id = uuidv7();
    const s = { req, stdin: '', terminated: false };
    this.#sessions.set(id, s);
    this.runs.push(s);
    return Promise.resolve({ status: 'running', sessionId: id, output: '' });
  }
  async poll(id: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    const s = this.#sessions.get(id)!;
    const a = this.answer(s.stdin, s.req);
    if (a === 'hang') {
      await new Promise<void>((r) => {
        const t = setTimeout(r, yieldMs);
        signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
      return { status: 'running', sessionId: id, output: '' };
    }
    return { status: 'exited', exitCode: a.exitCode ?? 0, output: a.output };
  }
  write(id: string, input: { text?: string; signal?: 'interrupt' | 'terminate' }): Promise<void> {
    const s = this.#sessions.get(id)!;
    if (input.text) s.stdin += input.text;
    if (input.signal === 'terminate') s.terminated = true;
    return Promise.resolve();
  }
  killTurn(): Promise<void> {
    return Promise.resolve();
  }
}

let dir: string;
let data: string;
let db: NovaDatabase;
let events: MemoryEventSink;
let audit: AuditRecord[];
let sandbox: FakeSandbox;
let managed: unknown;
let svc: HookService;

function makeService(over: Partial<HookServiceOptions> = {}): HookService {
  return new HookService({
    db,
    events,
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    userFile: join(data, 'hooks.json'),
    managed: () => managed,
    sandbox,
    scope: (): Promise<ToolScope> =>
      Promise.resolve({
        roots: [{ path: join(dir, 'work'), access: 'write', label: 'Work' }],
        profile: { id: 'workspace', hash: 'p' },
        network: 'limited',
      }),
    spillDir: join(dir, 'spill'),
    ...over,
  });
}

function writeUser(hooks: unknown[]): void {
  writeFileSync(join(data, 'hooks.json'), JSON.stringify({ hooks }));
}

const guard = (over: Partial<HookDefinition> = {}): HookDefinition => ({
  id: 'guard',
  event: 'tool.pre',
  handler: { type: 'command', command: ['node', 'guard.mjs'] },
  ...over,
});

function input(over: Partial<HookInput & { callId: string; subject: string }> = {}) {
  return {
    accountId: ACCOUNT,
    threadId: THREAD,
    turnId: 'turn-1',
    projectId: null,
    tool: tool('exec.run'),
    args: { cmd: 'git push', token: 'sk-live-should-not-leak-1234567890' },
    callId: 'call-1',
    ...over,
  };
}

const signal = () => new AbortController().signal;

/**
 * Add a project folder. The workspace area owns `project_folder` (0014); hooks read only its
 * id, project and path, so any other required column gets a plain value.
 */
function addFolder(id: string, projectId: string, path: string): void {
  const cols = db.raw.prepare('PRAGMA table_info(project_folder)').all() as {
    name: string;
    notnull: number;
    dflt_value: unknown;
  }[];
  const values: Record<string, unknown> = { id, project_id: projectId, path };
  for (const c of cols)
    if (!(c.name in values) && c.notnull && c.dflt_value === null)
      values[c.name] =
        c.name === 'account_id' ? ACCOUNT : c.name.endsWith('_at') ? new Date().toISOString() : '';
  const names = Object.keys(values);
  db.raw
    .prepare(
      `INSERT INTO project_folder (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    )
    .run(...(Object.values(values) as string[]));
}

async function trustAll(s = svc): Promise<void> {
  for (const h of await s.list(ACCOUNT))
    if (h.status === 'needs_trust') await s.trust(ACCOUNT, h.id, h.contentHash);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hooks-'));
  data = join(dir, 'data');
  mkdirSync(data);
  mkdirSync(join(dir, 'work'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
    .run(ACCOUNT, now, now);
  db.raw
    .prepare(
      'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(PROJECT, ACCOUNT, 'billing', now, now);
  events = new MemoryEventSink();
  audit = [];
  sandbox = new FakeSandbox();
  managed = undefined;
  svc = makeService();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('discovery and trust', () => {
  it('lists user, managed, project and plugin hooks with their trust state', async () => {
    writeUser([guard()]);
    managed = { hooks: [guard({ id: 'org-policy', event: 'prompt.submit' })] };
    const folder = join(dir, 'proj');
    mkdirSync(join(folder, '.nova'), { recursive: true });
    writeFileSync(
      join(folder, '.nova', 'hooks.json'),
      JSON.stringify({ hooks: [guard({ id: 'check-branch', matcher: 'exec.run' })] }),
    );
    addFolder('f1', PROJECT, folder);
    const plugin = join(dir, 'plugin');
    mkdirSync(plugin);
    await svc.registerPluginHooks(ACCOUNT, {
      pluginId: 'com.example.dev',
      root: plugin,
      hooks: [guard({ id: 'lint', event: 'tool.post' })],
    });

    const list = await svc.list(ACCOUNT);
    // Canonical ids name each hook in the trust list, events and audit (docs/08 §8).
    expect(list.map((h) => h.id)).toEqual([
      'hook:managed.org-policy',
      'hook:user.guard',
      `hook:project:${PROJECT}.check-branch`,
      'hook:com.example.dev.lint',
    ]);
    expect(list.map((h) => [h.source, h.status])).toEqual([
      ['managed', 'trusted'],
      ['user', 'needs_trust'],
      ['project', 'needs_trust'],
      ['plugin', 'needs_trust'],
    ]);
    expect(list[2]).toMatchObject({ matcher: 'exec.run', handler: { type: 'command' } });
    expect(events.names().filter((n) => n === 'hook.trust.changed').length).toBe(3);
    // Nothing new: a second listing announces nothing.
    const before = events.events.length;
    await svc.list(ACCOUNT);
    expect(events.events.length).toBe(before);
  });

  it('trusts by hash only, and a changed hook or script needs trust again', async () => {
    writeFileSync(join(data, 'guard.mjs'), 'v1');
    writeUser([guard()]);
    const [h] = await svc.list(ACCOUNT);
    await expect(svc.trust(ACCOUNT, h!.id, 'sha256:wrong')).rejects.toMatchObject({
      code: 'conflict',
    });
    const trusted = await svc.trust(ACCOUNT, h!.id, h!.contentHash);
    expect(trusted.status).toBe('trusted');
    expect(audit.at(-1)).toMatchObject({
      kind: 'settings',
      action: 'hook.trust',
      decision: 'trusted',
    });
    expect(events.events.at(-1)).toMatchObject({
      name: 'hook.trust.changed',
      payload: { hookId: h!.id, status: 'trusted' },
    });

    // Edit the definition: back to needs_trust.
    writeUser([guard({ matcher: 'exec.*' })]);
    const [changed] = await svc.list(ACCOUNT);
    expect(changed).toMatchObject({ id: h!.id, status: 'needs_trust', changedSinceTrust: true });
    expect(changed!.contentHash).not.toBe(h!.contentHash);
    expect(trusted.changedSinceTrust).toBe(false);
    // Reverting does not silently trust it again.
    writeUser([guard()]);
    expect((await svc.list(ACCOUNT))[0]!.status).toBe('needs_trust');
    await trustAll();
    expect((await svc.list(ACCOUNT))[0]!.status).toBe('trusted');
  });

  it('re-hashes the script a project hook runs', async () => {
    const folder = join(dir, 'proj');
    mkdirSync(join(folder, '.nova', 'hooks'), { recursive: true });
    writeFileSync(join(folder, '.nova', 'hooks', 'check.sh'), 'echo {}');
    writeFileSync(
      join(folder, '.nova', 'hooks.json'),
      JSON.stringify({
        hooks: [guard({ handler: { type: 'command', command: ['sh', '.nova/hooks/check.sh'] } })],
      }),
    );
    addFolder('f1', PROJECT, folder);
    await trustAll();
    expect((await svc.list(ACCOUNT))[0]!.status).toBe('trusted');
    writeFileSync(join(folder, '.nova', 'hooks', 'check.sh'), 'echo \'{"decision":"allow"}\'');
    expect((await svc.list(ACCOUNT))[0]!.status).toBe('needs_trust');
    // A dispatch for the project sees the change before running anything.
    const out = await svc.dispatch('tool.pre', input({ projectId: PROJECT }), signal());
    expect(out).toEqual({ context: [] });
    expect(sandbox.runs).toHaveLength(0);
    expect(events.events.at(-1)).toMatchObject({
      name: 'hook.skipped',
      payload: { reason: 'needs_trust' },
    });
  });

  it('revokes at once, and managed hooks cannot be revoked', async () => {
    writeUser([guard()]);
    managed = [guard({ id: 'org' })];
    await trustAll();
    const [org, user] = await svc.list(ACCOUNT);
    expect((await svc.untrust(ACCOUNT, user!.id)).status).toBe('revoked');
    await expect(svc.untrust(ACCOUNT, org!.id)).rejects.toMatchObject({ code: 'policy_denied' });
    expect((await svc.trust(ACCOUNT, org!.id, 'anything')).status).toBe('trusted');
    sandbox.answer = () => ({ output: '' });
    await svc.dispatch('tool.pre', input(), signal());
    expect(sandbox.runs).toHaveLength(1);
    expect(events.events.find((e) => e.name === 'hook.skipped')?.payload).toMatchObject({
      hookId: user!.id,
      reason: 'revoked',
    });
  });

  it('switches and deletes user hooks only, editing the user file', async () => {
    writeUser([guard(), guard({ id: 'other', event: 'tool.post' })]);
    await svc.registerPluginHooks(ACCOUNT, {
      pluginId: 'p1',
      root: dir,
      hooks: [guard({ id: 'lint' })],
    });
    const list = await svc.list(ACCOUNT);
    const user = list.find((h) => h.source === 'user' && h.event === 'tool.pre')!;
    const plugin = list.find((h) => h.source === 'plugin')!;
    expect((await svc.setEnabled(ACCOUNT, user.id, false)).status).toBe('disabled');
    await expect(svc.setEnabled(ACCOUNT, plugin.id, false)).rejects.toMatchObject({
      code: 'policy_denied',
    });
    await expect(svc.remove(ACCOUNT, plugin.id)).rejects.toBeInstanceOf(NovaError);
    await svc.remove(ACCOUNT, user.id);
    const file = JSON.parse(readFileSync(join(data, 'hooks.json'), 'utf8')) as {
      hooks: { id: string }[];
    };
    expect(file.hooks.map((h) => h.id)).toEqual(['other']);
    expect((await svc.list(ACCOUNT)).map((h) => h.id)).not.toContain(user.id);
    await expect(svc.get(ACCOUNT, user.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps the rows of an unreadable user file but runs none of them (fail closed)', async () => {
    writeUser([guard()]);
    await trustAll();
    writeFileSync(join(data, 'hooks.json'), '{ not json');
    const list = await svc.list(ACCOUNT);
    expect(list).toHaveLength(1);
    expect(svc.diagnostics().unreadable.user).toMatch(/not valid JSON/);
    const out = await svc.dispatch('tool.pre', input(), signal());
    expect(out.block?.reason).toMatch(/cannot be read/);
    expect(sandbox.runs).toHaveLength(0);
    expect(events.names()).toContain('hook.skipped');
    // Fixed: the trust survived.
    writeUser([guard()]);
    expect((await svc.list(ACCOUNT))[0]!.status).toBe('trusted');
  });

  it('treats a malformed managed or project hooks file the same way', async () => {
    managed = [guard({ id: 'org' })];
    const folder = join(dir, 'proj');
    mkdirSync(join(folder, '.nova'), { recursive: true });
    writeFileSync(
      join(folder, '.nova', 'hooks.json'),
      JSON.stringify({ hooks: [guard({ id: 'p' })] }),
    );
    addFolder('f1', PROJECT, folder);
    await trustAll();
    expect(await svc.list(ACCOUNT)).toHaveLength(2);
    managed = { hooks: [guard({ id: 'org' })], unexpected: true };
    writeFileSync(join(folder, '.nova', 'hooks.json'), JSON.stringify({ hooks: 'nope' }));
    expect((await svc.list(ACCOUNT)).map((h) => h.status)).toEqual(['trusted', 'trusted']);
    expect(Object.keys(svc.diagnostics().unreadable).sort()).toEqual([
      'managed',
      `project:${PROJECT}`,
    ]);
    const out = await svc.dispatch('tool.pre', input({ projectId: PROJECT }), signal());
    expect(out.block?.reason).toMatch(/hook org failed.*unknown top-level keys/);
    expect(sandbox.runs).toHaveLength(0);
    expect(events.events.filter((e) => e.name === 'hook.blocked')).toHaveLength(2);
  });
});

describe('command hooks', () => {
  beforeEach(async () => {
    writeUser([
      guard({
        matcher: ['exec.*'],
        handler: { type: 'command', command: ['node', "it's.mjs"], timeoutMs: 1_000 },
      }),
    ]);
    await trustAll();
  });

  it('runs the argv in the sandbox with the redacted event on stdin', async () => {
    sandbox.answer = (stdin) => {
      const e = JSON.parse(stdin) as { tool: string; arguments: { token: string } };
      return { output: JSON.stringify({ block: { reason: `no ${e.tool}` } }) };
    };
    const out = await svc.dispatch('tool.pre', input(), signal());
    expect(out.block).toMatchObject({ reason: 'no exec.run' });
    const run = sandbox.runs[0]!;
    expect(run.req.cmd).toBe("exec 'node' 'it'\\''s.mjs' 2>/dev/null");
    expect(run.req.network).toBe('off');
    expect(run.req.cwd).toBe(join(dir, 'work'));
    const stdin = JSON.parse(run.stdin) as Record<string, unknown>;
    expect(stdin).toMatchObject({
      event: 'tool.pre',
      hookId: 'guard',
      threadId: THREAD,
      turnId: 'turn-1',
      callId: 'call-1',
      tool: 'exec.run',
    });
    expect(run.stdin).not.toContain('sk-live-should-not-leak'); // secret-scan: fake
    const names = events.names();
    expect(names).toContain('hook.started');
    expect(events.events.find((e) => e.name === 'hook.blocked')).toMatchObject({
      payload: { event: 'tool.pre', reason: 'no exec.run', failClosed: false, callId: 'call-1' },
      correlation: { threadId: THREAD, turnId: 'turn-1', callId: 'call-1' },
    });
    expect(audit.at(-1)).toMatchObject({
      kind: 'policy',
      action: 'hook.tool.pre',
      resource: 'exec.run',
      decision: 'blocked',
      result: 'ok',
    });
    expect((await svc.list(ACCOUNT))[0]!.lastRun).toMatchObject({ effect: 'blocked' });
  });

  it('does not run for tools its matcher leaves out', async () => {
    await svc.dispatch('tool.pre', input({ tool: tool('fs.read') }), signal());
    expect(sandbox.runs).toHaveLength(0);
  });

  it('treats empty output as no opinion and adds context', async () => {
    sandbox.answer = () => ({ output: '' });
    expect(await svc.dispatch('tool.pre', input(), signal())).toEqual({ context: [] });
    sandbox.answer = () => ({ output: 'warming up\n{"context":"branch is main"}' });
    const out = await svc.dispatch('tool.pre', input(), signal());
    expect(out.context).toEqual([{ text: 'branch is main', hookId: expect.any(String) as string }]);
    expect(events.events.at(-1)).toMatchObject({
      name: 'hook.completed',
      payload: { effect: 'context' },
    });
    // What a hook prints reaches the model: secrets in it are redacted.
    sandbox.answer = () => ({ output: '{"context":"key sk-live-should-not-leak-1234567890"}' });
    const leaked = await svc.dispatch('tool.pre', input(), signal());
    expect(leaked.context[0]!.text).not.toContain('should-not-leak');
  });

  it('fails closed on tool.pre when the hook errors, answers badly or times out', async () => {
    sandbox.answer = () => ({ output: 'boom', exitCode: 2 });
    let out = await svc.dispatch('tool.pre', input(), signal());
    expect(out.block?.reason).toMatch(/exited with code 2/);
    expect(events.events.at(-1)).toMatchObject({
      name: 'hook.blocked',
      payload: { failClosed: true },
    });
    sandbox.answer = () => ({ output: '{"rewrite":true}' });
    out = await svc.dispatch('tool.pre', input(), signal());
    expect(out.block?.reason).toMatch(/invalid result/);
    sandbox.answer = () => 'hang';
    out = await svc.dispatch('tool.pre', input(), signal());
    expect(out.block?.reason).toMatch(/did not answer within 1 s/);
    expect(sandbox.runs.at(-1)!.terminated).toBe(true);
    expect(audit.at(-1)).toMatchObject({ result: 'timeout', decision: 'error' });
  });

  it('blocks without a sandbox for guards, and skips with error elsewhere', async () => {
    sandbox.ok = false;
    const out = await svc.dispatch('tool.pre', input(), signal());
    expect(out.block?.reason).toMatch(/need a sandbox/);
    expect(events.names()).not.toContain('hook.started');
    expect(events.events.find((e) => e.name === 'hook.skipped')?.payload).toMatchObject({
      reason: 'error',
    });
    const none = makeService({ sandbox: null });
    expect((await none.dispatch('tool.pre', input(), signal())).block?.reason).toMatch(
      /no sandbox/,
    );
  });
});

describe('effects per event', () => {
  it('ignores failures outside guards unless failClosed (prompt.submit)', async () => {
    writeUser([
      guard({ id: 'post', event: 'tool.post' }),
      guard({ id: 'prompt', event: 'prompt.submit' }),
      guard({ id: 'strict', event: 'prompt.submit', failClosed: true }),
    ]);
    await trustAll();
    sandbox.answer = () => ({ output: '', exitCode: 1 });
    expect(await svc.dispatch('tool.post', input({ result: 'ok' }), signal())).toEqual({
      context: [],
    });
    expect(events.events.at(-1)).toMatchObject({
      name: 'hook.skipped',
      payload: { reason: 'error' },
    });
    const out = await svc.dispatch(
      'prompt.submit',
      input({ tool: undefined, prompt: 'hi' }),
      signal(),
    );
    expect(out.block?.reason).toMatch(/hook strict failed/);
  });

  it('only lets each event have its own effects', async () => {
    writeUser([
      guard({ id: 'post', event: 'tool.post' }),
      guard({ id: 'end', event: 'session.end' }),
    ]);
    await trustAll();
    sandbox.answer = () => ({
      output: '{"block":{"reason":"x"},"decision":"deny","continue":"go","context":"c"}',
    });
    const post = await svc.dispatch('tool.post', input({ result: 'r' }), signal());
    expect(post.block).toBeUndefined();
    expect(post.decision).toBeUndefined();
    expect(post.continueWith).toBeUndefined();
    expect(post.context.map((c) => c.text)).toEqual(['c']);
    expect(await svc.dispatch('session.end', input({ tool: undefined }), signal())).toEqual({
      context: [],
    });
  });

  it('combines context in source order and spills large context to a file', async () => {
    managed = [guard({ id: 'm', event: 'session.start', matcher: 'new' })];
    writeUser([
      guard({ id: 'b', event: 'session.start' }),
      guard({ id: 'a', event: 'session.start' }),
    ]);
    await trustAll();
    sandbox.answer = (stdin) => {
      const id = (JSON.parse(stdin) as { hookId: string }).hookId;
      return { output: JSON.stringify({ context: id === 'a' ? 'x'.repeat(12_000) : id }) };
    };
    const out = await svc.dispatch(
      'session.start',
      input({ tool: undefined, subject: 'new' }),
      signal(),
    );
    expect(out.context.map((c) => c.text.slice(0, 5))).toEqual(['m', 'xxxxx', 'b']);
    const big = out.context[1]!.text;
    expect(big.length).toBeLessThan(12_000);
    const path = /fs\.read at (\S+)\]/.exec(big)?.[1];
    expect(readFileSync(path!, 'utf8')).toHaveLength(12_000);
    expect(JSON.parse(sandbox.runs[0]!.stdin)).toMatchObject({ reason: 'new' });
    // A different start reason does not match the managed hook.
    sandbox.runs.length = 0;
    await svc.dispatch('session.start', input({ tool: undefined, subject: 'resume' }), signal());
    expect(sandbox.runs).toHaveLength(2);
  });

  it('requests at most one continuation per stop and per turn', async () => {
    writeUser([guard({ id: 'one', event: 'stop' }), guard({ id: 'two', event: 'stop' })]);
    await trustAll();
    sandbox.answer = (stdin) => ({
      output: JSON.stringify({
        continue: `again from ${(JSON.parse(stdin) as { hookId: string }).hookId}`,
      }),
    });
    const first = await svc.dispatch('stop', input({ tool: undefined, reply: 'done' }), signal());
    expect(first.continueWith?.prompt).toBe('again from one');
    const second = await svc.dispatch('stop', input({ tool: undefined, reply: 'done' }), signal());
    expect(second.continueWith).toBeUndefined();
    const next = await svc.dispatch('stop', input({ tool: undefined, turnId: 'turn-2' }), signal());
    expect(next.continueWith?.prompt).toBe('again from one');
  });
});

describe('permission.request', () => {
  const ask = { effect: 'ask' as const, reason: 'your rule asks', source: 'rule' };

  async function setup(answers: Record<string, string>, answersAsks = false): Promise<void> {
    writeUser([guard({ id: 'user-allow', event: 'permission.request' })]);
    const folder = join(dir, 'proj');
    mkdirSync(join(folder, '.nova'), { recursive: true });
    writeFileSync(
      join(folder, '.nova', 'hooks.json'),
      JSON.stringify({ hooks: [guard({ id: 'project-hook', event: 'permission.request' })] }),
    );
    addFolder('f1', PROJECT, folder);
    await svc.registerPluginHooks(ACCOUNT, {
      pluginId: 'p1',
      root: join(dir, 'work'),
      hooks: [guard({ id: 'plugin-hook', event: 'permission.request' })],
      limits: { answersAsks },
    });
    await trustAll();
    sandbox.answer = (stdin) => ({
      output: answers[(JSON.parse(stdin) as { hookId: string }).hookId] ?? '',
    });
  }

  it('lets a user hook answer an ask from a rule or tool default', async () => {
    await setup({ 'user-allow': '{"decision":"allow"}' });
    const out = await svc.dispatch('permission.request', input({ decision: ask }), signal());
    // The decision says where the hook came from, so the gate can check who may answer.
    expect(out.decision).toMatchObject({
      effect: 'allow',
      hookId: 'hook:user.user-allow',
      source: 'user',
      pluginId: null,
    });
    const fromDefault = await svc.dispatch(
      'permission.request',
      input({ decision: { ...ask, source: 'tool_default' } }),
      signal(),
    );
    expect(fromDefault.decision?.effect).toBe('allow');
    const fromPlugin = await svc.dispatch(
      'permission.request',
      input({ decision: { ...ask, source: 'plugin' } }),
      signal(),
    );
    expect(fromPlugin.decision?.effect).toBe('allow');
  });

  it('never loosens a deny, built-in safety, managed policy or the approval policy', async () => {
    await setup({ 'user-allow': '{"decision":"allow"}' });
    for (const decision of [
      { effect: 'deny' as const, reason: 'no', source: 'rule' },
      { effect: 'ask' as const, reason: 'safety', source: 'builtin' },
      { effect: 'ask' as const, reason: 'org', source: 'managed' },
      { effect: 'ask' as const, reason: 'policy', source: 'approval_policy' },
      { effect: 'handoff' as const, reason: 'hand', source: 'builtin' },
    ]) {
      const out = await svc.dispatch('permission.request', input({ decision }), signal());
      expect(out.decision).toBeUndefined();
    }
  });

  it('ignores allows from project hooks and from plugins without answersAsks; any deny wins', async () => {
    await setup({ 'project-hook': '{"decision":"allow"}', 'plugin-hook': '{"decision":"allow"}' });
    const none = await svc.dispatch(
      'permission.request',
      input({ projectId: PROJECT, decision: ask }),
      signal(),
    );
    expect(none.decision).toBeUndefined();
    sandbox.answer = (stdin) => ({
      output:
        (JSON.parse(stdin) as { hookId: string }).hookId === 'project-hook'
          ? '{"decision":"deny"}'
          : '{"decision":"allow"}',
    });
    const denied = await svc.dispatch(
      'permission.request',
      input({ projectId: PROJECT, decision: ask }),
      signal(),
    );
    expect(denied.decision).toMatchObject({
      effect: 'deny',
      reason: 'hook project-hook denied this call',
    });
  });

  it('lets a plugin hook answer when its manifest says answersAsks', async () => {
    await setup({ 'plugin-hook': '{"decision":"allow"}' }, true);
    const out = await svc.dispatch('permission.request', input({ decision: ask }), signal());
    expect(out.decision).toMatchObject({ effect: 'allow', source: 'plugin', pluginId: 'p1' });
  });

  it('denies when a permission hook fails', async () => {
    await setup({});
    sandbox.answer = () => ({ output: 'nope' });
    const out = await svc.dispatch('permission.request', input({ decision: ask }), signal());
    expect(out.decision?.effect).toBe('deny');
  });
});

describe('mcp_tool hooks', () => {
  let gateCalls: GateRequest[];
  let gateEffect: GateOutcome['effect'];
  let mcpCalls: { name: string; args: Record<string, unknown> }[];
  let mcpResult: ToolResult;
  let nested: unknown;

  beforeEach(async () => {
    gateCalls = [];
    gateEffect = 'allow';
    mcpCalls = [];
    mcpResult = { ok: true, content: [{ type: 'text', text: '{"context":"guard says ok"}' }] };
    nested = null;
    const gate: ToolGate = {
      check: async (req) => {
        gateCalls.push(req);
        // A permission hook wired into the gate would land here: hooks never fire hooks.
        nested = await svc.dispatch(
          'permission.request',
          input({ decision: { effect: 'ask', reason: 'r', source: 'rule' } }),
          signal(),
        );
        return gateEffect === 'allow'
          ? { effect: 'allow', reason: 'ok', tier: 'pre_approvable' }
          : { effect: 'deny', reason: 'blocked by rule', tier: 'pre_approvable', stop: false };
      },
      preview: () => Promise.reject(new Error('unused')),
    };
    const mcp: HookMcpClient = {
      find: (_a, name) => (name === 'mcp:guard.check' ? tool(name) : null),
      call: (_a, name, args) => {
        mcpCalls.push({ name, args });
        return Promise.resolve(mcpResult);
      },
    };
    svc = makeService({ gate, mcp });
    writeUser([
      guard({
        id: 'mcp-guard',
        handler: {
          type: 'mcp_tool',
          tool: 'mcp:guard.check',
          arguments: { mode: 'strict', event: 'masked' },
        },
      }),
      guard({
        id: 'mcp-perm',
        event: 'permission.request',
        handler: { type: 'mcp_tool', tool: 'mcp:guard.check' },
      }),
    ]);
    await trustAll();
  });

  it('passes the gate with origin hook and calls the tool with the event', async () => {
    const out = await svc.dispatch('tool.pre', input(), signal());
    expect(out.context.map((c) => c.text)).toEqual(['guard says ok']);
    expect(gateCalls[0]).toMatchObject({
      origin: 'hook',
      tool: { name: 'mcp:guard.check' },
      provenance: { taint: ['tool'] },
    });
    expect(mcpCalls[0]!.args).toMatchObject({
      mode: 'strict',
      event: 'tool.pre',
      tool: 'exec.run',
    });
    expect(nested).toEqual({ context: [] });
  });

  it('reads a structured result', async () => {
    mcpResult = {
      ok: true,
      content: [],
      meta: { structuredContent: { block: { reason: 'prod' } } },
    };
    expect((await svc.dispatch('tool.pre', input(), signal())).block?.reason).toBe('prod');
  });

  it('fails closed when the gate refuses, the tool errors or is missing', async () => {
    gateEffect = 'deny';
    expect((await svc.dispatch('tool.pre', input(), signal())).block?.reason).toMatch(
      /blocked by rule/,
    );
    expect(mcpCalls).toHaveLength(0);
    gateEffect = 'allow';
    mcpResult = { ok: false, error: { code: 'mcp.tool_error', message: 'down' } };
    expect((await svc.dispatch('tool.pre', input(), signal())).block?.reason).toMatch(/down/);
    const perm = await svc.dispatch(
      'permission.request',
      input({ decision: { effect: 'ask', reason: 'r', source: 'rule' } }),
      signal(),
    );
    expect(perm.decision?.effect).toBe('deny');
    writeUser([guard({ id: 'mcp-guard', handler: { type: 'mcp_tool', tool: 'mcp:gone.check' } })]);
    await trustAll();
    expect((await svc.dispatch('tool.pre', input(), signal())).block?.reason).toMatch(
      /no connected MCP tool/,
    );
  });

  it('cannot run without the gate', async () => {
    const noGate = makeService({
      mcp: { find: () => tool('mcp:guard.check'), call: () => Promise.resolve(mcpResult) },
    });
    expect((await noGate.dispatch('tool.pre', input(), signal())).block?.reason).toMatch(
      /policy gate/,
    );
  });
});

describe('plugin hooks', () => {
  it('previews hashes that match the installed copy, and trusts what was shown', async () => {
    const src = join(dir, 'src');
    const installed = join(dir, 'installed');
    for (const d of [src, installed]) {
      mkdirSync(join(d, 'hooks'), { recursive: true });
      writeFileSync(join(d, 'hooks', 'check.sh'), 'echo {}');
      writeFileSync(
        join(d, 'hooks', 'hooks.json'),
        JSON.stringify({
          hooks: [
            guard({
              id: 'check',
              handler: {
                type: 'command',
                command: ['sh', '${pluginRoot}/hooks/check.sh'],
                network: ['api.github.com', 'evil.example'],
              },
            }),
            guard({ id: 'later', event: 'tool.post' }),
          ],
        }),
      );
    }
    const preview = svc.previewPluginHooks({
      pluginId: 'dev',
      root: src,
      hooks: 'hooks/hooks.json',
    });
    expect(preview.items.map((h) => h.id)).toEqual(['hook:dev.check', 'hook:dev.later']);
    const reg = await svc.registerPluginHooks(ACCOUNT, {
      pluginId: 'dev',
      root: installed,
      hooks: 'hooks/hooks.json',
      limits: { network: ['api.github.com'], fsProject: false },
      trust: [{ id: preview.items[0]!.id, contentHash: preview.items[0]!.contentHash }],
    });
    expect(reg.items.map((h) => [h.status, h.contentHash])).toEqual([
      ['trusted', preview.items[0]!.contentHash],
      ['needs_trust', preview.items[1]!.contentHash],
    ]);
    sandbox.answer = () => ({ output: '' });
    await svc.dispatch('tool.pre', input(), signal());
    const run = sandbox.runs[0]!;
    expect(run.req.cmd).toContain(`'${join(installed, 'hooks', 'check.sh')}'`);
    expect(run.req.cwd).toBe(installed);
    expect(run.req.roots).toEqual([{ path: installed, access: 'read', label: 'Hook folder' }]);
    expect(run.req.network).toBe('allowlist');
    expect(JSON.parse(run.stdin)).toMatchObject({ cwd: installed });

    // Editing the installed script needs re-trust.
    writeFileSync(join(installed, 'hooks', 'check.sh'), 'echo \'{"block":{"reason":"x"}}\'');
    expect(
      (await svc.list(ACCOUNT)).find((h) => h.pluginId === 'dev' && h.event === 'tool.pre')?.status,
    ).toBe('needs_trust');
  });

  it('follows the plugin when it is disabled or removed, and reports a missing hooks file', async () => {
    await svc.registerPluginHooks(ACCOUNT, { pluginId: 'p', root: dir, hooks: [guard()] });
    await trustAll();
    await svc.setPluginHooksEnabled(ACCOUNT, 'p', false);
    await svc.dispatch('tool.pre', input(), signal());
    expect(events.events.at(-1)).toMatchObject({
      name: 'hook.skipped',
      payload: { reason: 'disabled' },
    });
    await svc.setPluginHooksEnabled(ACCOUNT, 'p', true);
    expect((await svc.list(ACCOUNT))[0]!.status).toBe('trusted');
    await svc.removePluginHooks(ACCOUNT, 'p');
    expect(await svc.list(ACCOUNT)).toEqual([]);
    const missing = await svc.registerPluginHooks(ACCOUNT, {
      pluginId: 'q',
      root: dir,
      hooks: 'nope.json',
    });
    expect(missing.errors[0]).toMatch(/does not exist/);
    expect(svc.previewPluginHooks({ pluginId: 'q', root: dir, hooks: undefined }).items).toEqual(
      [],
    );
  });
});

describe('plugin hooks from the plugins area', () => {
  type Listener = (c: {
    accountId: string;
    pluginId: string;
    change: 'installed' | 'updated' | 'enabled' | 'disabled' | 'removed';
    trust: { id: string; contentHash: string }[];
  }) => void | Promise<void>;

  it('takes hooks and hashes from the feed and applies install-screen trust', async () => {
    let entries: {
      pluginId: string;
      hook: unknown;
      contentHash: string;
      root: string;
      pluginEnabled: boolean;
      answersAsks: boolean;
      network: string[];
    }[] = [];
    let listener: Listener | null = null;
    svc.usePluginHooks({
      list: () => Promise.resolve(entries),
      onChange: (l) => {
        listener = l;
        return () => (listener = null);
      },
    });
    const entry = (hash: string, enabled = true) => ({
      pluginId: 'com.example.dev',
      hook: guard({ id: 'lint' }),
      contentHash: hash,
      root: dir,
      pluginEnabled: enabled,
      answersAsks: true,
      network: [],
    });
    const hash1 = `sha256:${'1'.repeat(64)}`;
    entries = [entry(hash1), { ...entry(hash1), hook: { id: 'Bad' } }];
    await listener!({
      accountId: ACCOUNT,
      pluginId: 'com.example.dev',
      change: 'installed',
      trust: [{ id: 'hook:com.example.dev.lint', contentHash: hash1 }],
    });
    expect(await svc.list(ACCOUNT)).toMatchObject([
      { id: 'hook:com.example.dev.lint', status: 'trusted', contentHash: hash1 },
    ]);
    expect(await svc.untrustedPluginHooks(ACCOUNT, 'com.example.dev')).toBe(0);
    // An update with a new hash and no trust waits for the user.
    entries = [entry(`sha256:${'2'.repeat(64)}`)];
    await listener!({
      accountId: ACCOUNT,
      pluginId: 'com.example.dev',
      change: 'updated',
      trust: [],
    });
    expect(await svc.untrustedPluginHooks(ACCOUNT, 'com.example.dev')).toBe(1);
    entries = [entry(`sha256:${'2'.repeat(64)}`, false)];
    expect((await svc.list(ACCOUNT))[0]!.status).toBe('disabled');
    entries = [];
    expect(await svc.list(ACCOUNT)).toEqual([]);
    svc.close();
    expect(listener).toBeNull();
  });

  it('keeps plugin rows when the feed cannot be read', async () => {
    await svc.registerPluginHooks(ACCOUNT, { pluginId: 'p', root: dir, hooks: [guard()] });
    svc.usePluginHooks({ list: () => Promise.reject(new Error('busy')) });
    expect(await svc.list(ACCOUNT)).toHaveLength(1);
    svc.usePluginHooks(null);
  });
});

describe('without the hooks table', () => {
  it('does nothing, like noHooks', async () => {
    db.raw.exec('DROP TABLE hook');
    expect(await svc.dispatch('tool.pre', input(), signal())).toEqual(
      await noHooks.dispatch('tool.pre', input(), signal()),
    );
    expect(await svc.list(ACCOUNT)).toEqual([]);
    expect(
      (await svc.registerPluginHooks(ACCOUNT, { pluginId: 'p', root: dir, hooks: [] })).errors,
    ).toHaveLength(1);
  });
});
