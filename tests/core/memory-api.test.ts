import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createNova } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import { sha256 } from '../../src/core/workspace.ts';

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-memory-api-'));
  const config = { ...loadConfig({ NOVA_HOME: home, NOVA_AGENT_CMD: 'node scripts/fake-agent.js', NOVA_AGENT_EGRESS: 'none', NOVA_TZ: 'UTC' }), port: 0 };
  const nova = createNova(config);
  await new Promise<void>((r) => nova.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(nova.server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const stop = async () => { nova.server.close(); await nova.core.close(); };
  return { nova, home, call, stop };
}

test('the person remembers, corrects, confirms, searches and exports memory over the API', async () => {
  const { nova, call, stop } = await boot();
  const made = await call('POST', '/memory', { kind: 'fact', content: 'The library closes at six on Fridays.', source: 'conversation', recorded_by: 'nova' });
  assert.equal(made.status, 201);
  assert.equal(made.body.recorded_by, 'person', 'the API speaks for the person');
  assert.equal(made.body.user_state, 'confirmed');
  assert.equal((await call('POST', '/memory', { kind: 'rumour', content: 'x' })).status, 400);

  const nova1 = nova.core.memory.remember({ kind: 'preference', content: 'Probably likes the library reading room.', recorded_by: 'nova', confidence: 0.4 });
  const listed = (await call('GET', '/memory?state=unreviewed')).body;
  assert.deepEqual(listed.map((r: { id: string; low_confidence: boolean }) => [r.id, r.low_confidence]), [[nova1.id, true]]);
  assert.equal((await call('GET', '/memory?kind=fact&scope=personal')).body.length, 1);
  assert.equal((await call('GET', '/memory?state=maybe')).status, 400);

  const fixed = await call('POST', `/memory/${made.body.id}/correct`, { content: 'The library closes at five on Fridays.' });
  assert.equal(fixed.body.supersedes, made.body.id);
  assert.equal((await call('POST', `/memory/${nova1.id}/confirm`)).body.user_state, 'confirmed');
  assert.equal((await call('POST', '/memory/nope/confirm')).status, 404);

  const found = (await call('GET', '/memory/search?q=closes+fridays')).body;
  assert.deepEqual(found.records.map((r: { id: string }) => r.id), [fixed.body.id]);
  assert.equal(found.retrieved[0].ref, fixed.body.id);

  const out = (await call('POST', '/memory/export')).body;
  assert.ok(existsSync(out.json) && existsSync(out.markdown));
  assert.equal(JSON.parse(readFileSync(out.json, 'utf8')).records.length, 2);

  const health = (await call('GET', '/health')).body;
  assert.deepEqual(health.checks.memory.counts, { active: 2, unreviewed: 0, low_confidence: 1 });
  assert.deepEqual(health.checks.receipts.counts, { total: 0, remote: 0 });
  await stop();
});

test('forgetting over the API leaves no trace in the database file or the log', async () => {
  const { nova, home, call, stop } = await boot();
  const secret = 'Example Person keeps a spare key under the green pot.';
  const a = (await call('POST', '/memory', { kind: 'entity', content: secret })).body;
  await call('POST', `/memory/${a.id}/correct`, { content: `${secret} Not any more.` });
  const files = ['nova.db', 'nova.db-wal', join('logs', 'nova.log')].map((f) => join(home, f));
  const holding = () => files.filter((p) => existsSync(p) && readFileSync(p).includes('green pot'));
  assert.ok(holding().length > 0, 'the check can see the content on disk while it is remembered');
  const gone = await call('DELETE', `/memory/${a.id}`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.forgotten.length, 2);
  assert.deepEqual((await call('GET', '/memory')).body, []);
  const db = nova.core.db;
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  for (const t of tables) assert.ok(!JSON.stringify(db.all(`SELECT * FROM "${t.name}"`)).includes('green pot'), t.name);
  assert.deepEqual(holding(), [], 'no file on disk still holds the content');
  assert.equal((await call('DELETE', `/memory/${a.id}`)).status, 404);
  await stop();
});

test('receipts are listed by task, session and egress; the egress log is the remote ones', async () => {
  const { nova, call, stop } = await boot();
  const item = { kind: 'session', ref: 'session-1', sha256: sha256('hello') } as const;
  const local = nova.core.receipts.record({ session_id: 'session-1', provider: 'local-runner', model: 'small', purpose: 'chat reply', privacy_mode: 'local-only', egress: 'local', context_items: [item] });
  const remote = nova.core.receipts.record({ task_id: 't1', provider: 'cloud', model: 'large', purpose: 'summary', privacy_mode: 'cloud-allowed', egress: 'remote:example-cloud', context_items: [] });
  assert.deepEqual((await call('GET', '/receipts?egress=remote')).body.map((r: { id: string }) => r.id), [remote.id]);
  assert.deepEqual((await call('GET', '/receipts?session_id=session-1')).body.map((r: { id: string }) => r.id), [local.id]);
  assert.deepEqual((await call('GET', '/receipts?task_id=t1')).body.map((r: { id: string }) => r.id), [remote.id]);
  assert.equal((await call('GET', '/receipts')).body.length, 2);
  assert.equal((await call('GET', '/receipts?egress=elsewhere')).status, 400);
  assert.throws(() => nova.core.receipts.record({ provider: 'cloud', model: 'large', purpose: 'chat reply', privacy_mode: 'local-only', egress: 'remote:example-cloud', context_items: [] }), /local-only/i);
  assert.equal((await call('GET', '/receipts?egress=remote')).body.length, 1, 'the refused call is not in the egress log');
  const problems = (await call('GET', '/problems?open=1')).body;
  assert.ok(problems.some((p: { source: string }) => p.source === 'receipts'));
  await stop();
});
