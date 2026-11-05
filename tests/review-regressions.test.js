import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/sessions.js';
import { healthCard } from '../ui/js/components.js';
import { checkState } from '../ui/js/health-state.js';
import { firstAction } from '../src/core/onboard/first.ts';

test('the session index follows append, external edits, removal and restart', async () => {
  const h = mkdtempSync(join(tmpdir(), 'nova-session-index-'));
  mkdirSync(join(h, 'sessions'));
  const store = new SessionStore(h, 'UTC');
  const id = '2026-11-05-aaaaaa';
  try {
    store.append(id, { type: 'session', title: 'First', id });
    assert.equal((await store.listAsync())[0].title, 'First');
    const first = store.read(id);
    first[0].title = 'must not mutate the record';
    assert.equal(store.read(id)[0].title, 'First');
    store.append(id, { type: 'user', text: 'Next' });
    assert.equal(store.read(id).length, 2);
    writeFileSync(store.path(id), JSON.stringify({ type: 'session', title: 'Edited outside Nova' }) + '\n');
    await new Promise(r => setTimeout(r, 50));
    assert.equal((await store.listAsync())[0].title, 'Edited outside Nova');
    assert.equal(store.read(id).length, 1);
    store.close();
    const restarted = new SessionStore(h, 'UTC');
    try { assert.equal((await restarted.listAsync())[0].title, 'Edited outside Nova'); } finally { restarted.close(); }
    rmSync(store.path(id));
    assert.deepEqual(await store.listAsync(), []);
  } finally { store.close(); rmSync(h, { recursive: true, force: true }); }
});

test('cold conversation indexing yields to the event loop and hides worker logs', async () => {
  const h = mkdtempSync(join(tmpdir(), 'nova-session-pages-'));
  mkdirSync(join(h, 'sessions'));
  const store = new SessionStore(h, 'UTC');
  try {
    for (let i = 0; i < 200; i++) store.append(`2026-11-05-${i.toString(36).padStart(6, '0')}`, { type: 'session', title: 'History', ...(i === 0 ? { kind: 'helper' } : {}) });
    let yielded = false;
    setImmediate(() => { yielded = true; });
    assert.equal((await store.listAsync()).length, 199);
    assert.equal(yielded, true);
    assert.equal(store.list().length, 199);
  } finally { store.close(); rmSync(h, { recursive: true, force: true }); }
});

test('readiness states never become all systems normal', () => {
  const checks = { computer: { ok: true, available: null }, ingest: { ok: true, model: false }, passkeys: { ok: true, complete: false }, backups: { ok: true, configured: false } };
  assert.equal(checkState('computer', checks.computer), 'Not checked');
  assert.equal(checkState('ingest', checks.ingest), 'Limited');
  assert.equal(checkState('backups', checks.backups), 'Not configured');
  assert.equal(checkState('passkeys', checks.passkeys), 'Needs setup');
  assert.doesNotMatch(healthCard({ health: { ok: true, checks } }), /All systems normal/);
  assert.match(healthCard({ health: { ok: true, checks } }), /need setup or checking/);
});

test('the first-run import action names the configured path, including custom homes', () => {
  const folder = join(tmpdir(), 'Nova with spaces', 'workspace', 'import');
  assert.ok(firstAction(0, folder).why.includes(folder));
  assert.ok(!firstAction(0, folder).why.includes('~/workspace/import'));
  assert.equal(firstAction(2, folder).id, 'review-imports');
});
