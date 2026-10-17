// Context compaction (FR-183, docs/09 §11): the record and summary helpers, the context tools'
// tracker, and the loop's triggers: pre-turn above the threshold, mid-turn when the next step
// would not fit (earlier results of the turn are left out), post-turn with nothing queued, and
// manual through context.fresh. A compaction is a `summary` item in the thread; the originals
// stay; later contexts start from the summary; compact.pre/post hooks run; a model writes the
// summary unless offline, and a failed request falls back to the extractive summary.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@nova/providers';
import {
  TurnContextTracker,
  cleanSummary,
  estimateRequestTokens,
  extractiveSummary,
  parseCompaction,
  transcriptText,
  type CompactionRecord,
} from '../src/index.ts';
import { ACCOUNT, waitFor } from './helpers.ts';
import { recordingGate, scriptedHooks, toolResultText, userText } from './loop-env.ts';
import { callStep, makeM5Env, turnRows, type M5Env } from './loop-m5-env.ts';

let env: M5Env | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** Set the model's context window (the mock reads its capabilities each step). */
function setLimit(e: M5Env, tokens: number): void {
  (e.mock.capabilities as { maxContextTokens: number }).maxContextTokens = tokens;
}

function compactions(e: M5Env, threadId: string) {
  return (
    e.db.raw
      .prepare(
        `SELECT m.id AS id, m.parent_id AS parentId, p.content AS content FROM message m
         JOIN message_part p ON p.message_id = m.id AND p.type = 'compaction'
         WHERE m.thread_id = ? AND m.role = 'summary' ORDER BY m.created_at, m.id`,
      )
      .all(threadId) as { id: string; parentId: string | null; content: string }[]
  ).map((r) => ({ ...r, rec: parseCompaction(r.content)! }));
}

function parentOf(e: M5Env, id: string): string | null {
  return (
    e.db.raw.prepare('SELECT parent_id AS p FROM message WHERE id = ?').get(id) as {
      p: string | null;
    }
  ).p;
}

describe('compaction records and summaries', () => {
  it('parses a record and treats unknown origins as tool data', () => {
    const rec = parseCompaction(
      JSON.stringify({
        trigger: 'mid_turn',
        tokensBefore: 10,
        tokensAfter: 4,
        summary: 'S',
        turnId: 't',
        elided: ['a', 3],
        taint: ['file', 'weird'],
        hooks: [{ hookId: 'h', text: 'x' }, { hookId: 1 }],
        method: 'model',
      }),
    );
    expect(rec).toMatchObject({
      trigger: 'mid_turn',
      summary: 'S',
      elided: ['a'],
      taint: ['file', 'tool'],
      hooks: [{ hookId: 'h', text: 'x' }],
      method: 'model',
      note: null,
    });
    expect(parseCompaction('nope')).toBeNull();
    expect(parseCompaction(JSON.stringify({ trigger: 'pre_turn' }))).toBeNull();
    expect(parseCompaction(JSON.stringify({ trigger: 'x', summary: 's' }))!.trigger).toBe('manual');
  });

  it('extracts a deterministic summary within its budget, newest lines kept', () => {
    const items = [
      { kind: 'summary' as const, text: 'before' },
      ...Array.from({ length: 200 }, (_, i) => ({
        kind: i % 2 ? ('assistant' as const) : ('user' as const),
        text: `message number ${i}\nwith a second line`,
      })),
      { kind: 'tool' as const, name: 'fs.read', text: 'file body' },
    ];
    const s = extractiveSummary(items, 'remember FOO', 2_000);
    expect(s.length).toBeLessThanOrEqual(2_000);
    expect(s).toContain('Earlier summary: before');
    expect(s).toContain('messages omitted');
    expect(s).toContain('- Tool fs.read: file body');
    expect(s).toContain('message number 199 with a second line');
    expect(s.endsWith('Handoff note: remember FOO')).toBe(true);
    expect(extractiveSummary(items, null, 2_000)).toBe(extractiveSummary(items, null, 2_000));
  });

  it('caps a transcript keeping its head and tail; a model summary keeps the note', () => {
    const t = transcriptText(
      [
        { kind: 'user', text: 'HEAD' },
        { kind: 'assistant', text: 'x'.repeat(5_000) },
        { kind: 'user', text: 'TAIL' },
      ],
      1_000,
    );
    expect(t.startsWith('[User]\nHEAD')).toBe(true);
    expect(t.endsWith('TAIL')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(1_000);
    expect(cleanSummary('  ', null)).toBeNull();
    expect(cleanSummary('Did A.', 'next: B')).toBe('Did A.\n\nHandoff note: next: B');
    expect(cleanSummary('Did A. next: B', 'next: B')).toBe('Did A. next: B');
  });

  it('estimates request tokens from text, calls, results, images and tools', () => {
    const n = estimateRequestTokens(
      [
        { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'c', name: 'fs.read', args: { path: 'a' } }],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              callId: 'c',
              content: [{ type: 'text', text: 'y'.repeat(400) }],
              untrusted: true,
            },
          ],
        },
        { role: 'user', content: [{ type: 'image', mime: 'image/png', data: 'AAAA' }] },
      ],
      [{ name: 'fs.read', description: 'd', inputSchema: {} }],
    );
    expect(n).toBe(Math.ceil((400 + 7 + 12 + 400 + 7 + 1 + 2) / 4) + 1_500);
  });
});

