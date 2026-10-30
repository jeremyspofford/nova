// Work with outside effects never reruns by itself (M5 review, should-fix 2). A worker says what a
// brief may change outside Nova (none, idempotent, external). For external work, any failure after
// it was dispatched (evidence that doesn't hold up, a throw, a report Nova can't read, a time-out,
// a restart while it ran or waited for the person) leaves the task waiting, flagged for the
// person, with "May already have happened: …"; only their retry runs it again, and a task that
// needed their OK asks for it again. A brief that marks where its effect happens (`commits`) may
// still rerun by itself if that point was never passed, and the ledger notes which. Then the
// workers: Home Assistant (against the stand-in, whose read-back lags) and n8n (against its stand-in,
// which never calls back). The browser's side is in browser.test.ts and tests/ui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Ledger, type Task } from '../../src/core/ledger.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { ENVELOPE_VERSION, type Brief } from '../../src/core/envelope.ts';
import { createCore, type Core } from '../../src/core/index.ts';
import type { Effects, Worker } from '../../src/core/workers.ts';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { startFakeN8n } from '../../scripts/stand-ins/fake-n8n.js';
import { bootCore, until } from './connector-support.ts';

const MAY = /^May already have happened: .*\. Check, then retry or cancel\.$/;

// A worker that "sends" something each run. `how` decides what comes back.
function sender(o: { effects?: Effects | (() => Effects); how: 'bad-evidence' | 'throw' | 'garbage' | 'hang'; commits?: boolean; ledger?: () => Ledger; commitFirst?: boolean; timeoutMs?: number }) {
  const runs: string[] = [];
  const w: Worker = {
    id: 'sender', name: 'Sender', about: 'test', egress: 'none', evidence: ['read_back'], health: () => ({ ok: true }),
    ...(o.effects ? { effects: typeof o.effects === 'function' ? o.effects : () => o.effects as Effects } : {}),
    ...(o.commits !== undefined ? { commits: () => o.commits! } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    run: async (b: Brief) => {
      runs.push(b.task_id);
      if (o.commitFirst) o.ledger!().committing(b.task_id, 'Send the form');
      if (o.how === 'throw') throw new Error('the far end hung up');
      if (o.how === 'garbage') return { nonsense: true };
      if (o.how === 'hang') return new Promise(() => {});
      const ev = { kind: 'read_back', target: 'note.md', sha256: 'f'.repeat(64), bytes: 9 };
      return { envelope: ENVELOPE_VERSION, task_id: b.task_id, status: 'done', summary: 'Sent it.', evidence: [ev], artifacts: [], blockers: [], usage: { duration_ms: 1 }, follow_up_suggestions: [] };
    },
  };
  return { w, runs };
}

function ledgerWith(w: Worker, o: { timeoutMs?: number; db?: Db } = {}) {
  const db = o.db ?? new Db(':memory:');
  if (!o.db) db.migrate();
  const ws = new Workspace(join(mkdtempSync(join(tmpdir(), 'nova-effects-')), 'workspace'));
  const ledger = new Ledger({ db, log: new Log(db, null), verifier: new Verifier(ws), workers: [w], defaultPrivacy: () => 'local-only', ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
  return { db, ledger };
}

const input = (tier: 1 | 2 = 1) => ({ title: 'Send the example form', owner: 'sender', goal: 'Sent.', origin: { kind: 'user' as const }, evidence_required: [{ kind: 'read_back' as const, target: 'note.md' }], approval_tier: tier });
const lastMove = (l: Ledger, id: string) => l.events(id).filter((e) => e.to_state).at(-1)!;

for (const [how, kind, why] of [
  ['bad-evidence', 'verification_failed', /The evidence didn't hold up: Nova looked for note\.md and it isn't there/],
  ['throw', 'attempt_failed', /Sender stopped with an error: the far end hung up/],
  ['garbage', 'attempt_failed', /Sender sent back a report Nova couldn't read/],
  ['hang', 'timed_out', /Sender took longer than/],
] as const) {
  test(`external work that fails after it was sent (${how}) waits for the person; it never reruns by itself`, async () => {
    const s = sender({ effects: 'external', how, ...(how === 'hang' ? { timeoutMs: 40 } : {}) });
    const { ledger } = ledgerWith(s.w);
    const t = ledger.create(input());
    await ledger.idle();
    const held = ledger.get(t.id);
    assert.equal(s.runs.length, 1, 'it ran once');
    assert.deepEqual([held.state, held.user_visibility], ['waiting', 'attention']);
    assert.match(held.reason!, MAY);
    assert.match(held.reason!, why);
    const ev = lastMove(ledger, t.id);
    assert.equal(ev.kind, kind);
    assert.equal((ev.detail as { held: boolean }).held, true);
    if (how === 'bad-evidence') {
      // The discrepancy is kept, for the person to check against.
      assert.match(JSON.stringify((ev.detail as { discrepancy: unknown }).discrepancy), /"kind":"read_back".*isn't there/);
      assert.equal(held.verification!.ok, false);
    }
    // Nothing moves it on by itself, not even a pump.
    await ledger.pump();
    assert.equal(ledger.get(t.id).state, 'waiting');
    assert.equal(s.runs.length, 1);
    // The person's retry is the one way to run it again.
    ledger.retry(t.id);
    await ledger.idle();
    assert.equal(s.runs.length, 2);
    ledger.cancel(t.id, 'Checked: it went through the first time.');
    assert.equal(ledger.get(t.id).state, 'cancelled');
  });
}

test('the same failures rerun by themselves for work with no outside effects, or that the far end takes twice as once', async () => {
  for (const effects of [undefined, 'none', 'idempotent'] as const) {
    const s = sender({ ...(effects ? { effects } : {}), how: 'bad-evidence' });
    const { ledger } = ledgerWith(s.w);
    const t = ledger.create(input());
    await ledger.idle();
    assert.equal(s.runs.length, 3, `${effects}: the ledger's three attempts`);
    assert.equal(ledger.get(t.id).state, 'failed');
  }
  // A worker that can't say what its brief does counts as external.
  const s = sender({ effects: () => { throw new Error('no idea'); }, how: 'throw' });
  const { ledger } = ledgerWith(s.w);
  const t = ledger.create(input());
  await ledger.idle();
  assert.equal(s.runs.length, 1);
  assert.match(ledger.get(t.id).reason!, MAY);
});

test('a retry of external work that needed your OK asks for it again', async () => {
  const s = sender({ effects: 'external', how: 'throw' });
  const { ledger } = ledgerWith(s.w);
  const t = ledger.create(input(2));
  assert.match(ledger.get(t.id).reason!, /Needs your OK/);
  ledger.approve(t.id);
  await ledger.idle();
  assert.equal(s.runs.length, 1);
  assert.match(ledger.get(t.id).reason!, MAY);
  assert.ok(ledger.get(t.id).approved_at, 'approved for the first run');
  const r = ledger.retry(t.id);
  await ledger.idle();
  assert.equal(s.runs.length, 1, 'not run yet: it waits for a fresh OK');
  assert.deepEqual([r.state, r.approved_at, r.reason], ['waiting', null, 'Needs your OK before it runs.']);
  assert.equal(ledger.events(t.id).find((e) => e.kind === 'retried')!.detail && (ledger.events(t.id).find((e) => e.kind === 'retried')!.detail as { asks_again: boolean }).asks_again, true);
  ledger.approve(t.id);
  await ledger.idle();
  assert.equal(s.runs.length, 2);
});

test('after a restart, external work that was running or waiting for the person waits for them instead of starting over', () => {
  const s = sender({ effects: 'external', how: 'hang', timeoutMs: 40 });
  const { db, ledger } = ledgerWith(s.w);
  const running = ledger.create(input());
  const asking = ledger.create(input());
  const verifying = ledger.create(input());
  // As the process left them when it went away.
  db.run(`UPDATE task SET state = 'active', attempts = 1 WHERE id = ?`, running.id);
  db.run(`UPDATE task SET state = 'waiting', reason = 'Needs you: sign in.', attempts = 1 WHERE id = ?`, asking.id);
  db.run(`INSERT INTO task_event (task_id, at, kind, from_state, to_state, detail) VALUES (?, ?, 'needs_person', 'active', 'waiting', NULL)`, asking.id, new Date().toISOString());
  db.run(`UPDATE task SET state = 'verifying', attempts = 1 WHERE id = ?`, verifying.id);
  const { ledger: after } = ledgerWith(s.w, { db });
  const r = after.recover();
  assert.deepEqual(r.requeued, []);
  for (const [t, why] of [[running, /Nova restarted while this was running/], [asking, /Nova restarted while this waited for you/], [verifying, /Nova restarted before the report arrived/]] as [Task, RegExp][]) {
    const x = after.get(t.id);
    assert.deepEqual([x.state, x.user_visibility], ['waiting', 'attention'], t.id);
    assert.match(x.reason!, MAY);
    assert.match(x.reason!, why);
  }
  assert.equal(s.runs.length, 0, 'nothing ran again');
});

test('a brief that marks its commit point reruns by itself only if that point was never passed; the ledger notes which', async () => {
  let l!: Ledger;
  const before = sender({ effects: 'external', how: 'throw', commits: true });
  ({ ledger: l } = ledgerWith(before.w));
  const a = l.create(input());
  await l.idle();
  assert.equal(before.runs.length, 3, 'it failed before sending, every time: safe to run again');
  assert.equal(l.get(a.id).state, 'failed');
  const decisions = l.events(a.id).filter((e) => e.kind === 'rerun_decision').map((e) => e.detail as { rerun: boolean });
  assert.ok(decisions.length >= 2 && decisions.every((d) => d.rerun === true), JSON.stringify(decisions));

  const after = sender({ effects: 'external', how: 'throw', commits: true, commitFirst: true, ledger: () => l });
  ({ ledger: l } = ledgerWith(after.w));
  const b = l.create(input());
  await l.idle();
  assert.equal(after.runs.length, 1, 'it got as far as sending: it may already have happened');
  assert.match(l.get(b.id).reason!, MAY);
  const ev = l.events(b.id);
  assert.deepEqual(ev.find((e) => e.kind === 'commit_point')!.detail, { what: 'Send the form', attempt: 1 });
  assert.match((ev.find((e) => e.kind === 'rerun_decision')!.detail as { why: string }).why, /got as far as “Send the form”/);

  // On a restart too: running, never past the point, it starts again.
  const db = new Db(':memory:');
  db.migrate();
  const quiet = sender({ effects: 'external', how: 'hang', commits: true, timeoutMs: 40 });
  const { ledger: first } = ledgerWith(quiet.w, { db });
  const c = first.create(input());
  db.run(`UPDATE task SET state = 'active', attempts = 1 WHERE id = ?`, c.id);
  db.run(`INSERT INTO task_event (task_id, at, kind, from_state, to_state, detail) VALUES (?, ?, 'dispatched', 'queued', 'active', NULL)`, c.id, new Date().toISOString());
  const { ledger: second } = ledgerWith(quiet.w, { db });
  assert.deepEqual(second.recover().requeued, [c.id]);
});

// ---- Home Assistant -------------------------------------------------------------------------------

test('Home Assistant: a call whose read-back lags waits for you instead of calling again (a toggle would undo itself)', async () => {
  const ha = await startFakeHomeAssistant();
  const nova = await bootCore();
  const HA = '/connectors/home-assistant';
  try {
    assert.equal((await nova.call('POST', `${HA}/connect`, { url: `${ha.base}/`, token: ha.token })).status, 200);
    await until(() => nova.get(HA), (v) => v.live === 'listening');
    // The light takes its time: Nova's read right after the call still shows it off.
    ha.state.lagMs = 400;
    const made = await nova.call('POST', `${HA}/services/light/turn_on`, { entity_id: 'light.kitchen' });
    assert.equal(made.status, 201);
    await until(() => nova.get(`/tasks/${made.body.id}`), (t) => t.state === 'waiting');
    assert.equal((await nova.call('POST', `/tasks/${made.body.id}/approve`, {})).status, 200);
    const held = await until(() => nova.get(`/tasks/${made.body.id}`), (t) => t.state === 'waiting' && /May already/.test(t.reason ?? '') || ['done', 'failed'].includes(t.state));
    assert.match(held.reason, MAY);
    assert.match(held.reason, /it is off, not on/);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(ha.state.calls.length, 1, 'Home Assistant was called once');
    assert.equal(ha.state.entities.get('light.kitchen').state, 'on', 'and the light did come on');
    // Retrying asks for the OK again.
    const again = await nova.call('POST', `/tasks/${made.body.id}/retry`, {});
    assert.equal(again.status, 200);
    const t = await until(() => nova.get(`/tasks/${made.body.id}`), (x) => x.state === 'waiting');
    assert.match(t.reason, /Needs your OK/);
    assert.equal(ha.state.calls.length, 1);
  } finally {
    await nova.stop();
    await ha.close();
  }
});

// ---- n8n --------------------------------------------------------------------------------------------

const SECRET = 'example-signing-secret-0123456789';

async function n8nCore(idempotent: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'nova-effects-n8n-'));
  const core: Core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, secrets: (n) => (n === 'N8N_SIGNING_SECRET' ? SECRET : null) });
  core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  const server = createServer(async (req, res) => { await core.handle(req, res, new URL(req.url!, 'http://127.0.0.1'), { kind: 'console' }, 'console'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const nova = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { token } = core.providers.configure('n8n', { webhook_url: 'http://127.0.0.1:9/webhook/x' });
  // A workflow that takes the brief and never calls back.
  const fake = await startFakeN8n({ secret: SECRET, nova, token: token!, behavior: 'silent' });
  core.providers.configure('n8n', { webhook_url: fake.url, idempotent });
  // One second to wait, not the five the settings allow: the profile directly, for the test.
  core.profile.set('providers', 'config.n8n', { ...core.profile.get<Record<string, unknown>>('providers', 'config.n8n'), timeout_s: 1 }, 'settings');
  core.providers.enable('n8n', { approved: true });
  return { core, fake, stop: async () => { server.close(); await fake.close(); await core.close(); } };
}

test('n8n: a workflow that never answers is sent once and waits for you, unless its settings say it takes a brief twice as once', async () => {
  const once = await n8nCore(false);
  try {
    const t = once.core.ledger.create({ title: 'Run the archive workflow', owner: 'n8n', goal: 'Archived.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }] });
    const held = await until(() => once.core.ledger.get(t.id), (x) => x.state !== 'active' && x.state !== 'queued', 6000);
    assert.match(held.reason!, MAY);
    assert.match(held.reason!, /took longer than/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(once.fake.received.length, 1, 'the workflow got the brief once');
    assert.match(JSON.stringify(once.core.providers.view('n8n')), /Safe to send twice/, 'the setting, in plain words');
  } finally { await once.stop(); }

  const twice = await n8nCore(true);
  try {
    const t = twice.core.ledger.create({ title: 'Run the archive workflow', owner: 'n8n', goal: 'Archived.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }] });
    await until(() => twice.fake.received.length, (n) => n >= 2, 6000);
    assert.ok(twice.fake.received.length >= 2, 'sent again by itself, under the same idempotency key');
    assert.equal(twice.fake.received[0]!.headers['idempotency-key'], twice.fake.received[1]!.headers['idempotency-key']);
    twice.core.ledger.cancel(t.id);
  } finally { await twice.stop(); }
});
