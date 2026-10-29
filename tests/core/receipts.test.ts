import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Receipts, type ReceiptInput } from '../../src/core/receipts.ts';
import { sha256 } from '../../src/core/workspace.ts';

function setup() {
  const db = new Db(':memory:');
  db.migrate();
  const log = new Log(db, null);
  const receipts = new Receipts({ db, log, now: () => new Date('2026-10-01T09:00:00Z') });
  return { db, log, receipts };
}

const call = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({
  session_id: 'session-1', provider: 'local-runner', model: 'small-model', purpose: 'chat reply',
  privacy_mode: 'local-only', egress: 'local',
  context_items: [
    { kind: 'standing', ref: 'SOUL.md', sha256: sha256('soul') },
    { kind: 'memory', ref: 'm1', sha256: sha256('a memory') },
  ],
  ...over,
});

test('a receipt records what a model was told and where it went', () => {
  const { receipts } = setup();
  const r = receipts.record(call());
  assert.equal(r.at, '2026-10-01T09:00:00.000Z');
  assert.equal(r.task_id, null);
  assert.equal(r.session_id, 'session-1');
  assert.equal(r.egress, 'local');
  assert.deepEqual(r.context_items.map((i) => i.kind), ['standing', 'memory']);
  assert.deepEqual(receipts.get(r.id), r);
});

test('receipts list newest first and filter by task, session and egress', () => {
  const { receipts } = setup();
  const a = receipts.record(call({ task_id: 't1', session_id: undefined }));
  const b = receipts.record(call({ privacy_mode: 'cloud-allowed', egress: 'remote:example-cloud' }));
  const c = receipts.record(call({ session_id: 'session-2', privacy_mode: 'local-preferred', egress: 'remote:other-cloud' }));
  assert.deepEqual(receipts.list().map((r) => r.id), [c.id, b.id, a.id]);
  assert.deepEqual(receipts.list({ task_id: 't1' }).map((r) => r.id), [a.id]);
  assert.deepEqual(receipts.list({ session_id: 'session-1' }).map((r) => r.id), [b.id]);
  assert.deepEqual(receipts.list({ egress: 'remote' }).map((r) => r.id), [c.id, b.id], 'the egress log');
  assert.deepEqual(receipts.list({ egress: 'local' }).map((r) => r.id), [a.id]);
  assert.throws(() => receipts.list({ egress: 'sideways' as 'local' }), /egress must be local or remote/);
  assert.deepEqual(receipts.counts(), { total: 3, remote: 2 });
});

test('bad receipts are refused in plain words', () => {
  const { receipts } = setup();
  assert.throws(() => receipts.record(call({ provider: '' })), /provider is required/);
  assert.throws(() => receipts.record(call({ purpose: ' ' })), /purpose is required/);
  assert.throws(() => receipts.record(call({ privacy_mode: 'open' as 'local-only' })), /privacy_mode must be one of/);
  assert.throws(() => receipts.record(call({ egress: 'cloud' })), /egress must be "local" or "remote:<name>"/);
  assert.throws(() => receipts.record(call({ context_items: [{ kind: 'gossip' as 'file', ref: 'x', sha256: sha256('x') }] })), /context item 1: kind must be one of memory, file, skill, session, standing/);
  assert.throws(() => receipts.record(call({ context_items: [{ kind: 'file', ref: 'x', sha256: 'abc' }] })), /context item 1: sha256 must be/);
  assert.throws(() => receipts.record(call({ context_items: [{ kind: 'file', ref: '', sha256: sha256('x') }] })), /context item 1: ref is required/);
  assert.deepEqual(receipts.list(), []);
});

test('a remote call in local-only mode is refused, never stored as fine, and becomes a problem', () => {
  const { db, log, receipts } = setup();
  db.run("INSERT INTO task (id, title, origin, state, owner, brief, privacy_mode, approval_tier, user_visibility, idempotency_key, created_at, updated_at) VALUES ('t9', 'x', '{}', 'queued', 'workspace', '{}', 'local-only', 0, 'silent', 'k9', 'now', 'now')");
  assert.throws(() => receipts.record(call({ task_id: 't9', egress: 'remote:example-cloud' })), (e: Error & { code?: string }) => {
    assert.equal(e.code, 'forbidden');
    assert.match(e.message, /local-only/i);
    assert.match(e.message, /example-cloud/);
    return true;
  });
  assert.deepEqual(receipts.list(), []);
  const [p] = log.problems({ open: true });
  assert.equal(p?.source, 'receipts');
  assert.match(p!.message, /example-cloud/);
  assert.equal(p?.task_id, 't9');
  // A task id that isn't in the ledger (a chat session's call, say) still becomes a problem.
  assert.throws(() => receipts.record(call({ task_id: 'not-a-task', egress: 'remote:example-cloud' })), /local-only/i);
  assert.equal(log.problems().length, 2);
});
