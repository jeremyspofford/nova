// M1 Hub API integration tests through `app.inject` (and a real listener for SSE): providers,
// models, account, threads, messages, cancel, crash recovery, search, attachments and the
// per-thread stream (FR-017, FR-018, FR-021, FR-023, FR-101, FR-125).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider, type MockProviderOptions } from '@nova/providers';
import { FileVault } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub, type HubDeps } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';

const HOST = { host: '127.0.0.1:7419' };
const KEY = 'sk-proj-INTEGRATION-0123456789abcdefSECRET';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let config: HubConfig;
let mock: MockProvider;
let auth: Record<string, string>;
let fake: Server;
let fakeBase: string;
const extraHubs: Hub[] = [];

async function makeHub(opts: { mock?: MockProviderOptions; deps?: Partial<HubDeps> } = {}) {
  mock = new MockProvider({ id: 'mock', timing: 'instant', ...opts.mock });
  const m = mock;
  return buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    providerFactory: ({ row }) => (row.provider === 'mock' ? m : undefined),
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    ...opts.deps,
  });
}

async function signIn(h: Hub = hub): Promise<Record<string, string>> {
  const code = await h.auth.issueSetupCode();
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  const session = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  return { ...HOST, authorization: `Bearer ${session}` };
}

/** A tiny OpenAI-compatible server: accepts only KEY and echoes a bad key in its error. */
function startFake(): Promise<void> {
  fake = createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${KEY}`;
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (!ok) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: `Incorrect API key provided: ${req.headers.authorization}` },
          }),
        );
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fake-1' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"Hi from "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"fake"},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      );
    });
  });
  return new Promise((r) =>
    fake.listen(0, '127.0.0.1', () => {
      fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;
      r();
    }),
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-chat-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await makeHub();
  auth = await signIn();
  await startFake();
});

afterEach(async () => {
  for (const h of extraHubs.splice(0)) await h.app.close();
  await hub.app.close();
  db.close();
  fake.closeAllConnections();
  await new Promise<void>((r) => fake.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, headers = auth) => hub.app.inject({ method: 'GET', url, headers });
const send = (
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers = auth,
) =>
  hub.app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

async function newThread(body: object = {}): Promise<{ id: string; model: string | null }> {
  const res = await send('POST', '/api/v1/threads', body);
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function mockAccountId(): Promise<string> {
  return (await get('/api/v1/providers'))
    .json()
    .items.find((p: { provider: string }) => p.provider === 'mock').id;
}

describe('auth on every M1 route (FR-192)', () => {
  it.each([
    ['GET', '/api/v1/providers'],
    ['POST', '/api/v1/providers'],
    ['DELETE', '/api/v1/providers/x'],
    ['POST', '/api/v1/providers/x/test'],
    ['GET', '/api/v1/models'],
    ['PATCH', '/api/v1/account'],
    ['GET', '/api/v1/threads'],
    ['POST', '/api/v1/threads'],
    ['GET', '/api/v1/threads/x'],
    ['PATCH', '/api/v1/threads/x'],
    ['DELETE', '/api/v1/threads/x'],
    ['POST', '/api/v1/threads/x/messages'],
    ['POST', '/api/v1/threads/x/cancel'],
    ['GET', '/api/v1/threads/x/stream'],
    ['GET', '/api/v1/search?q=x'],
    ['GET', '/api/v1/attachments/x'],
  ])('%s %s requires a token', async (method, url) => {
    const res = await hub.app.inject({
      method: method as 'GET',
      url,
      headers: HOST,
      payload: method === 'GET' ? undefined : {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('token_required');
  });
});

describe('providers & models', () => {
  it('starts with the offline mock provider and lists its two models', async () => {
    const providers = (await get('/api/v1/providers')).json().items;
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      provider: 'mock',
      label: 'Mock (offline)',
      hasSecret: false,
    });
    const all = (await get('/api/v1/models')).json().items as {
      kind: string;
      ref: string;
      modelId: string;
    }[];
    // The built-in presets come first (FR-221), then the account's models.
    expect(all.filter((m) => m.kind === 'preset').map((m) => m.ref)).toEqual([
      'preset:faster',
      'preset:balanced',
      'preset:smarter',
    ]);
    const models = all.filter((m) => m.kind === 'model');
    expect(models.map((m) => m.modelId)).toEqual(['mock-fast', 'mock-smart']);
    expect(models[0]!.ref).toBe(`${providers[0].id}/mock-fast`);
  });

  it('adds, tests and removes an OpenAI-compatible account without ever echoing the key', async () => {
    const created = await send('POST', '/api/v1/providers', {
      provider: 'openai_compatible',
      label: 'Fake',
      baseUrl: fakeBase,
      apiKey: KEY,
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(KEY);
    const view = created.json();
    expect(view).toMatchObject({
      provider: 'openai_compatible',
      hasSecret: true,
      authKind: 'api_key',
    });
    expect(view.apiKey).toBeUndefined();

    const test = await send('POST', `/api/v1/providers/${view.id}/test`);
    expect(test.json()).toEqual({ ok: true, models: 1 });
    const models = (await get('/api/v1/models')).json().items;
    expect(models.map((m: { ref: string }) => m.ref)).toContain(`${view.id}/fake-1`);

    const bad = (
      await send('POST', '/api/v1/providers', {
        provider: 'openai_compatible',
        label: 'Bad key',
        baseUrl: fakeBase,
        apiKey: 'sk-wrong-0123456789abcdefghij',
      })
    ).json();
    const badTest = await send('POST', `/api/v1/providers/${bad.id}/test`);
    expect(badTest.statusCode).toBe(200);
    expect(badTest.json().ok).toBe(false);
    expect(badTest.json().detail).not.toContain('sk-wrong-0123456789abcdefghij');
    expect(
      (await get('/api/v1/providers')).json().items.find((p: { id: string }) => p.id === bad.id)
        .status,
    ).toBe('expired');

    expect((await send('DELETE', `/api/v1/providers/${view.id}`)).json()).toEqual({ ok: true });
    expect((await send('DELETE', `/api/v1/providers/${view.id}`)).statusCode).toBe(404);
    expect((await send('POST', `/api/v1/providers/${view.id}/test`)).statusCode).toBe(404);
  });

  it('validates provider bodies', async () => {
    const post = (b: object) => send('POST', '/api/v1/providers', b);
    expect((await post({ provider: 'nope', label: 'x' })).statusCode).toBe(400);
    expect((await post({ provider: 'mock' })).statusCode).toBe(400);
    expect(
      (await post({ provider: 'openai_compatible', label: 'x', baseUrl: 'not a url' })).statusCode,
    ).toBe(400);
    // Cloud APIs need a key (M2 supports every kind; the providers agent owns the details).
    const anthropic = await post({ provider: 'anthropic', label: 'x' });
    expect(anthropic.statusCode).toBe(400);
    expect(anthropic.json().error.code).toBe('validation');
  });
});

describe('account (PATCH /account)', () => {
  it('updates the display name and validates input', async () => {
    const res = await send('PATCH', '/api/v1/account', { displayName: ' Jeremy ', avatar: null });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ displayName: 'Jeremy' });
    expect((await get('/api/v1/session')).json().displayName).toBe('Jeremy');
    expect((await send('PATCH', '/api/v1/account', {})).statusCode).toBe(400);
    expect(
      (await send('PATCH', '/api/v1/account', { displayName: 'x'.repeat(101) })).statusCode,
    ).toBe(400);
    expect((await send('PATCH', '/api/v1/account', { avatar: 'http://x' })).statusCode).toBe(400);
  });
});

describe('threads (FR-017)', () => {
  it('creates, lists, renames, pins, archives and deletes', async () => {
    const a = await newThread();
    expect(a.model).toBe(`${await mockAccountId()}/mock-fast`);
    const b = await newThread({ title: 'Second' });
    const renamed = await send('PATCH', `/api/v1/threads/${a.id}`, {
      title: 'First',
      pinned: true,
    });
    expect(renamed.json()).toMatchObject({ title: 'First', pinned: true });
    const list = (await get('/api/v1/threads')).json();
    expect(list.items.map((t: { id: string }) => t.id)).toEqual([a.id, b.id]);
    expect(list.nextCursor).toBeNull();
    const paged = (await get('/api/v1/threads?limit=1')).json();
    expect(paged.items).toHaveLength(1);
    const rest = (await get(`/api/v1/threads?limit=1&cursor=${paged.nextCursor}`)).json();
    expect(rest.items[0].id).toBe(b.id);

    await send('PATCH', `/api/v1/threads/${b.id}`, { archived: true });
    expect((await get('/api/v1/threads')).json().items).toHaveLength(1);
    expect((await get('/api/v1/threads?archived=true')).json().items[0].id).toBe(b.id);
    expect((await get('/api/v1/threads?q=Seco&archived=true')).json().items).toHaveLength(1);

    expect((await send('DELETE', `/api/v1/threads/${a.id}`)).json()).toEqual({ ok: true });
    expect((await get(`/api/v1/threads/${a.id}`)).statusCode).toBe(404);
    expect((await send('DELETE', `/api/v1/threads/${a.id}`)).statusCode).toBe(404);
  });

  it('validates thread bodies and queries', async () => {
    const t = await newThread();
    expect((await send('POST', '/api/v1/threads', { mode: 'nope' })).statusCode).toBe(400);
    expect((await send('POST', '/api/v1/threads', { model: 'bogus' })).statusCode).toBe(400);
    const empty = await send('PATCH', `/api/v1/threads/${t.id}`, {});
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('validation');
    expect((await get('/api/v1/threads?limit=0')).statusCode).toBe(400);
    expect((await get('/api/v1/threads?cursor=zzz')).statusCode).toBe(400);
    expect((await get('/api/v1/threads/missing')).statusCode).toBe(404);
  });
});

describe('messages, streaming and cancel (FR-018)', () => {
  it('accepts a message with 202 and completes the reply in the background', async () => {
    const t = await newThread();
    const res = await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'Hello Nova' });
    expect(res.statusCode).toBe(202);
    const ids = res.json();
    expect(Object.keys(ids).sort()).toEqual([
      'assistantMessageId',
      'disposition',
      'turnId',
      'userMessageId',
    ]);
    await hub.chat.idle();
    const detail = (await get(`/api/v1/threads/${t.id}`)).json();
    expect(detail.thread).toMatchObject({ title: 'Hello Nova', state: 'idle' });
    expect(detail.messages.map((m: { id: string }) => m.id)).toEqual([
      ids.userMessageId,
      ids.assistantMessageId,
    ]);
    expect(detail.messages[1]).toMatchObject({
      status: 'complete',
      parts: [{ type: 'text', text: 'You said: Hello Nova' }],
    });
    const names = (await get('/api/v1/events')).json().events.map((e: { name: string }) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(['turn.started', 'chat.message.completed', 'turn.completed']),
    );
    expect(names).not.toContain('chat.delta');
  });

  it('validates sends and queues a second one while a turn runs (FR-019)', async () => {
    await hub.app.close();
    hub = await makeHub({ mock: { timing: { chunkDelayMs: 30 } } });
    auth = await signIn();
    const t = await newThread();
    expect((await send('POST', `/api/v1/threads/${t.id}/messages`, {})).statusCode).toBe(400);
    expect((await send('POST', `/api/v1/threads/${t.id}/messages`, { text: ' ' })).statusCode).toBe(
      400,
    );
    expect((await send('POST', '/api/v1/threads/missing/messages', { text: 'x' })).statusCode).toBe(
      404,
    );
    expect(
      (await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'one two three four' }))
        .statusCode,
    ).toBe(202);
    const again = await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'again' });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ disposition: 'queued', turnId: null, queuePosition: 1 });
    await hub.chat.idle();
    const detail = (await get(`/api/v1/threads/${t.id}`)).json();
    expect(detail.messages.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(detail.messages[2]).toMatchObject({
      id: again.json().userMessageId,
      provenance: 'queued',
    });
  });

  it('cancel mid-stream keeps the partial text, marked incomplete', async () => {
    await hub.app.close();
    hub = await makeHub({ mock: { timing: { chunkDelayMs: 15 } } });
    auth = await signIn();
    const t = await newThread();
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const { assistantMessageId } = (
      await send('POST', `/api/v1/threads/${t.id}/messages`, { text: words })
    ).json();
    await new Promise((r) => setTimeout(r, 120));
    const res = await send('POST', `/api/v1/threads/${t.id}/cancel`);
    expect(res.json()).toEqual({ ok: true, cancelled: true });
    const msg = (await get(`/api/v1/threads/${t.id}`))
      .json()
      .messages.find((m: { id: string }) => m.id === assistantMessageId);
    expect(msg.status).toBe('incomplete');
    const text = msg.parts.find((p: { type: string }) => p.type === 'text').text as string;
    expect(text.length).toBeGreaterThan(0);
    expect(`You said: ${words}`.startsWith(text)).toBe(true);
    expect(text.length).toBeLessThan(`You said: ${words}`.length);
    expect((await send('POST', `/api/v1/threads/${t.id}/cancel`)).json()).toEqual({
      ok: true,
      cancelled: false,
    });
    const names = (await get('/api/v1/events')).json().events.map((e: { name: string }) => e.name);
    expect(names).toContain('turn.interrupted');
  });

  it('deleting a thread stops its running reply', async () => {
    await hub.app.close();
    hub = await makeHub({ mock: { timing: { chunkDelayMs: 20 } } });
    auth = await signIn();
    const t = await newThread();
    await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'a b c d e f g h i j' });
    expect((await send('DELETE', `/api/v1/threads/${t.id}`)).statusCode).toBe(200);
    expect(hub.chat.isActive(t.id)).toBe(false);
  });

  it('streams through a real OpenAI-compatible adapter and records usage', async () => {
    const p = (
      await send('POST', '/api/v1/providers', {
        provider: 'openai_compatible',
        label: 'Fake',
        baseUrl: fakeBase,
        apiKey: KEY,
      })
    ).json();
    const t = await newThread({ model: `${p.id}/fake-1` });
    await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'hi' });
    await hub.chat.idle();
    const reply = (await get(`/api/v1/threads/${t.id}`)).json().messages[1];
    expect(reply).toMatchObject({
      status: 'complete',
      parts: [{ type: 'text', text: 'Hi from fake' }],
      usage: { inputTokens: 5, outputTokens: 2 },
      model: `${p.id}/fake-1`,
    });
  });

  it('recovers a reply that was streaming when the Hub crashed', async () => {
    await hub.app.close();
    hub = await makeHub({ mock: { timing: { chunkDelayMs: 40 } } });
    auth = await signIn();
    const t = await newThread();
    const { assistantMessageId } = (
      await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'a b c d e f g h i j k l' })
    ).json();
    await new Promise((r) => setTimeout(r, 150));
    // A second Hub on the same database plays the restarted process; the first never finishes.
    const restarted = await makeHub();
    extraHubs.push(restarted);
    expect(await restarted.chat.recoverOnStartup()).toEqual({ messages: 1, turns: 1 });
    const res = await restarted.app.inject({ url: `/api/v1/threads/${t.id}`, headers: auth });
    const msg = res.json().messages.find((m: { id: string }) => m.id === assistantMessageId);
    expect(msg.status).toBe('incomplete');
    expect(msg.parts[0].text.length).toBeGreaterThan(0);
    expect(res.json().thread.state).toBe('idle');
  });
});

describe('search', () => {
  it('finds a message and excludes temporary and deleted threads', async () => {
    const kept = await newThread();
    const temp = await newThread({ temporary: true });
    const gone = await newThread();
    for (const t of [kept, temp, gone]) {
      await send('POST', `/api/v1/threads/${t.id}/messages`, {
        text: 'pineapple upside-down cake',
      });
      await hub.chat.idle();
    }
    await send('DELETE', `/api/v1/threads/${gone.id}`);
    const hits = (await get('/api/v1/search?q=pineapp')).json().items;
    expect(hits.length).toBe(2); // the user message and the echoing reply, both in `kept`
    expect(new Set(hits.map((h: { threadId: string }) => h.threadId))).toEqual(new Set([kept.id]));
    expect(hits[0].snippet).toContain('<mark>pineapple</mark>');
    expect((await get('/api/v1/search?q=pineapple&limit=1')).json().items).toHaveLength(1);
    expect((await get('/api/v1/search?q=')).statusCode).toBe(400);
    expect((await get(`/api/v1/search?q=${encodeURIComponent('"NEAR( *')}`)).statusCode).toBe(200);
  });
});

describe('attachments (FR-021)', () => {
  it('stores uploads, serves them back, and validates type', async () => {
    const t = await newThread();
    const res = await send('POST', `/api/v1/threads/${t.id}/messages`, {
      text: 'files',
      attachments: [
        { name: 'notes.txt', mime: 'text/plain', data: b64('hello file') },
        { name: 'pic.png', mime: 'image/png', data: b64(PNG) },
      ],
    });
    expect(res.statusCode).toBe(202);
    await hub.chat.idle();
    const user = (await get(`/api/v1/threads/${t.id}`)).json().messages[0];
    const files = user.parts.filter((p: { type: string }) => p.type === 'file');
    expect(files).toHaveLength(2);
    const txt = await get(`/api/v1/attachments/${files[0].attachmentId}`);
    expect(txt.statusCode).toBe(200);
    expect(txt.body).toBe('hello file');
    expect(txt.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(txt.headers['content-disposition']).toMatch(/^attachment; filename="notes.txt"/);
    const png = await get(`/api/v1/attachments/${files[1].attachmentId}`);
    expect(png.rawPayload.equals(PNG)).toBe(true);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toMatch(/^inline/);
    expect(png.headers['content-security-policy']).toContain('sandbox');
    expect(existsSync(join(config.dataDir, 'blobs', 'attachments'))).toBe(true);
    expect((await get('/api/v1/attachments/unknown')).statusCode).toBe(404);

    const bad = await send('POST', `/api/v1/threads/${t.id}/messages`, {
      text: 'x',
      attachments: [{ name: 'run.exe', mime: 'application/x-msdownload', data: b64('MZ') }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details).toMatchObject({ attachment: 'run.exe', reason: 'type' });

    await send('DELETE', `/api/v1/threads/${t.id}`);
    expect((await get(`/api/v1/attachments/${files[0].attachmentId}`)).statusCode).toBe(404);
  });

  it('accepts a message body larger than the default 1 MB limit', async () => {
    const t = await newThread();
    const big = 'a'.repeat(3 * 1024 * 1024);
    const res = await send('POST', `/api/v1/threads/${t.id}/messages`, {
      text: 'big',
      attachments: [{ name: 'big.txt', mime: 'text/plain', data: b64(big) }],
    });
    expect(res.statusCode).toBe(202);
    await hub.chat.idle();
    expect(
      (await send('POST', '/api/v1/threads', { title: 'x'.repeat(2 * 1024 * 1024) })).statusCode,
    ).toBe(413);
  });
});

describe('per-thread event stream (SSE)', () => {
  async function readUntil(
    url: string,
    headers: Record<string, string>,
    until: string,
    act?: () => Promise<unknown>,
  ) {
    const addr = await hub.app.listen({ host: '127.0.0.1', port: 0 });
    const ac = new AbortController();
    const res = await fetch(`${addr}${url}`, {
      headers: { authorization: auth.authorization!, ...headers },
      signal: ac.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const timer = setTimeout(() => ac.abort(), 4_000);
    if (act) void act();
    try {
      while (!text.includes(until)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
    return text;
  }

  it('delivers chat.delta then chat.message.completed for the thread only', async () => {
    const t = await newThread();
    const other = await newThread();
    const text = await readUntil(
      `/api/v1/threads/${t.id}/stream`,
      {},
      'event: turn.completed',
      async () => {
        await new Promise((r) => setTimeout(r, 30));
        await send('POST', `/api/v1/threads/${other.id}/messages`, { text: 'elsewhere' });
        await hub.chat.idle();
        await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'stream me please' });
      },
    );
    expect(text).toContain('event: chat.delta');
    expect(text.indexOf('event: chat.delta')).toBeLessThan(
      text.indexOf('event: chat.message.completed'),
    );
    expect(text).not.toContain('elsewhere');
    expect(text).not.toContain(other.id);
  });

  it('replays persisted events after Last-Event-ID, without ephemeral deltas', async () => {
    const t = await newThread();
    await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'replay me' });
    await hub.chat.idle();
    const events = (await get('/api/v1/events')).json().events as { id: string; name: string }[];
    const started = events.find((e) => e.name === 'turn.started')!;
    const text = await readUntil(
      `/api/v1/threads/${t.id}/stream`,
      { 'last-event-id': started.id },
      'event: turn.completed',
    );
    expect(text).not.toContain('event: turn.started');
    expect(text).toContain('event: chat.message.created');
    expect(text).toContain('event: chat.message.completed');
    expect(text).not.toContain('event: chat.delta');
    expect((await get('/api/v1/threads/missing/stream')).statusCode).toBe(404);
  });
});

describe('secrets never leak (FR-101)', () => {
  it('keeps the provider key out of every response and out of the database file', async () => {
    await hub.app.close();
    db.close();
    const dbPath = join(dir, 'data', 'nova.db');
    mkdirSync(join(dir, 'data'), { recursive: true });
    db = openDatabase({ path: dbPath });
    await migrate(db, { backupDir: join(dir, 'backups') });
    const vaultPath = join(dir, 'data', 'secrets.vault');
    hub = await makeHub({
      deps: {
        secrets: new FileVault(vaultPath, {
          kind: 'keyfile',
          path: join(dir, 'data', 'vault.key'),
        }),
      },
    });
    auth = await signIn();
    const bodies: string[] = [];
    const record = async (p: Promise<{ body: string }>) => {
      const r = await p;
      bodies.push(r.body);
      return r;
    };
    const created = JSON.parse(
      (
        await record(
          send('POST', '/api/v1/providers', {
            provider: 'openai_compatible',
            label: 'Fake',
            baseUrl: fakeBase,
            apiKey: KEY,
          }),
        )
      ).body,
    );
    // A second account whose server echoes the key it was sent in the 401 error.
    const echo = JSON.parse(
      (
        await record(
          send('POST', '/api/v1/providers', {
            provider: 'openai_compatible',
            label: 'Echo',
            baseUrl: fakeBase,
            apiKey: `${KEY}-WRONG`,
          }),
        )
      ).body,
    );
    const t = await newThread({ model: `${created.id}/fake-1` });
    await record(send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'hi' }));
    await hub.chat.idle();
    const t2 = await newThread({ model: `${echo.id}/fake-1` });
    await record(send('POST', `/api/v1/threads/${t2.id}/messages`, { text: 'hi' }));
    await hub.chat.idle();
    await record(send('POST', `/api/v1/providers/${echo.id}/test`));
    for (const url of [
      '/api/v1/providers',
      '/api/v1/models',
      '/api/v1/threads',
      `/api/v1/threads/${t.id}`,
      `/api/v1/threads/${t2.id}`,
      '/api/v1/events',
      '/api/v1/search?q=hi',
    ]) {
      await record(get(url));
    }
    const failed = JSON.parse(bodies.at(-3)!).messages[1];
    expect(failed.status).toBe('error');
    expect(failed.parts.find((p: { type: string }) => p.type === 'error').code).toBe(
      'auth_expired',
    );
    for (const b of bodies) expect(b).not.toContain(KEY);

    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const files = [dbPath, `${dbPath}-wal`].filter(existsSync);
    for (const f of files) expect(readFileSync(f).includes(Buffer.from(KEY))).toBe(false);
    expect(readFileSync(vaultPath).includes(Buffer.from(KEY))).toBe(false);
    expect(
      await new FileVault(vaultPath, { kind: 'keyfile', path: join(dir, 'data', 'vault.key') }).get(
        `secret://provider/${created.id}/api_key`,
      ),
    ).toBe(KEY);
  });
});

describe('web shell fallback still works with chat routes', () => {
  it('serves the API when no web build exists', async () => {
    const web = join(dir, 'web');
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
    expect((await get('/api/v1/threads')).statusCode).toBe(200);
  });
});
