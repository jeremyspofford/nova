// M2 Hub API integration tests through `app.inject`: follow-up queue, versions, branches, side
// chats, the thread tree, temporary purge, search filters, projects, sources and memory
// (FR-019, FR-020, FR-025, FR-026, FR-027, FR-032, FR-033, FR-034, FR-040).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider, type MockProviderOptions } from '@nova/providers';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig, type HubConfig } from '../src/config.ts';

const HOST = { host: '127.0.0.1:7419' };
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let config: HubConfig;
let auth: Record<string, string>;

async function makeHub(mockOpts: MockProviderOptions = {}): Promise<Hub> {
  const mock = new MockProvider({ id: 'mock', timing: 'instant', ...mockOpts });
  return buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    providerFactory: ({ row }) => (row.provider === 'mock' ? mock : undefined),
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-m2-'));
  config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await makeHub();
  auth = await signIn();
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function slowHub(): Promise<void> {
  await hub.app.close();
  hub = await makeHub({ timing: { chunkDelayMs: 15 } });
  auth = await signIn();
}

const get = (url: string, headers = auth) => hub.app.inject({ method: 'GET', url, headers });
const send = (
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT',
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

async function newThread(body: object = {}): Promise<{ id: string }> {
  const res = await send('POST', '/api/v1/threads', body);
  expect(res.statusCode).toBe(201);
  return res.json();
}

interface Sent {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  disposition: string;
}

async function say(threadId: string, text: string): Promise<Sent> {
  const res = await send('POST', `/api/v1/threads/${threadId}/messages`, { text });
  expect(res.statusCode).toBe(202);
  await hub.chat.idle();
  return res.json<Sent>();
}

const detail = async (id: string) => (await get(`/api/v1/threads/${id}`)).json();

describe('auth on every M2 route (FR-192)', () => {
  it.each([
    ['GET', '/api/v1/threads/x/queue'],
    ['DELETE', '/api/v1/threads/x/queue/q'],
    ['POST', '/api/v1/threads/x/messages/m/edit'],
    ['POST', '/api/v1/threads/x/messages/m/regenerate'],
    ['POST', '/api/v1/threads/x/active'],
    ['DELETE', '/api/v1/threads/x/messages/m'],
    ['POST', '/api/v1/threads/x/branch'],
    ['GET', '/api/v1/threads/x/tree'],
    ['POST', '/api/v1/threads/x/side'],
    ['GET', '/api/v1/projects'],
    ['POST', '/api/v1/projects'],
    ['GET', '/api/v1/projects/x'],
    ['PATCH', '/api/v1/projects/x'],
    ['DELETE', '/api/v1/projects/x'],
    ['GET', '/api/v1/projects/x/sources'],
    ['POST', '/api/v1/projects/x/sources'],
    ['POST', '/api/v1/sources/x/reindex'],
    ['DELETE', '/api/v1/sources/x'],
    ['GET', '/api/v1/memory/items'],
    ['POST', '/api/v1/memory/items'],
    ['PATCH', '/api/v1/memory/items/x'],
    ['DELETE', '/api/v1/memory/items/x'],
    ['POST', '/api/v1/memory/import'],
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

describe('follow-up queue (FR-019)', () => {
  it('queues while a turn runs, lists, cancels and then runs the rest', async () => {
    await slowHub();
    const t = await newThread();
    await send('POST', `/api/v1/threads/${t.id}/messages`, {
      text: Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '),
    });
    const a = (await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'one' })).json();
    const b = (await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'two' })).json();
    expect([a.disposition, a.queuePosition, b.queuePosition]).toEqual(['queued', 1, 2]);
    const queue = (await get(`/api/v1/threads/${t.id}/queue`)).json().items;
    expect(queue.map((q: { text: string; position: number }) => [q.text, q.position])).toEqual([
      ['one', 1],
      ['two', 2],
    ]);
    expect((await detail(t.id)).queue).toHaveLength(2);
    expect(
      (await send('DELETE', `/api/v1/threads/${t.id}/queue/${a.userMessageId}`)).json(),
    ).toEqual({ ok: true });
    expect(
      (await send('DELETE', `/api/v1/threads/${t.id}/queue/${a.userMessageId}`)).statusCode,
    ).toBe(404);
    await hub.chat.idle();
    const msgs = (await detail(t.id)).messages;
    expect(msgs).toHaveLength(4);
    expect(msgs[2]).toMatchObject({ id: b.userMessageId, provenance: 'queued' });
    expect((await get('/api/v1/threads/missing/queue')).statusCode).toBe(404);
    const names = (await get('/api/v1/events')).json().events.map((e: { name: string }) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'chat.followup.queued',
        'chat.followup.started',
        'chat.followup.cancelled',
      ]),
    );
  });

  it('steers the running turn when asked', async () => {
    await slowHub();
    const t = await newThread();
    const first = (
      await send('POST', `/api/v1/threads/${t.id}/messages`, {
        text: Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '),
      })
    ).json();
    const steer = await send('POST', `/api/v1/threads/${t.id}/messages`, {
      text: 'shorter please',
      inputMode: 'steer',
    });
    expect(steer.statusCode).toBe(202);
    expect(steer.json()).toMatchObject({
      disposition: 'steered',
      turnId: first.turnId,
      assistantMessageId: null,
    });
    await hub.chat.idle();
    const msgs = (await detail(t.id)).messages;
    expect(msgs.map((m: { role: string; provenance?: string }) => [m.role, m.provenance])).toEqual([
      ['user', 'typed'],
      ['assistant', undefined],
      ['user', 'steer'],
      ['assistant', undefined],
    ]);
    expect(
      (await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'x', inputMode: 'later' }))
        .statusCode,
    ).toBe(400);
  });
});

