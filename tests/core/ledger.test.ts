import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger, canMove, type TaskInput } from '../../src/core/ledger.ts';
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
  const verifier = new Verifier(ws);
  const ledger = new Ledger({ db, log, verifier, workers, defaultPrivacy: () => opts.privacy ?? 'local-only' });
  return { db, log, ws, ledger, root, verifier };
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
  // Confirmations are checkable now, but only from systems Nova can read itself; "shop" isn't one.
  assert.match(ledger.get(t.id).reason ?? '', /can't check confirmations from shop yet, so it can't count as proof/);
});

test('a local-only task is never handed to a worker that would send data off the device', async () => {
  let called = false;
  const cloud = fake('cloud', 'remote', async (b) => { called = true; return report(b); });
  const { ledger } = setup({ workers: (ws) => [cloud(ws)] });
  assert.throws(() => ledger.create(writeNote({ owner: 'cloud' })), /sends data off your devices, and this task is local-only/);
  await ledger.idle();
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

// Review findings (PR #210): each of these failed before its fix.

test('a worker that hangs past the timeout does not block the queue', async () => {
  const hang = fake('hang', 'none', () => new Promise(() => {}));
  const root = mkdtempSync(join(tmpdir(), 'nova-ledger-'));
  const db = new Db(':memory:');
  db.migrate();
  const ws = new Workspace(join(root, 'workspace'));
  const ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [workspaceWorker(ws), hang(ws)], defaultPrivacy: () => 'local-only', timeoutMs: 40, maxAttempts: 1 });
  const stuck = ledger.create(writeNote({ owner: 'hang', idempotency_key: 'h' }));
  const next = ledger.create(writeNote({ idempotency_key: 'n' }));
  await ledger.idle();
  assert.equal(ledger.get(stuck.id).state, 'failed');
  assert.match(ledger.get(stuck.id).reason ?? '', /took longer than/);
  assert.equal(ledger.get(next.id).state, 'done', 'the next task still ran');
});

test('cancelling a running task frees the queue', async () => {
  const hang = fake('hang', 'none', () => new Promise(() => {}));
  const { ledger } = setup({ workers: (ws) => [hang(ws)] });
  const stuck = ledger.create(writeNote({ owner: 'hang', idempotency_key: 'h' }));
  const next = ledger.create(writeNote({ idempotency_key: 'n' }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ledger.get(stuck.id).state, 'active');
  ledger.cancel(stuck.id, 'Taking too long.');
  await ledger.idle();
  assert.equal(ledger.get(stuck.id).state, 'cancelled');
  assert.equal(ledger.get(next.id).state, 'done');
});

test('a read-back target matches however it is spelled, and an append is not repeated', async () => {
  const { ledger, ws } = setup();
  const t = ledger.create(writeNote({ evidence_required: [{ kind: 'read_back', target: 'notes/log.md' }], inputs: { action: 'append', path: 'notes/log.md', content: 'x\n' } }));
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'done', ledger.get(t.id).reason ?? '');
  assert.equal(readFileSync(ws.resolve('notes/log.md'), 'utf8'), 'x\n');
});

test('the workspace worker does not apply the same brief twice', async () => {
  const { ws } = setup();
  const w = workspaceWorker(ws);
  const brief = { envelope: ENVELOPE_VERSION, task_id: 't', goal: 'g', context_refs: [], constraints: {}, privacy_mode: 'local-only', approval_tier: 1, evidence_required: [], idempotency_key: 'once', inputs: { action: 'append', path: 'a.md', content: 'x\n' } } as Brief;
  await w.run(brief, new AbortController().signal);
  const again = (await w.run(brief, new AbortController().signal)) as { status: string };
  assert.equal(again.status, 'done');
  assert.equal(readFileSync(ws.resolve('a.md'), 'utf8'), 'x\n');
});

test('a read-back requirement must name its target', () => {
  const { ledger } = setup();
  assert.throws(() => ledger.create(writeNote({ evidence_required: [{ kind: 'read_back' }] })), /must name the file/);
});

test('a local-only task assigned to a worker that sends data off the device is refused up front', () => {
  const cloud = fake('cloud', 'remote', async (b) => report(b));
  const { ledger } = setup({ workers: (ws) => [cloud(ws)] });
  assert.throws(() => ledger.create(writeNote({ owner: 'cloud' })), /local-only/);
});

