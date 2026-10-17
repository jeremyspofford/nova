import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ftsQuery, titleFrom, toPartView } from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(() => env.close());

/** Insert a message with one text part directly, bypassing the chat engine. */
function addMessage(threadId: string, text: string, createdAt = new Date().toISOString()): string {
  const id = `m-${Math.random().toString(36).slice(2)}`;
  env.db.raw
    .prepare(
      "INSERT INTO message (id, thread_id, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)",
    )
    .run(id, threadId, createdAt, createdAt);
  env.db.raw
    .prepare(
      "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES (?, ?, 0, 'text', ?, ?)",
    )
    .run(`${id}-p`, id, text, createdAt);
  return id;
}

let clock = Date.parse('2026-10-17T00:00:00.000Z');
const tick = () => {
  clock += 1000;
  env.db.raw.exec('SELECT 1');
};
function setUpdated(id: string): void {
  tick();
  env.db.raw
    .prepare('UPDATE thread SET updated_at = ? WHERE id = ?')
    .run(new Date(clock).toISOString(), id);
}

describe('ThreadService (FR-017)', () => {
  it('creates a chat with the first available model, or the configured default', async () => {
    const t = await env.threads.create(ACCOUNT, {});
    expect(t).toMatchObject({
      mode: 'chat',
      title: null,
      pinned: false,
      archived: false,
      temporary: false,
      state: 'idle',
      model: `${env.mockAccountId}/mock-fast`,
    });
    env.defaultModel.value = `${env.mockAccountId}/mock-smart`;
    expect((await env.threads.create(ACCOUNT, { title: '  Plans  ' })).model).toBe(
      `${env.mockAccountId}/mock-smart`,
    );
    env.defaultModel.value = 'gone/model';
    expect((await env.threads.create(ACCOUNT, {})).model).toBe(`${env.mockAccountId}/mock-fast`);
    const explicit = await env.threads.create(ACCOUNT, {
      mode: 'work',
      model: `${env.mockAccountId}/mock-smart`,
      reasoningLevel: 'high',
      temporary: true,
    });
    expect(explicit).toMatchObject({ mode: 'work', reasoningLevel: 'high', temporary: true });
  });

  it('rejects unknown models and projects', async () => {
    await expect(env.threads.create(ACCOUNT, { model: 'not-a-ref' })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(env.threads.create(ACCOUNT, { model: 'x/y' })).rejects.toMatchObject({
      details: { reason: 'unknown_model' },
    });
    await expect(env.threads.create(ACCOUNT, { projectId: 'p1' })).rejects.toMatchObject({
      details: { reason: 'project' },
    });
    const now = new Date().toISOString();
    env.db.raw
      .prepare(
        "INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES ('p1', ?, 'P', ?, ?)",
      )
      .run(ACCOUNT, now, now);
    expect((await env.threads.create(ACCOUNT, { projectId: 'p1' })).projectId).toBe('p1');
  });

  it('lists pinned first, then most recently updated, with cursor paging', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await env.threads.create(ACCOUNT, { title: `t${i}` });
      setUpdated(t.id);
      ids.push(t.id);
    }
    await env.threads.update(ACCOUNT, ids[1]!, { pinned: true });
    const first = await env.threads.list(ACCOUNT, { limit: 2 });
    expect(first.items.map((t) => t.title)).toEqual(['t1', 't4']);
    expect(first.nextCursor).not.toBeNull();
    const second = await env.threads.list(ACCOUNT, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((t) => t.title)).toEqual(['t3', 't2']);
    const third = await env.threads.list(ACCOUNT, { limit: 2, cursor: second.nextCursor! });
    expect(third.items.map((t) => t.title)).toEqual(['t0']);
    expect(third.nextCursor).toBeNull();
    await expect(env.threads.list(ACCOUNT, { cursor: 'garbage' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('filters by mode, archived and text', async () => {
    const a = await env.threads.create(ACCOUNT, { title: 'Garden 100% plan' });
    const b = await env.threads.create(ACCOUNT, { mode: 'code', title: 'Refactor' });
    const c = await env.threads.create(ACCOUNT, { title: 'Misc' });
    addMessage(c.id, 'tomatoes need full sun');
    await env.threads.update(ACCOUNT, b.id, { archived: true });
    expect((await env.threads.list(ACCOUNT)).items.map((t) => t.id).sort()).toEqual(
      [a.id, c.id].sort(),
    );
    expect((await env.threads.list(ACCOUNT, { archived: true })).items.map((t) => t.id)).toEqual([
      b.id,
    ]);
    expect((await env.threads.list(ACCOUNT, { mode: 'code', archived: true })).items).toHaveLength(
      1,
    );
    expect((await env.threads.list(ACCOUNT, { q: 'garden' })).items.map((t) => t.id)).toEqual([
      a.id,
    ]);
    expect((await env.threads.list(ACCOUNT, { q: 'tomato' })).items.map((t) => t.id)).toEqual([
      c.id,
    ]);
    expect((await env.threads.list(ACCOUNT, { q: '100%' })).items.map((t) => t.id)).toEqual([a.id]);
    expect((await env.threads.list(ACCOUNT, { q: '%' })).items.map((t) => t.id)).toEqual([a.id]);
    expect((await env.threads.list(ACCOUNT, { q: '_' })).items).toEqual([]);
  });

  it('renames, pins, archives and changes the model; flags do not count as activity', async () => {
    const t = await env.threads.create(ACCOUNT, {});
    const pinned = await env.threads.update(ACCOUNT, t.id, { pinned: true, unread: true });
    expect(pinned).toMatchObject({ pinned: true, unread: true, updatedAt: t.updatedAt });
    const renamed = await env.threads.update(ACCOUNT, t.id, {
      title: 'Renamed',
      model: `${env.mockAccountId}/mock-smart`,
      reasoningLevel: 'low',
    });
    expect(renamed).toMatchObject({
      title: 'Renamed',
      model: `${env.mockAccountId}/mock-smart`,
      reasoningLevel: 'low',
    });
    expect((await env.threads.update(ACCOUNT, t.id, { title: '   ' })).title).toBeNull();
    await expect(env.threads.update(ACCOUNT, t.id, { model: 'a/b' })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(env.threads.update(ACCOUNT, 'missing', { pinned: true })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('soft-deletes a thread and its messages', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'gone' });
    addMessage(t.id, 'secret recipe');
    await env.threads.remove(ACCOUNT, t.id);
    expect((await env.threads.list(ACCOUNT)).items).toEqual([]);
    await expect(env.threads.detail(ACCOUNT, t.id)).rejects.toMatchObject({ code: 'not_found' });
    const row = env.db.raw
      .prepare('SELECT deleted_at FROM message WHERE thread_id = ?')
      .get(t.id) as {
      deleted_at: string | null;
    };
    expect(row.deleted_at).not.toBeNull();
    expect(env.threads.search(ACCOUNT, 'recipe')).toEqual([]);
  });

  it('scopes threads to their account', async () => {
    const t = await env.threads.create(ACCOUNT, {});
    await expect(env.threads.view('someone-else', t.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('search (FR-017, FR-027)', () => {
  it('finds messages with snippets, newest first, excluding temporary and deleted threads', async () => {
    const a = await env.threads.create(ACCOUNT, { title: 'Cooking' });
    const tmp = await env.threads.create(ACCOUNT, { title: 'Temp', temporary: true });
    const old = addMessage(
      a.id,
      'The best banana bread uses ripe bananas.',
      '2026-01-01T00:00:00.000Z',
    );
    const recent = addMessage(a.id, 'Banana pancakes on Sunday', '2026-02-01T00:00:00.000Z');
    addMessage(tmp.id, 'banana in a temporary chat');
    const hits = env.threads.search(ACCOUNT, 'banan');
    expect(hits.map((h) => h.messageId)).toEqual([recent, old]);
    expect(hits[0]).toMatchObject({ threadId: a.id, threadTitle: 'Cooking' });
    expect(hits[1]!.snippet.replace(/<\/?mark>/g, '')).toContain('banana bread');
    // Matches are marked for highlighting; the client renders everything else as plain text.
    expect(hits[1]!.snippet).toMatch(/<mark>[^<]+<\/mark>/);
    expect(env.threads.search(ACCOUNT, 'banana', 1)).toHaveLength(1);
    expect(env.threads.search('other-account', 'banana')).toEqual([]);
  });

  it('treats any input as plain text', async () => {
    const t = await env.threads.create(ACCOUNT, {});
    addMessage(t.id, 'use AND or NOT carefully: title "quoted" (parens) col:val');
    const weird = [
      '"',
      '""',
      '*',
      'AND',
      'NOT OR',
      'NEAR(',
      'title:',
      '(',
      ')',
      '-',
      '^x',
      '{a b}',
      '🦊',
      ' ',
      '',
    ];
    for (const q of weird) expect(() => env.threads.search(ACCOUNT, q)).not.toThrow();
    expect(env.threads.search(ACCOUNT, '"quoted"')).toHaveLength(1);
    expect(env.threads.search(ACCOUNT, 'AND NOT')).toHaveLength(1);
    expect(env.threads.search(ACCOUNT, 'col:val')).toHaveLength(1);
    expect(env.threads.search(ACCOUNT, '(parens)')).toHaveLength(1);
  });

  it('builds safe FTS queries', () => {
    expect(ftsQuery('hello wor')).toBe('"hello"* "wor"*');
    expect(ftsQuery('say "hi"')).toBe('"say"* """hi"""*');
    expect(ftsQuery('*** --- ')).toBeNull();
  });
});

describe('views', () => {
  it('derives titles and maps parts', () => {
    expect(titleFrom('  hello\n\nworld  ')).toBe('hello world');
    expect(titleFrom('x'.repeat(80))).toHaveLength(60);
    expect(titleFrom('   ')).toBeNull();
    const base = {
      id: 'p',
      messageId: 'm',
      idx: 0,
      refId: null,
      mime: null,
      blobPath: null,
      createdAt: '',
    };
    expect(toPartView({ ...base, type: 'text', content: '' })).toBeNull();
    expect(toPartView({ ...base, type: 'reasoning', content: 'r' })).toEqual({
      type: 'reasoning',
      text: 'r',
    });
    expect(toPartView({ ...base, type: 'error', content: 'not json' })).toEqual({
      type: 'error',
      code: 'provider_error',
      message: 'the response failed',
    });
    expect(toPartView({ ...base, type: 'file', content: null, refId: 'a1' })).toEqual({
      type: 'file',
      attachmentId: 'a1',
      name: 'file',
      mime: 'application/octet-stream',
      size: 0,
    });
    expect(toPartView({ ...base, type: 'plan', content: '{}' })).toBeNull();
  });
});
