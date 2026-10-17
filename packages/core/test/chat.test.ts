import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, NovaError } from '@nova/shared';
import type { ChatRequest, Provider, StreamEvent } from '@nova/providers';
import { ChatService, MemoryEventSink, prepareAttachments } from '../src/index.ts';
import { ACCOUNT, PNG, b64, makeEnv, waitFor, type Env } from './helpers.ts';

let env: Env;
afterEach(() => env.close());

const msgRow = (id: string) =>
  env.db.raw.prepare('SELECT * FROM message WHERE id = ?').get(id) as Record<string, unknown>;
const turnRow = (id: string) =>
  env.db.raw.prepare('SELECT * FROM turn WHERE id = ?').get(id) as Record<string, unknown>;
const textOf = (messageId: string, type = 'text') =>
  (
    env.db.raw
      .prepare('SELECT content FROM message_part WHERE message_id = ? AND type = ?')
      .get(messageId, type) as { content: string } | undefined
  )?.content;

describe('ChatService.send (FR-018)', () => {
  it('streams a reply in the background and records turn, messages, usage and events', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const res = await env.chat.send(ACCOUNT, t.id, { text: 'Hello there, how are you today?' });
    expect(env.chat.isActive(t.id)).toBe(true);
    await env.chat.idle();

    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.thread).toMatchObject({
      title: 'Hello there, how are you today?',
      state: 'idle',
    });
    expect(detail.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'complete'],
      ['assistant', 'complete'],
    ]);
    const reply = detail.messages[1]!;
    expect(reply.parts).toEqual([
      { type: 'text', text: 'You said: Hello there, how are you today?' },
    ]);
    expect(reply.model).toBe(`${env.mockAccountId}/mock-fast`);
    expect(reply.usage!.outputTokens).toBeGreaterThan(0);
    expect(reply.id).toBe(res.assistantMessageId!);

    expect(turnRow(res.turnId!)).toMatchObject({
      status: 'completed',
      stop_reason: 'end',
      trigger: 'user',
      execution_location: 'hub',
      step_count: 1,
      model_id: `${env.mockAccountId}/mock-fast`,
      idx: 0,
    });
    const usage = env.db.raw
      .prepare('SELECT * FROM usage_event WHERE turn_id = ?')
      .get(res.turnId) as Record<string, unknown>;
    expect(usage).toMatchObject({
      account_id: ACCOUNT,
      provider: 'mock',
      model: 'mock-fast',
      thread_id: t.id,
    });

    const names = env.events.names();
    const persisted = env.events.events.filter((e) => !e.ephemeral).map((e) => e.name);
    expect(persisted).toEqual([
      'turn.started',
      'chat.message.created',
      'chat.message.created',
      'chat.message.completed',
      'turn.completed',
    ]);
    const deltas = env.events.events.filter((e) => e.name === 'chat.delta');
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((d) => d.payload.text).join('')).toBe(
      'You said: Hello there, how are you today?',
    );
    expect(names.indexOf('chat.delta')).toBeGreaterThan(names.indexOf('chat.message.created'));
    expect(names.lastIndexOf('chat.delta')).toBeLessThan(names.indexOf('chat.message.completed'));
    expect(env.events.events.find((e) => e.name === 'turn.started')!.payload).toMatchObject({
      threadId: t.id,
      turnId: res.turnId,
      idx: 0,
      trigger: 'user',
      executionLocation: 'hub',
    });
    expect(env.events.events.find((e) => e.name === 'chat.message.completed')!).toMatchObject({
      payload: { status: 'complete', messageId: res.assistantMessageId },
      correlation: { threadId: t.id, turnId: res.turnId },
    });
  });

  it('sends the history with a system prompt, skipping error parts and reasoning', async () => {
    env = await makeEnv({
      mock: {
        scripts: [
          {
            when: 'fail',
            once: true,
            steps: [
              { type: 'text_delta', text: 'partial' },
              {
                type: 'stop',
                reason: 'error',
                error: { code: 'network', message: 'drop', retryable: true },
              },
            ],
          },
          {
            when: 'think',
            steps: [
              { type: 'reasoning_delta', text: 'hmm' },
              { type: 'text_delta', text: 'thought' },
            ],
          },
        ],
      },
    });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'think first' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: 'fail now' });
    await env.chat.idle();
    await env.chat.send(ACCOUNT, t.id, { text: 'third' });
    await env.chat.idle();
    const req = env.mock.requests.at(-1)!;
    expect(
      req.messages.map((m) => [
        m.role,
        m.content.map((p) => (p.type === 'text' ? p.text : p.type)).join('|'),
      ]),
    ).toEqual([
      ['system', expect.stringContaining('Nova')],
      ['user', 'think first'],
      ['assistant', 'thought'],
      ['user', 'fail now'],
      ['assistant', 'partial'],
      ['user', 'third'],
    ]);
    const detail = await env.threads.detail(ACCOUNT, t.id);
    expect(detail.messages[1]!.parts).toEqual([
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'thought' },
    ]);
    expect(detail.messages[3]!.status).toBe('error');
    expect(detail.messages[3]!.parts).toEqual([
      { type: 'text', text: 'partial' },
      { type: 'error', code: 'network', message: 'drop' },
    ]);
    expect(detail.thread.state).toBe('idle');
    expect(env.mock.requests[0]!.reasoning).toBeUndefined();
  });

  it('refuses a second send while a turn runs (conflict)', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 20 } } });
    const t = await env.threads.create(ACCOUNT, {});
    const first = env.chat.send(ACCOUNT, t.id, { text: 'one two three four five' });
    await expect(env.chat.send(ACCOUNT, t.id, { text: 'again' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await first;
    await expect(env.chat.send(ACCOUNT, t.id, { text: 'again' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await env.chat.idle();
    await expect(env.chat.send(ACCOUNT, t.id, { text: 'now ok' })).resolves.toBeTruthy();
    await env.chat.idle();
    const turns = env.db.raw
      .prepare('SELECT idx FROM turn WHERE thread_id = ? ORDER BY idx')
      .all(t.id);
    expect(turns).toEqual([{ idx: 0 }, { idx: 1 }]);
  });

  it('cancels mid-stream and keeps the partial text, marked incomplete', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 15 } } });
    const t = await env.threads.create(ACCOUNT, {});
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    const res = await env.chat.send(ACCOUNT, t.id, { text: words });
    await waitFor(() => env.events.events.filter((e) => e.name === 'chat.delta').length >= 3);
    expect(await env.chat.cancel(ACCOUNT, t.id)).toBe(true);
    expect(env.chat.isActive(t.id)).toBe(false);
    const status = msgRow(res.assistantMessageId!).status;
    expect(status).toBe('incomplete');
    const partial = textOf(res.assistantMessageId!)!;
    expect(partial.length).toBeGreaterThan(0);
    expect(`You said: ${words}`.startsWith(partial)).toBe(true);
    expect(partial.length).toBeLessThan(`You said: ${words}`.length);
    expect(turnRow(res.turnId!)).toMatchObject({ status: 'interrupted', stop_reason: 'cancelled' });
    expect(env.events.names()).toContain('turn.interrupted');
    expect(env.events.names()).not.toContain('turn.completed');
    expect(await env.chat.cancel(ACCOUNT, t.id)).toBe(false);
    await expect(env.chat.cancel(ACCOUNT, 'nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cancels even when the provider ignores the abort signal', async () => {
    const stuck: Provider = {
      id: 'stuck',
      capabilities: {
        streaming: true,
        tools: false,
        parallelToolCalls: false,
        vision: false,
        audioIn: false,
        audioOut: false,
        realtime: false,
        reasoning: false,
        promptCache: 'none',
        structuredOutput: false,
        imageGeneration: false,
        maxContextTokens: 1000,
        maxOutputTokens: 100,
      },
      listModels: () => Promise.resolve([{ id: 'stuck', label: 'Stuck', capabilities: {} }]),
      stream: async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', text: 'before ' };
        await new Promise(() => undefined);
      },
    };
    env = await makeEnv({ factory: ({ row }) => (row.provider === 'mock' ? stuck : undefined) });
    const t = await env.threads.create(ACCOUNT, {});
    const res = await env.chat.send(ACCOUNT, t.id, { text: 'go' });
    await waitFor(() => env.events.names().includes('chat.delta'));
    await env.chat.cancel(ACCOUNT, t.id);
    expect(msgRow(res.assistantMessageId!).status).toBe('incomplete');
    expect(textOf(res.assistantMessageId!)).toBe('before ');
  });

  it('persists partial text while streaming, at most every flush interval', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 10 } }, chat: { flushIntervalMs: 30 } });
    const t = await env.threads.create(ACCOUNT, {});
    const res = await env.chat.send(ACCOUNT, t.id, {
      text: Array.from({ length: 40 }, (_, i) => `x${i}`).join(' '),
    });
    await waitFor(() => (textOf(res.assistantMessageId!) ?? '').length > 0);
    expect(msgRow(res.assistantMessageId!).status).toBe('streaming');
    expect((await env.threads.view(ACCOUNT, t.id)).state).toBe('streaming');
    await env.chat.idle();
    expect(msgRow(res.assistantMessageId!).status).toBe('complete');
  });

  it('records provider errors as an error part, a failed turn and an error thread state', async () => {
    env = await makeEnv({
      mock: {
        failWith: { code: 'auth_expired', message: 'key sk-live-abcdefghijklmnop1234 rejected' },
      },
    });
    const t = await env.threads.create(ACCOUNT, {});
    const res = await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    const reply = (await env.threads.detail(ACCOUNT, t.id)).messages[1]!;
    expect(reply.status).toBe('error');
    const errPart = reply.parts.find((p) => p.type === 'error');
    expect(errPart).toMatchObject({ type: 'error', code: 'auth_expired' });
    expect(JSON.stringify(errPart)).not.toContain('sk-live-abcdefghijklmnop1234');
    expect(turnRow(res.turnId!)).toMatchObject({ status: 'failed', stop_reason: 'error' });
    expect((await env.threads.view(ACCOUNT, t.id)).state).toBe('error');
    const done = env.events.events.find((e) => e.name === 'turn.completed')!;
    expect(done.payload).toMatchObject({ status: 'failed', stopReason: 'error' });
  });

  it('treats a throwing provider and a stream without stop as failures', async () => {
    let mode: 'throw' | 'silent' = 'throw';
    const odd: Provider = {
      id: 'odd',
      capabilities: {
        streaming: true,
        tools: false,
        parallelToolCalls: false,
        vision: false,
        audioIn: false,
        audioOut: false,
        realtime: false,
        reasoning: false,
        promptCache: 'none',
        structuredOutput: false,
        imageGeneration: false,
        maxContextTokens: 1000,
        maxOutputTokens: 100,
      },
      listModels: () => Promise.resolve([{ id: 'odd', label: 'Odd', capabilities: {} }]),
      stream: async function* (_req: ChatRequest): AsyncGenerator<StreamEvent> {
        await Promise.resolve();
        yield { type: 'usage', inputTokens: 3, outputTokens: 1 };
        if (mode === 'throw') throw new NovaError('rate_limited', 'too many');
      },
    };
    env = await makeEnv({ factory: ({ row }) => (row.provider === 'mock' ? odd : undefined) });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'a' });
    await env.chat.idle();
    mode = 'silent';
    await env.chat.send(ACCOUNT, t.id, { text: 'b' });
    await env.chat.idle();
    const msgs = (await env.threads.detail(ACCOUNT, t.id)).messages;
    expect(msgs[1]!.parts).toEqual([{ type: 'error', code: 'rate_limited', message: 'too many' }]);
    expect(msgs[3]!.parts).toEqual([
      { type: 'error', code: 'provider_error', message: 'The response ended unexpectedly' },
    ]);
    expect(msgs[1]!.usage).toEqual({ inputTokens: 3, outputTokens: 1, costUsd: 0 });
  });

  it('marks a reply cut off by the output limit as incomplete but completes the turn', async () => {
    env = await makeEnv({
      mock: {
        scripts: [
          {
            steps: [
              { type: 'text_delta', text: 'cut' },
              { type: 'stop', reason: 'length' },
            ],
          },
        ],
      },
    });
    const t = await env.threads.create(ACCOUNT, {});
    const res = await env.chat.send(ACCOUNT, t.id, { text: 'long' });
    await env.chat.idle();
    expect(msgRow(res.assistantMessageId!).status).toBe('incomplete');
    expect(turnRow(res.turnId!)).toMatchObject({ status: 'completed', stop_reason: 'end' });
  });

  it('uses the request model and reasoning level, persists them on the thread, and prices usage', async () => {
    env = await makeEnv();
    const now = new Date().toISOString();
    env.db.raw
      .prepare(
        `INSERT INTO model_pref (id, account_id, provider, model_id, cost_in, cost_out, created_at, updated_at)
         VALUES ('mp', ?, 'mock', 'mock-smart', 1000000, 2000000, ?, ?)`,
      )
      .run(ACCOUNT, now, now);
    const t = await env.threads.create(ACCOUNT, {});
    const ref = `${env.mockAccountId}/mock-smart`;
    const res = await env.chat.send(ACCOUNT, t.id, {
      text: 'hello',
      model: ref,
      reasoningLevel: 'high',
    });
    await env.chat.idle();
    expect(env.mock.requests[0]).toMatchObject({
      model: 'mock-smart',
      reasoning: { level: 'high' },
    });
    expect(await env.threads.view(ACCOUNT, t.id)).toMatchObject({
      model: ref,
      reasoningLevel: 'high',
    });
    expect(turnRow(res.turnId!)).toMatchObject({ model_id: ref, reasoning_level: 'high' });
    const m = msgRow(res.assistantMessageId!);
    const u = JSON.parse(m.usage_json as string);
    expect(m.cost_usd).toBe(u.inputTokens * 1 + u.outputTokens * 2);
  });

  it('validates the request: empty text, no model, unknown thread', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    await expect(env.chat.send(ACCOUNT, t.id, { text: '   ' })).rejects.toMatchObject({
      code: 'validation',
      details: { reason: 'empty' },
    });
    await expect(env.chat.send(ACCOUNT, 'missing', { text: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await env.registry.remove(ACCOUNT, env.mockAccountId);
    const bare = await env.threads.create(ACCOUNT, {});
    expect(bare.model).toBeNull();
    await expect(env.chat.send(ACCOUNT, bare.id, { text: 'x' })).rejects.toMatchObject({
      details: { reason: 'no_model' },
    });
    await expect(env.chat.send(ACCOUNT, t.id, { text: 'x' })).rejects.toMatchObject({
      details: { reason: 'unknown_model' },
    });
    expect(env.chat.isActive(t.id)).toBe(false);
  });
});