test('tier 3 needs a fresh confirmation before every run, including retries', async () => {
  let n = 0;
  const flaky = fake('flaky', 'none', async (b, ws) => { n += 1; if (n === 1) throw new Error('first try fails'); return workspaceWorker(ws).run(b, new AbortController().signal); });
  const { ledger } = setup({ workers: (ws) => [flaky(ws)] });
  const t = ledger.create(writeNote({ owner: 'flaky', approval_tier: 3 }));
  await ledger.idle();
  ledger.approve(t.id, { confirm: true });
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'waiting', 'the retry waits for a new confirmation');
  assert.equal(ledger.get(t.id).reason, 'Needs your OK before it runs.');
  ledger.approve(t.id, { confirm: true });
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'done');
});

test('a blocked task can be retried by the person', async () => {
  let n = 0;
  const sometimes = fake('sometimes', 'none', async (b, ws) => { n += 1; return n === 1 ? report(b, { status: 'blocked', blockers: ['the folder was locked'] }) : workspaceWorker(ws).run(b, new AbortController().signal); });
  const { ledger } = setup({ workers: (ws) => [sometimes(ws)] });
  const t = ledger.create(writeNote({ owner: 'sometimes' }));
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'waiting');
  ledger.retry(t.id);
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'done');
  assert.throws(() => ledger.retry(t.id), /isn't waiting/);
});

test('a task that keeps dying with Nova is failed after the attempt limit, not requeued forever', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-ledger-'));
  const db = new Db(join(root, 'nova.db'));
  db.migrate();
  const { ledger } = setup({ db, root });
  const t = ledger.create(writeNote({ approval_tier: 2 }));
  db.run(`UPDATE task SET state = 'active', attempts = 3 WHERE id = ?`, t.id);
  ledger.recover();
  assert.equal(ledger.get(t.id).state, 'failed');
  assert.match(ledger.get(t.id).reason ?? '', /restarted while this was running/);
});

test('the transition table refuses moves it does not list', () => {
  assert.equal(canMove('done', 'queued'), false);
  assert.equal(canMove('failed', 'active'), false);
  assert.equal(canMove('cancelled', 'done'), false);
  assert.equal(canMove('queued', 'done'), false, 'nothing reaches done without verifying');
  assert.equal(canMove('active', 'done'), false);
  assert.equal(canMove('verifying', 'done'), true);
});

// M2 integration: confirmations Nova checks itself, and bounded concurrency by lane.

