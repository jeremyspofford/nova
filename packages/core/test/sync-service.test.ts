// Sync (FR-109, FR-129, FR-112; docs/13 §2, ADR-010): the change feed records every Hub-side write
// with a growing cursor and per-field clocks; deletes are tombstones; pushed ops merge per field,
// last writer wins, with the value that lost in the merge log; restore writes it back; messages
// are append-only; skewed device clocks are refused; replicas are reset, revoked and reported.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, type SyncChangeView, type SyncOp } from '@nova/shared';
import { compareHlc, parseHlc } from '../src/index.ts';
import {
  ACCOUNT,
  DEV_A,
  DEV_B,
  DEV_OTHER,
  OTHER,
  PLAIN_SETTING,
  SECURITY_SETTING,
  syncEnv,
  type SyncEnv,
} from './sync-env.ts';

let env: SyncEnv;

beforeEach(async () => {
  env = await syncEnv();
});

afterEach(async () => {
  await env.close();
});

async function pull(device = DEV_A, since = 0): Promise<SyncChangeView[]> {
  await env.sync.flush();
  const out: SyncChangeView[] = [];
  let cursor = since;
  for (;;) {
    const page = await env.sync.changes(ACCOUNT, device, cursor, 100);
    out.push(...page.changes);
    cursor = page.cursor;
    if (!page.more) return out;
  }
}

const field = (changes: SyncChangeView[], kind: string, id: string, name: string) =>
  changes.filter((c) => c.kind === kind && c.id === id && c.field === name).at(-1);

async function newPage(title = 'Notes', content = 'v0') {
  const space = await env.spaces.createSpace(ACCOUNT, { name: 'Home' });
  return env.spaces.createPage(ACCOUNT, space.id, { title, content });
}

function push(device: string, ops: SyncOp[]) {
  return env.sync.push(ACCOUNT, device, ops);
}

