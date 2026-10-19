// The sync area over HTTP (FR-109, FR-129; docs/13 §2, ADR-095 decisions 1 and 3): two device
// sessions with `offline-replica` sync through the Hub (A pushes, B pulls); concurrent edits to one
// page field leave the loser in the merge log and a restore brings it back for both; a device
// without the scope, the owner's own browser and a session-less caller are refused; a revoked
// device is told and then gets 401; a reset replica must load a snapshot again.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import type {
  SyncChangeView,
  SyncChangesView,
  SyncMergeEntryView,
  SyncPushResult,
  SyncReplicaView,
  SyncSnapshotView,
} from '@nova/shared';
import { deviceScopes } from '../src/auth.ts';
import { ACCOUNT, syncHub, type Session, type SyncHub } from './sync-env.ts';

let hub: SyncHub;

/** Event handlers run after the request that caused them; wait until the event is stored. */
async function eventNamed(name: string) {
  for (let i = 0; i < 100; i++) {
    const found = (await hub.events.since(null, 500, { accountId: ACCOUNT })).find(
      (e) => e.name === name,
    );
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  return undefined;
}

beforeEach(async () => {
  hub = await syncHub();
});

afterEach(async () => {
  await hub.close();
});

async function pull(s: Session, since = 0): Promise<SyncChangesView> {
  const res = await hub.call(s, 'GET', `/api/v1/sync/changes?since=${since}&limit=1000`);
  expect(res.statusCode).toBe(200);
  return res.json<SyncChangesView>();
}

const latest = (changes: SyncChangeView[], id: string, field: string) =>
  changes.filter((c) => c.id === id && c.field === field).at(-1);

async function push(s: Session, ops: unknown[], headers: Record<string, string> = {}) {
  return hub.call(s, 'POST', '/api/v1/sync/push', { deviceId: s.deviceId, ops }, headers);
}

async function newPage(content = 'v0') {
  const space = await hub.call(hub.owner, 'POST', '/api/v1/spaces', { name: 'Notes' });
  const spaceId = space.json<{ id: string }>().id;
  const page = await hub.call(hub.owner, 'POST', `/api/v1/spaces/${spaceId}/pages`, {
    title: 'Groceries',
    content,
  });
  expect(page.statusCode).toBe(201);
  return { spaceId, pageId: page.json<{ id: string }>().id };
}

describe('device sessions (decision 3)', () => {
  it('carry the device id and its current scopes; the owner’s browser session carries none', async () => {
    const a = await hub.auth.verify(hub.a.token);
    expect(a).toMatchObject({ deviceId: hub.a.deviceId, scopes: ['offline-replica'] });
    expect(deviceScopes({ principal: a })).toEqual({
      deviceId: hub.a.deviceId,
      scopes: ['offline-replica'],
    });
    const owner = await hub.auth.verify(hub.owner.token);
    expect(owner).toMatchObject({ deviceId: null, scopes: null });
    expect(deviceScopes({ principal: owner })).toBeNull();
    expect(deviceScopes({ principal: null })).toBeNull();
    // A scope change applies to the next request.
    await hub.pairing.setScopes(ACCOUNT, hub.a.deviceId!, ['offline-replica', 'local-runtime']);
    expect((await hub.auth.verify(hub.a.token))?.scopes).toEqual([
      'offline-replica',
      'local-runtime',
    ]);
    // A revoked device whose session somehow survived fails closed.
    hub.db.raw.prepare("UPDATE device SET status = 'revoked' WHERE id = ?").run(hub.b.deviceId);
    expect(await hub.auth.verify(hub.b.token)).toBeNull();
  });
});

describe('replica routes', () => {
  it('refuse a device without offline-replica, the owner’s browser and a caller with no session', async () => {
    for (const s of [hub.plain, hub.owner]) {
      for (const [method, url, body] of [
        ['GET', '/api/v1/sync/snapshot'],
        ['GET', '/api/v1/sync/changes'],
        ['POST', '/api/v1/sync/push', { deviceId: s.deviceId ?? 'x', ops: [] }],
      ] as const) {
        const res = await hub.call(s, method, url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toMatchObject({
          error: { code: 'policy_denied', details: { reason: 'replica_not_granted' } },
        });
      }
    }
    expect((await hub.call(null, 'GET', '/api/v1/sync/changes')).statusCode).toBe(401);
    expect((await hub.call(null, 'GET', '/api/v1/sync/merge-log')).statusCode).toBe(401);
    hub.settings['sync.enabled'] = false;
    for (const [s, method, url] of [
      [hub.a, 'GET', '/api/v1/sync/changes'],
      [hub.owner, 'GET', '/api/v1/sync/merge-log'],
      [hub.owner, 'POST', '/api/v1/sync/merge-log/any/restore'],
    ] as const) {
      const off = await hub.call(s, method, url);
      expect(off.statusCode, url).toBe(403);
      expect(off.json()).toMatchObject({ error: { details: { reason: 'sync_disabled' } } });
    }
  });

  it('let A push a chat written offline and B pull it, as changes and in a snapshot', async () => {
    const threadId = '01920000-0000-7000-8000-00000000a001';
    const messageId = '01920000-0000-7000-8000-00000000b001';
    const res = await push(hub.a, [
      {
        kind: 'thread',
        id: threadId,
        field: 'title',
        value: 'From the train',
        hlc: hub.hlc(hub.a),
      },
      {
        kind: 'message',
        id: messageId,
        field: 'body',
        value: { threadId, role: 'user', text: 'Remember to buy stamps' },
        hlc: hub.hlc(hub.a, 0, 1),
      },
    ]);
    expect(res.statusCode).toBe(200);
    const body = res.json<SyncPushResult>();
    expect(body.results.map((r) => r.status)).toEqual(['accepted', 'accepted']);
    // The Hub has it: the chat and its message, with no turn started.
    const detail = await hub.threads.detail(ACCOUNT, threadId);
    expect(detail.thread.title).toBe('From the train');
    expect(detail.messages.map((m) => m.role)).toEqual(['user']);

    const b = await pull(hub.b);
    expect(latest(b.changes, threadId, 'title')).toMatchObject({
      value: 'From the train',
      deviceId: hub.a.deviceId,
    });
    expect(latest(b.changes, messageId, 'body')?.value).toMatchObject({
      text: 'Remember to buy stamps',
    });
    expect(b.cursor).toBe(body.cursor);
    const snap = await hub.call(hub.b, 'GET', '/api/v1/sync/snapshot?kind=thread');
    expect(snap.statusCode).toBe(200);
    const page = snap.json<SyncSnapshotView>();
    expect(page.items.map((i) => i.id)).toEqual([threadId]);
    expect(page.feedCursor).toBeGreaterThanOrEqual(body.cursor);
    // A change made on the Hub reaches B too, and tells online replicas to pull.
    const seen: unknown[] = [];
    const off = hub.events.bus.subscribe('sync.changed', (e) => seen.push(e.payload));
    await hub.threads.update(ACCOUNT, threadId, { archived: true });
    await hub.area.service.flush();
    off();
    expect(seen.length).toBeGreaterThan(0);
    const next = await pull(hub.b, b.cursor);
    expect(next.changes.map((c) => [c.field, c.value])).toEqual([['archived', true]]);
  });

  it('keep the loser of concurrent page edits in the merge log; a restore reaches both replicas', async () => {
    const { spaceId, pageId } = await newPage('milk');
    const start = await pull(hub.a);
    const base = latest(start.changes, pageId, 'content')!.hlc;
    await pull(hub.b);
    hub.clock.t += 1000;
    const fromA = { kind: 'page', id: pageId, field: 'content', value: 'milk, eggs', base };
    const fromB = { kind: 'page', id: pageId, field: 'content', value: 'milk, bread', base };
    const ra = await push(hub.a, [{ ...fromA, hlc: hub.hlc(hub.a, 0) }]);
    const rb = await push(hub.b, [{ ...fromB, hlc: hub.hlc(hub.b, 25) }]);
    expect(ra.json<SyncPushResult>().results[0]!.status).toBe('accepted');
    const won = rb.json<SyncPushResult>().results[0]!;
    expect(won.status).toBe('accepted');
    expect(won.entryId).toBeTruthy();
    const conflict = await hub.events.since(null, 500, { accountId: ACCOUNT });
    expect(conflict.find((e) => e.name === 'sync.conflict')?.payload).toEqual({
      entryId: won.entryId,
      kind: 'page',
      id: pageId,
      field: 'content',
    });

    // The owner sees the history from the browser and restores A's edit.
    const log = await hub.call(hub.owner, 'GET', '/api/v1/sync/merge-log?status=open');
    const [entry] = log.json<{ items: SyncMergeEntryView[] }>().items;
    expect(entry).toMatchObject({
      id: won.entryId,
      reason: 'concurrent',
      lost: { value: 'milk, eggs', deviceId: hub.a.deviceId },
      winner: { value: 'milk, bread', deviceId: hub.b.deviceId },
    });
    expect(entry!.lost.deviceName).toMatch(/^Phone /);
    hub.clock.t += 1000;
    const restored = await hub.call(
      hub.owner,
      'POST',
      `/api/v1/sync/merge-log/${entry!.id}/restore`,
    );
    expect(restored.statusCode).toBe(200);
    expect(restored.json<SyncMergeEntryView>().status).toBe('restored');
    for (const s of [hub.a, hub.b]) {
      const c = latest((await pull(s)).changes, pageId, 'content')!;
      expect(c.value).toBe('milk, eggs');
      expect(c.deviceId).toBeNull();
    }
    const page = await hub.call(hub.owner, 'GET', `/api/v1/spaces/${spaceId}/pages/${pageId}`);
    expect(page.json<{ content: string }>().content).toBe('milk, eggs');
    expect(hub.audit.some((r) => r.action === 'sync.restore')).toBe(true);
    const again = await hub.call(hub.a, 'POST', `/api/v1/sync/merge-log/${entry!.id}/restore`);
    expect(again.statusCode).toBe(409);
    expect(
      (await hub.call(hub.owner, 'POST', '/api/v1/sync/merge-log/nope/restore')).statusCode,
    ).toBe(404);
  });

  it('refuse a push for another device and malformed requests', async () => {
    const res = await hub.call(hub.a, 'POST', '/api/v1/sync/push', {
      deviceId: hub.b.deviceId,
      ops: [{ kind: 'thread', id: 'x', field: 'title', value: 'x', hlc: hub.hlc(hub.b) }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { details: { reason: 'device_mismatch' } } });
    expect(
      (await push(hub.a, [{ kind: 'nope', id: 'x', field: 'f', value: 1, hlc: 'x' }])).statusCode,
    ).toBe(400);
    expect((await hub.call(hub.a, 'GET', '/api/v1/sync/changes?since=-1')).statusCode).toBe(400);
    expect((await hub.call(hub.a, 'GET', '/api/v1/sync/snapshot?cursor=%%%')).statusCode).toBe(400);
  });

  it('tell a revoked device, which then gets 401, and list replicas with their status', async () => {
    await pull(hub.a);
    await pull(hub.b);
    let list = (await hub.call(hub.owner, 'GET', '/api/v1/sync/devices')).json<{
      items: SyncReplicaView[];
    }>();
    expect(list.items.map((r) => r.status)).toEqual(['synced', 'synced']);
    await hub.pairing.revokeDevice(ACCOUNT, hub.a.deviceId!);
    // Its open event stream is told; its next call has no session.
    const told = await eventNamed('sync.replica.revoked');
    expect(told?.payload).toEqual({ deviceId: hub.a.deviceId, reason: 'revoked' });
    expect((await hub.call(hub.a, 'GET', '/api/v1/sync/changes')).statusCode).toBe(401);
    expect((await push(hub.a, [])).statusCode).toBe(401);
    list = (await hub.call(hub.owner, 'GET', '/api/v1/sync/devices')).json<{
      items: SyncReplicaView[];
    }>();
    expect(list.items.find((r) => r.deviceId === hub.a.deviceId)).toMatchObject({
      revoked: true,
      granted: false,
      status: 'offline',
    });
  });

  it('end a replica whose scope is taken away, and reset one on the owner’s word', async () => {
    const first = await pull(hub.b);
    await hub.threads.create(ACCOUNT, { title: 'x' });
    await hub.area.service.flush();
    const reset = await hub.call(hub.owner, 'POST', `/api/v1/sync/devices/${hub.b.deviceId}/reset`);
    expect(reset.statusCode).toBe(200);
    expect(reset.json<SyncReplicaView>().resetAt).toBeTruthy();
    const refused = await hub.call(hub.b, 'GET', `/api/v1/sync/changes?since=${first.cursor || 1}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { details: { reason: 'replica_reset' } } });
    expect((await hub.call(hub.b, 'GET', '/api/v1/sync/snapshot')).statusCode).toBe(200);
    expect(
      (await hub.call(hub.b, 'GET', `/api/v1/sync/changes?since=${first.cursor}`)).statusCode,
    ).toBe(200);
    expect(hub.audit.some((r) => r.action === 'sync.replica.reset')).toBe(true);
    expect(
      (await hub.call(hub.owner, 'POST', '/api/v1/sync/devices/unknown/reset')).statusCode,
    ).toBe(404);

    await hub.pairing.setScopes(ACCOUNT, hub.b.deviceId!, []);
    expect((await eventNamed('sync.replica.revoked'))?.payload).toEqual({
      deviceId: hub.b.deviceId,
      reason: 'scope_removed',
    });
    const now = await hub.call(hub.b, 'GET', '/api/v1/sync/changes');
    expect(now.statusCode).toBe(403);
  });

  it('report the feed in diagnostics', async () => {
    await hub.threads.create(ACCOUNT, { title: 'x' });
    await hub.area.service.flush();
    const { sync } = (await hub.diagnostics.collect()) as {
      sync: { fields: number; cursor: number; openConflicts: number };
    };
    expect(sync.fields).toBeGreaterThan(0);
    expect(sync.cursor).toBe(hub.area.service.cursor());
    expect(sync.openConflicts).toBe(0);
  });
});

describe('local answers and asking for an answer', () => {
  it('take a local model’s answer only from a device with local-runtime (FR-128)', async () => {
    const both = hub.device(['offline-replica', 'local-runtime']);
    const threadId = '01920000-0000-7000-8000-00000000d001';
    const asked = '01920000-0000-7000-8000-00000000d002';
    const answerId = '01920000-0000-7000-8000-00000000d003';
    const answer = {
      kind: 'message',
      id: answerId,
      field: 'body',
      value: {
        threadId,
        role: 'assistant',
        text: 'Here is what I found offline.',
        parentId: asked,
        model: 'local/qwen3',
        provenance: 'offline',
      },
    };
    const setup = await push(both, [
      { kind: 'thread', id: threadId, field: 'title', value: 'Offline', hlc: hub.hlc(both) },
      {
        kind: 'message',
        id: asked,
        field: 'body',
        value: { threadId, role: 'user', text: 'Find my notes' },
        hlc: hub.hlc(both, 0, 1),
      },
    ]);
    expect(setup.json<SyncPushResult>().results.map((r) => r.status)).toEqual([
      'accepted',
      'accepted',
    ]);
    const refused = await push(hub.a, [{ ...answer, hlc: hub.hlc(hub.a, 0, 2) }]);
    expect(refused.json<SyncPushResult>().results[0]).toMatchObject({
      status: 'rejected',
      reason: 'local_runtime_not_granted',
    });
    const ok = await push(both, [{ ...answer, hlc: hub.hlc(both, 0, 2) }]);
    expect(ok.json<SyncPushResult>().results[0]!.status).toBe('accepted');
    const detail = await hub.threads.detail(ACCOUNT, threadId);
    expect(detail.messages.map((m) => [m.role, m.provenance, m.model])).toEqual([
      ['user', 'sync', null],
      ['assistant', 'offline', 'local/qwen3'],
    ]);
  });

  it('starts the answer through the chat loop, replaying a queued retry', async () => {
    const tid = '01920000-0000-7000-8000-00000000d101';
    const mid = '01920000-0000-7000-8000-00000000d102';
    const url = `/api/v1/threads/${tid}/messages/${mid}/answer`;
    const notReady = await hub.call(hub.owner, 'POST', url, {});
    expect(notReady.statusCode).toBe(500);
    const calls: unknown[][] = [];
    hub.area.useChat({
      answer: (...args) => {
        calls.push(args);
        return Promise.resolve({
          disposition: 'started',
          turnId: 't1',
          userMessageId: mid,
          assistantMessageId: 'a1',
        });
      },
    });
    expect((await hub.call(null, 'POST', url, {})).statusCode).toBe(401);
    const key = { 'idempotency-key': 'answer-1' };
    const first = await hub.call(hub.a, 'POST', url, { model: 'mock/x' }, key);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ disposition: 'started', userMessageId: mid });
    const again = await hub.call(hub.a, 'POST', url, { model: 'mock/x' }, key);
    expect(again.statusCode).toBe(202);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(calls).toEqual([[ACCOUNT, tid, mid, { model: 'mock/x' }]]);
    // A conflict from the loop (already answered) is the route's answer.
    hub.area.useChat({
      answer: () =>
        Promise.reject(
          new NovaError('conflict', 'this message already has a reply', {
            details: { reason: 'answered' },
          }),
        ),
    });
    const answered = await hub.call(hub.owner, 'POST', url, {});
    expect(answered.statusCode).toBe(409);
    expect(answered.json()).toMatchObject({ error: { details: { reason: 'answered' } } });
  });

  it('serves spaces with their names in the snapshot', async () => {
    const { spaceId, pageId } = await newPage();
    const snap = await hub.call(hub.a, 'GET', '/api/v1/sync/snapshot?kind=space');
    const page = snap.json<SyncSnapshotView>();
    expect(page.items.map((i) => [i.id, i.fields.name?.value])).toEqual([[spaceId, 'Notes']]);
    const pages = await hub.call(hub.a, 'GET', '/api/v1/sync/snapshot?kind=page');
    expect(pages.json<SyncSnapshotView>().items[0]).toMatchObject({
      id: pageId,
      fields: { version: { value: 1 } },
    });
  });
});