describe('the context tracker', () => {
  it('reports what is left and hands over a fresh request once', () => {
    const t = new TurnContextTracker();
    expect(t.remaining('turn', 'thread')).toBeNull();
    expect(t.requestFresh('turn', 'thread', 'n')).toBe(false);
    t.update('turn', 'thread', { tokens: 2_500, limit: 10_000, threshold: 0.8 });
    expect(t.remaining('turn', 'other')).toBeNull();
    expect(t.remaining('turn', 'thread')).toEqual({
      tokens: 2_500,
      limit: 10_000,
      threshold: 0.8,
      tokensLeft: 7_500,
      percentLeft: 75,
      compactAt: 8_000,
    });
    expect(t.takeFresh('turn')).toBeNull();
    expect(t.requestFresh('turn', 'thread', 'carry this')).toBe(true);
    // A later measurement keeps the pending request.
    t.update('turn', 'thread', { tokens: 3_000, limit: 10_000, threshold: 0.8 });
    expect(t.takeFresh('turn')).toBe('carry this');
    expect(t.takeFresh('turn')).toBeNull();
    t.end('turn');
    expect(t.remaining('turn', 'thread')).toBeNull();
  });
});

describe('pre-turn compaction', () => {
  it('summarizes older turns into an item above the turn; the originals stay', async () => {
    env = await makeM5Env({ noTools: true });
    setLimit(env, 200);
    const t = await env.threads.create(ACCOUNT, {});
    const first = await env.chat.send(ACCOUNT, t.id, { text: 'hello there' });
    await env.chat.idle();
    expect(compactions(env, t.id)).toHaveLength(0);
    const long = `please review ${'lorem ipsum '.repeat(70)}`;
    const second = await env.chat.send(ACCOUNT, t.id, { text: long });
    await env.chat.idle();

    const [c] = compactions(env, t.id);
    expect(c!.rec).toMatchObject({
      trigger: 'pre_turn',
      turnId: second.turnId,
      covered: 2,
      method: 'extractive',
      elided: [],
    });
    expect(c!.rec.summary).toContain('- User: hello there');
    expect(c!.rec.summary).toContain('- Assistant: You said: hello there');
    // In the tree just above the turn's user message, below the reply it follows.
    expect(c!.parentId).toBe(first.assistantMessageId);
    expect(parentOf(env, second.userMessageId)).toBe(c!.id);
    // The thread shows the item between the turns; nothing was removed.
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'summary',
      'user',
      'assistant',
    ]);
    expect(detail.messages[2]!.parts[0]).toMatchObject({
      type: 'compaction',
      trigger: 'pre_turn',
      summary: expect.any(String) as unknown,
      method: 'extractive',
    });
    // The model gets the summary instead of the older turns.
    const req = env.mock.requests[1]!;
    expect(req.messages.map((m) => m.role)).toEqual(['system', 'user']);
    const text = userText(req);
    expect(text).toContain('Earlier turns of this conversation were compacted');
    expect(text).toContain('- User: hello there');
    expect(text.indexOf('compacted')).toBeLessThan(text.indexOf('please review'));
    const ev = env.events.events.find((e) => e.name === 'compaction.completed');
    expect(ev?.payload).toMatchObject({
      threadId: t.id,
      turnId: second.turnId,
      itemId: c!.id,
      trigger: 'pre_turn',
      tokensBefore: c!.rec.tokensBefore,
      tokensAfter: c!.rec.tokensAfter,
    });
    expect(c!.rec.tokensAfter).toBe(estimateRequestTokens(req.messages, req.tools ?? undefined));
    expect(
      env.events.events.some(
        (e) => e.name === 'chat.message.created' && e.payload.role === 'summary',
      ),
    ).toBe(true);

    // The next turn folds the earlier summary into a new one above it.
    const third = await env.chat.send(ACCOUNT, t.id, { text: 'and now?' });
    await env.chat.idle();
    const all = compactions(env, t.id);
    expect(all).toHaveLength(2);
    expect(all[1]!.rec.summary).toContain('Earlier summary:');
    expect(all[1]!.rec.covered).toBe(2);
    expect(parentOf(env, third.userMessageId)).toBe(all[1]!.id);
    expect(env.mock.requests[2]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    // Edits of a compacted turn's message keep the item above them.
    const edited = await env.chat.edit(ACCOUNT, t.id, third.userMessageId, { text: 'edited' });
    await env.chat.idle();
    expect(parentOf(env, edited.userMessageId)).toBe(all[1]!.id);
  });

  it('runs compact.pre and compact.post; post context reaches the model as data', async () => {
    const hooks = scriptedHooks({
      'compact.post': () => ({ context: [{ text: 're-read PLAN.md', hookId: 'hook:user.plan' }] }),
    });
    env = await makeM5Env({ noTools: true, hooks });
    setLimit(env, 200);
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hello' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: 'words '.repeat(150) });
    await env.chat.idle();
    const events = hooks.calls.filter((c) => c.event.startsWith('compact.'));
    expect(events.map((c) => [c.event, c.input.subject])).toEqual([
      ['compact.pre', 'pre_turn'],
      ['compact.post', 'pre_turn'],
    ]);
    const [c] = compactions(env, t.id);
    expect(c!.rec.hooks).toEqual([{ hookId: 'hook:user.plan', text: 're-read PLAN.md' }]);
    expect(userText(env.mock.requests[1])).toMatch(
      /<untrusted_data source="hook:user.plan" id="[0-9a-f]{12}">\nre-read PLAN.md/,
    );
  });

  it('keeps the taint of what it summarized (FR-189)', async () => {
    const gate = recordingGate();
    env = await makeM5Env({ gate });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, {
      text: 'read this',
      attachments: [
        { name: 'a.txt', mime: 'text/plain', data: Buffer.from('note').toString('base64') },
      ],
    });
    await env.chat.idle();
    // Compact before the next turn.
    setLimit(env, 1_000);
    await env.chat.send(ACCOUNT, t.id, { text: '/tool fs.list {}' });
    await env.chat.idle();
    const [c] = compactions(env, t.id);
    expect(c!.rec.taint).toContain('file');
    expect(c!.rec.summary).toContain('[Attachment: a.txt]');
    expect(gate.requests.at(-1)!.provenance.taint).toContain('file');
  });
});

