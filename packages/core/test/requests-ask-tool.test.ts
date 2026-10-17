// `ask_user` (FR-188): asked through the broker in Work and Code threads only, the answer comes
// back labelled as the user's, an unanswered question ends like an approval timeout, a cancelled
// turn withdraws it, and the gate lets the question itself through without a card.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluate } from '@nova/policy';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { MemoryEventSink } from '../src/events.ts';
import { RequestService, requestToolSource, userAskTool } from '../src/requests/index.ts';
import type { AskInput, AskResult, RequestBroker } from '../src/runtime/types.ts';
import type { ToolContext, ToolResult } from '../src/tools/types.ts';
import { openRequestsDb } from './requests-db.ts';

const ACCOUNT = '01920000-0000-7000-8000-000000000001';
const WORK = '01920000-0000-7000-8000-0000000000a1';
const CHAT = '01920000-0000-7000-8000-0000000000a2';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    accountId: ACCOUNT,
    threadId: WORK,
    turnId: 'turn-1',
    callId: 'call-1',
    projectId: 'proj-1',
    origin: 'model',
    profile: { id: 'workspace', hash: 'h' },
    roots: [],
    sandbox: {} as never,
    signal: new AbortController().signal,
    log: new Logger({ module: 'test', sinks: [] }),
    ...over,
  };
}

function fakeBroker(result: AskResult) {
  const asked: AskInput[] = [];
  const broker: RequestBroker = {
    ask: (input) => {
      asked.push(input);
      return Promise.resolve(result);
    },
  };
  return { broker, asked };
}

const modes: Record<string, string> = { [WORK]: 'work', [CHAT]: 'chat' };
const threadMode = (_a: string, id: string) => Promise.resolve(modes[id] ?? null);
const text = (r: ToolResult) => (r.ok ? (r.content[0] as { text: string }).text : r.error.message);