describe('change feed', () => {
  it('records Hub-side writes with growing cursors and per-field clocks', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'First' });
    const first = await pull();
    expect(field(first, 'thread', t.id, 'title')).toMatchObject({ value: 'First', deviceId: null });
    expect(field(first, 'thread', t.id, 'pinned')?.value).toBe(false);
    expect(field(first, 'thread', t.id, 'mode')?.value).toBe('chat');
    const cursor = first.at(-1)!.cursor;
    const titleClock = field(first, 'thread', t.id, 'title')!.hlc;

    // Pinning does not move updated_at; the service's event is what tells sync.
    await env.threads.update(ACCOUNT, t.id, { pinned: true });
    const next = await pull(DEV_A, cursor);
    expect(next.map((c) => [c.field, c.value])).toEqual([['pinned', true]]);
    expect(next[0]!.cursor).toBeGreaterThan(cursor);
    expect(compareHlc(next[0]!.hlc, titleClock)).toBeGreaterThan(0);
    // Nothing else changed: pulling again gives nothing.
    expect(await pull(DEV_A, next[0]!.cursor)).toEqual([]);
  });

  it('feeds projects, memory, pages, schedules and plain settings, but not temporary chats', async () => {
    const p = await env.projects.create(ACCOUNT, { name: 'Garden', instructions: 'Be brief' });
    const m = await env.memory.create(ACCOUNT, { content: 'Likes tea' });
    const page = await newPage('Shopping', 'milk');
    const s = await env.schedules.create(ACCOUNT, {
      when: { cron: '0 9 * * *' },
      timezone: 'UTC',
      instructions: 'Summarize the news',
      deliveryTargets: [{ kind: 'inapp' }],
    });
    const temp = await env.threads.create(ACCOUNT, { title: 'Secret', temporary: true });
    env.db.raw
      .prepare(
        "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES (?, 'global', '', ?, ?), (?, 'global', '', ?, ?)",
      )
      .run(PLAIN_SETTING, '"dark"', 'x', SECURITY_SETTING, 'false', 'x');
    await env.sync.sweep();
    const all = await pull();
    expect(field(all, 'project', p.id, 'name')?.value).toBe('Garden');
    expect(field(all, 'project', p.id, 'instructions')?.value).toBe('Be brief');
    expect(field(all, 'memory', m.id, 'content')?.value).toBe('Likes tea');
    expect(field(all, 'memory', m.id, 'status')?.value).toBe('active');
    expect(field(all, 'page', page.id, 'content')?.value).toBe('milk');
    expect(field(all, 'page', page.id, 'space')?.value).toBe(page.spaceId);
    expect(field(all, 'schedule', s.id, 'enabled')?.value).toBe(true);
    expect(field(all, 'setting', PLAIN_SETTING, 'value')?.value).toBe('dark');
    expect(all.some((c) => c.id === SECURITY_SETTING)).toBe(false);
    expect(all.some((c) => c.id === temp.id)).toBe(false);
    // Only the owner's account holds global settings; another account sees none of this.
    const theirs = await env.sync.changes(OTHER, DEV_OTHER, 0, 100);
    expect(theirs.changes).toEqual([]);
  });

  it('feeds finished messages of a chat, never the streaming ones', async () => {
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'Hello there, how are you today?' });
    await env.chat.idle();
    const all = await pull();
    const bodies = all
      .filter((c) => c.kind === 'message')
      .map((c) => c.value as { role: string; text: string; status: string });
    expect(bodies.map((b) => b.role)).toEqual(['user', 'assistant']);
    expect(bodies[0]!.text).toBe('Hello there, how are you today?');
    expect(bodies.every((b) => b.status !== 'streaming')).toBe(true);
    // The first message titled the chat.
    expect(field(all, 'thread', t.id, 'title')?.value).toBeTruthy();
  });

  it('turns deletes into tombstones: a thread takes its messages, a project leaves its chats', async () => {
    const p = await env.projects.create(ACCOUNT, { name: 'Work' });
    const t = await env.threads.create(ACCOUNT, { title: 'In project', projectId: p.id });
    const u = await env.threads.create(ACCOUNT, { title: 'Doomed' });
    await env.chat.send(ACCOUNT, u.id, { text: 'one message here please' });
    await env.chat.idle();
    const m = await env.memory.create(ACCOUNT, { content: 'Forget me' });
    const before = await pull();
    const cursor = before.at(-1)!.cursor;
    expect(before.some((c) => c.kind === 'message')).toBe(true);

    await env.threads.remove(ACCOUNT, u.id);
    await env.memory.remove(ACCOUNT, m.id);
    await env.projects.remove(ACCOUNT, p.id);
    const after = await pull(DEV_A, cursor);
    expect(field(after, 'thread', u.id, '_deleted')?.value).toBe(true);
    expect(field(after, 'memory', m.id, '_deleted')?.value).toBe(true);
    expect(field(after, 'project', p.id, '_deleted')?.value).toBe(true);
    expect(field(after, 'thread', t.id, 'project')?.value).toBeNull();
    // Only the tombstone is left of the thread and nothing of its messages.
    const everything = await pull();
    expect(everything.filter((c) => c.id === u.id).map((c) => c.field)).toEqual(['_deleted']);
    expect(everything.some((c) => c.kind === 'message')).toBe(false);
  });

  it('finds writes that sent no event with the sweep', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'Before' });
    const first = await pull();
    env.db.raw.prepare("UPDATE thread SET title = 'Edited by hand' WHERE id = ?").run(t.id);
    expect(await pull(DEV_A, first.at(-1)!.cursor)).toEqual([]);
    expect(await env.sync.sweep()).toBeGreaterThan(0);
    const later = await pull(DEV_A, first.at(-1)!.cursor);
    expect(later.map((c) => [c.field, c.value])).toEqual([['title', 'Edited by hand']]);
    // A setting removed by hand reads as its default again.
    env.db.raw
      .prepare(
        "INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at) VALUES (?, 'global', '', '\"light\"', 'x')",
      )
      .run(PLAIN_SETTING);
    await env.sync.sweep();
    env.db.raw.prepare('DELETE FROM setting WHERE key = ?').run(PLAIN_SETTING);
    await env.sync.sweep();
    const all = await pull();
    expect(field(all, 'setting', PLAIN_SETTING, 'value')?.value).toBe(
      SETTINGS[PLAIN_SETTING].default,
    );
  });

  it('keeps its clock and cursor across a restart', async () => {
    await env.threads.create(ACCOUNT, { title: 'One' });
    await env.sync.flush();
    const clock = env.sync.clock();
    const cursor = env.sync.cursor();
    env.clock.t -= 3_600_000; // the wall clock stepped back
    const again = env.restart();
    expect(again.cursor()).toBe(cursor);
    expect(again.clock()).toBe(clock);
    await again.close();
  });
});

