// Interactive exec sessions (FR-184, docs/08 §1.1, docs/10 §4): ExecSessions records who started
// each running command, lists and kills them, carries the `exec.sessions` settings, and keeps a
// run's sessions past a turn that ended normally; exec tools read the settings and refuse
// another thread's session; the loop kills sessions on cancel, keeps a Work run's, and
// TurnStarter.cancel kills the thread's.
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '@nova/telemetry';
import {
  DEFAULT_EXEC_SESSION_SETTINGS,
  ExecSessions,
  MemoryEventSink,
  UnavailableSandbox,
  execTools,
  type AuditRecord,
  type BuiltinContext,
  type ExecOwner,
  type SandboxClient,
  type ToolResult,
} from '../src/index.ts';
import { ACCOUNT, waitFor } from './helpers.ts';
import { toolResultText } from './loop-env.ts';
import { FakeSandbox, callStep, makeM5Env, type M5Env } from './loop-m5-env.ts';

const OTHER = '01920000-0000-7000-8000-0000000000ff';

function owner(extra: Partial<ExecOwner> = {}): ExecOwner {
  return { accountId: ACCOUNT, threadId: 't1', turnId: 'turn-1', callId: 'call-1', ...extra };
}

function req(cmd: string, o: ExecOwner | null = owner()) {
  return {
    cmd,
    cwd: '/work',
    roots: [],
    network: 'off' as const,
    yieldMs: 10,
    signal: new AbortController().signal,
    ...(o ? { turnId: o.turnId, owner: o } : {}),
  };
}

function tracked(opts: { settings?: () => Promise<unknown> } = {}) {
  const inner = new FakeSandbox();
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const sessions = new ExecSessions(inner, {
    events,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    now: () => new Date('2026-10-17T12:00:00.000Z'),
    ...(opts.settings
      ? { settings: opts.settings as () => Promise<{ yieldMs: number; outputTokens: number }> }
      : {}),
  });
  return { inner, events, audit, sessions };
}