describe('attachments (FR-021)', () => {
  it('stores blobs by hash and inlines text files into the model request', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    const res = await env.chat.send(ACCOUNT, t.id, {
      text: 'see file',
      attachments: [
        { name: 'notes.md', mime: 'text/markdown', data: b64('# Title\nbody') },
        {
          name: 'main.ts',
          mime: 'video/mp2t',
          data: `data:video/mp2t;base64,${b64('export const x = 1;')}`,
        },
      ],
    });
    await env.chat.idle();
    const user = (await env.threads.detail(ACCOUNT, t.id)).messages[0]!;
    expect(user.id).toBe(res.userMessageId);
    const files = user.parts.filter((p) => p.type === 'file');
    expect(files).toMatchObject([
      { name: 'notes.md', mime: 'text/markdown', size: 12 },
      { name: 'main.ts', mime: 'text/plain' },
    ]);
    const rows = env.db.raw.prepare('SELECT * FROM attachment ORDER BY name').all() as {
      blob_path: string;
      sha256: string;
      thread_id: string;
    }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.blob_path).toBe(`blobs/attachments/${r.sha256}`);
      expect(existsSync(join(env.dir, 'data', r.blob_path))).toBe(true);
      expect(r.thread_id).toBe(t.id);
    }
    const text = env.mock.requests[0]!.messages.at(-1)!
      .content.map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    expect(text).toContain(
      'see file\n\n--- Attachment: notes.md (text/markdown) ---\n# Title\nbody\n--- End of notes.md ---',
    );
    expect(text).toContain('export const x = 1;');
  });

  it('sends images to vision models and a note otherwise; PDFs get a note', async () => {
    env = await makeEnv();
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, {
      text: '',
      attachments: [
        { name: 'pic.png', mime: 'image/png', data: b64(PNG) },
        { name: 'doc.pdf', mime: 'application/pdf', data: b64('%PDF-1.7 ...') },
      ],
    });
    await env.chat.idle();
    expect((await env.threads.view(ACCOUNT, t.id)).title).toBe('pic.png');
    const parts = env.mock.requests[0]!.messages.at(-1)!.content;
    expect(parts.map((p) => (p.type === 'text' ? p.text : p.type))).toEqual([
      '[Image attached: pic.png. The selected model cannot view images.]',
      '\n\n[PDF attached: doc.pdf. Reading PDF text is not available yet.]',
    ]);

    const vision = await makeEnv({ mock: { capabilities: { vision: true } } });
    try {
      const v = await vision.threads.create(ACCOUNT, {});
      await vision.chat.send(ACCOUNT, v.id, {
        text: 'what is this',
        attachments: [{ name: 'pic.png', mime: 'image/png', data: b64(PNG) }],
      });
      await vision.chat.idle();
      const vp = vision.mock.requests[0]!.messages.at(-1)!.content;
      expect(vp[1]).toEqual({ type: 'image', mime: 'image/png', data: b64(PNG) });
      // A blob that vanished is reported, not fatal.
      rmSync(join(vision.dir, 'data', 'blobs'), { recursive: true, force: true });
      await vision.chat.send(ACCOUNT, v.id, { text: 'again' });
      await vision.chat.idle();
      const again = vision.mock.requests[1]!.messages[1]!.content;
      expect(again.at(-1)).toEqual({ type: 'text', text: '\n\n[Attachment unavailable: pic.png]' });
    } finally {
      await vision.close();
    }
  });

  it('rejects bad attachments with clear validation errors', () => {
    const one = (name: string, mime: string, data: string) => () =>
      prepareAttachments([{ name, mime, data }]);
    const reason = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return {
          code: (e as NovaError).code,
          ...((e as NovaError).details ?? {}),
          message: (e as Error).message,
        };
      }
      return null;
    };
    expect(reason(one('a.exe', 'application/x-msdownload', b64('MZ')))).toMatchObject({
      code: 'validation',
      reason: 'type',
      attachment: 'a.exe',
    });
    expect(reason(one('a.png', 'image/png', b64('not a png')))).toMatchObject({
      reason: 'content',
    });
    expect(reason(one('a.pdf', 'application/pdf', b64('nope')))).toMatchObject({
      reason: 'content',
    });
    expect(reason(one('a.txt', 'text/plain', '%%%'))).toMatchObject({ reason: 'encoding' });
    expect(reason(one('a.txt', 'text/plain', ''))).toMatchObject({ reason: 'empty' });
    expect(reason(one('a.txt', 'text/plain', b64(Buffer.from([0xff, 0xfe, 0x00]))))).toMatchObject({
      reason: 'content',
    });
    const big = Buffer.alloc(ATTACHMENT_LIMITS.maxBytes + 1, 0x61);
    const tooBig = reason(one('big.txt', 'text/plain', b64(big)));
    expect(tooBig).toMatchObject({ reason: 'size' });
    expect(tooBig!.message).toMatch(/limit is 20\.0 MB/);
    const many = Array.from({ length: ATTACHMENT_LIMITS.maxCount + 1 }, () => ({
      name: 'a.txt',
      mime: 'text/plain',
      data: b64('a'),
    }));
    expect(reason(() => prepareAttachments(many))).toMatchObject({ reason: 'count' });
    expect(
      prepareAttachments([
        { name: '../../etc/x.json', mime: 'application/json; charset=utf-8', data: b64('{}') },
      ])[0],
    ).toMatchObject({
      name: '.._.._etc_x.json',
      mime: 'application/json',
      kind: 'text',
    });
  });
});

