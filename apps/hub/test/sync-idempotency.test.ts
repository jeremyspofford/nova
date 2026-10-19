// Idempotent writes over HTTP (FR-112, ADR-095 decision 2): a queued POST sent again with its
// `Idempotency-Key` gets the first answer (`idempotent-replay: true`) and does nothing twice; a
// different body with the key is 409 `idempotency_key_reused`; keys are per principal (a device's
// key survives its new session); failures worth retrying are not kept; `no-store` answers are not
// replayed; keys expire after 24 hours.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { NovaError, type SyncPushResult } from '@nova/shared';
import { setupDevices } from '../src/devices.ts';
import { ACCOUNT, syncHub, type SyncHub } from './sync-env.ts';

let hub: SyncHub;
let calls = 0;
let failNext = 0;

async function build(): Promise<void> {
  calls = 0;
  failNext = 0;
  hub = await syncHub({}, async (app, ctx) => {
    // A write that counts how often it really ran, fails on request, or answers no-store; it
    // opts in to replay. The same write without the opt-in is `/api/v1/test/plain`.
    const count = (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.principal) throw new NovaError('token_required', 'sign in');
      if (failNext > 0) {
        failNext--;
        throw new NovaError('server_error', 'try again');
      }
      calls++;
      if ((req.body as { secret?: boolean } | undefined)?.secret)
        void reply.header('cache-control', 'no-store');
      void reply.status(201);
      return Promise.resolve({ calls });
    };
    app.post('/api/v1/test/count', { config: { idempotentReplay: true } }, count);
    app.post('/api/v1/test/plain', count);
    // The devices area, for its credential route.
    const devices = await setupDevices(ctx);
    devices.register(app);
    return () => devices.close();
  });
}

afterEach(async () => {
  await hub.close();
});

const key = (k: string) => ({ 'idempotency-key': k });