describe('post-turn compaction', () => {
  const longReply = { textChunks: ['word '.repeat(400)] };

  it('compacts after a turn that ends above the threshold', async () => {
    env = await makeM5Env({
      noTools: true,
      mock: { scripts: [{ when: 'long please', steps: [longReply] }] },
    });
    setLimit(env, 400);
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    const second = await env.chat.send(ACCOUNT, t.id, { text: 'long please' });
    await env.chat.idle();
    const [c] = compactions(env, t.id);
    expect(c!.rec).toMatchObject({ trigger: 'post_turn', turnId: second.turnId, covered: 2 });
    expect(parentOf(env, second.userMessageId)).toBe(c!.id);
    expect(turnRows(env, t.id)[1]!.status).toBe('completed');
  });

  it('does not compact after a turn while input is queued', async () => {
    env = await makeM5Env({
      noTools: true,
      mock: {
        timing: { chunkDelayMs: 5 },
        scripts: [
          {
            when: 'long please',
            steps: [{ textChunks: Array.from({ length: 50 }, () => 'word '.repeat(8)) }],
          },
        ],
      },
    });
    setLimit(env, 400);
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: 'long please' });
    await waitFor(() => env!.mock.requests.length === 2);
    await env.chat.send(ACCOUNT, t.id, { text: 'next', inputMode: 'queue' });
    await env.chat.idle();
    expect(compactions(env, t.id).map((c) => c.rec.trigger)).not.toContain('post_turn');
  });
});

