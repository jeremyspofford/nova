// Lifecycle hooks in the agent loop (FR-197, docs/09 §2, docs/08 §4.1) with a scripted
// dispatcher: session.start on a thread's first turn, prompt.submit context and blocks, tool.pre
// blocks and context, tool.post context, one stop continuation per stop as a `hook` turn with no
// user authorization, the backstop the chain shares, interrupt on cancel, and fail-closed rules.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_STEPS, type ToolRuntime } from '../src/index.ts';
import { ACCOUNT, toolCards, waitFor } from './helpers.ts';
import {
  makeLoopEnv,
  mcpTool,
  recordingGate,
  scriptedHooks,
  toolResultText,
  userText,
  type LoopEnv,
} from './loop-env.ts';

let env: LoopEnv;
afterEach(() => env.close());

const turns = (threadId: string) =>
  env.db.raw
    .prepare(
      'SELECT id, idx, status, trigger, trigger_ref AS triggerRef, stop_reason AS stopReason, step_count AS steps FROM turn WHERE thread_id = ? ORDER BY idx',
    )
    .all(threadId) as {
    id: string;
    idx: number;
    status: string;
    trigger: string;
    triggerRef: string | null;
    stopReason: string;
    steps: number;
  }[];

describe('session.start and prompt.submit (FR-197)', () => {
  it('runs session.start on the first turn only; context joins the turn, labelled', async () => {
    const hooks = scriptedHooks({
      'session.start': () => ({ context: [{ text: 'repo uses pnpm', hookId: 'hook:user.env' }] }),
      'prompt.submit': (i) => ({
        context: [{ text: `ticket for: ${i.prompt ?? ''}`, hookId: 'hook:user.ticket' }],
      }),
    });
    env = await makeLoopEnv({ hooks });
    const t = await env.threads.create(ACCOUNT, {});
    const first = await env.chat.send(ACCOUNT, t.id, { text: 'hello there' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: 'second' });
    await env.chat.idle();

    const events = hooks.calls.map((c) => c.event);
    expect(events.filter((e) => e === 'session.start')).toHaveLength(1);
    expect(events.filter((e) => e === 'prompt.submit')).toHaveLength(2);
    const start = hooks.calls.find((c) => c.event === 'session.start')!;
    expect(start.input).toMatchObject({
      accountId: ACCOUNT,
      threadId: t.id,
      turnId: first.turnId,
      projectId: null,
      subject: 'new',
      cwd: env.workspace,
    });
    expect(hooks.calls.find((c) => c.event === 'prompt.submit')!.input.prompt).toBe('hello there');

    // The context is in the first turn's request, inside envelopes labelled with each hook.
    const text = userText(env.mock.requests[0]);
    expect(text).toMatch(/<untrusted_data source="hook:user.env" id="[0-9a-f]{12}">/);
    expect(text).toContain('repo uses pnpm');
    expect(text).toMatch(/<untrusted_data source="hook:user.ticket"/);
    expect(text).toContain('ticket for: hello there');
    expect(text.indexOf('hello there')).toBeLessThan(text.indexOf('repo uses pnpm'));
    // The user's message shows what they typed; hook context is not a mention.
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages[0]!.parts).toEqual([{ type: 'text', text: 'hello there' }]);
    expect(detail.messages[0]!.mentions ?? []).toEqual([]);
  });

  it('a prompt.submit block ends the turn with the reason and calls no model', async () => {
    const hooks = scriptedHooks({
      'prompt.submit': () => ({
        context: [],
        block: { reason: 'no secrets in prompts', hookId: 'hook:user.guard' },
      }),
    });
    env = await makeLoopEnv({ hooks });
    const t = await env.threads.create(ACCOUNT, {});
    const sent = await env.chat.send(ACCOUNT, t.id, { text: 'my password is hunter2' });
    await env.chat.idle();
    expect(env.mock.requests).toHaveLength(0);
    const detail = await env.threads.detail(ACCOUNT, t.id);
    const reply = detail.messages[1]!;
    expect(reply.status).toBe('error');
    expect(reply.parts).toEqual([
      {
        type: 'error',
        code: 'hook_blocked',
        message: 'A hook blocked this message: no secrets in prompts',
      },
    ]);
    expect(turns(t.id)[0]).toMatchObject({
      id: sent.turnId,
      status: 'failed',
      stopReason: 'error',
    });
    const usage = env.db.raw
      .prepare('SELECT count(*) AS n FROM usage_event WHERE turn_id = ?')
      .get(sent.turnId) as { n: number };
    expect(usage.n).toBe(0);
    // No stop hooks for a turn that never answered.
    expect(hooks.calls.map((c) => c.event)).not.toContain('stop');
  });

  it('stores hook output redacted', async () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const hooks = scriptedHooks({
      'prompt.submit': () => ({ context: [{ text: `use ${key}`, hookId: 'hook:user.leaky' }] }),
    });
    env = await makeLoopEnv({ hooks, noTools: true });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    const rows = env.db.raw
      .prepare("SELECT content FROM message_part WHERE type = 'context'")
      .all() as { content: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).not.toContain('abcdefghijklmnop');
    expect(userText(env.mock.requests[0])).not.toContain('abcdefghijklmnop');
  });

  it('a failing dispatcher has no effect on the prompt', async () => {
    env = await makeLoopEnv({
      hooks: { dispatch: () => Promise.reject(new Error('hooks down')) },
    });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'still works' });
    await env.chat.idle();
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages[1]!.parts).toEqual([{ type: 'text', text: 'You said: still works' }]);
  });

  it('regenerating submits nothing new: no prompt.submit hooks', async () => {
    const hooks = scriptedHooks();
    env = await makeLoopEnv({ hooks });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'once' });
    await env.chat.idle();
    const detail = await env.threads.detail(ACCOUNT, t.id);
    await env.chat.regenerate(ACCOUNT, t.id, detail.messages[1]!.id);
    await env.chat.idle();
    expect(hooks.calls.filter((c) => c.event === 'prompt.submit')).toHaveLength(1);
    expect(hooks.calls.filter((c) => c.event === 'stop')).toHaveLength(2);
  });
});