describe('Idempotency-Key', () => {
  it('replays the first answer of a queued POST and creates nothing twice', async () => {
    await build();
    const space = await hub.call(
      hub.owner,
      'POST',
      '/api/v1/spaces',
      { name: 'Home' },
      key('space-1'),
    );
    expect(space.statusCode).toBe(201);
    expect(space.headers['idempotent-replay']).toBeUndefined();
    const again = await hub.call(
      hub.owner,
      'POST',
      '/api/v1/spaces',
      { name: 'Home' },
      key('space-1'),
    );
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.headers['content-type']).toContain('application/json');
    expect(again.json()).toEqual(space.json());
    const list = await hub.call(hub.owner, 'GET', '/api/v1/spaces');
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(1);
    // The same key with another body is refused.
    const reused = await hub.call(
      hub.owner,
      'POST',
      '/api/v1/spaces',
      { name: 'Work' },
      key('space-1'),
    );
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({
      error: { code: 'conflict', details: { reason: 'idempotency_key_reused' } },
    });
    // Without the header nothing is remembered.
    await hub.call(hub.owner, 'POST', '/api/v1/test/count', {});
    await hub.call(hub.owner, 'POST', '/api/v1/test/count', {});
    expect(calls).toBe(2);
  });

  it('keeps keys per principal; a device keeps its keys across a new session', async () => {
    await build();
    const one = await hub.call(hub.a, 'POST', '/api/v1/test/count', {}, key('k'));
    expect(one.json()).toEqual({ calls: 1 });
    const other = await hub.call(hub.b, 'POST', '/api/v1/test/count', {}, key('k'));
    expect(other.json()).toEqual({ calls: 2 });
    const relogin = hub.sessionFor(hub.a.deviceId!);
    const replay = await hub.call(relogin, 'POST', '/api/v1/test/count', {}, key('k'));
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.json()).toEqual({ calls: 1 });
    expect(calls).toBe(2);
    // The path is part of the key.
    const elsewhere = await hub.call(hub.a, 'POST', '/api/v1/spaces', { name: 'S' }, key('k'));
    expect(elsewhere.statusCode).toBe(201);
  });

  it('replays a queued sync push without merging it twice', async () => {
    await build();
    const threadId = '01920000-0000-7000-8000-00000000a0a1';
    const body = {
      deviceId: hub.a.deviceId,
      ops: [{ kind: 'thread', id: threadId, field: 'title', value: 'Queued', hlc: hub.hlc(hub.a) }],
    };
    const first = await hub.call(hub.a, 'POST', '/api/v1/sync/push', body, key('push-1'));
    expect(first.json<SyncPushResult>().results[0]!.status).toBe('accepted');
    const cursor = hub.area.service.cursor();
    const again = await hub.call(hub.a, 'POST', '/api/v1/sync/push', body, key('push-1'));
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.json()).toEqual(first.json());
    expect(hub.area.service.cursor()).toBe(cursor);
    expect((await hub.threads.view(ACCOUNT, threadId)).title).toBe('Queued');
  });

  it('runs a retry of a failed request again, and replays a client error as it was', async () => {
    await build();
    failNext = 1;
    const failed = await hub.call(hub.a, 'POST', '/api/v1/test/count', {}, key('retry'));
    expect(failed.statusCode).toBe(500);
    const retry = await hub.call(hub.a, 'POST', '/api/v1/test/count', {}, key('retry'));
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replay']).toBeUndefined();
    expect(calls).toBe(1);
    const bad = await hub.call(hub.a, 'POST', '/api/v1/spaces', { name: '' }, key('bad'));
    expect(bad.statusCode).toBe(400);
    const badAgain = await hub.call(hub.a, 'POST', '/api/v1/spaces', { name: '' }, key('bad'));
    expect(badAgain.statusCode).toBe(400);
    expect(badAgain.headers['idempotent-replay']).toBe('true');
  });

  it('never keeps a no-store answer: a repeat is refused, not replayed or redone', async () => {
    await build();
    const first = await hub.call(
      hub.a,
      'POST',
      '/api/v1/test/count',
      { secret: true },
      key('once'),
    );
    expect(first.statusCode).toBe(201);
    const again = await hub.call(
      hub.a,
      'POST',
      '/api/v1/test/count',
      { secret: true },
      key('once'),
    );
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { details: { reason: 'idempotency_not_replayable' } },
    });
    expect(calls).toBe(1);
    const row = hub.db.raw
      .prepare("SELECT response FROM idempotency_key WHERE key = 'once'")
      .get() as { response: string | null };
    expect(row.response).toBeNull();
  });

  it('refuses malformed keys and leaves requests without a session alone', async () => {
    await build();
    for (const bad of ['', 'with space', 'x'.repeat(201)]) {
      const res = await hub.call(hub.a, 'POST', '/api/v1/test/count', {}, key(bad));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: { details: { reason: 'idempotency_key_invalid' } },
      });
    }
    const anon = await hub.call(null, 'POST', '/api/v1/test/count', {}, key('anon'));
    expect(anon.statusCode).toBe(401);
    const n = hub.db.raw.prepare('SELECT count(*) AS n FROM idempotency_key').get() as {
      n: number;
    };
    expect(n.n).toBe(0);
    // GET is never keyed.
    const get = await hub.call(hub.a, 'GET', '/api/v1/sync/devices', undefined, key('g'));
    expect(get.headers['idempotent-replay']).toBeUndefined();
  });

  it('forgets keys after 24 hours', async () => {
    await build();
    await hub.call(hub.a, 'POST', '/api/v1/test/count', {}, key('day'));
    hub.clock.t += 24 * 60 * 60 * 1000;
    const later = await hub.call(hub.a, 'POST', '/api/v1/test/count', {}, key('day'));
    expect(later.headers['idempotent-replay']).toBeUndefined();
    expect(calls).toBe(2);
    hub.clock.t += 24 * 60 * 60 * 1000;
    expect(await hub.area.idempotency.store.sweep()).toBe(1);
  });

  it('remembers the key of a route that did not opt in, and refuses a repeat without its answer', async () => {
    await build();
    const first = await hub.call(hub.a, 'POST', '/api/v1/test/plain', {}, key('plain'));
    expect(first.statusCode).toBe(201);
    const again = await hub.call(hub.a, 'POST', '/api/v1/test/plain', {}, key('plain'));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { details: { reason: 'idempotency_not_replayable' } },
    });
    expect(calls).toBe(1);
  });

  it('keeps no enrollment token from novad enroll and never replays one (review finding 8)', async () => {
    await build();
    const first = await hub.call(
      hub.owner,
      'POST',
      '/api/v1/devices/novad/enroll',
      {},
      key('enroll-1'),
    );
    expect(first.statusCode).toBe(201);
    expect(first.headers['cache-control']).toContain('no-store');
    const token = JSON.stringify(first.json());
    expect(token).toMatch(/nvd_/);
    const rows = hub.db.raw
      .prepare('SELECT response, replayable, status FROM idempotency_key')
      .all() as { response: string | null; replayable: number; status: number }[];
    expect(rows).toEqual([{ response: null, replayable: 0, status: 201 }]);
    const dump = JSON.stringify(hub.db.raw.prepare('SELECT * FROM idempotency_key').all());
    expect(dump).not.toMatch(/nv[a-z]_[A-Za-z0-9_-]{20,}/);
    const again = await hub.call(
      hub.owner,
      'POST',
      '/api/v1/devices/novad/enroll',
      {},
      key('enroll-1'),
    );
    expect(again.statusCode).toBe(409);
    expect(again.body).not.toMatch(/nvd_/);
    expect(again.headers['idempotent-replay']).toBeUndefined();
  });
});