describe('push: per-field last writer wins', () => {
  it('applies a newer op through the service and records the device and its clock', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'Old' });
    const base = field(await pull(), 'thread', t.id, 'title')!.hlc;
    env.clock.t += 1000;
    const op = env.op(DEV_A, 'thread', t.id, 'title', 'New', { base });
    const res = await push(DEV_A, [op]);
    expect(res.results).toEqual([
      { index: 0, kind: 'thread', id: t.id, field: 'title', status: 'accepted', hlc: op.hlc },
    ]);
    expect((await env.threads.view(ACCOUNT, t.id)).title).toBe('New');
    const fed = field(await pull(DEV_B), 'thread', t.id, 'title')!;
    expect(fed).toMatchObject({ value: 'New', hlc: op.hlc, deviceId: DEV_A });
    expect(await env.sync.mergeLog(ACCOUNT, { status: 'all', limit: 10 })).toEqual([]);
    // The Hub's clock is now past the device's.
    expect(compareHlc(res.hlc, op.hlc)).toBeGreaterThan(0);
  });

  it('keeps the loser of concurrent edits to one page field in the merge log, and restore brings it back', async () => {
    const page = await newPage('Notes', 'v0');
    const base = field(await pull(), 'page', page.id, 'content')!.hlc;
    env.clock.t += 1000;
    // A and B both edit from v0; B's clock is later, so B wins.
    const a = env.op(DEV_A, 'page', page.id, 'content', 'from A', { base, offsetMs: 0 });
    const b = env.op(DEV_B, 'page', page.id, 'content', 'from B', { base, offsetMs: 10 });
    const ra = await push(DEV_A, [a]);
    expect(ra.results[0]!.status).toBe('accepted');
    const rb = await push(DEV_B, [b]);
    expect(rb.results[0]).toMatchObject({ status: 'accepted', hlc: b.hlc });
    expect(rb.results[0]!.entryId).toBeTruthy();
    expect((await env.spaces.getPage(ACCOUNT, page.spaceId, page.id)).content).toBe('from B');
    const [entry] = await env.sync.mergeLog(ACCOUNT, { status: 'open', limit: 10 });
    expect(entry).toMatchObject({
      kind: 'page',
      entityId: page.id,
      field: 'content',
      reason: 'concurrent',
      lost: { value: 'from A', hlc: a.hlc, deviceId: DEV_A, deviceName: 'Device da' },
      winner: { value: 'from B', hlc: b.hlc, deviceId: DEV_B },
      status: 'open',
    });
    expect(env.events.names()).toContain('sync.conflict');

    // Restore writes A's value as a new change, later than both, and keeps B's in the log.
    env.clock.t += 1000;
    const restored = await env.sync.restore(ACCOUNT, entry!.id, { actor: 'user', deviceId: null });
    expect(restored.status).toBe('restored');
    expect((await env.spaces.getPage(ACCOUNT, page.spaceId, page.id)).content).toBe('from A');
    const now = field(await pull(DEV_B), 'page', page.id, 'content')!;
    expect(now.value).toBe('from A');
    expect(compareHlc(now.hlc, b.hlc)).toBeGreaterThan(0);
    const log = await env.sync.mergeLog(ACCOUNT, { status: 'all', limit: 10 });
    expect(log.map((e) => [e.reason, e.lost.value, e.status])).toEqual([
      ['restore', 'from B', 'open'],
      ['concurrent', 'from A', 'restored'],
    ]);
    expect(
      env.audit.some((r) => r.action === 'sync.restore' && r.detail?.entryId === entry!.id),
    ).toBe(true);
    // The page's history has every version (FR-036).
    const versions = env.db.raw
      .prepare('SELECT count(*) AS n FROM space_page_version WHERE page_id = ?')
      .get(page.id) as { n: number };
    expect(versions.n).toBe(4);
    await expect(
      env.sync.restore(ACCOUNT, entry!.id, { actor: 'user', deviceId: null }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'already_restored' },
    });
  });

  it('answers an older op overwritten, with the winner, and logs its value', async () => {
    const page = await newPage();
    const base = field(await pull(), 'page', page.id, 'title')!.hlc;
    env.clock.t += 1000;
    const b = env.op(DEV_B, 'page', page.id, 'title', 'B title', { offsetMs: 50, base });
    const a = env.op(DEV_A, 'page', page.id, 'title', 'A title', { offsetMs: 0 });
    await push(DEV_B, [b]);
    const ra = await push(DEV_A, [a]);
    expect(ra.results[0]).toMatchObject({
      status: 'overwritten',
      reason: 'stale',
      hlc: b.hlc,
      value: 'B title',
    });
    const [entry] = await env.sync.mergeLog(ACCOUNT, { status: 'open', limit: 10 });
    expect(entry).toMatchObject({
      reason: 'stale',
      lost: { value: 'A title' },
      winner: { value: 'B title' },
    });
    expect(ra.results[0]!.entryId).toBe(entry!.id);
    expect(await env.sync.mergeLog(ACCOUNT, { status: 'all', limit: 10 })).toHaveLength(1);
    expect((await env.spaces.getPage(ACCOUNT, page.spaceId, page.id)).title).toBe('B title');
  });

  it('keeps a Hub value an op overwrote without having seen it', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'Hub title' });
    await pull();
    env.clock.t += 1000;
    const res = await push(DEV_A, [env.op(DEV_A, 'thread', t.id, 'title', 'Device title')]);
    expect(res.results[0]!.status).toBe('accepted');
    const [entry] = await env.sync.mergeLog(ACCOUNT, { status: 'open', limit: 10 });
    expect(entry).toMatchObject({
      reason: 'concurrent',
      lost: { value: 'Hub title', deviceId: null },
      winner: { value: 'Device title', deviceId: DEV_A },
    });
  });

  it('logs nothing for a sequential edit, a device overwriting itself, or a repeat', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'x' });
    const base = field(await pull(), 'thread', t.id, 'title')!.hlc;
    env.clock.t += 1000;
    const one = env.op(DEV_A, 'thread', t.id, 'title', 'one', { base });
    const two = env.op(DEV_A, 'thread', t.id, 'title', 'two', { c: 1 });
    const res = await push(DEV_A, [one, two]);
    expect(res.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    expect((await env.threads.view(ACCOUNT, t.id)).title).toBe('two');
    const cursor = env.sync.cursor();
    const again = await push(DEV_A, [two]);
    expect(again.results[0]).toMatchObject({ status: 'accepted', hlc: two.hlc });
    expect(env.sync.cursor()).toBe(cursor);
    // B saw "two" (base) and edits on.
    env.clock.t += 1000;
    const three = env.op(DEV_B, 'thread', t.id, 'title', 'three', { base: two.hlc });
    expect((await push(DEV_B, [three])).results[0]!.status).toBe('accepted');
    expect(await env.sync.mergeLog(ACCOUNT, { status: 'all', limit: 10 })).toEqual([]);
  });

  it('refuses a device clock far in the future, another device’s clock and bad fields', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'x' });
    const s = await env.schedules.create(ACCOUNT, {
      when: { cron: '0 9 * * *' },
      timezone: 'UTC',
      instructions: 'x',
      deliveryTargets: [{ kind: 'inapp' }],
    });
    await pull();
    const res = await push(DEV_A, [
      env.op(DEV_A, 'thread', t.id, 'title', 'from the future', { offsetMs: 10 * 60_000 }),
      env.op(DEV_B, 'thread', t.id, 'title', 'as B'),
      env.op(DEV_A, 'thread', t.id, 'mode', 'code'),
      env.op(DEV_A, 'thread', t.id, 'colour', 'red'),
      env.op(DEV_A, 'thread', t.id, 'pinned', 'yes'),
      env.op(DEV_A, 'schedule', s.id, '_deleted', true),
      env.op(DEV_A, 'setting', SECURITY_SETTING, 'value', false),
      env.op(DEV_A, 'thread', t.id, 'title', 'within the limit', { offsetMs: 4 * 60_000 }),
    ]);
    expect(res.results.map((r) => r.reason ?? r.status)).toEqual([
      'clock_skew',
      'hlc_device_mismatch',
      'read_only_field',
      'unknown_field',
      'invalid_value',
      'not_deletable',
      'not_syncable',
      'accepted',
    ]);
    expect((await env.threads.view(ACCOUNT, t.id)).title).toBe('within the limit');
    const [replica] = (await env.sync.replicas(ACCOUNT)).filter((r) => r.deviceId === DEV_A);
    expect(replica!.status).toBe('error');
    expect(replica!.lastError).toContain('7 change(s) refused');
  });

  it('writes memory, projects, schedules and settings through their services', async () => {
    const p = await env.projects.create(ACCOUNT, { name: 'P' });
    const m = await env.memory.create(ACCOUNT, { content: 'old fact' });
    const s = await env.schedules.create(ACCOUNT, {
      when: { cron: '0 9 * * *' },
      timezone: 'UTC',
      instructions: 'x',
      deliveryTargets: [{ kind: 'inapp' }],
    });
    await pull();
    env.clock.t += 1000;
    const res = await push(DEV_A, [
      env.op(DEV_A, 'project', p.id, 'name', 'Renamed'),
      env.op(DEV_A, 'memory', m.id, 'content', 'new fact'),
      env.op(DEV_A, 'memory', m.id, 'status', 'dismissed'),
      env.op(DEV_A, 'schedule', s.id, 'enabled', false),
      env.op(DEV_A, 'setting', PLAIN_SETTING, 'value', 'dark'),
      env.op(DEV_A, 'setting', 'appearance.fontScale', 'value', 99),
    ]);
    expect(res.results.map((r) => r.reason ?? r.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
      'accepted',
      'apply_failed',
    ]);
    expect((await env.projects.get(ACCOUNT, p.id)).name).toBe('Renamed');
    expect(await env.memory.get(ACCOUNT, m.id)).toMatchObject({
      content: 'new fact',
      status: 'dismissed',
    });
    expect((await env.schedules.get(ACCOUNT, s.id)).enabled).toBe(false);
    expect(env.settingsWritten).toEqual([{ key: PLAIN_SETTING, value: 'dark' }]);
  });

  it('refuses an entity of another account as unknown, and a failed write changes nothing', async () => {
    const theirs = await env.threads.create(OTHER, { title: 'Not yours' });
    const mine = await env.threads.create(ACCOUNT, { title: 'Mine' });
    await pull();
    env.clock.t += 1000;
    const res = await push(DEV_A, [
      env.op(DEV_A, 'thread', theirs.id, 'title', 'stolen'),
      env.op(DEV_A, 'thread', mine.id, 'project', '01920000-0000-7000-8000-00000000beef'),
      env.op(DEV_A, 'page', '01920000-0000-7000-8000-00000000cafe', 'title', 'nope'),
    ]);
    expect(res.results.map((r) => r.reason)).toEqual(['not_found', 'invalid_value', 'not_found']);
    expect((await env.threads.view(OTHER, theirs.id)).title).toBe('Not yours');
    expect((await env.threads.view(ACCOUNT, mine.id)).projectId).toBeNull();
    expect(await env.sync.mergeLog(ACCOUNT, { status: 'all', limit: 10 })).toEqual([]);
  });
});