describe('mid-turn compaction', () => {
  it('leaves out earlier results of the turn when the next step would not fit', async () => {
    env = await makeM5Env({
      mock: {
        scripts: [
          { when: 'read both', once: true, steps: callStep('c1', 'fs.read', { path: 'a.txt' }) },
          { when: 'read both', once: true, steps: callStep('c2', 'fs.read', { path: 'b.txt' }) },
        ],
      },
    });
    writeFileSync(join(env.workspace, 'a.txt'), 'A'.repeat(20_000));
    writeFileSync(join(env.workspace, 'b.txt'), 'B'.repeat(20_000));
    setLimit(env, 12_000);
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hello' });
    await env.chat.idle();
    const sent = await env.chat.send(ACCOUNT, t.id, { text: 'read both files' });
    await env.chat.idle();

    expect(env.mock.requests).toHaveLength(4);
    const [c] = compactions(env, t.id);
    expect(c!.rec.trigger).toBe('mid_turn');
    expect(c!.rec.covered).toBe(3);
    const firstStep = (await env.threads.detail(ACCOUNT, t.id)).messages.find(
      (m) =>
        m.role === 'assistant' &&
        m.turnId === sent.turnId &&
        m.parts.some((p) => p.type === 'tool_call' && p.argsPreview.includes('a.txt')),
    )!;
    expect(c!.rec.elided).toEqual([firstStep.id]);
    expect(c!.rec.tokensAfter).toBeLessThan(c!.rec.tokensBefore);
    // The third step: a.txt's result is compacted, b.txt's is whole; the calls still pair up.
    const third = env.mock.requests[3]!;
    const results = toolResultText(third);
    expect(results).toContain('This result was compacted');
    expect(results).not.toContain('AAAA');
    expect(results).toContain('BBBB');
    expect(third.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(estimateRequestTokens(third.messages, third.tools)).toBe(c!.rec.tokensAfter);
    // The summary covers the compacted result.
    expect(c!.rec.summary).toContain('- Tool fs.read: AAAA');
  });
});

describe('context.fresh and context.remaining', () => {
  it('compacts on request, carrying the handoff note', async () => {
    env = await makeM5Env();
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'the key is called FOO_TOKEN' });
    await env.chat.idle();
    env.runtime!.load(t.id, ['mcp:docs.search']);
    const sent = await env.chat.send(ACCOUNT, t.id, {
      text: '/tool context.fresh {"note":"Next: rotate FOO_TOKEN"}',
    });
    await env.chat.idle();
    const [c] = compactions(env, t.id);
    expect(c!.rec).toMatchObject({
      trigger: 'manual',
      note: 'Next: rotate FOO_TOKEN',
      turnId: sent.turnId,
      covered: 2,
    });
    expect(c!.rec.summary).toContain('Handoff note: Next: rotate FOO_TOKEN');
    expect(c!.rec.summary).toContain('the key is called FOO_TOKEN');
    expect(parentOf(env, sent.userMessageId)).toBe(c!.id);
    // The step after the call reads the summary; the tool said what would happen.
    const after = env.mock.requests[2]!;
    expect(userText(after)).toContain('Handoff note: Next: rotate FOO_TOKEN');
    expect(toolResultText(after)).toContain('The context will be compacted before your next step');
    // Tools loaded by tool.search are unloaded by a compaction (docs/08 §1.4).
    expect(env.runtime!.loaded(t.id)).toEqual([]);
    const ev = env.events.events.find((e) => e.name === 'compaction.completed');
    expect(ev?.payload).toMatchObject({ trigger: 'manual' });
  });

  it('reports the context left inside a turn', async () => {
    env = await makeM5Env();
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: '/tool context.remaining {}' });
    await env.chat.idle();
    const text = toolResultText(env.mock.requests[1]);
    expect(text).toMatch(/About \d+ of 32000 tokens are in use; \d+ \(\d+%\) are left/);
    expect(text).toContain('passes 25600 tokens (80%)');
    // Outside a turn (the UI) there is nothing to report.
    const r = await env.runtime!.invoke({
      accountId: ACCOUNT,
      name: 'context.remaining',
      args: {},
      threadId: t.id,
      initiator: 'user',
    });
    const done = await r.done;
    expect(done).toMatchObject({ ok: false, error: { code: 'no_turn' } });
  });

  it('uses the configured threshold', async () => {
    env = await makeM5Env({
      noTools: true,
      context: { compactThreshold: () => Promise.resolve(0.3) },
    });
    setLimit(env, 400);
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    // ~140 tokens: under 80 % of 400, over 30 %.
    await env.chat.send(ACCOUNT, t.id, { text: 'abcd '.repeat(80) });
    await env.chat.idle();
    expect(compactions(env, t.id).map((c) => c.rec.trigger)).toEqual(['pre_turn']);
  });
});