describe('ask_user', () => {
  it('asks the user through the broker and returns the answer as theirs', async () => {
    const { broker, asked } = fakeBroker({
      status: 'resolved',
      result: { text: 'Use dev' },
      by: 'user',
    });
    const tool = userAskTool({
      broker,
      threadMode,
      timeoutMs: (projectId) => Promise.resolve(projectId === 'proj-1' ? 600_000 : 1),
      runOf: (turnId) => (turnId === 'turn-1' ? 'run-1' : null),
    });
    const r = await tool.handler(
      { question: ' Which branch? ', choices: ['main', ' dev ', 'main', ''], multiline: true },
      ctx(),
    );
    expect(r).toMatchObject({ ok: true, meta: { answeredBy: 'user', userAnswer: true } });
    expect(text(r)).toBe('The user answered: Use dev');
    expect(asked).toEqual([
      {
        accountId: ACCOUNT,
        kind: 'user_input',
        correlation: { threadId: WORK, turnId: 'turn-1', callId: 'call-1', runId: 'run-1' },
        payload: { question: 'Which branch?', choices: ['main', 'dev'], multiline: true },
        timeoutMs: 600_000,
      },
    ]);
    expect(tool.origin).toBeNull();
  });

  it('reports a choice, a timeout and a cancelled turn', async () => {
    const chose = userAskTool({
      ...fakeBroker({ status: 'resolved', result: { choice: 'dev' }, by: 'user' }),
      threadMode,
    });
    expect(text(await chose.handler({ question: 'q' }, ctx()))).toBe('The user chose: dev');
    const expired = userAskTool({ ...fakeBroker({ status: 'expired' }), threadMode });
    expect(await expired.handler({ question: 'q' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'approval_timeout' },
    });
    const cancelled = userAskTool({ ...fakeBroker({ status: 'cancelled' }), threadMode });
    expect(await cancelled.handler({ question: 'q' }, ctx())).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  it('is only for Work and Code threads, and needs a question', async () => {
    const { broker, asked } = fakeBroker({ status: 'expired' });
    const tool = userAskTool({ broker, threadMode });
    expect(await tool.handler({ question: 'q' }, ctx({ threadId: CHAT }))).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(await tool.handler({ question: 'q' }, ctx({ threadId: '' }))).toMatchObject({
      ok: false,
    });
    const failing = userAskTool({ broker, threadMode: () => Promise.reject(new Error('db')) });
    expect((await failing.handler({ question: 'q' }, ctx())).ok).toBe(false);
    expect(await tool.handler({ question: '  ' }, ctx())).toMatchObject({
      error: { code: 'invalid_arguments' },
    });
    expect(asked).toEqual([]);
  });

  it('waits 24 h by default, or when the setting cannot be read', async () => {
    const { broker, asked } = fakeBroker({ status: 'expired' });
    await userAskTool({ broker, threadMode }).handler({ question: 'q' }, ctx({ turnId: '' }));
    await userAskTool({
      broker,
      threadMode,
      timeoutMs: () => Promise.reject(new Error('settings down')),
    }).handler({ question: 'q' }, ctx());
    expect(asked.map((a) => a.timeoutMs)).toEqual([86_400_000, 86_400_000]);
    expect(asked[0]!.correlation).toEqual({ threadId: WORK, callId: 'call-1' });
  });

  it('passes the policy gate without a card, even with no typed instruction', () => {
    const tool = userAskTool({ ...fakeBroker({ status: 'expired' }), threadMode });
    const d = evaluate({
      actor: { kind: 'agent', id: 'work' },
      scopes: [{ kind: 'global' }],
      approvalPolicy: { kind: 'ask_always' },
      permissionProfile: { id: 'workspace', hash: 'h' },
      provenance: { taint: ['tool'] },
      tool: tool.descriptor,
      environment: { kind: 'hub', trusted: true, substrate: null },
      fs: { entries: [] },
    });
    expect(d.effect).toBe('allow');
    expect(tool.descriptor.timeoutMs).toBeGreaterThan(7 * 86_400_000);
  });

  it('is offered by the request tool source', async () => {
    const tool = userAskTool({ ...fakeBroker({ status: 'expired' }), threadMode });
    const source = requestToolSource([tool]);
    expect(source.source).toBe('builtin');
    expect((await source.list(ACCOUNT)).map((t) => t.descriptor.name)).toEqual(['ask_user']);
    // A turn's listing offers it in Work and Code threads only; a chat asks in its reply.
    for (const mode of ['work', 'code'] as const)
      expect(await source.list(ACCOUNT, { threadId: 't', mode })).toHaveLength(1);
    expect(await source.list(ACCOUNT, { threadId: 't', mode: 'chat' })).toEqual([]);
  });
});

describe('ask_user with the real broker', () => {
  let db: NovaDatabase;
  let svc: RequestService;

  beforeEach(async () => {
    db = await openRequestsDb();
    const now = new Date().toISOString();
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(ACCOUNT, now, now);
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'work', 'streaming', ?, ?)",
      )
      .run(WORK, ACCOUNT, now, now);
    svc = new RequestService({ db, events: new MemoryEventSink() });
  });
  afterEach(async () => {
    await svc.close();
    db.close();
  });

  it('waits for the answer typed in a client, and withdraws the question when the turn is cancelled', async () => {
    const tool = userAskTool({ broker: svc, threadMode });
    const pending = tool.handler({ question: 'Ship it?', choices: ['yes', 'no'] }, ctx());
    await vi.waitFor(async () => expect(await svc.list(ACCOUNT)).toHaveLength(1));
    const [req] = await svc.list(ACCOUNT);
    expect(req).toMatchObject({ kind: 'user_input', payload: { question: 'Ship it?' } });
    await svc.respond(ACCOUNT, req!.id, { choice: 'yes' });
    expect(text(await pending)).toBe('The user chose: yes');

    const ac = new AbortController();
    const second = tool.handler({ question: 'Again?' }, ctx({ signal: ac.signal }));
    await vi.waitFor(async () => expect(await svc.list(ACCOUNT)).toHaveLength(1));
    ac.abort();
    expect(await second).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });
});