test('a confirmation counts only when a checker for its system finds it; the checker is given the brief; unknown systems still fail', async () => {
  const claims = (id: string, system: string) => fake(`claims-${id}-${system}`, 'none', async (b) => report(b, { evidence: [{ kind: 'confirmation', system, id }] }));
  const { ledger, verifier } = setup({ workers: (ws) => [claims('h1', 'example-log')(ws), claims('h2', 'example-log')(ws), claims('h1', 'elsewhere')(ws)] });
  const found = new Set(['h1']);
  const briefs: string[] = [];
  verifier.registerConfirmation('example-log', (e, brief) => {
    briefs.push(brief.task_id);
    if (e.kind !== 'confirmation' || !found.has(e.id)) return { ok: false, why: `Nova looked for ${e.kind === 'confirmation' ? e.id : 'it'} in the example log and it isn't there.` };
    return { ok: true, why: `Nova found ${e.id} in the example log itself.` };
  });
  assert.throws(() => verifier.registerConfirmation('example-log', () => ({ ok: true, why: '' })), /already have a checker/);
  const need = { evidence_required: [{ kind: 'confirmation' as const }], inputs: {} };
  const ok = ledger.create(writeNote({ ...need, owner: 'claims-h1-example-log', idempotency_key: 'a' }));
  const missing = ledger.create(writeNote({ ...need, owner: 'claims-h2-example-log', idempotency_key: 'b' }));
  const unknown = ledger.create(writeNote({ ...need, owner: 'claims-h1-elsewhere', idempotency_key: 'c' }));
  await ledger.idle();
  assert.equal(ledger.get(ok.id).state, 'done');
  assert.match(ledger.get(ok.id).verification!.checks[0]!.why, /found h1 in the example log itself/);
  assert.ok(briefs.includes(ok.id));
  assert.equal(ledger.get(missing.id).state, 'failed');
  assert.match(ledger.get(missing.id).reason ?? '', /looked for h2 in the example log and it isn't there/);
  assert.equal(ledger.get(unknown.id).state, 'failed');
  assert.match(ledger.get(unknown.id).reason ?? '', /can't check confirmations from elsewhere/);
  assert.ok(verifier.kinds().includes('confirmation'));
});

test('a worker can run tasks side by side in a lane, up to its limit; other workers still run one at a time', async () => {
  const running = new Set<string>();
  let most = 0;
  const releases: (() => void)[] = [];
  const laned: Worker & { lane(b: Brief): { key: string; max: number } } = {
    id: 'laned', name: 'laned', about: 'test worker', egress: 'none', evidence: ['confirmation'], health: () => ({ ok: true }),
    lane: (b) => (b.inputs?.lane === 'b' ? { key: 'laned:b', max: 1 } : { key: 'laned:a', max: 2 }),
    run: (b) => new Promise((resolve) => {
      running.add(b.task_id);
      most = Math.max(most, running.size);
      releases.push(() => { running.delete(b.task_id); resolve(report(b, { status: 'failed', summary: 'stopped on purpose' })); });
    }),
  };
  const { ledger } = setup({ workers: () => [laned] });
  const task = (key: string, lane = 'a') => ledger.create(writeNote({ owner: 'laned', idempotency_key: key, inputs: { lane }, evidence_required: [{ kind: 'confirmation' }] }));
  const [a1, a2, a3] = [task('a1'), task('a2'), task('a3')];
  const b1 = task('b1', 'b');
  const note = ledger.create(writeNote({ idempotency_key: 'n' }));
  const states = () => [a1, a2, a3, b1].map((t) => ledger.get(t.id).state);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(states(), ['active', 'active', 'queued', 'active'], 'two in lane a, the third waits; lane b is not held up');
  assert.equal(ledger.get(note.id).state, 'done', 'a task for another worker runs while those are busy');
  releases.shift()!();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ledger.get(a3.id).state, 'active', 'the waiting task starts when a place frees up');
  while (releases.length) releases.shift()!();
  await ledger.idle();
  assert.deepEqual(states(), ['failed', 'failed', 'failed', 'failed']);
  assert.equal(most, 3);

  // A worker without lanes keeps the old rule: one task at a time, across those workers.
  let inside = 0;
  let peak = 0;
  const slow = fake('slow', 'none', async (b, ws) => { inside++; peak = Math.max(peak, inside); await new Promise((r) => setTimeout(r, 10)); inside--; return workspaceWorker(ws).run(b, new AbortController().signal); });
  const s = setup({ workers: (ws) => [slow(ws)] });
  for (const k of ['s1', 's2', 's3']) s.ledger.create(writeNote({ owner: 'slow', idempotency_key: k, inputs: { action: 'append', path: 'notes/log.md', content: `${k}\n` }, evidence_required: [{ kind: 'read_back', target: 'notes/log.md' }] }));
  await s.ledger.idle();
  assert.equal(peak, 1);
});

test('a waiting task can be sent back to the queue with the reason why', async () => {
  let n = 0;
  const twice = fake('twice', 'none', async (b, ws) => { n += 1; return n === 1 ? report(b, { status: 'blocked', blockers: ['waiting for an answer'] }) : workspaceWorker(ws).run(b, new AbortController().signal); });
  const { ledger } = setup({ workers: (ws) => [twice(ws)] });
  const t = ledger.create(writeNote({ owner: 'twice' }));
  await ledger.idle();
  ledger.retry(t.id, 'The answer came; carrying on.');
  await ledger.idle();
  assert.equal(ledger.get(t.id).state, 'done');
  const retried = ledger.events(t.id).find((e) => e.kind === 'retried');
  assert.equal((retried?.detail as { reason: string }).reason, 'The answer came; carrying on.');
});

test('bad parameters are refused, not stored as problems', () => {
  const { ledger, log } = setup();
  assert.throws(() => ledger.create(writeNote({ parent_id: 'nope' })), /No parent task/);
  assert.throws(() => ledger.create(writeNote({ user_visibility: 'loud' as never })), /user_visibility/);
  assert.equal(log.problems().length, 0);
});