describe('versions and delete (FR-020)', () => {
  it('edits, regenerates, selects a version and deletes', async () => {
    const t = await newThread();
    const a = await say(t.id, 'first question');
    const edit = await send('POST', `/api/v1/threads/${t.id}/messages/${a.userMessageId}/edit`, {
      text: 'better question',
    });
    expect(edit.statusCode).toBe(202);
    await hub.chat.idle();
    let d = await detail(t.id);
    expect(d.messages[0].siblingIds).toEqual([a.userMessageId, edit.json().userMessageId]);

    const regen = await send(
      'POST',
      `/api/v1/threads/${t.id}/messages/${edit.json().assistantMessageId}/regenerate`,
    );
    expect(regen.statusCode).toBe(202);
    expect(regen.json().userMessageId).toBe(edit.json().userMessageId);
    await hub.chat.idle();
    d = await detail(t.id);
    expect(d.messages[1].siblingIds).toHaveLength(2);

    const back = await send('POST', `/api/v1/threads/${t.id}/active`, {
      messageId: a.userMessageId,
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().messages.map((m: { id: string }) => m.id)).toEqual([
      a.userMessageId,
      a.assistantMessageId,
    ]);

    expect(
      (await send('DELETE', `/api/v1/threads/${t.id}/messages/${a.userMessageId}`)).json(),
    ).toEqual({ ok: true });
    expect((await detail(t.id)).messages).toEqual([]);
    expect(
      (await send('DELETE', `/api/v1/threads/${t.id}/messages/${a.userMessageId}`)).statusCode,
    ).toBe(404);
  });

  it('validates bodies and answers 409 while a turn runs', async () => {
    const t = await newThread();
    const a = await say(t.id, 'hello');
    const edit = (body: unknown) =>
      send('POST', `/api/v1/threads/${t.id}/messages/${a.userMessageId}/edit`, body);
    expect((await edit({})).statusCode).toBe(400);
    expect((await edit({ text: '' })).statusCode).toBe(400);
    expect((await send('POST', `/api/v1/threads/${t.id}/active`, {})).statusCode).toBe(400);
    expect(
      (await send('POST', `/api/v1/threads/${t.id}/messages/nope/regenerate`, {})).statusCode,
    ).toBe(404);
    expect(
      (await send('POST', `/api/v1/threads/${t.id}/messages/${a.userMessageId}/regenerate`, {}))
        .statusCode,
    ).toBe(400);

    await slowHub();
    const s = await newThread();
    const b = await say(s.id, 'hi');
    await send('POST', `/api/v1/threads/${s.id}/messages`, {
      text: Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '),
    });
    const busy = await send('POST', `/api/v1/threads/${s.id}/messages/${b.userMessageId}/edit`, {
      text: 'x',
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('conflict');
    expect(
      (await send('DELETE', `/api/v1/threads/${s.id}/messages/${b.userMessageId}`)).statusCode,
    ).toBe(409);
    await hub.chat.idle();
  });
});

describe('branches, side chats and the tree (FR-020, FR-026, FR-033)', () => {
  it('branches from a message and shows the lineage', async () => {
    const t = await newThread({ title: 'Trip' });
    const a = await say(t.id, 'plan a trip');
    await say(t.id, 'add a museum');
    const res = await send('POST', `/api/v1/threads/${t.id}/branch`, {
      fromMessageId: a.assistantMessageId,
    });
    expect(res.statusCode).toBe(201);
    const branch = res.json();
    expect(branch).toMatchObject({
      title: 'Branch: Trip',
      parentThreadId: t.id,
      branchFromMessageId: a.assistantMessageId,
    });
    const inherited = (await detail(branch.id)).messages;
    expect(inherited.map((m: { threadId: string }) => m.threadId)).toEqual([t.id, t.id]);
    await say(branch.id, 'beach instead');
    expect((await detail(branch.id)).messages).toHaveLength(4);
    expect((await detail(t.id)).messages).toHaveLength(4);

    const tree = (await get(`/api/v1/threads/${branch.id}/tree`)).json();
    expect(tree.rootThreadId).toBe(t.id);
    expect(tree.nodes.map((n: { threadId: string }) => n.threadId)).toEqual([t.id, branch.id]);
    const names = (await get('/api/v1/events')).json().events.map((e: { name: string }) => e.name);
    expect(names).toContain('chat.branch.created');

    expect((await send('POST', `/api/v1/threads/${t.id}/branch`, {})).statusCode).toBe(400);
    expect(
      (await send('POST', `/api/v1/threads/${t.id}/branch`, { fromMessageId: 'nope' })).statusCode,
    ).toBe(404);
    expect((await get('/api/v1/threads/missing/tree')).statusCode).toBe(404);
  });

  it('runs a side chat that is never listed and adds nothing to the parent', async () => {
    const t = await newThread();
    await say(t.id, 'main thread');
    const res = await send('POST', `/api/v1/threads/${t.id}/side`, { text: 'side question' });
    expect(res.statusCode).toBe(201);
    const side = res.json();
    expect(side.thread).toMatchObject({ side: true, memoryOptOut: true, parentThreadId: t.id });
    expect(side.send).toMatchObject({ disposition: 'started' });
    await hub.chat.idle();
    expect((await detail(t.id)).messages).toHaveLength(2);
    expect((await detail(side.thread.id)).messages).toHaveLength(2);
    const list = (await get('/api/v1/threads')).json().items.map((x: { id: string }) => x.id);
    expect(list).toEqual([t.id]);
    const tree = (await get(`/api/v1/threads/${t.id}/tree`)).json();
    expect(tree.nodes.find((n: { side: boolean }) => n.side).threadId).toBe(side.thread.id);
    expect((await send('POST', `/api/v1/threads/${t.id}/side`, { text: '' })).statusCode).toBe(400);
    expect((await send('POST', '/api/v1/threads/missing/side', { text: 'x' })).statusCode).toBe(
      404,
    );
  });
});

describe('temporary chats and search (FR-025, FR-027)', () => {
  it('purges a temporary chat on delete', async () => {
    const t = await newThread({ temporary: true });
    await say(t.id, 'forget me soon');
    expect((await send('DELETE', `/api/v1/threads/${t.id}`)).json()).toEqual({ ok: true });
    expect((await get(`/api/v1/threads/${t.id}`)).statusCode).toBe(404);
    expect(db.raw.prepare('SELECT count(*) AS n FROM thread').get()).toEqual({ n: 0 });
    expect(db.raw.prepare('SELECT count(*) AS n FROM message').get()).toEqual({ n: 0 });
  });

  it('filters search by project and reports role and project', async () => {
    const p = (await send('POST', '/api/v1/projects', { name: 'Kitchen' })).json();
    const inside = await newThread({ projectId: p.id });
    const outside = await newThread();
    await say(inside.id, 'saffron risotto');
    await say(outside.id, 'saffron tea');
    const all = (await get('/api/v1/search?q=saffron')).json().items;
    expect(all).toHaveLength(4);
    const scoped = (await get(`/api/v1/search?q=saffron&projectId=${p.id}`)).json().items;
    expect(
      scoped.map((h: { threadId: string; projectId: string }) => [h.threadId, h.projectId]),
    ).toEqual([
      [inside.id, p.id],
      [inside.id, p.id],
    ]);
    expect(new Set(scoped.map((h: { role: string }) => h.role))).toEqual(
      new Set(['user', 'assistant']),
    );
    const listed = (await get(`/api/v1/threads?projectId=${p.id}`)).json().items;
    expect(listed.map((x: { id: string }) => x.id)).toEqual([inside.id]);
  });
});

describe('projects and sources (FR-034, FR-040)', () => {
  it('creates, reads, updates and deletes projects, with validation', async () => {
    const created = await send('POST', '/api/v1/projects', {
      name: 'Garden',
      instructions: 'Be brief.',
      memoryScope: 'project_only',
    });
    expect(created.statusCode).toBe(201);
    const p = created.json();
    expect(p).toMatchObject({ name: 'Garden', memoryScope: 'project_only', threadCount: 0 });
    expect((await get('/api/v1/projects')).json().items).toHaveLength(1);
    expect((await get(`/api/v1/projects/${p.id}`)).json().name).toBe('Garden');
    const patched = await send('PATCH', `/api/v1/projects/${p.id}`, { name: 'Yard' });
    expect(patched.json()).toMatchObject({ name: 'Yard', memoryScope: 'project_only' });
    // The memory scope is fixed at creation (FR-205): PATCH rejects it.
    expect(
      (await send('PATCH', `/api/v1/projects/${p.id}`, { memoryScope: 'shared' })).statusCode,
    ).toBe(400);
    expect((await send('PATCH', `/api/v1/projects/${p.id}`, {})).statusCode).toBe(400);
    expect((await send('POST', '/api/v1/projects', { name: '  ' })).statusCode).toBe(400);
    expect(
      (await send('POST', '/api/v1/projects', { name: 'x', memoryScope: 'team' })).statusCode,
    ).toBe(400);
    const t = await newThread({ projectId: p.id });
    expect((await send('DELETE', `/api/v1/projects/${p.id}`)).json()).toEqual({ ok: true });
    expect((await get(`/api/v1/projects/${p.id}`)).statusCode).toBe(404);
    expect((await detail(t.id)).thread.projectId).toBeNull();
  });

  it('adds, lists, reindexes and deletes sources; indexing emits status events', async () => {
    const p = (await send('POST', '/api/v1/projects', { name: 'Docs' })).json();
    const text = await send('POST', `/api/v1/projects/${p.id}/sources`, {
      kind: 'text',
      name: 'policy.md',
      text: 'Refunds are allowed within 30 days of purchase.',
    });
    expect(text.statusCode).toBe(201);
    expect(text.json().status).toBe('pending');
    const big = 'line of handbook text\n'.repeat(70_000); // > 1 MB as base64
    const file = await send('POST', `/api/v1/projects/${p.id}/sources`, {
      kind: 'file',
      name: 'handbook.txt',
      mime: 'text/plain',
      data: b64(big),
    });
    expect(file.statusCode).toBe(201);
    const image = await send('POST', `/api/v1/projects/${p.id}/sources`, {
      kind: 'file',
      name: 'pic.gif',
      mime: 'image/gif',
      data: b64('GIF89a....'),
    });
    expect(image.statusCode).toBe(201);
    await hub.sources.idle();
    const list = (await get(`/api/v1/projects/${p.id}/sources`)).json().items;
    expect(list.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ['policy.md', 'ready'],
      ['handbook.txt', 'ready'],
      ['pic.gif', 'error'],
    ]);
    expect(list[2].error).toBe('This file type cannot be indexed yet');

    const re = await send('POST', `/api/v1/sources/${text.json().id}/reindex`);
    expect(re.json().status).toBe('pending');
    await hub.sources.idle();

    // A project chat answers with the source and cites it.
    const t = await newThread({ projectId: p.id });
    const r = await say(t.id, 'What is the refund window?');
    const reply = (await detail(t.id)).messages.find(
      (m: { id: string }) => m.id === r.assistantMessageId,
    );
    expect(reply.citations[0]).toMatchObject({
      idx: 1,
      sourceId: text.json().id,
      title: 'policy.md',
    });

    expect((await send('DELETE', `/api/v1/sources/${text.json().id}`)).json()).toEqual({
      ok: true,
    });
    expect((await send('DELETE', `/api/v1/sources/${text.json().id}`)).statusCode).toBe(404);
    expect((await send('POST', `/api/v1/sources/${text.json().id}/reindex`)).statusCode).toBe(404);
    const events = (await get('/api/v1/events?limit=500')).json().events as {
      name: string;
      payload: { status: string };
    }[];
    expect(
      events.filter((e) => e.name === 'source.status.changed').map((e) => e.payload.status),
    ).toEqual(expect.arrayContaining(['pending', 'indexing', 'ready', 'error']));

    expect(
      (await send('POST', `/api/v1/projects/${p.id}/sources`, { kind: 'url', url: 'x' }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await send('POST', '/api/v1/projects/missing/sources', {
          kind: 'text',
          name: 'a',
          text: 'b',
        })
      ).statusCode,
    ).toBe(404);
    expect((await get('/api/v1/projects/missing/sources')).statusCode).toBe(404);
  });
});

describe('memory (FR-032)', () => {
  it('lists, creates, patches, deletes and imports items, with validation', async () => {
    const created = await send('POST', '/api/v1/memory/items', {
      content: 'Prefers aisle seats',
      category: 'travel',
    });
    expect(created.statusCode).toBe(201);
    const item = created.json();
    expect(item).toMatchObject({ scopeKind: 'global', sourceKind: 'manual', pinned: false });
    expect((await send('POST', '/api/v1/memory/items', { content: '' })).statusCode).toBe(400);
    expect(
      (await send('POST', '/api/v1/memory/items', { content: 'x', scopeKind: 'agent' })).statusCode,
    ).toBe(400);

    const pinned = await send('PATCH', `/api/v1/memory/items/${item.id}`, { pinned: true });
    expect(pinned.json().pinned).toBe(true);
    expect((await send('PATCH', `/api/v1/memory/items/${item.id}`, {})).statusCode).toBe(400);
    expect((await send('PATCH', '/api/v1/memory/items/missing', { pinned: true })).statusCode).toBe(
      404,
    );

    const imported = await send('POST', '/api/v1/memory/import', {
      format: 'text',
      data: 'Has a cat\nprefers aisle seats\n',
    });
    expect(imported.json()).toEqual({ imported: 1, skipped: 1 });
    expect(
      (await send('POST', '/api/v1/memory/import', { format: 'json', data: 'nope' })).statusCode,
    ).toBe(400);
    expect(
      (await send('POST', '/api/v1/memory/import', { format: 'csv', data: 'x' })).statusCode,
    ).toBe(400);

    const all = (await get('/api/v1/memory/items')).json().items;
    expect(all.map((m: { content: string }) => m.content)).toEqual([
      'Prefers aisle seats',
      'Has a cat',
    ]);
    expect((await get('/api/v1/memory/items?q=cat')).json().items).toHaveLength(1);
    expect((await get('/api/v1/memory/items?category=travel')).json().items).toHaveLength(1);
    expect((await get('/api/v1/memory/items?scope=global')).json().items).toHaveLength(2);
    expect((await get('/api/v1/memory/items?status=gone')).statusCode).toBe(400);

    expect((await send('DELETE', `/api/v1/memory/items/${item.id}`)).json()).toEqual({ ok: true });
    expect((await send('DELETE', `/api/v1/memory/items/${item.id}`)).statusCode).toBe(404);
  });

  it('extracts memory from chats and leaves temporary chats out', async () => {
    const t = await newThread();
    await say(t.id, 'My name is Robin.');
    const temp = await newThread({ temporary: true });
    await say(temp.id, 'I live in Oslo.');
    const items = (await get('/api/v1/memory/items')).json().items;
    expect(items.map((m: { content: string }) => m.content)).toEqual(["The user's name is Robin."]);
    expect(items[0]).toMatchObject({ sourceKind: 'chat', sourceThreadId: t.id });
    const names = (await get('/api/v1/events')).json().events.map((e: { name: string }) => e.name);
    expect(names).toContain('memory.item.created');
  });

  it('turns memory off with the memory.enabled setting', async () => {
    await send('PATCH', '/api/v1/settings', { key: 'memory.enabled', value: false });
    const t = await newThread();
    await say(t.id, 'My name is Quiet.');
    expect((await get('/api/v1/memory/items')).json().items).toEqual([]);
  });

  it('uses the general.followUp setting for sends during a turn', async () => {
    await slowHub();
    await send('PATCH', '/api/v1/settings', { key: 'general.followUp', value: 'steer' });
    const t = await newThread();
    await send('POST', `/api/v1/threads/${t.id}/messages`, {
      text: Array.from({ length: 30 }, (_, i) => `w${i}`).join(' '),
    });
    const res = await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'and this' });
    expect(res.json().disposition).toBe('steered');
    await hub.chat.idle();
  });
});