describe('tool.pre and tool.post (FR-197)', () => {
  it('a tool.pre block refuses the call with the reason: denied card, no gate, no handler', async () => {
    let ran = 0;
    const gate = recordingGate();
    const hooks = scriptedHooks({
      'tool.pre': (i) =>
        i.tool?.name === 'mcp:db.drop_table'
          ? { context: [], block: { reason: 'no prod writes', hookId: 'hook:user.no-prod' } }
          : { context: [] },
    });
    env = await makeLoopEnv({
      hooks,
      gate,
      sources: [
        {
          source: 'mcp',
          list: () =>
            Promise.resolve([
              mcpTool('mcp:db.drop_table', () => {
                ran++;
                return Promise.resolve({ ok: true, content: [{ type: 'text', text: 'dropped' }] });
              }),
            ]),
        },
      ],
    });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/tool mcp:db.drop_table {"name":"users"}' });
    await env.chat.idle();

    expect(ran).toBe(0);
    expect(gate.requests).toHaveLength(0);
    const [card] = await toolCards(env, t.id);
    expect(card).toMatchObject({
      status: 'denied',
      error: 'A hook blocked this call: no prod writes',
    });
    const pre = hooks.calls.find((c) => c.event === 'tool.pre')!;
    expect(pre.input).toMatchObject({
      tool: { name: 'mcp:db.drop_table' },
      args: { name: 'users' },
      threadId: t.id,
      callId: expect.any(String),
      cwd: env.workspace,
    });
    expect(hooks.calls.map((c) => c.event)).not.toContain('tool.post');
    expect(toolResultText(env.mock.requests[1])).toContain(
      'Error (denied): A hook blocked this call: no prod writes',
    );
    expect(env.audit.at(-1)).toMatchObject({ action: 'mcp:db.drop_table', decision: 'deny' });
  });

  it('tool.pre and tool.post context travels with the result, labelled per hook', async () => {
    const hooks = scriptedHooks({
      'tool.pre': () => ({ context: [{ text: 'pre note', hookId: 'hook:user.pre' }] }),
      'tool.post': (i) => ({
        context: [{ text: `saw ${i.result ?? ''}`, hookId: 'hook:project.post' }],
      }),
    });
    env = await makeLoopEnv({ hooks });
    writeFileSync(join(env.workspace, 'n.txt'), 'file body');
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/tool fs.read {"path":"n.txt"}' });
    await env.chat.idle();

    const post = hooks.calls.find((c) => c.event === 'tool.post')!;
    expect(post.input).toMatchObject({ tool: { name: 'fs.read' }, result: 'file body' });
    const text = toolResultText(env.mock.requests[1]);
    expect(text).toMatch(/<untrusted_data source="fs.read"[^>]*>\nfile body\n/);
    expect(text).toMatch(/<untrusted_data source="hook:user.pre"[^>]*>\npre note\n/);
    expect(text).toMatch(/<untrusted_data source="hook:project.post"[^>]*>\nsaw file body\n/);
    expect(text.indexOf('pre note')).toBeLessThan(text.indexOf('saw file body'));
    // The card shows the tool's own result.
    const [card] = await toolCards(env, t.id);
    expect(card).toMatchObject({ status: 'ok', resultPreview: 'file body' });
  });

  it('a dispatcher that fails blocks tool.pre (fail closed) and leaves tool.post alone', async () => {
    let event = '';
    env = await makeLoopEnv({
      hooks: {
        dispatch: (e) => {
          event = e;
          return e === 'tool.pre'
            ? Promise.reject(new Error('down'))
            : Promise.resolve({ context: [] });
        },
      },
    });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/tool fs.list {}' });
    await env.chat.idle();
    const [card] = await toolCards(env, t.id);
    expect(card).toMatchObject({
      status: 'denied',
      error: 'A hook blocked this call: the tool hooks could not run',
    });
    expect(event).toBe('stop');
  });

  it('calls made by hooks fire no hooks', async () => {
    const hooks = scriptedHooks();
    env = await makeLoopEnv({ hooks });
    const runtime = env.runtime as ToolRuntime;
    const def = await runtime.registry.find(ACCOUNT, 'fs.list');
    const scope = await runtime.scopeFor(ACCOUNT, null, null);
    const out = await runtime.execute({
      accountId: ACCOUNT,
      threadId: null,
      turnId: null,
      projectId: null,
      mode: 'chat',
      origin: 'hook',
      def,
      name: 'fs.list',
      args: {},
      modelCallId: null,
      messageId: null,
      partIdx: 0,
      provenance: { taint: ['tool'] },
      scope,
      signal: new AbortController().signal,
      extras: {
        messageId: null,
        network: 'off',
        deny: [],
        cite: () => [],
        searchTools: () => [],
      },
    });
    expect(out.status).toBe('ok');
    expect(hooks.calls).toHaveLength(0);
  });
});

