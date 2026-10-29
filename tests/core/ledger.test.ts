import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger, type TaskInput } from '../../src/core/ledger.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace, sha256, workspaceWorker } from '../../src/core/workspace.ts';
import { ENVELOPE_VERSION, type Brief, type PrivacyMode } from '../../src/core/envelope.ts';
import type { Egress, Worker } from '../../src/core/workers.ts';

function setup(opts: { workers?: (ws: Workspace) => Worker[]; privacy?: PrivacyMode; db?: Db; root?: string } = {}) {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'nova-ledger-'));
  const db = opts.db ?? new Db(':memory:');
  if (!opts.db) db.migrate();
  const log = new Log(db, null);
  const ws = new Workspace(join(root, 'workspace'));
  const workers = [workspaceWorker(ws), ...(opts.workers?.(ws) ?? [])];
  const ledger = new Ledger({ db, log, verifier: new Verifier(ws), workers, defaultPrivacy: () => opts.privacy ?? 'local-only' });
  return { db, log, ws, ledger, root };
}

const writeNote = (over: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Write a note',
  owner: 'workspace',
  goal: 'A note saying hello is in the workspace.',
  origin: { kind: 'user' },
  evidence_required: [{ kind: 'read_back', target: 'workspace:notes/hello.md' }],
  inputs: { action: 'write', path: 'notes/hello.md', content: 'hello\n' },
  ...over,
});

const fake = (id: string, egress: Egress, run: (b: Brief, ws: Workspace) => Promise<unknown>) => (ws: Workspace): Worker => ({
  id, name: id, about: 'test worker', egress, evidence: ['read_back'], health: () => ({ ok: true }), run: (b) => run(b, ws),
});

const report = (b: Brief, extra: Record<string, unknown> = {}) => ({
  envelope: ENVELOPE_VERSION, task_id: b.task_id, status: 'done', summary: 'did it', evidence: [], artifacts: [], blockers: [], usage: { duration_ms: 1 }, follow_up_suggestions: [], ...extra,
});

test('a task runs, is verified by reading the file back, and ends done with its evidence', async () => {
  const { ledger, ws } = setup();
  const t = ledger.create(writeNote());
  assert.equal(t.brief.envelope, '1');
  assert.equal(t.brief.task_id, t.id);
  assert.equal(t.privacy_mode, 'local-only');
  await ledger.idle();
  const done = ledger.get(t.id);
  assert.equal(done.state, 'done', done.reason ?? '');
  assert.equal(readFileSync(ws.resolve('notes/hello.md'), 'utf8'), 'hello\n');
  assert.equal(done.verification?.ok, true);
  assert.match(done.verification!.checks[0]!.why, /read workspace:notes\/hello.md itself/);
  assert.equal(done.report?.evidence[0]?.kind, 'read_back');
  assert.ok(done.completed_at);
  assert.deepEqual(ledger.events(t.id).map((e) => e.kind), ['created', 'dispatched', 'reported', 'verifying', 'verified']);
  assert.deepEqual(ledger.events(t.id).map((e) => e.to_state).filter(Boolean), ['queued', 'active', 'verifying', 'done']);
});

test('a task without an evidence requirement is refused: done must be provable', () => {
  const { ledger } = setup();
  assert.throws(() => ledger.create(writeNote({ evidence_required: [] })), /evidence/);
  assert.throws(() => ledger.create(writeNote({ owner: 'nobody' })), /no worker called "nobody"/);
});

test('the same idempotency key gives back the same task, not a second one', async () => {
  const { ledger } = setup();
  const a = ledger.create(writeNote({ idempotency_key: 'k1' }));
  const b = ledger.create(writeNote({ idempotency_key: 'k1', title: 'Something else' }));
  assert.equal(a.id, b.id);
  await ledger.idle();
  assert.equal(ledger.list().length, 1);
});