describe('ExecSessions', () => {
  it('records running commands with their owner and lists them per account and thread', async () => {
    const { sessions, events } = tracked();
    const r = await sessions.exec(req('serve --port 3000 API_KEY=supersecretvalue123'));
    expect(r.status).toBe('running');
    await sessions.exec(req('serve two', owner({ threadId: 't2' })));
    await sessions.exec(req('echo done'));
    await sessions.exec(req('serve other', owner({ accountId: OTHER })));
    // Commands without an owner (hooks, terminals) are not listed.
    await sessions.exec(req('serve hook', null));
    expect(sessions.list(ACCOUNT).map((s) => s.threadId)).toEqual(['t1', 't2']);
    const [one] = sessions.list(ACCOUNT, 't1');
    expect(one).toEqual({
      id: 's1',
      threadId: 't1',
      turnId: 'turn-1',
      callId: 'call-1',
      cmd: 'serve --port 3000 API_KEY=[REDACTED]',
      cwd: '/work',
      startedAt: '2026-10-17T12:00:00.000Z',
      retained: false,
    });
    expect(sessions.owner('s1')).toMatchObject({ threadId: 't1', retained: false });
    expect(sessions.owner('nope')).toBeNull();
    expect(events.events.filter((e) => e.name === 'exec.session.started')).toHaveLength(3);
    expect(events.events[0]).toMatchObject({
      correlation: { threadId: 't1', turnId: 'turn-1', callId: 'call-1' },
      payload: { sessionId: 's1', cmd: 'serve --port 3000 API_KEY=[REDACTED]' },
    });
  });

  it('forgets a session that exits, is terminated, or whose turn ends', async () => {
    const { sessions, inner, events } = tracked();
    await sessions.exec(req('serve a'));
    await sessions.exec(req('serve b'));
    await sessions.exec(req('serve c', owner({ turnId: 'turn-2' })));
    inner.sessions.get('s1')!.exited = 3;
    expect(await sessions.poll('s1', 0, new AbortController().signal)).toMatchObject({
      status: 'exited',
      exitCode: 3,
    });
    await sessions.write('s2', { signal: 'terminate' });
    await sessions.killTurn('turn-2');
    expect(sessions.list(ACCOUNT)).toEqual([]);
    expect(inner.killedTurns).toEqual(['turn-2']);
    expect(
      events.events.filter((e) => e.name === 'exec.session.ended').map((e) => e.payload),
    ).toEqual([
      { sessionId: 's1', threadId: 't1', reason: 'exited', exitCode: 3 },
      { sessionId: 's2', threadId: 't1', reason: 'terminated' },
      { sessionId: 's3', threadId: 't1', reason: 'turn_ended' },
    ]);
    // A poll of a session the sandbox lost forgets it too.
    await sessions.exec(req('serve d'));
    inner.sessions.delete('s4');
    await expect(sessions.poll('s4', 0, new AbortController().signal)).rejects.toThrow();
    expect(sessions.list(ACCOUNT)).toEqual([]);
  });

  it("keeps a retained turn's sessions for its thread until the thread's are killed", async () => {
    const { sessions, inner, audit } = tracked();
    await sessions.exec(req('serve a'));
    sessions.retainTurn('turn-1');
    // A turn without sessions is not remembered.
    sessions.retainTurn('turn-9');
    await sessions.killTurn('turn-1');
    expect(inner.killedTurns).toEqual([]);
    expect(sessions.list(ACCOUNT, 't1')).toMatchObject([{ id: 's1', retained: true }]);
    expect(await sessions.killThread(OTHER, 't1')).toBe(0);
    expect(await sessions.killThread(ACCOUNT, 't1')).toBe(1);
    expect(inner.killed).toEqual(['s1']);
    expect(sessions.list(ACCOUNT)).toEqual([]);
    expect(audit[0]).toMatchObject({
      actor: 'system',
      kind: 'tool_call',
      action: 'exec.session.kill',
      result: 'cancelled',
      threadId: 't1',
      detail: { sessionId: 's1', callId: 'call-1' },
    });
  });

  it("kills one session for its account only (the terminal pane's stop)", async () => {
    const { sessions, audit } = tracked();
    await sessions.exec(req('serve a'));
    expect(await sessions.kill(OTHER, 's1')).toBe(false);
    expect(await sessions.kill(ACCOUNT, 'missing')).toBe(false);
    expect(await sessions.kill(ACCOUNT, 's1')).toBe(true);
    expect(audit).toMatchObject([{ actor: 'user', result: 'killed' }]);
    // A session the sandbox already lost is still forgotten.
    expect(await sessions.kill(ACCOUNT, 's1')).toBe(false);
  });

  it('holds at most 8 open sessions per thread', async () => {
    const { sessions } = tracked();
    for (let i = 0; i < 8; i++) await sessions.exec(req(`serve ${i}`));
    await expect(sessions.exec(req('serve 9'))).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'too_many_sessions' },
    });
    // Another thread is not affected.
    expect((await sessions.exec(req('serve x', owner({ threadId: 't2' })))).status).toBe('running');
  });

  it('reads the exec.sessions settings, clamped, with defaults on failure', async () => {
    expect(await tracked().sessions.config()).toEqual(DEFAULT_EXEC_SESSION_SETTINGS);
    expect(
      await tracked({
        settings: () => Promise.resolve({ yieldMs: 5, outputTokens: 1e9 }),
      }).sessions.config(),
    ).toEqual({ yieldMs: 100, outputTokens: 50_000 });
    expect(
      await tracked({ settings: () => Promise.reject(new Error('db')) }).sessions.config(),
    ).toEqual(DEFAULT_EXEC_SESSION_SETTINGS);
  });

  it('passes through the substrate, availability and a full kill', async () => {
    const off = new ExecSessions(new UnavailableSandbox());
    expect(off.substrate).toBeNull();
    expect((await off.available()).ok).toBe(false);
    await expect(off.exec(req('ls'))).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    let all = 0;
    const inner: SandboxClient & { killAll(): Promise<void> } = Object.assign(new FakeSandbox(), {
      killAll: () => {
        all++;
        return Promise.resolve();
      },
    });
    const s = new ExecSessions(inner);
    await s.exec(req('serve a'));
    await s.killAll();
    expect(all).toBe(1);
    expect(s.list(ACCOUNT)).toEqual([]);
    expect(s.inner).toBe(inner);
  });
});

// ---- the exec tools over ExecSessions -------------------------------------------------------

function ctx(sandbox: SandboxClient, extra: Partial<BuiltinContext> = {}): BuiltinContext {
  return {
    accountId: ACCOUNT,
    threadId: 't1',
    turnId: 'turn-1',
    callId: 'c',
    projectId: null,
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [{ path: '/work', access: 'write', label: 'Workspace' }],
    sandbox,
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
    ...extra,
  };
}
const text = (r: ToolResult) =>
  r.ok ? r.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';