describe('stop continuations (FR-197, docs/09 §2 step 8b)', () => {
  it('one continuation per stop: the turn completes, a hook turn follows without user authority', async () => {
    let asked = 0;
    const gate = recordingGate();
    const hooks = scriptedHooks({
      stop: () =>
        asked++ === 0
          ? {
              context: [],
              continueWith: { prompt: '/tool fs.list {}', hookId: 'hook:user.keep-going' },
            }
          : { context: [] },
    });
    env = await makeLoopEnv({ hooks, gate });
    const t = await env.threads.create(ACCOUNT, {});
    const sent = await env.chat.send(ACCOUNT, t.id, { text: 'start' });
    await env.chat.idle();

    const rows = turns(t.id);
    expect(rows.map((r) => [r.idx, r.status, r.trigger, r.triggerRef])).toEqual([
      [0, 'completed', 'user', null],
      [1, 'completed', 'hook', 'hook:user.keep-going'],
    ]);
    expect(rows[0]!.id).toBe(sent.turnId);
    const stop = hooks.calls.find((c) => c.event === 'stop')!;
    expect(stop.input).toMatchObject({ turnId: sent.turnId, reply: 'You said: start' });
    // Hook turns get no session.start or prompt.submit.
    expect(hooks.calls.filter((c) => c.event === 'prompt.submit')).toHaveLength(1);

    // The continuation's input is labelled as a hook's, and its calls carry no user instruction.
    const second = env.mock.requests[1]!;
    expect(userText(second)).toContain(
      'A lifecycle hook asked you to continue (this is not a message from the user):\n/tool fs.list {}',
    );
    expect(gate.requests).toHaveLength(1);
    expect(gate.requests[0]!.provenance).toEqual({ taint: ['tool'] });
    const msg = env.db.raw
      .prepare(
        "SELECT author_kind AS a, provenance AS p FROM message WHERE turn_id = ? AND role = 'user'",
      )
      .get(rows[1]!.id) as { a: string; p: string };
    expect(msg).toEqual({ a: 'hook', p: 'tool' });
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages.filter((m) => m.role === 'user').map((m) => m.provenance)).toEqual([
      'typed',
      'hook',
    ]);
    const started = env.events.events.filter((e) => e.name === 'turn.started');
    expect(started.map((e) => e.payload.trigger)).toEqual(['user', 'hook']);
    const created = env.events.events.find(
      (e) => e.name === 'chat.message.created' && e.payload.provenance === 'hook',
    );
    expect(created?.payload).toMatchObject({ role: 'user', turnId: rows[1]!.id });
  });

  it('the chain shares the 200-step backstop: a hook that always continues is stopped', async () => {
    const hooks = scriptedHooks({
      stop: () => ({ context: [], continueWith: { prompt: 'more', hookId: 'hook:user.loop' } }),
    });
    env = await makeLoopEnv({ hooks, noTools: true });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'go' });
    await env.chat.idle();
    const rows = turns(t.id);
    expect(rows).toHaveLength(MAX_STEPS);
    expect(rows.every((r) => r.status === 'completed')).toBe(true);
    expect(rows.reduce((n, r) => n + r.steps, 0)).toBe(MAX_STEPS);
    expect(env.chat.isActive(t.id)).toBe(false);
  }, 30_000);

  it('a cancel stops the chain; input queued meanwhile runs after it', async () => {
    const hooks = scriptedHooks({
      stop: (i) =>
        i.reply?.includes('queued')
          ? { context: [] }
          : { context: [], continueWith: { prompt: 'again', hookId: 'hook:user.loop' } },
    });
    env = await makeLoopEnv({
      hooks,
      noTools: true,
      mock: { timing: { chunkDelayMs: 5 } },
    });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'go' });
    await waitFor(() => turns(t.id).length >= 2);
    const queued = await env.chat.send(ACCOUNT, t.id, { text: 'queued please' });
    expect(queued.disposition).toBe('queued');
    await waitFor(() => turns(t.id).length >= 4);
    await env.chat.cancel(ACCOUNT, t.id);
    await env.chat.idle();
    const rows = turns(t.id);
    const last = rows.at(-1)!;
    const before = rows.at(-2)!;
    // The chain stopped at the cancel; the queued message ran next, as its own user turn.
    expect(before).toMatchObject({ status: 'interrupted', trigger: 'hook' });
    expect(last).toMatchObject({ status: 'completed', trigger: 'user' });
    expect(rows.slice(1, -2).every((r) => r.trigger === 'hook' && r.status === 'completed')).toBe(
      true,
    );
    expect(hooks.calls.map((c) => c.event)).toContain('interrupt');
  });

  it('no stop hooks after a cancel; interrupt runs instead, outside the turn', async () => {
    const hooks = scriptedHooks();
    env = await makeLoopEnv({ hooks, noTools: true, mock: { timing: 'slow' } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'a long answer please' });
    await waitFor(() => env.mock.requests.length > 0);
    await env.chat.cancel(ACCOUNT, t.id);
    await env.chat.idle();
    const events = hooks.calls.map((c) => c.event);
    expect(events).toContain('interrupt');
    expect(events).not.toContain('stop');
    const interrupt = hooks.calls.find((c) => c.event === 'interrupt')!;
    expect(interrupt.signal.aborted).toBe(false);
    expect(interrupt.input.threadId).toBe(t.id);
  });
});