describe('the summary model', () => {
  async function remoteEnv(steps: ConstructorParameters<typeof MockProvider>[0]) {
    const remote = new MockProvider({ id: 'openai', ...steps });
    const hooks = scriptedHooks({
      'compact.pre': () => ({ context: [{ text: 'keep file paths', hookId: 'hook:user.keep' }] }),
    });
    const e = await makeM5Env({
      noTools: true,
      hooks,
      factory: ({ row }) => (row.provider === 'openai' ? remote : undefined),
    });
    const acc = await e.registry.create(ACCOUNT, {
      provider: 'openai',
      label: 'remote',
      apiKey: 'sk-test-0123456789abcdefghij',
    });
    (remote.capabilities as { maxContextTokens: number }).maxContextTokens = 200;
    const t = await e.threads.create(ACCOUNT, { model: `${acc.id}/mock-fast` });
    return { e, remote, t };
  }

  it('asks the turn model for the summary and records its usage', async () => {
    const r = await remoteEnv({
      scripts: [
        {
          when: 'Summarize this conversation',
          steps: [{ textChunks: ['The user said hello; ', 'nothing is open.'] }],
        },
      ],
    });
    env = r.e;
    // No memory extraction: the turn's only extra request is the summary.
    env.settings.memoryEnabled = false;
    await env.chat.send(ACCOUNT, r.t.id, { text: 'hello' });
    await env.chat.idle();
    const second = await env.chat.send(ACCOUNT, r.t.id, { text: 'more words '.repeat(70) });
    await env.chat.idle();
    const [c] = compactions(env, r.t.id);
    expect(c!.rec).toMatchObject({
      method: 'model',
      summary: 'The user said hello; nothing is open.',
    });
    const ask = r.remote.requests.find((q) => userText(q).includes('Summarize this conversation'))!;
    expect(userText(ask)).toContain('(hook:user.keep) keep file paths');
    expect(userText(ask)).toContain('[User]\nhello');
    const usage = env.db.raw
      .prepare('SELECT count(*) AS n FROM usage_event WHERE turn_id = ?')
      .get(second.turnId) as { n: number };
    expect(usage.n).toBe(2);
  });

  it('falls back to the extractive summary when the request fails', async () => {
    const r = await remoteEnv({
      scripts: [
        {
          when: 'Summarize this conversation',
          steps: [
            {
              type: 'stop',
              reason: 'error',
              error: { code: 'provider_error', message: 'boom', retryable: false },
            },
          ],
        },
      ],
    });
    env = r.e;
    await env.chat.send(ACCOUNT, r.t.id, { text: 'hello' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, r.t.id, { text: 'more words '.repeat(70) });
    await env.chat.idle();
    const [c] = compactions(env, r.t.id);
    const rec: CompactionRecord = c!.rec;
    expect(rec.method).toBe('extractive');
    expect(rec.summary).toContain('- User: hello');
  });
});
