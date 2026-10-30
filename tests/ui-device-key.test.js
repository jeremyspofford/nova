// A browser that forgets its device key (it was revoked) also drops what the service worker kept
// for offline use: a revoked phone must not go on showing Nova's answers from its cache. The
// browser's storage is stood in for by small fakes. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const keys = new Map([['self', { deviceId: 'example-device' }]]);
const fakeDb = {
  close() {},
  transaction() {
    const t = {
      objectStore: () => ({
        delete(k) { keys.delete(k); queueMicrotask(() => t.oncomplete?.()); return {}; },
        get(k) { const r = { result: keys.get(k) }; queueMicrotask(() => t.oncomplete?.()); return r; },
      }),
    };
    return t;
  },
};
globalThis.indexedDB = { open() { const req = { result: fakeDb }; queueMicrotask(() => req.onsuccess?.()); return req; } };
const local = new Map([['nova.session', '2026-10-30T10:00:00Z']]);
globalThis.localStorage = { getItem: (k) => local.get(k) ?? null, setItem: (k, v) => local.set(k, v), removeItem: (k) => local.delete(k) };
const cached = new Map([['nova-shell-v3', ['/api/v1/tasks', '/api/sessions', '/']]]);
globalThis.caches = { keys: async () => [...cached.keys()], delete: async (k) => cached.delete(k) };

const key = await import('../ui/js/device-key.js');

test('forgetting the key drops the session flag and every offline copy', async () => {
  assert.ok(await key.load());
  await key.forget();
  assert.equal(await key.load(), null);
  assert.equal(local.has('nova.session'), false);
  assert.deepEqual(await caches.keys(), [], 'no cached answers survive a revocation');
});

test('a browser without the Cache API still forgets its key', async () => {
  const saved = globalThis.caches;
  delete globalThis.caches;
  try {
    keys.set('self', { deviceId: 'example-device' });
    await key.forget();
    assert.equal(await key.load(), null);
  } finally {
    globalThis.caches = saved;
  }
});