describe("MCP Apps' model context (FR-198)", () => {
  it('joins each turn as untrusted context with origin mcp, read once per turn', async () => {
    const asked: string[] = [];
    const gate = recordingGate();
    env = await makeLoopEnv({
      gate,
      appContext: (_a, threadId) => {
        asked.push(threadId);
        return Promise.resolve('Widget: 3 open pull requests');
      },
    });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/tool fs.list {}' });
    await env.chat.idle();
    expect(asked).toEqual([t.id]);
    for (const req of env.mock.requests) {
      const text = userText(req);
      expect(text).toMatch(
        /<untrusted_data source="mcp" id="[0-9a-f]{12}">\nWidget: 3 open pull requests\n/,
      );
    }
    // It is MCP output: the call it shaped carries the taint (FR-189).
    expect(gate.requests[0]!.provenance.taint).toEqual(['mcp']);
    // Not stored with the message: a later turn reads it afresh, the old one is gone.
    await env.chat.send(ACCOUNT, t.id, { text: 'next' });
    await env.chat.idle();
    expect(asked).toHaveLength(2);
    expect(userText(env.mock.requests.at(-1)).match(/Widget/g)).toHaveLength(1);
  });

  it('a failing or empty source adds nothing', async () => {
    env = await makeLoopEnv({ noTools: true, appContext: () => Promise.reject(new Error('down')) });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    expect(userText(env.mock.requests[0])).toBe('hi');
    await env.close();
    env = await makeLoopEnv({ noTools: true, appContext: () => Promise.resolve('  ') });
    const t2 = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t2.id, { text: 'hi' });
    await env.chat.idle();
    expect(userText(env.mock.requests[0])).toBe('hi');
  });
});
