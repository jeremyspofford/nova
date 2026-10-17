// Projects (FR-034) and their sources (FR-040): CRUD, instructions in context, background
// indexing states, unsupported types, reindex, retrieval and citations.
import { afterEach, describe, expect, it } from 'vitest';
import { SourceService, chunkText, orQuery, isTextSource } from '../src/index.ts';
import { ACCOUNT, PNG, b64, makeEnv, waitFor, type Env } from './helpers.ts';

let env: Env;
afterEach(() => env.close());

const systemText = () =>
  env.mock.requests
    .at(-1)!
    .messages[0]!.content.map((p) => (p.type === 'text' ? p.text : ''))
    .join('');

const NOTES = [
  'Garden plan for spring.',
  '',
  'Tomatoes go in the south bed after the last frost. Water them deeply twice a week.',
  '',
  'The shed key is under the blue pot.',
].join('\n');

describe('projects (FR-034)', () => {
  it('creates, lists, renames and deletes; chats in it stay, detached', async () => {
    env = await makeEnv();
    const a = await env.projects.create(ACCOUNT, {
      name: '  Garden  ',
      instructions: 'Answer briefly.',
    });
    expect(a).toMatchObject({
      name: 'Garden',
      instructions: 'Answer briefly.',
      memoryScope: 'shared',
      threadCount: 0,
      sourceCount: 0,
    });
    const b = await env.projects.create(ACCOUNT, { name: 'Work', memoryScope: 'project_only' });
    expect(b.memoryScope).toBe('project_only');
    const t = await env.threads.create(ACCOUNT, { projectId: a.id });
    await env.sources.add(ACCOUNT, a.id, { kind: 'text', name: 'n.md', text: 'hello' });
    expect(await env.projects.get(ACCOUNT, a.id)).toMatchObject({ threadCount: 1, sourceCount: 1 });
    expect((await env.projects.list(ACCOUNT)).map((p) => p.name)).toEqual(['Garden', 'Work']);

    const renamed = await env.projects.update(ACCOUNT, b.id, {
      name: 'Office',
      instructions: null,
    });
    expect(renamed).toMatchObject({
      name: 'Office',
      instructions: null,
      memoryScope: 'project_only',
    });
    expect((await env.projects.list(ACCOUNT))[0]!.name).toBe('Office');

    await env.projects.remove(ACCOUNT, a.id);
    await expect(env.projects.get(ACCOUNT, a.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await env.threads.view(ACCOUNT, t.id)).projectId).toBeNull();
    expect(
      (
        env.db.raw.prepare('SELECT count(*) AS n FROM source WHERE deleted_at IS NULL').get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
    await expect(env.projects.update(ACCOUNT, a.id, { name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(env.projects.get('other-account', b.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('adds the project instructions to the system prompt of every chat in it', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, {
      name: 'Pirates',
      instructions: 'Always answer like a pirate.',
    });
    const inside = await env.threads.create(ACCOUNT, { projectId: p.id });
    await env.chat.send(ACCOUNT, inside.id, { text: 'hello' });
    await env.chat.idle();
    expect(systemText()).toContain('Always answer like a pirate.');
    expect(systemText()).toContain('## Project instructions');
    expect(env.mock.requests.at(-1)!.messages.filter((m) => m.role === 'system')).toHaveLength(1);

    const outside = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, outside.id, { text: 'hello' });
    await env.chat.idle();
    expect(systemText()).not.toContain('pirate');

    // A side chat of a project chat uses the project too.
    await env.chat.sideChat(ACCOUNT, inside.id, { text: 'aside' });
    await env.chat.idle();
    expect(systemText()).toContain('Always answer like a pirate.');
  });
});

describe('sources (FR-040)', () => {
  it('indexes text in the background: pending, indexing, ready', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'Garden' });
    const s = await env.sources.add(ACCOUNT, p.id, {
      kind: 'file',
      name: 'notes.md',
      mime: 'text/markdown',
      data: b64(NOTES),
    });
    expect(s).toMatchObject({
      status: 'pending',
      chunkCount: 0,
      name: 'notes.md',
      size: NOTES.length,
    });
    await env.sources.idle();
    const [ready] = await env.sources.list(ACCOUNT, p.id);
    expect(ready).toMatchObject({ status: 'ready', chunkCount: 1, error: null });
    expect(ready!.indexedAt).not.toBeNull();
    const statuses = env.events.events
      .filter((e) => e.name === 'source.status.changed')
      .map((e) => e.payload.status);
    expect(statuses).toEqual(['pending', 'indexing', 'ready']);
  });

  it('marks unsupported and non-text files as errors, and validates uploads', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'X' });
    await env.sources.add(ACCOUNT, p.id, {
      kind: 'file',
      name: 'pic.png',
      mime: 'image/png',
      data: b64(PNG),
    });
    await env.sources.add(ACCOUNT, p.id, {
      kind: 'file',
      name: 'bad.txt',
      mime: 'text/plain',
      data: b64(Buffer.from([0xff, 0xfe, 0x00, 0x41])),
    });
    await env.sources.add(ACCOUNT, p.id, {
      kind: 'file',
      name: 'main.ts',
      mime: 'video/mp2t',
      data: b64('export const answer = 42;'),
    });
    await env.sources.idle();
    const list = await env.sources.list(ACCOUNT, p.id);
    expect(list.map((s) => [s.name, s.status, s.error])).toEqual([
      ['pic.png', 'error', 'This file type cannot be indexed yet'],
      ['bad.txt', 'error', 'This file is not UTF-8 text'],
      ['main.ts', 'ready', null],
    ]);
    const errored = env.events.events.find(
      (e) => e.name === 'source.status.changed' && e.payload.status === 'error',
    )!;
    expect(errored.payload).toMatchObject({ projectId: p.id, error: expect.any(String) });

    await expect(
      env.sources.add(ACCOUNT, p.id, { kind: 'file', name: 'x', mime: 'text/plain', data: '%%%' }),
    ).rejects.toMatchObject({ code: 'validation', details: { reason: 'encoding' } });
    await expect(
      env.sources.add(ACCOUNT, p.id, { kind: 'file', name: 'x', mime: 'text/plain', data: '' }),
    ).rejects.toMatchObject({ details: { reason: 'empty' } });
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x61);
    await expect(
      env.sources.add(ACCOUNT, p.id, {
        kind: 'file',
        name: 'x',
        mime: 'text/plain',
        data: b64(big),
      }),
    ).rejects.toMatchObject({ details: { reason: 'size' } });
    await expect(
      env.sources.add(ACCOUNT, 'missing', { kind: 'text', name: 'x', text: 'y' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reindexes on request and removes a deleted source from retrieval at once', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'Garden' });
    const s = await env.sources.add(ACCOUNT, p.id, {
      kind: 'text',
      name: 'notes.txt',
      text: NOTES,
    });
    await env.sources.idle();
    expect(env.sources.retrieve(ACCOUNT, p.id, 'where is the shed key?')).toHaveLength(1);
    const again = await env.sources.reindex(ACCOUNT, s.id);
    expect(again.status).toBe('pending');
    await env.sources.idle();
    expect((await env.sources.list(ACCOUNT, p.id))[0]!.status).toBe('ready');
    await env.sources.remove(ACCOUNT, s.id);
    expect(env.sources.retrieve(ACCOUNT, p.id, 'shed key')).toEqual([]);
    expect(await env.sources.list(ACCOUNT, p.id)).toEqual([]);
    await expect(env.sources.reindex(ACCOUNT, s.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(env.sources.remove(ACCOUNT, s.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('resumes indexing after a restart', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'Garden' });
    await env.sources.stop();
    // A stopped service stands in for the old process: the row stays pending.
    const s = await env.sources.add(ACCOUNT, p.id, {
      kind: 'text',
      name: 'notes.txt',
      text: NOTES,
    });
    await env.db.transaction(() =>
      env.db.raw.prepare("UPDATE source SET status = 'indexing' WHERE id = ?").run(s.id),
    );
    const restarted = new SourceService({
      db: env.db,
      events: env.events,
      dataDir: `${env.dir}/data`,
    });
    expect(await restarted.recover()).toBe(1);
    await restarted.idle();
    expect((await restarted.list(ACCOUNT, p.id))[0]!.status).toBe('ready');
  });

  it('retrieves matching excerpts into project chats and stores them as citations', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'Garden' });
    const s = await env.sources.add(ACCOUNT, p.id, { kind: 'text', name: 'notes.md', text: NOTES });
    await env.sources.add(ACCOUNT, p.id, {
      kind: 'text',
      name: 'other.txt',
      text: 'Nothing relevant here about cars.',
    });
    await env.sources.idle();
    const t = await env.threads.create(ACCOUNT, { projectId: p.id });
    const res = await env.chat.send(ACCOUNT, t.id, { text: 'When do tomatoes go in?' });
    await env.chat.idle();
    expect(systemText()).toContain('## Project sources');
    expect(systemText()).toContain('[1] notes.md');
    expect(systemText()).not.toContain('other.txt');
    const reply = (await env.threads.detail(ACCOUNT, t.id)).messages.find(
      (m) => m.id === res.assistantMessageId,
    )!;
    expect(reply.citations).toEqual([
      expect.objectContaining({ idx: 1, sourceId: s.id, title: 'notes.md', url: null }),
    ]);
    expect(reply.citations![0]!.snippet).toContain('Tomatoes');
    // A message with nothing to match gets no excerpts and no citations.
    const r2 = await env.chat.send(ACCOUNT, t.id, { text: 'zzz qqq' });
    await env.chat.idle();
    expect(systemText()).not.toContain('## Project sources');
    const plain = (await env.threads.detail(ACCOUNT, t.id)).messages.find(
      (m) => m.id === r2.assistantMessageId,
    )!;
    expect(plain.citations).toBeUndefined();
  });

  it('caps retrieval at five excerpts and 6,000 characters', async () => {
    env = await makeEnv();
    const p = await env.projects.create(ACCOUNT, { name: 'Big' });
    const para = (i: number) => `Section ${i}. ${'kumquat orchard notes '.repeat(60)}`;
    await env.sources.add(ACCOUNT, p.id, {
      kind: 'text',
      name: 'big.txt',
      text: Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n'),
    });
    await env.sources.idle();
    const got = env.sources.retrieve(ACCOUNT, p.id, 'kumquat orchard');
    expect(got.length).toBeLessThanOrEqual(5);
    expect(got.length).toBeGreaterThan(1);
    expect(got.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(6_000);
    expect(got.map((e) => e.idx)).toEqual(got.map((_, i) => i + 1));
  });
});

describe('chunking and queries', () => {
  it('splits on boundaries with overlap', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('short')).toEqual(['short']);
    const text = Array.from({ length: 40 }, (_, i) => `Line ${i} ${'word '.repeat(12)}`).join('\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1_500);
    for (const c of chunks.slice(0, -1)) expect(text).toContain(c);
    // Consecutive chunks overlap.
    const tail = chunks[0]!.slice(-50);
    expect(chunks[1]!.includes(tail.slice(-20))).toBe(true);
    // A long line without breaks still splits.
    expect(chunkText('x'.repeat(4_000)).every((c) => c.length <= 1_500)).toBe(true);
  });

  it('builds OR queries without stop words or operators', () => {
    expect(orQuery('What is the shed key?')).toBe('"shed"* OR "key"');
    expect(orQuery('the a of')).toBeNull();
    expect(orQuery('NEAR( "x" * AND title:foo')).toBe('"near"* OR "title"* OR "foo"');
    expect(isTextSource('a.py', 'application/octet-stream')).toBe(true);
    expect(isTextSource('a.bin', 'application/octet-stream')).toBe(false);
  });
});

describe('retrieval safety', () => {
  it('never crosses projects or accounts', async () => {
    env = await makeEnv();
    const a = await env.projects.create(ACCOUNT, { name: 'A' });
    const b = await env.projects.create(ACCOUNT, { name: 'B' });
    await env.sources.add(ACCOUNT, a.id, { kind: 'text', name: 'a.txt', text: 'secret walnut' });
    await env.sources.idle();
    await waitFor(() => env.sources.retrieve(ACCOUNT, a.id, 'walnut').length === 1);
    expect(env.sources.retrieve(ACCOUNT, b.id, 'walnut')).toEqual([]);
    expect(env.sources.retrieve('someone-else', a.id, 'walnut')).toEqual([]);
    await expect(env.sources.list('someone-else', a.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