test('a worker that claims evidence it did not produce is caught, retried, then failed and surfaced', async () => {
  const liar = fake('liar', 'none', async (b) => report(b, { evidence: [{ kind: 'read_back', target: 'workspace:notes/hello.md', sha256: sha256('hello\n'), bytes: 6 }] }));
  const { ledger, log } = setup({ workers: (ws) => [liar(ws)] });
  const t = ledger.create(writeNote({ owner: 'liar' }));
  await ledger.idle();
  const after = ledger.get(t.id);
  assert.equal(after.state, 'failed');
  assert.match(after.reason ?? '', /looked for workspace:notes\/hello.md and it isn't there/);
  assert.equal(after.attempts, 3);
  assert.equal(after.user_visibility, 'attention');
  assert.equal(ledger.events(t.id).filter((e) => e.kind === 'verification_failed').length, 3);
  const [problem] = log.problems({ open: true });
  assert.equal(problem?.task_id, t.id, 'the failure reaches the problem list, not only the log');
});

test('evidence that does not match what is on disk fails verification', async () => {
  const tamper = fake('tamper', 'none', async (b, ws) => {
    mkdirSync(join(ws.root, 'notes'), { recursive: true });
    writeFileSync(ws.resolve('notes/hello.md'), 'something else');
    return report(b, { evidence: [{ kind: 'read_back', target: 'workspace:notes/hello.md', sha256: sha256('hello\n'), bytes: 6 }] });
  });
  const { ledger } = setup({ workers: (ws) => [tamper(ws)] });
  const t = ledger.create(writeNote({ owner: 'tamper' }));
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'failed');
  assert.match(ledger.get(t.id).reason ?? '', /doesn't match the report/);
});

test('evidence of a kind Nova cannot check yet never counts as proof', async () => {
  const claims = fake('claims', 'none', async (b) => report(b, { evidence: [{ kind: 'confirmation', system: 'shop', id: 'X1' }] }));
  const { ledger } = setup({ workers: (ws) => [claims(ws)] });
  const t = ledger.create(writeNote({ owner: 'claims', evidence_required: [{ kind: 'confirmation' }] }));
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'failed');
  assert.match(ledger.get(t.id).reason ?? '', /can't check confirmation evidence yet/);
});

test('a local-only task is never handed to a worker that would send data off the device', async () => {
  let called = false;
  const cloud = fake('cloud', 'remote', async (b) => { called = true; return report(b); });
  const { ledger } = setup({ workers: (ws) => [cloud(ws)] });
  const t = ledger.create(writeNote({ owner: 'cloud' }));
  await ledger.idle();
  const after = ledger.get(t.id);
  assert.equal(after.state, 'waiting');
  assert.match(after.reason ?? '', /Waiting on local capacity/);
  assert.equal(called, false);
  const allowed = ledger.create(writeNote({ owner: 'cloud', privacy_mode: 'cloud-allowed', idempotency_key: 'c2' }));
  await ledger.idle();
  assert.equal(called, true, 'the same worker serves a task whose mode allows it');
  assert.notEqual(ledger.get(allowed.id).state, 'waiting');
});

test('tier 2 waits for an OK; tier 3 needs an explicit confirmation', async () => {
  const { ledger } = setup();
  const t2 = ledger.create(writeNote({ approval_tier: 2, idempotency_key: 't2' }));
  await ledger.idle();
  assert.equal(ledger.get(t2.id).state, 'waiting');
  assert.equal(ledger.get(t2.id).reason, 'Needs your OK before it runs.');
  ledger.approve(t2.id);
  await ledger.idle();
  assert.equal(ledger.get(t2.id).state, 'done');

  const t3 = ledger.create(writeNote({ approval_tier: 3, idempotency_key: 't3' }));
  await ledger.idle();
  assert.throws(() => ledger.approve(t3.id), /explicit confirmation/);
  ledger.approve(t3.id, { confirm: true });
  await ledger.idle();
  assert.equal(ledger.get(t3.id).state, 'done');
  assert.throws(() => ledger.approve(writeNote().title), /No task/);
});

test('a worker that crashes is retried, and its final failure is a visible problem', async () => {
  let n = 0;
  const flaky = fake('flaky', 'none', async (b, ws) => {
    n += 1;
    if (n < 2) throw new Error('disk hiccup');
    return workspaceWorker(ws).run(b, new AbortController().signal);
  });
  const { ledger } = setup({ workers: (ws) => [flaky(ws)] });
  const t = ledger.create(writeNote({ owner: 'flaky' }));
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'done');
  assert.equal(ledger.get(t.id).attempts, 2);

  const broken = fake('broken', 'none', async () => ({ nonsense: true }));
  const s = setup({ workers: (ws) => [broken(ws)] });
  const bad = s.ledger.create(writeNote({ owner: 'broken' }));
  await s.ledger.idle();
  assert.equal(s.ledger.get(bad.id).state, 'failed');
  assert.match(s.ledger.get(bad.id).reason ?? '', /report Nova couldn't read/);
  assert.equal(s.log.problems().length, 1);
});

test('blocked and partial reports wait for the person instead of passing as done', async () => {
  const blocked = fake('blocked', 'none', async (b) => report(b, { status: 'blocked', blockers: ['needs a password'] }));
  const { ledger } = setup({ workers: (ws) => [blocked(ws)] });
  const t = ledger.create(writeNote({ owner: 'blocked' }));
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'waiting');
  assert.equal(ledger.get(t.id).reason, 'Blocked: needs a password');
  ledger.cancel(t.id, 'Not needed any more.');
  assert.equal(ledger.get(t.id).state, 'cancelled');
  assert.throws(() => ledger.cancel(t.id), /already cancelled/);
});

test('tasks survive a restart: running work is requeued and finishes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-ledger-'));
  const path = join(root, 'nova.db');
  const db1 = new Db(path);
  db1.migrate();
  const hang = fake('hang', 'none', () => new Promise(() => {}));
  const first = setup({ db: db1, root, workers: (ws) => [hang(ws)] });
  const t = first.ledger.create(writeNote({ owner: 'hang' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(first.ledger.get(t.id).state, 'active');
  db1.close(); // the process dies here

  const db2 = new Db(path);
  db2.migrate();
  const ok = fake('hang', 'none', (b, ws) => workspaceWorker(ws).run(b, new AbortController().signal));
  const second = setup({ db: db2, root, workers: (ws) => [ok(ws)] });
  const r = second.ledger.recover();
  assert.deepEqual(r.requeued, [t.id]);
  await second.ledger.idle();
  const after = second.ledger.get(t.id);
  assert.equal(after.state, 'done');
  assert.ok(second.ledger.events(t.id).some((e) => e.kind === 'recovered'));
  db2.close();
});

test('illegal moves are refused', async () => {
  const { ledger } = setup();
  const t = ledger.create(writeNote());
  await ledger.idle();
  assert.throws(() => ledger.cancel(t.id), /already done/);
});

test('pumping an empty queue settles, so idle() returns (regression: it used to spin forever)', async () => {
  const { ledger } = setup();
  await ledger.pump();
  await ledger.idle();
  const t = ledger.create(writeNote());
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'done');
});
