// Idempotent writes (FR-112, ADR-095 decision 2): the first answer is kept per principal, key,
// method and path for 24 hours; a different body is refused, so is a repeat while the first runs;
// unreplayable answers are refused rather than redone; failures worth retrying are forgotten;
// expired keys are swept.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  IDEMPOTENCY_IN_FLIGHT_MS,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_MAX_RESPONSE_BYTES,
  IDEMPOTENCY_TTL_MS,
  IdempotencyStore,
  carriesCredential,
  hashRequestBody,
  type IdempotencyRef,
} from '../src/index.ts';

let db: NovaDatabase;
let t: number;
let store: IdempotencyStore;
const ref: IdempotencyRef = {
  principal: 'device:d1',
  key: 'k-1',
  method: 'POST',
  path: '/api/v1/x',
};
const body = hashRequestBody({ a: 1 });

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  t = Date.parse('2026-10-17T09:00:00.000Z');
  store = new IdempotencyStore({ db, now: () => new Date(t) });
});

afterEach(() => {
  db.close();
});

describe('IdempotencyStore', () => {
  it('lets the first request run and replays its answer for the same key', async () => {
    expect(await store.begin(ref, body, 'acct')).toEqual({ kind: 'proceed' });
    expect(await store.begin(ref, body, 'acct')).toEqual({
      kind: 'refuse',
      reason: 'idempotency_in_flight',
    });
    await store.complete(ref, { status: 201, body: '{"id":"x"}', contentType: 'application/json' });
    expect(await store.begin(ref, body, 'acct')).toEqual({
      kind: 'replay',
      status: 201,
      body: '{"id":"x"}',
      contentType: 'application/json',
    });
    // Another principal, method or path is another key.
    for (const other of [
      { ...ref, principal: 'token:t2' },
      { ...ref, method: 'PATCH' },
      { ...ref, path: '/api/v1/y' },
    ])
      expect(await store.begin(other, body, 'acct')).toEqual({ kind: 'proceed' });
  });

  it('refuses the same key with a different body', async () => {
    await store.begin(ref, body, null);
    await store.complete(ref, { status: 200, body: '{}', contentType: null });
    expect(await store.begin(ref, hashRequestBody({ a: 2 }), null)).toEqual({
      kind: 'refuse',
      reason: 'idempotency_key_reused',
    });
  });

  it('remembers but does not replay an answer it may not keep', async () => {
    await store.begin(ref, body, null);
    await store.complete(ref, { status: 201, body: null, contentType: 'application/json' });
    expect(await store.begin(ref, body, null)).toEqual({
      kind: 'refuse',
      reason: 'idempotency_not_replayable',
    });
    const big = { ...ref, key: 'big' };
    await store.begin(big, body, null);
    await store.complete(big, {
      status: 200,
      body: 'x'.repeat(IDEMPOTENCY_MAX_RESPONSE_BYTES + 1),
      contentType: 'text/plain',
    });
    expect((await store.begin(big, body, null)).kind).toBe('refuse');
    const row = db.raw.prepare("SELECT response FROM idempotency_key WHERE key = 'big'").get() as {
      response: string | null;
    };
    expect(row.response).toBeNull();
  });

  it('forgets an abandoned key and takes over one lost in flight', async () => {
    await store.begin(ref, body, null);
    await store.abandon(ref);
    expect(await store.begin(ref, body, null)).toEqual({ kind: 'proceed' });
    t += IDEMPOTENCY_IN_FLIGHT_MS + 1;
    expect(await store.begin(ref, body, null)).toEqual({ kind: 'proceed' });
  });

  it('expires keys after 24 hours and sweeps them', async () => {
    await store.begin(ref, body, null);
    await store.complete(ref, { status: 200, body: '{}', contentType: null });
    await store.begin({ ...ref, key: 'k-2' }, body, null);
    await store.complete({ ...ref, key: 'k-2' }, { status: 200, body: '{}', contentType: null });
    t += IDEMPOTENCY_TTL_MS;
    expect(await store.begin(ref, hashRequestBody({ new: true }), null)).toEqual({
      kind: 'proceed',
    });
    expect(await store.sweep()).toBe(1);
    const n = db.raw.prepare('SELECT count(*) AS n FROM idempotency_key').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('hashes bodies by content and accepts only visible ASCII keys of 1-200', () => {
    expect(hashRequestBody({ a: 1 })).toBe(hashRequestBody({ a: 1 }));
    expect(hashRequestBody(undefined)).toBe(hashRequestBody(null));
    expect(hashRequestBody(Buffer.from('x'))).not.toBe(hashRequestBody('x'));
    expect(IDEMPOTENCY_KEY_PATTERN.test('a'.repeat(200))).toBe(true);
    for (const bad of ['', 'a'.repeat(201), 'has space', 'tab\t', 'ünï'])
      expect(IDEMPOTENCY_KEY_PATTERN.test(bad)).toBe(false);
  });

  it('never writes an answer that carries a credential, whatever the caller passes', async () => {
    const cases = [
      '{"token":"nvd_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","expiresAt":"x"}',
      '{"authorization":{"id":"a"},"token":"nvm_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}',
      '{"grant":{"type":"session","token":"opaque"}}',
      '{"enrollToken":"whatever-shape"}',
      '{"note":"key sk-abcdefghijklmnopqrstuvwxyz0123 in text"}',
    ];
    for (const [i, body] of cases.entries()) {
      const r = { ...ref, key: `cred-${i}` };
      await store.begin(r, hashRequestBody(null), null);
      await store.complete(r, { status: 201, body, contentType: 'application/json' });
      expect(await store.begin(r, hashRequestBody(null), null)).toEqual({
        kind: 'refuse',
        reason: 'idempotency_not_replayable',
      });
    }
    const kept = db.raw
      .prepare('SELECT count(*) AS n FROM idempotency_key WHERE response IS NOT NULL')
      .get() as { n: number };
    expect(kept.n).toBe(0);
  });
});

describe('carriesCredential', () => {
  it('finds tokens by shape and by key, and leaves ordinary answers alone', () => {
    expect(carriesCredential('{"routeToken":"x"}')).toBe(true);
    expect(carriesCredential('{"clientSecret":"x"}')).toBe(true);
    expect(carriesCredential('{"items":[{"privateKey":{"k":1}}]}')).toBe(true);
    expect(carriesCredential('plain nve_CCCCCCCCCCCCCCCCCCCCCCCCCCCCC text')).toBe(true);
    expect(carriesCredential('{"id":"t1","title":"Tokens and secrets","maxTokens":5}')).toBe(false);
    expect(carriesCredential('{"secretRef":"secret://x","token":null,"hasPassword":true}')).toBe(
      false,
    );
    expect(carriesCredential('not json')).toBe(false);
  });
});