describe('push: creation, deletes and append-only messages', () => {
  it('creates a chat and appends offline user messages with the ids the replica chose', async () => {
    const tid = '01920000-0000-7000-8000-000000000a01';
    const m1 = '01920000-0000-7000-8000-000000000b01';
    const m2 = '01920000-0000-7000-8000-000000000b02';
    env.clock.t -= 120_000; // written offline two minutes ago
    const ops = [
      env.op(DEV_A, 'thread', tid, 'title', 'Offline chat'),
      env.op(DEV_A, 'thread', tid, 'pinned', true),
      env.op(
        DEV_A,
        'message',
        m1,
        'body',
        { threadId: tid, role: 'user', text: 'first' },
        { c: 1 },
      ),
      env.op(
        DEV_A,
        'message',
        m2,
        'body',
        { threadId: tid, role: 'user', text: 'second', parentId: m1 },
        { c: 2 },
      ),
    ];
    env.clock.t += 120_000;
    const res = await push(DEV_A, ops);
    expect(res.results.map((r) => r.status)).toEqual([
      'accepted',
      'accepted',
      'accepted',
      'accepted',
    ]);
    const detail = await env.threads.detail(ACCOUNT, tid);
    expect(detail.thread).toMatchObject({ title: 'Offline chat', pinned: true });
    expect(detail.messages.map((m) => [m.id, m.role])).toEqual([
      [m1, 'user'],
      [m2, 'user'],
    ]);
    // The Hub records when it received the message: a device cannot backdate it.
    expect(Date.parse(detail.messages[0]!.createdAt)).toBe(env.clock.t);
    expect(Date.parse(detail.messages[0]!.createdAt)).toBeGreaterThan(parseHlc(ops[2]!.hlc)!.pt);
    const fed = await pull(DEV_B);
    expect(field(fed, 'message', m2, 'body')).toMatchObject({
      deviceId: DEV_A,
      value: { threadId: tid, role: 'user', text: 'second', parentId: m1 },
    });

    // Repeating the push is harmless; editing a message is refused.
    const again = await push(DEV_A, [ops[2]!]);
    expect(again.results[0]!.status).toBe('accepted');
    const edit = await push(DEV_B, [
      env.op(DEV_B, 'message', m1, 'body', { threadId: tid, role: 'user', text: 'rewritten' }),
    ]);
    expect(edit.results[0]).toMatchObject({ status: 'rejected', reason: 'append_only' });
    expect((await env.threads.detail(ACCOUNT, tid)).messages).toHaveLength(2);
  });

  it('refuses messages with no thread, as another role, and ids that are not UUIDs', async () => {
    const res = await push(DEV_A, [
      env.op(DEV_A, 'message', '01920000-0000-7000-8000-000000000b09', 'body', {
        threadId: '01920000-0000-7000-8000-000000000a09',
        role: 'user',
        text: 'orphan',
      }),
      env.op(DEV_A, 'message', '01920000-0000-7000-8000-000000000b0a', 'body', {
        threadId: 'x',
        role: 'assistant',
        text: 'I am the model',
      }),
      env.op(DEV_A, 'thread', 'not-a-uuid', 'title', 'x'),
      env.op(DEV_A, 'page', '01920000-0000-7000-8000-000000000a0b', '_deleted', true),
    ]);
    expect(res.results.map((r) => r.reason)).toEqual([
      'not_found',
      'invalid_value',
      'invalid_id',
      'not_found',
    ]);
  });

  it('deletes when the tombstone is newer than every field, and refuses later ops', async () => {
    const page = await newPage();
    await pull();
    env.clock.t += 1000;
    const res = await push(DEV_A, [env.op(DEV_A, 'page', page.id, '_deleted', true)]);
    expect(res.results[0]!.status).toBe('accepted');
    await expect(env.spaces.getPage(ACCOUNT, page.spaceId, page.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    const fed = await pull(DEV_B);
    expect(field(fed, 'page', page.id, '_deleted')).toMatchObject({ value: true, deviceId: DEV_A });
    const late = await push(DEV_B, [
      env.op(DEV_B, 'page', page.id, 'title', 'too late', { offsetMs: 5 }),
    ]);
    expect(late.results[0]).toMatchObject({ status: 'rejected', reason: 'deleted' });
  });

  it('keeps an entity a newer edit touched, with the losing delete in the merge log', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'Keep me' });
    const base = field(await pull(), 'thread', t.id, 'title')!.hlc;
    env.clock.t += 1000;
    await push(DEV_B, [
      env.op(DEV_B, 'thread', t.id, 'title', 'Edited later', { offsetMs: 100, base }),
    ]);
    const res = await push(DEV_A, [env.op(DEV_A, 'thread', t.id, '_deleted', true)]);
    expect(res.results[0]).toMatchObject({ status: 'overwritten', reason: 'stale' });
    expect((await env.threads.view(ACCOUNT, t.id)).title).toBe('Edited later');
    const [entry] = await env.sync.mergeLog(ACCOUNT, { status: 'open', limit: 10 });
    expect(entry).toMatchObject({ field: '_deleted', lost: { value: true, deviceId: DEV_A } });
    // Restoring the delete deletes it.
    await env.sync.restore(ACCOUNT, entry!.id, { actor: 'user', deviceId: DEV_B });
    await expect(env.threads.view(ACCOUNT, t.id)).rejects.toMatchObject({ code: 'not_found' });
    // Its merge-log entries went with it.
    expect(await env.sync.mergeLog(ACCOUNT, { status: 'all', limit: 10 })).toEqual([]);
  });

  it('cannot restore onto a deleted entity or an unknown entry', async () => {
    const page = await newPage();
    const base = field(await pull(), 'page', page.id, 'title')!.hlc;
    env.clock.t += 1000;
    await push(DEV_B, [env.op(DEV_B, 'page', page.id, 'title', 'B', { offsetMs: 10, base })]);
    await push(DEV_A, [env.op(DEV_A, 'page', page.id, 'title', 'A', { base })]);
    const [entry] = await env.sync.mergeLog(ACCOUNT, { status: 'open', limit: 10 });
    expect(entry).toBeTruthy();
    // Deleted on the Hub meanwhile: the tombstone drops the entry, so it is unknown now.
    await env.spaces.deletePage(ACCOUNT, page.spaceId, page.id);
    await env.sync.flush();
    await expect(
      env.sync.restore(ACCOUNT, entry!.id, { actor: 'user', deviceId: null }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      env.sync.restore(OTHER, entry!.id, { actor: 'user', deviceId: null }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('snapshot, reset and replicas', () => {
  it('pages the initial load kind by kind without tombstones', async () => {
    const keep = await env.threads.create(ACCOUNT, { title: 'Keep' });
    const gone = await env.threads.create(ACCOUNT, { title: 'Gone' });
    for (let i = 0; i < 3; i++) await env.projects.create(ACCOUNT, { name: `P${i}` });
    await env.threads.remove(ACCOUNT, gone.id);
    await env.sync.flush();
    const pages: { kind: string; ids: string[] }[] = [];
    let cursor: string | undefined;
    let feedCursor = -1;
    for (let i = 0; i < 30; i++) {
      const page = await env.sync.snapshot(ACCOUNT, DEV_A, { cursor, limit: 2 });
      if (feedCursor < 0) feedCursor = page.feedCursor;
      pages.push({ kind: page.kind, ids: page.items.map((x) => x.id) });
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const threads = pages.filter((p) => p.kind === 'thread').flatMap((p) => p.ids);
    expect(threads).toEqual([keep.id]);
    expect(pages.filter((p) => p.kind === 'project').flatMap((p) => p.ids)).toHaveLength(3);
    expect(pages.at(-1)!.kind).toBe('setting');
    expect(feedCursor).toBe(env.sync.cursor());
    const one = await env.sync.snapshot(ACCOUNT, DEV_A, { kind: 'thread', limit: 10 });
    expect(one.items[0]!.fields.title).toMatchObject({ value: 'Keep', deviceId: null });
    expect(one.nextCursor).toBeNull();
    await expect(
      env.sync.snapshot(ACCOUNT, DEV_A, { kind: 'project', cursor: 'garbage', limit: 2 }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('makes a reset replica load a snapshot before it pulls again', async () => {
    await env.threads.create(ACCOUNT, { title: 'x' });
    const first = await pull();
    const since = first.at(-1)!.cursor;
    await env.sync.resetReplica(ACCOUNT, DEV_A, { actor: 'user', deviceId: null });
    expect(env.events.names()).toContain('sync.replica.reset');
    expect(env.audit.some((a) => a.action === 'sync.replica.reset')).toBe(true);
    await expect(env.sync.changes(ACCOUNT, DEV_A, since, 10)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'replica_reset' },
    });
    await env.sync.snapshot(ACCOUNT, DEV_A, { limit: 10 });
    expect((await env.sync.changes(ACCOUNT, DEV_A, since, 10)).changes).toEqual([]);
    await expect(env.sync.changes(ACCOUNT, DEV_A, since + 1000, 10)).rejects.toMatchObject({
      details: { reason: 'cursor_ahead' },
    });
    await expect(
      env.sync.resetReplica(ACCOUNT, DEV_OTHER, { actor: 'user', deviceId: null }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports replicas as synced, pending, offline or error, and tells a revoked one', async () => {
    await env.threads.create(ACCOUNT, { title: 'x' });
    await pull(DEV_A);
    let views = await env.sync.replicas(ACCOUNT);
    expect(views.map((v) => [v.deviceId, v.status])).toEqual([
      [DEV_A, 'synced'],
      [DEV_B, 'offline'],
    ]);
    await env.threads.create(ACCOUNT, { title: 'y' });
    await env.sync.flush();
    views = await env.sync.replicas(ACCOUNT);
    expect(views[0]).toMatchObject({ status: 'pending', granted: true });
    expect(views[0]!.behind).toBeGreaterThan(0);
    env.clock.t += 11 * 60_000;
    expect((await env.sync.replicas(ACCOUNT))[0]!.status).toBe('offline');

    env.db.raw.prepare("UPDATE device SET status = 'revoked' WHERE id = ?").run(DEV_A);
    expect(await env.sync.replicaRevoked(ACCOUNT, DEV_A, 'revoked')).toBe(true);
    expect(await env.sync.replicaRevoked(ACCOUNT, DEV_A, 'revoked')).toBe(false);
    const ev = env.events.events.find((e) => e.name === 'sync.replica.revoked');
    expect(ev?.payload).toEqual({ deviceId: DEV_A, reason: 'revoked' });
    expect((await env.sync.replicas(ACCOUNT))[0]).toMatchObject({
      revoked: true,
      granted: false,
      status: 'offline',
    });
    // A device that never had a replica is not told anything.
    env.makeDevice('01920000-0000-7000-8000-0000000000dd', ACCOUNT, []);
    expect(
      await env.sync.replicaRevoked(
        ACCOUNT,
        '01920000-0000-7000-8000-0000000000dd',
        'scope_removed',
      ),
    ).toBe(false);
  });

  it('starts a re-granted replica over', async () => {
    await pull(DEV_B);
    await env.sync.replicaRevoked(ACCOUNT, DEV_B, 'scope_removed');
    await env.threads.create(ACCOUNT, { title: 'x' });
    await env.sync.flush();
    // Its first call after the scope is back makes it load a snapshot.
    await expect(env.sync.changes(ACCOUNT, DEV_B, 1, 10)).rejects.toMatchObject({
      details: { reason: 'replica_reset' },
    });
  });

  it('drops merge-log entries past the retention', async () => {
    const t = await env.threads.create(ACCOUNT, { title: 'x' });
    const base = field(await pull(), 'thread', t.id, 'title')!.hlc;
    env.clock.t += 1000;
    await push(DEV_B, [env.op(DEV_B, 'thread', t.id, 'title', 'B', { offsetMs: 10, base })]);
    await push(DEV_A, [env.op(DEV_A, 'thread', t.id, 'title', 'A', { base })]);
    expect(await env.sync.mergeLog(ACCOUNT, { status: 'all', limit: 10 })).toHaveLength(1);
    env.clock.t += 91 * 86_400_000;
    await env.sync.sweep();
    expect(await env.sync.mergeLog(ACCOUNT, { status: 'all', limit: 10 })).toEqual([]);
  });
});

describe('answers written on a device, answering offline messages, spaces and page versions', () => {
  const tid = '01920000-0000-7000-8000-000000000c01';
  const asked = '01920000-0000-7000-8000-000000000c02';
  const local = '01920000-0000-7000-8000-000000000c03';

  async function offlineChat() {
    env.clock.t += 1000;
    const res = await push(DEV_A, [
      env.op(DEV_A, 'thread', tid, 'title', 'On the plane'),
      env.op(
        DEV_A,
        'message',
        asked,
        'body',
        { threadId: tid, role: 'user', text: 'What is a haiku?' },
        { c: 1 },
      ),
    ]);
    expect(res.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
  }

  const answerOp = (extra: Record<string, unknown> = {}) =>
    env.op(
      DEV_A,
      'message',
      local,
      'body',
      {
        threadId: tid,
        role: 'assistant',
        text: 'A short poem in three lines.',
        parentId: asked,
        model: 'local/llama3',
        provenance: 'offline',
        ...extra,
      },
      { c: 2 },
    );

  it('stores a local model’s answer from a device with local-runtime, labelled offline (FR-128)', async () => {
    await offlineChat();
    const refused = await env.sync.push(ACCOUNT, DEV_A, [answerOp()]);
    expect(refused.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'local_runtime_not_granted',
    });
    const res = await env.sync.push(ACCOUNT, DEV_A, [answerOp()], { localRuntime: true });
    expect(res.results[0]!.status).toBe('accepted');
    const row = env.db.raw
      .prepare('SELECT role, author_kind, model_id, parent_id FROM message WHERE id = ?')
      .get(local);
    expect(row).toEqual({
      role: 'assistant',
      author_kind: 'offline',
      model_id: 'local/llama3',
      parent_id: asked,
    });
    const detail = await env.threads.detail(ACCOUNT, tid);
    expect(detail.messages.map((m) => [m.id, m.role, m.provenance])).toEqual([
      [asked, 'user', 'sync'],
      [local, 'assistant', 'offline'],
    ]);
    expect(detail.messages[1]!.model).toBe('local/llama3');
    const fed = field(await pull(DEV_B), 'message', local, 'body');
    expect(fed?.value).toMatchObject({ role: 'assistant', provenance: 'offline', parentId: asked });
  });

  it('refuses a local answer without a parent in the thread', async () => {
    await offlineChat();
    const missing = await env.sync.push(ACCOUNT, DEV_A, [answerOp({ parentId: undefined })], {
      localRuntime: true,
    });
    expect(missing.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid_value' });
    const elsewhere = await env.sync.push(
      ACCOUNT,
      DEV_A,
      [answerOp({ parentId: '01920000-0000-7000-8000-000000000cff' })],
      { localRuntime: true },
    );
    expect(elsewhere.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid_value' });
  });

  it('answers a message written offline through the chat loop, once', async () => {
    await offlineChat();
    await expect(
      env.chat.answer(ACCOUNT, tid, '01920000-0000-7000-8000-000000000cfe'),
    ).rejects.toMatchObject({ code: 'not_found' });
    const started = await env.chat.answer(ACCOUNT, tid, asked);
    expect(started).toMatchObject({ disposition: 'started', userMessageId: asked });
    await expect(env.chat.answer(ACCOUNT, tid, asked)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'turn_in_progress' },
    });
    await env.chat.idle();
    const detail = await env.threads.detail(ACCOUNT, tid);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.messages[1]!.parentId).toBe(asked);
    expect(detail.messages[1]!.status).toBe('complete');
    // One user message, not a copy of it.
    const users = env.db.raw
      .prepare("SELECT count(*) AS n FROM message WHERE thread_id = ? AND role = 'user'")
      .get(tid) as { n: number };
    expect(users.n).toBe(1);
    await expect(env.chat.answer(ACCOUNT, tid, asked)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'answered' },
    });
    await expect(env.chat.answer(ACCOUNT, tid, detail.messages[1]!.id)).rejects.toMatchObject({
      details: { reason: 'not_user_message' },
    });
  });

  it('answers only the last of several offline messages', async () => {
    await offlineChat();
    const next = '01920000-0000-7000-8000-000000000c04';
    await push(DEV_A, [
      env.op(
        DEV_A,
        'message',
        next,
        'body',
        { threadId: tid, role: 'user', text: 'And a limerick?' },
        { c: 3 },
      ),
    ]);
    await expect(env.chat.answer(ACCOUNT, tid, asked)).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'not_last' },
    });
    await env.chat.answer(ACCOUNT, tid, next);
    await env.chat.idle();
    expect((await env.threads.detail(ACCOUNT, tid)).messages.map((m) => m.role)).toEqual([
      'user',
      'user',
      'assistant',
    ]);
  });

  it('syncs spaces by name and pages with their version', async () => {
    const page = await newPage('Packing', 'socks');
    const all = await pull();
    expect(field(all, 'space', page.spaceId, 'name')?.value).toBe('Home');
    expect(field(all, 'page', page.id, 'version')?.value).toBe(1);
    env.clock.t += 1000;
    const res = await push(DEV_A, [
      env.op(DEV_A, 'space', page.spaceId, 'name', 'Travel'),
      env.op(DEV_A, 'page', page.id, 'content', 'socks, passport'),
      env.op(DEV_A, 'page', page.id, 'version', 7),
      env.op(DEV_A, 'space', page.spaceId, '_deleted', true),
    ]);
    expect(res.results.map((r) => r.reason ?? r.status)).toEqual([
      'accepted',
      'accepted',
      'read_only_field',
      'not_deletable',
    ]);
    expect((await env.spaces.getSpace(ACCOUNT, page.spaceId)).name).toBe('Travel');
    const after = await pull(DEV_B);
    expect(field(after, 'space', page.spaceId, 'name')).toMatchObject({
      value: 'Travel',
      deviceId: DEV_A,
    });
    expect(field(after, 'page', page.id, 'version')?.value).toBe(2);
    // A deleted space takes its pages with it.
    await env.spaces.deleteSpace(ACCOUNT, page.spaceId);
    const gone = await pull(DEV_B);
    expect(field(gone, 'space', page.spaceId, '_deleted')?.value).toBe(true);
    expect(field(gone, 'page', page.id, '_deleted')?.value).toBe(true);
  });
});