describe('exec tools with sessions', () => {
  it('use the yield time and output cap of the settings; the model may only lower the cap', async () => {
    const inner = new FakeSandbox();
    const sessions = new ExecSessions(inner, {
      settings: () => Promise.resolve({ yieldMs: 2_500, outputTokens: 500 }),
    });
    const [run] = execTools();
    await run!.handler({ cmd: `echo ${'z'.repeat(10_000)}` }, ctx(sessions));
    expect(inner.execs[0]!.yieldMs).toBe(2_500);
    const capped = await run!.handler({ cmd: `echo ${'z'.repeat(10_000)}` }, ctx(sessions));
    expect(text(capped).length).toBeLessThan(2_100);
    const lower = await run!.handler(
      { cmd: `echo ${'z'.repeat(10_000)}`, maxOutputTokens: 100 },
      ctx(sessions),
    );
    expect(text(lower).length).toBeLessThan(500);
    const higher = await run!.handler(
      { cmd: `echo ${'z'.repeat(10_000)}`, maxOutputTokens: 20_000 },
      ctx(sessions),
    );
    expect(text(higher).length).toBeLessThan(2_100);
    await run!.handler({ cmd: 'echo x', yieldMs: 50 }, ctx(sessions));
    expect(inner.execs.at(-1)!.yieldMs).toBe(50);
  });

  it("refuse another thread's session and allow a later turn once the run kept it", async () => {
    const sessions = new ExecSessions(new FakeSandbox());
    const [run, poll, write] = execTools();
    const started = await run!.handler({ cmd: 'serve' }, ctx(sessions, { callId: 'call-9' }));
    expect(text(started)).toContain('Still running (session s1)');
    expect(sessions.list(ACCOUNT)).toMatchObject([{ id: 's1', callId: 'call-9' }]);
    expect(
      await poll!.handler({ sessionId: 's1' }, ctx(sessions, { threadId: 't2' })),
    ).toMatchObject({ ok: false, error: { code: 'session_denied' } });
    expect(
      await write!.handler({ sessionId: 's1', text: 'q' }, ctx(sessions, { threadId: 't2' })),
    ).toMatchObject({ ok: false, error: { code: 'session_denied' } });
    expect(
      await poll!.handler({ sessionId: 's1' }, ctx(sessions, { accountId: OTHER })),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    // A later turn of the same thread: only after the run kept the session.
    const later = ctx(sessions, { turnId: 'turn-2' });
    expect(await poll!.handler({ sessionId: 's1' }, later)).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    sessions.retainTurn('turn-1');
    await sessions.killTurn('turn-1');
    const w = await write!.handler({ sessionId: 's1', text: 'status\n' }, later);
    expect(text(w)).toContain('got status');
    expect(text(await poll!.handler({ sessionId: 's1', yieldMs: 0 }, later))).toContain(
      'Still running',
    );
  });
});

// ---- the loop ------------------------------------------------------------------------------

describe('exec sessions in the loop', () => {
  let env: M5Env;
  afterEach(() => env.close());

  it('kills a chat turn’s sessions when the turn ends', async () => {
    env = await makeM5Env();
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/tool exec.run {"cmd":"serve"}' });
    await env.chat.idle();
    expect(toolResultText(env.mock.requests[1])).toContain('Still running (session s1)');
    expect(env.sessions!.list(ACCOUNT)).toEqual([]);
  });

  it("keeps a Work run's session for its next turn, and the run's cancel kills it", async () => {
    const sandbox = new FakeSandbox();
    env = await makeM5Env({ sandbox });
    const t = await env.threads.create(ACCOUNT, { mode: 'work' });
    const first = await env.chat.startTurn({
      accountId: ACCOUNT,
      threadId: t.id,
      text: '/tool exec.run {"cmd":"serve --dev"}',
      trigger: 'user',
      authority: { kind: 'user', source: 'run:r' },
      authorKind: 'run',
    });
    await first.done;
    expect(env.sessions!.list(ACCOUNT, t.id)).toMatchObject([
      { id: 's1', turnId: first.turnId, retained: true },
    ]);
    const second = await env.chat.startTurn({
      accountId: ACCOUNT,
      threadId: t.id,
      text: '/tool exec.write {"sessionId":"s1","text":"ping"}',
      trigger: 'user',
      authority: { kind: 'user', source: 'run:r' },
      authorKind: 'run',
    });
    await second.done;
    expect(toolResultText(env.mock.requests.at(-1))).toContain('got ping');
    await env.chat.turnStarter.cancel(ACCOUNT, t.id);
    expect(env.sessions!.list(ACCOUNT)).toEqual([]);
    expect(sandbox.killed).toContain('s1');
  });

  it('kills the sessions of a cancelled turn', async () => {
    const sandbox = new FakeSandbox();
    env = await makeM5Env({
      sandbox,
      mock: {
        timing: 'slow',
        scripts: [
          { when: 'start it', once: true, steps: callStep('c1', 'exec.run', { cmd: 'serve' }) },
          {
            when: 'start it',
            steps: [{ textChunks: 'a long answer that keeps going'.split(' ') }],
          },
        ],
      },
    });
    const t = await env.threads.create(ACCOUNT, { mode: 'work' });
    await env.chat.send(ACCOUNT, t.id, { text: 'start it' });
    await waitFor(() => env.mock.requests.length === 2);
    expect(env.sessions!.list(ACCOUNT)).toHaveLength(1);
    await env.chat.cancel(ACCOUNT, t.id);
    await env.chat.idle();
    expect(env.sessions!.list(ACCOUNT)).toEqual([]);
    expect(sandbox.killed).toEqual(['s1']);
  });

  it('a deleted thread takes its sessions with it', async () => {
    env = await makeM5Env();
    const t = await env.threads.create(ACCOUNT, { mode: 'code' });
    await env.chat.send(ACCOUNT, t.id, { text: '/tool exec.run {"cmd":"serve"}' });
    await env.chat.idle();
    expect(env.sessions!.list(ACCOUNT)).toHaveLength(1);
    await env.chat.deleteThread(ACCOUNT, t.id);
    expect(env.sessions!.list(ACCOUNT)).toEqual([]);
  });
});
