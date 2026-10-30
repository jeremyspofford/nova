// A dispatch whose work never started isn't an attempt (M8 review: a busy Relay). A running worker
// may tell the ledger the work didn't start (`notStarted`); only a blocked report takes that claim,
// and then the ledger gives the dispatch back: the attempt count doesn't move, an event says so in
// plain words, and the task waits with the worker's reason as before. A done or failed report is
// counted whatever was claimed, and a restart keeps the count right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger, type TaskInput } from '../../src/core/ledger.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace, workspaceWorker } from '../../src/core/workspace.ts';
import { ENVELOPE_VERSION, type Brief } from '../../src/core/envelope.ts';

type Run = (b: Brief, ledger: Ledger) => Promise<unknown>;

function setup(run: Run, o: { db?: Db; root?: string } = {}) {
  const root = o.root ?? mkdtempSync(join(tmpdir(), 'nova-notstarted-'));
  const db = o.db ?? new Db(':memory:');
  if (!o.db) db.migrate();
  const log = new Log(db, null);
  const ws = new Workspace(join(root, 'workspace'));
  const holder: { ledger: Ledger | null } = { ledger: null };
  const busy = { id: 'busy', name: 'Busy service', about: 'test worker', egress: 'none' as const, evidence: ['read_back' as const], health: () => ({ ok: true }), lane: () => ({ key: 'run', max: 5 }), run: (b: Brief) => run(b, holder.ledger!) };
  const ledger = new Ledger({ db, log, verifier: new Verifier(ws), workers: [workspaceWorker(ws), busy], defaultPrivacy: () => 'local-only' });
  holder.ledger = ledger;
  return { db, ledger, root };
}

const input: TaskInput = { title: 'Do it', owner: 'busy', goal: 'Something done.', origin: { kind: 'user' }, evidence_required: [{ kind: 'read_back', target: 'workspace:x.md' }] };
const report = (b: Brief, status: string, summary: string) => ({
  envelope: ENVELOPE_VERSION, task_id: b.task_id, status, summary, evidence: [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], usage: { duration_ms: 1 }, follow_up_suggestions: [],
});
const kinds = (l: Ledger, id: string) => l.events(id).map((e) => e.kind);

test('a blocked report whose work never started gives the dispatch back, says so, and waits with the worker’s reason', async () => {
  const { ledger } = setup(async (b, l) => {
    l.notStarted(b.task_id, 'Relay was busy');
    return report(b, 'blocked', 'Relay is busy with another run.');
  });
  const t = ledger.create(input);
  await ledger.idle();
  const after = ledger.get(t.id);
  assert.equal(after.state, 'waiting');
  assert.match(String(after.reason), /Relay is busy with another run/);
  assert.equal(after.attempts, 0, 'not an attempt');
  const back = ledger.events(t.id).find((e) => e.kind === 'attempt_returned');
  assert.ok(back, kinds(ledger, t.id).join(' → '));
  assert.equal((back!.detail as { reason: string }).reason, 'Relay was busy; this didn’t count as an attempt.');

  // Again and again: still none counted.
  for (let i = 0; i < 4; i++) { ledger.retry(t.id); await ledger.idle(); }
  assert.equal(ledger.get(t.id).attempts, 0);
});

test('only a blocked report takes the claim: done and failed reports are counted, and so is a blocked one without it', async () => {
  for (const status of ['failed', 'done'] as const) {
    const { ledger } = setup(async (b, l) => {
      l.notStarted(b.task_id, 'Relay was busy');
      return report(b, status, 'It says it never started.');
    });
    const t = ledger.create(input);
    await ledger.idle();
    const after = ledger.get(t.id);
    assert.ok(after.attempts >= 1, `${status}: counted (${after.attempts})`);
    assert.ok(!kinds(ledger, t.id).includes('attempt_returned'), `${status}: nothing given back`);
  }
  const { ledger } = setup(async (b) => report(b, 'blocked', 'Blocked for another reason.'));
  const t = ledger.create(input);
  await ledger.idle();
  assert.equal(ledger.get(t.id).attempts, 1, 'a blocked report without the claim is an attempt');
});

test('notStarted is only for a running task', () => {
  const { ledger } = setup(async () => new Promise(() => {}));
  const t = ledger.create({ ...input, owner: 'workspace', inputs: { action: 'write', path: 'x.md', content: 'x' } });
  assert.throws(() => ledger.notStarted(t.id, 'Relay was busy'), /running/);
});

test('a restart keeps the count: work that said it never started is given back before it runs again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-notstarted-'));
  const path = join(root, 'nova.db');
  const db1 = new Db(path);
  db1.migrate();
  // One said it never started, then the process died before its report arrived; the other was
  // really running when it died.
  const first = setup(async (b, l) => { if (b.goal === 'Claims.') l.notStarted(b.task_id, 'Relay was busy'); return new Promise(() => {}); }, { db: db1, root });
  const t = first.ledger.create({ ...input, goal: 'Claims.' });
  const u = first.ledger.create({ ...input, goal: 'Runs.' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(first.ledger.get(t.id).attempts, 1);
  assert.equal(first.ledger.get(u.id).state, 'active');
  db1.close();

  const db2 = new Db(path);
  db2.migrate();
  let runs = 0;
  const second = setup(async () => { runs++; return new Promise(() => {}); }, { db: db2, root });
  second.ledger.recover();
  await new Promise((r) => setTimeout(r, 30));
  const tt = second.ledger.get(t.id);
  assert.ok(second.ledger.events(t.id).some((e) => e.kind === 'attempt_returned'), kinds(second.ledger, t.id).join(' → '));
  assert.equal(tt.attempts, 1, 'given back, then counted once for the run after the restart');
  assert.equal(second.ledger.get(u.id).attempts, 2, 'the one that really ran counts its first attempt');
  assert.ok(runs >= 1);
  db2.close();
});