describe('recovery and shutdown', () => {
  it('marks streaming messages incomplete and open turns interrupted after a crash', async () => {
    const dir = await makeEnv({ mock: { timing: { chunkDelayMs: 50 } } });
    env = dir;
    const t = await env.threads.create(ACCOUNT, {});
    const res = await env.chat.send(ACCOUNT, t.id, { text: 'a b c d e f g h' });
    await waitFor(() => (textOf(res.assistantMessageId!) ?? '').length > 0);
    // A second engine on the same database stands in for the restarted process.
    const restarted = new ChatService({
      db: env.db,
      router: env.router,
      threads: env.threads,
      events: new MemoryEventSink(),
      dataDir: join(env.dir, 'data'),
    });
    expect(await restarted.recoverOnStartup()).toEqual({ messages: 1, turns: 1 });
    expect(msgRow(res.assistantMessageId!).status).toBe('incomplete');
    expect(turnRow(res.turnId!)).toMatchObject({ status: 'interrupted', stop_reason: 'error' });
    expect((await env.threads.view(ACCOUNT, t.id)).state).toBe('idle');
    expect(textOf(res.assistantMessageId!)!.length).toBeGreaterThan(0);
    expect(await restarted.recoverOnStartup()).toEqual({ messages: 0, turns: 0 });
  });

  it('refuses a send while the database shows an open turn from elsewhere', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 30 } } });
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'a b c d e' });
    const other = new ChatService({
      db: env.db,
      router: env.router,
      threads: env.threads,
      events: new MemoryEventSink(),
      dataDir: join(env.dir, 'data'),
    });
    await expect(other.send(ACCOUNT, t.id, { text: 'x' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('shutdown cancels running turns and saves their partial output', async () => {
    env = await makeEnv({ mock: { timing: { chunkDelayMs: 20 } } });
    const t = await env.threads.create(ACCOUNT, {});
    const res = await env.chat.send(ACCOUNT, t.id, { text: 'one two three four five six seven' });
    await waitFor(() => env.events.names().includes('chat.delta'));
    await env.chat.shutdown();
    expect(msgRow(res.assistantMessageId!).status).toBe('incomplete');
    expect(textOf(res.assistantMessageId!)!.length).toBeGreaterThan(0);
    expect(env.chat.isActive(t.id)).toBe(false);
  });
});
