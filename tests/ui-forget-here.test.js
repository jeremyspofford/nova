// After a factory reset (M7 amendment review, finding 6), a page forgets what it kept of the old
// Nova: its device key, its drafts and other nova.* storage, and every offline copy the service
// worker kept. Other sites' and other apps' storage is left alone. The browser's storage is stood
// in for by small fakes, as in ui-device-key.test.js. Neutral placeholders only.
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
const store = (m) => ({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } });
const local = new Map([['nova.session', 'x'], ['nova.draft.new', 'half a thought'], ['nova.device', 'example'], ['nova.mainSeen', 'x'], ['another.app', 'keep']]);
const session = new Map([['nova.notice', '1'], ['another.app', 'keep']]);
globalThis.localStorage = store(local);
globalThis.sessionStorage = store(session);
const cached = new Map([['nova-shell-v8', ['/', '/api/v1/tasks']]]);
globalThis.caches = { keys: async () => [...cached.keys()], delete: async (k) => cached.delete(k) };

const { forgetHere } = await import('../ui/js/forget-here.js');

test('after a reset, a page forgets its key, its drafts and every offline copy; nothing of other apps', async () => {
  await forgetHere();
  assert.equal(keys.has('self'), false, 'the device key');
  assert.deepEqual([...local.keys()], ['another.app'], 'drafts and the rest of nova.*');
  assert.deepEqual([...session.keys()], ['another.app']);
  assert.deepEqual(await caches.keys(), [], 'no offline copy');
});

test('a browser without IndexedDB still forgets its drafts and offline copies', async () => {
  const saved = globalThis.indexedDB;
  delete globalThis.indexedDB;
  local.set('nova.draft.c1', 'more');
  cached.set('nova-shell-v8', ['/']);
  try {
    await forgetHere();
    assert.equal(local.has('nova.draft.c1'), false);
    assert.deepEqual(await caches.keys(), []);
  } finally {
    globalThis.indexedDB = saved;
  }
});
