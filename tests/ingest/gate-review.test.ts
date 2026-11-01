// The adversarial review of PR #258 (docs/plans/gate-decision-service.md, "After the review"): each
// finding as a test, against the real core and loopback stand-ins. Nothing calls TypeSafe.
//   1. a task's own local-only mode holds the screen (the ledger's task context);
//   2. a switch turned off mid-screen stops the cloud send (reviewer's cases A and B), and the
//      receipt is checked against the live setting, not the caller's label;
//   3. a seat's error body (which may echo the content) never reaches a record or the log;
//   4. a Tev1 build swapped under Nova never decides: the pin includes the digest;
//   5. untrusted seats are asked only as a bounded sample, and a screen has a time limit;
//   6. capture-derived text never goes to a cloud seat;
//   and the minor items: the receipt's hash and task, sync with a standby a release behind, the
//   wording pinned to a verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createCore, type Core } from '../../src/core/index.ts';
import { TASK_CONTEXT } from '../../src/core/ledger.ts';
import { ENVELOPE_VERSION } from '../../src/core/envelope.ts';
import { DecisionService, INGEST_SCREEN_V1, MemoryLog, Registry, memoryVerdicts, DEFAULT_SETTINGS } from '../../src/core/decision-service/index.ts';
import { wordingOf } from '../../src/core/decision-service/registry.ts';
import { PART1_WORDING, fileRecords, readVerdicts } from '../../src/core/decision-service/verdicts.ts';
import { Db, loadMigrations } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { SyncLog } from '../../src/core/mesh/sync.ts';
import { Receipts } from '../../src/core/receipts.ts';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import { hubHardware } from '../support/models.ts';
import { gateService, pass, standInSeat } from '../support/decision-gate.ts';
import { Ingest, SHADOW_CHUNKS } from '../../src/core/ingest/screen.ts';
import { RulesProvider, Templates } from '../../src/core/decide.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace } from '../../src/core/workspace.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';

const CLOSED = 'http://127.0.0.1:9';
const homes: string[] = [];
const home = () => { const h = mkdtempSync(join(tmpdir(), 'nova-gate-review-')); homes.push(h); return h; };
test.after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

// An Ollama stand-in serving Tev1: `digest()` is the build installed now, `p()` what it answers,
// `delay` how long each decision takes.
async function ollama(o: { digest: () => string; p: () => number; delay?: number }) {
  let asks = 0;
  const s = createServer(async (req, res) => {
    const send = (st: number, b: unknown) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/api/version') return send(200, { version: '0.40.13' });
    if (req.url === '/api/tags') return send(200, { models: [{ name: 'tev1:4b', model: 'tev1:4b', digest: o.digest(), size: 1 }] });
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const j = JSON.parse(Buffer.concat(parts).toString() || '{}') as { model: string; questions: Record<string, unknown> };
    asks++;
    if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
    send(200, { model: j.model, answers: Object.fromEntries(Object.keys(j.questions).map((n) => [n, { type: 'noul', noul: o.p() }])), usage: { input_tokens: 1, output_tokens: 1 } });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, asks: () => asks, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

async function core(o: { mode: PrivacyMode; ollamaUrl?: string; jev?: { url: string; key: string } | null; optIn?: boolean; tev1?: boolean; verdicts?: ReturnType<typeof pass>[] }): Promise<Core> {
  const c = createCore({ home: home(), version: '0.1.0', trustedOrigin: () => true, models: { ollamaUrl: o.ollamaUrl ?? CLOSED, hardware: async () => hubHardware() as never, watchMs: 60_000 }, decisions: { verdicts: memoryVerdicts(o.verdicts ?? []) } });
  c.profile.set('privacy', 'default', o.mode, 'settings');
  if (o.jev) {
    c.profile.set('models', 'decision', { jev: { base_url: o.jev.url, model: 'jev-1.14.0' }, tev1: o.tev1 === false ? null : { model: 'auto' }, opt_in: { screening: !!o.optIn, box: false } }, 'settings');
    c.vault.put('decisions.jev', o.jev.key);
  }
  await c.decisionService.refresh();
  return c;
}
const has = (reqs: { body: { state: unknown } }[], s: string) => reqs.some((r) => JSON.stringify(r.body.state).includes(s));

// ---- 1 ------------------------------------------------------------------------------------------

test('1. a task’s own local-only mode holds the screen under a cloud-allowed default (ledger task context)', async () => {
  const jev = await startJevStandIn({ noul: () => 0.02 });
  const c = await core({ mode: 'cloud-allowed', jev, tev1: false });
  try {
    // Inside a ledger task whose mode is local-only: nothing goes to Jev, and the record says local-only.
    const seen: string[] = [];
    c.ledger.workers.set('probe', {
      id: 'probe', name: 'probe', about: 'test worker', egress: 'none', evidence: ['confirmation'], health: () => ({ ok: true }),
      run: async (b) => {
        const r = await c.ingest.screen({ text: 'PRIVATE-TASK-CANARY my bank pin is 4417', source: { kind: 'file', origin: 'notes.txt' } });
        seen.push(r.verdict);
        return { envelope: ENVELOPE_VERSION, task_id: b.task_id, status: 'done', summary: 'read', evidence: [], artifacts: [], blockers: [], usage: { duration_ms: 1 }, follow_up_suggestions: [] };
      },
    });
    const t = c.ledger.create({ title: 'Read notes', owner: 'probe', goal: 'Read the notes.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation', note: 'test' }], privacy_mode: 'local-only', approval_tier: 0 });
    await c.ledger.idle();
    assert.ok(seen.length >= 1 && seen.every((v) => v === 'quarantine'), JSON.stringify(seen));
    assert.equal(jev.requests.length, 0, 'the task is local-only: Jev got nothing');
    const rec = c.db.get<{ privacy_mode: string; task_id: string }>("SELECT privacy_mode, task_id FROM decision_record WHERE template_id = 'ingest-screen'")!;
    assert.deepEqual({ ...rec }, { privacy_mode: 'local-only', task_id: t.id });
    // The same read outside any task goes to Jev in cloud mode (owner decision 1), with a receipt.
    await c.ingest.screen({ text: 'An ordinary page.', source: { kind: 'web', origin: 'www.example.org' } });
    assert.equal(jev.requests.length, 1);
    // A caller naming its own mode (the runner, a helper) is held to it too.
    await c.ingest.screen({ text: 'PRIVATE-RUN-CANARY', source: { kind: 'file', origin: 'x.txt' }, privacy_mode: 'local-only' });
    await TASK_CONTEXT.run({ task_id: 'no-such-task', privacy_mode: 'local-preferred' }, () => c.ingest.screen({ text: 'PRIVATE-CTX-CANARY', source: { kind: 'file', origin: 'y.txt' } }));
    assert.ok(!has(jev.requests, 'PRIVATE-RUN-CANARY') && !has(jev.requests, 'PRIVATE-CTX-CANARY') && !has(jev.requests, 'PRIVATE-TASK-CANARY'));
  } finally { await c.close(); await jev.close(); }
});

// ---- 2 ------------------------------------------------------------------------------------------

for (const [label, flip] of [
  ['A: local-preferred, the opt-in turned off mid-screen', (c: Core) => c.profile.set('models', 'decision', { ...(c.profile.get('models', 'decision') as object), opt_in: { screening: false, box: false } }, 'settings')],
  ['B: local-preferred to local-only, and the opt-in off, mid-screen', (c: Core) => { c.profile.set('models', 'decision', { ...(c.profile.get('models', 'decision') as object), opt_in: { screening: false, box: false } }, 'settings'); c.profile.set('privacy', 'default', 'local-only', 'settings'); }],
] as const) {
  test(`2. ${label}: nothing more goes to Jev after the switch`, async () => {
    const tev1 = await ollama({ digest: () => 'sha256:aaaa4b', p: () => 0.02, delay: 400 });
    const jev = await startJevStandIn({ noul: () => 0.02 });
    const c = await core({ mode: 'local-preferred', ollamaUrl: tev1.url, jev, optIn: true });
    try {
      const p = c.ingest.screen({ text: 'PRIVATE-RACE-CANARY a short private page.', source: { kind: 'file', origin: 'notes.txt' } });
      await new Promise((r) => setTimeout(r, 150)); // Tev1 is answering now
      flip(c);
      const r = await p;
      assert.equal(tev1.asks() > 0, true);
      assert.equal(has(jev.requests, 'PRIVATE-RACE-CANARY'), false, 'Jev got nothing after the switch');
      assert.equal(r.verdict, 'quarantine');
      assert.deepEqual(c.receipts.list({ egress: 'remote' }), [], 'no remote receipt either');
      const failures = JSON.parse(c.db.get<{ failures: string }>("SELECT failures FROM decision_record WHERE template_id = 'ingest-screen'")!.failures) as { seat: string; why: string }[];
      assert.ok(failures.some((f) => f.seat === 'jev' && /^Not sent/.test(f.why)), JSON.stringify(failures));
    } finally { await c.close(); await tev1.close(); await jev.close(); }
  });
}

test('2. the receipt is held to the live setting, not the label its caller gives it', () => {
  const db = new Db(':memory:');
  db.migrate();
  const log = new Log(db, null);
  let mode: PrivacyMode = 'local-only';
  let screening = false;
  const receipts = new Receipts({ db, log, live: { mode: () => mode, optIn: (f) => f === 'screening' && screening } });
  const r = { provider: 'jev', model: 'jev-1.14.0', purpose: 'decision: ingest-screen@1', egress: 'remote:typesafe', context_items: [] };
  // The caller says cloud-allowed, or names an opt-in that is off: refused, because local-only is live.
  assert.throws(() => receipts.record({ ...r, privacy_mode: 'cloud-allowed' }), /Local-only mode doesn't allow/);
  assert.throws(() => receipts.record({ ...r, privacy_mode: 'local-only', opt_in: 'screening' }), /Local-only mode doesn't allow/);
  screening = true;
  assert.equal(receipts.record({ ...r, privacy_mode: 'cloud-allowed', opt_in: 'screening' }).privacy_mode, 'local-only', 'the receipt says the mode that held');
  mode = 'cloud-allowed';
  assert.equal(receipts.record({ ...r, privacy_mode: 'cloud-allowed' }).privacy_mode, 'cloud-allowed');
});

// ---- 3 ------------------------------------------------------------------------------------------

test('3. a seat that echoes the content in its error: nothing of it reaches a record or the log', async () => {
  const s = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const j = JSON.parse(Buffer.concat(parts).toString() || '{}') as { state?: { content?: string } };
    res.writeHead(422, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: [{ type: 'value_error', loc: ['body', 'state', 'content'], msg: 'Value error', input: j.state?.content }], error: `bad input: ${j.state?.content}` }));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const c = await core({ mode: 'cloud-allowed', jev: { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, key: 'probe-key' }, tev1: false });
  try {
    const r = await c.ingest.screen({ text: 'SECRET-PAGE-CANARY: the merger closes Friday at 41.20 a share.', source: { kind: 'web', origin: 'example.com' } });
    assert.equal(r.verdict, 'quarantine');
    const rows = c.db.all<Record<string, unknown>>("SELECT * FROM decision_record WHERE template_id = 'ingest-screen'");
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /SECRET-PAGE-CANARY|merger|41\.20/);
    assert.match(String(rows[0]!.failures), /answered 422: it refused the request as invalid/);
    // Nothing of it in Nova's log files, or anywhere in its home.
    const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [join(d, e.name)]));
    const hits = all(homes.at(-1)!).filter((f) => !/nova\.db/.test(f) && readFileSync(f).includes('SECRET-PAGE-CANARY'));
    assert.deepEqual(hits, []);
    assert.ok(existsSync(join(homes.at(-1)!, 'logs')));
  } finally { await c.close(); s.closeAllConnections(); s.close(); }
});

test('3. the sorting model’s own words never reach a record', async () => {
  const db = new Db(':memory:');
  db.migrate();
  const templates = new Templates({ db, verifier: new Verifier(new Workspace(join(home(), 'workspace'))), rules: new RulesProvider() });
  const legacy = { id: 'local-model', egress: 'local' as const, questionTypes: ['noul' as const], async decide(t: { template_id: string; version: number }) { return { template_id: t.template_id, version: t.version, answers: {}, confidence: 0, provider: 'local-model', escalate: true, why: 'The local model answered outside the template: MODEL-SAID-CANARY is not a question.' }; } };
  const g = gateService({ templates, legacy: legacy as never });
  const ingest = new Ingest({ db, templates, ask: g.ask });
  await ingest.screen({ text: 'Plain.', source: { kind: 'web', origin: 'a.example' } });
  assert.doesNotMatch(JSON.stringify(g.log.records), /MODEL-SAID-CANARY/);
});

// ---- 4 ------------------------------------------------------------------------------------------

test('4. a Tev1 build swapped under Nova, inside the recheck window, never decides', async () => {
  let digest = 'sha256:aaaa4b';
  const tev1 = await ollama({ digest: () => digest, p: () => (digest === 'sha256:aaaa4b' ? 0.02 : 0.01) });
  const c = await core({ mode: 'local-only', ollamaUrl: tev1.url, verdicts: [pass('tev1', 'tev1:4b@aaaa4b')] });
  try {
    const before = await c.ingest.screen({ text: 'Opening hours are nine to five.', source: { kind: 'web', origin: 'a.example' } });
    assert.equal(before.verdict, 'pass');
    assert.equal(before.model, 'tev1:tev1:4b@aaaa4b');
    digest = 'sha256:cccc99'; // an `ollama pull` brings a build no eval has seen
    const after = await c.ingest.screen({ text: 'Opening hours are nine to five.', source: { kind: 'web', origin: 'a.example' } });
    assert.equal(after.verdict, 'quarantine', 'the new build’s answer is evidence only');
    assert.equal(after.model, null);
    const last = c.db.all<{ trust: string; failures: string }>("SELECT trust, failures FROM decision_record ORDER BY at").at(-1)!;
    assert.equal(last.trust, 'none');
    assert.match(last.failures, /tev1:4b@aaaa4b was asked but tev1:4b@cccc99 answered/);
    // From then on the seat names the new build, which has no passing eval.
    assert.equal(c.decisionService.standing('ingest-screen').relied, false);
  } finally { await c.close(); await tev1.close(); }
});

// ---- 5 ------------------------------------------------------------------------------------------

test('5. untrusted seats are a bounded sample: the first chunks only, and a daily budget', async () => {
  const db = new Db(':memory:');
  db.migrate();
  const templates = new Templates({ db, verifier: new Verifier(new Workspace(join(home(), 'workspace'))), rules: new RulesProvider() });
  const legacy = { id: 'local-model', egress: 'local' as const, questionTypes: ['noul' as const], ready: () => true, async decide(t: { template_id: string; version: number }) { return { template_id: t.template_id, version: t.version, answers: Object.fromEntries(['direct_instruction', 'hidden_instruction', 'exfiltration', 'impersonation', 'unrequested_action'].map((q) => [q, 0.02])), confidence: 1, provider: 'local-model', escalate: false, why: '' }; } };
  const jev = standInSeat('jev', () => ({}));
  const g = gateService({ templates, jev: jev.seat, legacy: legacy as never, privacy: 'cloud-allowed' });
  const ingest = new Ingest({ db, templates, ask: g.ask });
  const text = 'The museum opens at nine. '.repeat(4000); // ~104,000 characters, 38 chunks
  const r = await ingest.screen({ text, source: { kind: 'web', origin: 'attacker.example' } });
  assert.equal(r.model, 'legacy:sorting-model', 'the sorting model decides every chunk');
  assert.equal(jev.asked.length, SHADOW_CHUNKS, `Jev (untrusted) asked for the first ${SHADOW_CHUNKS} chunks only, not ${g.log.records.length}`);
  // The daily budget: a service with a budget of 3 asks the untrusted seat 3 times in all.
  const jev2 = standInSeat('jev', () => ({}));
  const registry = new Registry();
  registry.add(INGEST_SCREEN_V1);
  const svc = new DecisionService({ registry, log: new MemoryLog(), verdicts: memoryVerdicts([]), settings: () => ({ ...DEFAULT_SETTINGS, jev: { base_url: 'https://api.typesafe.ai', model: 'jev-1.14.0' } }), privacy: () => 'cloud-allowed', seats: { jev: jev2.seat }, shadowPerDay: 3 });
  for (let i = 0; i < 5; i++) await svc.ask('ingest-screen', { source_kind: 'web', origin: 'a', content: `chunk ${i}` }, { subsystem: 'ingest' });
  assert.equal(jev2.asked.length, 3);
});

test('5. a screen has a time limit: past it nothing more is asked, and the content is held back', async () => {
  const db = new Db(':memory:');
  db.migrate();
  let asked = 0;
  const ingest = new Ingest({ db, timeLimitMs: 150, ask: async () => { asked++; await new Promise((r) => setTimeout(r, 60)); return { trust: 'verdict', seat: 'tev1', model: 'm', answers: Object.fromEntries(['direct_instruction', 'hidden_instruction', 'exfiltration', 'impersonation', 'unrequested_action'].map((q) => [q, { type: 'noul', noul: 0.01 }])) }; } });
  const t0 = Date.now();
  const r = await ingest.screen({ text: 'Plain words. '.repeat(20_000), source: { kind: 'file', origin: 'long.txt' } });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.verdict, 'quarantine');
  assert.equal(r.scores, null);
  await new Promise((r2) => setTimeout(r2, 200));
  const after = asked;
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal(asked, after, 'nothing more is asked once the time is up');
  assert.ok(asked < 20);
});

// ---- 6 ------------------------------------------------------------------------------------------

test('6. capture-derived text never goes to a cloud seat, in any mode, opt-in or not', async () => {
  for (const mode of ['cloud-allowed', 'local-preferred', 'local-only'] as const) {
    const jev = await startJevStandIn({ noul: () => 0.02 });
    const c = await core({ mode, jev, optIn: true, tev1: false, verdicts: [pass('jev', 'jev-1.14.0')] });
    try {
      for (const [from, kind] of [['capture', 'ocr'], ['capture', 'transcript'], [undefined, 'ocr'], [undefined, 'transcript']] as const) {
        const r = await c.ingest.screen({ text: 'CAPTURE-CANARY on the screen.', ...(from ? { from } : {}), source: { kind, origin: 'Example app' } });
        assert.equal(r.model, null, `${mode} ${kind}`);
      }
      assert.equal(jev.requests.length, 0, `${mode}: Jev got no capture-derived text`);
      // A page in the same Nova still goes to the trusted Jev where the person allows it.
      const page = await c.ingest.screen({ text: 'An ordinary page.', source: { kind: 'web', origin: 'www.example.org' } });
      assert.equal(page.model, 'jev:jev-1.14.0', mode);
    } finally { await c.close(); await jev.close(); }
  }
});

// ---- minor --------------------------------------------------------------------------------------

test('the gate’s receipt names its task and the hash of what was judged, never the content', async () => {
  const jev = await startJevStandIn({ noul: () => 0.02 });
  const c = await core({ mode: 'cloud-allowed', jev, tev1: false });
  try {
    await TASK_CONTEXT.run({ task_id: 't-123', privacy_mode: 'cloud-allowed' }, () => c.ingest.screen({ text: 'RECEIPT-CANARY page.', source: { kind: 'web', origin: 'www.example.org' } }));
    const [r] = c.receipts.list({ egress: 'remote' });
    assert.equal(r!.task_id, 't-123');
    assert.equal(r!.context_items.length, 1);
    assert.equal(r!.context_items[0]!.kind, 'outside');
    const rec = c.db.get<{ state_sha256: string }>("SELECT state_sha256 FROM decision_record WHERE template_id = 'ingest-screen'")!;
    assert.equal(r!.context_items[0]!.sha256, rec.state_sha256);
    assert.doesNotMatch(JSON.stringify(r), /RECEIPT-CANARY/);
  } finally { await c.close(); await jev.close(); }
});

test('sync: a standby a release behind takes receipts; a column it doesn’t have is left out, not refused', () => {
  const mk = (upto: number) => {
    const h = home();
    const db = new Db(join(h, 'nova.db'));
    db.migrate({ migrations: loadMigrations().filter((m) => m.version <= upto) });
    const log = new Log(db, join(h, 'logs', 'nova.log'));
    return { db, log, h, sync: new SyncLog({ db, log, home: h, node: 'n', now: () => new Date() }) };
  };
  const hub = mk(999);
  const receipts = new Receipts({ db: hub.db, log: hub.log });
  const base = { provider: 'p', model: 'm', purpose: 'chat reply', egress: 'remote:example', context_items: [] };
  receipts.record({ ...base, privacy_mode: 'cloud-allowed' });
  receipts.record({ ...base, privacy_mode: 'local-preferred', provider: 'jev', opt_in: 'screening' });
  // M10f (review of #268, finding 3): one mechanism for every column a release adds (mesh/sync.ts
  // ADDED_COLUMNS). The triggers carry opt_in always; the hub leaves it out for a standby on 0018.
  const rows = hub.db.all<{ row: string }>("SELECT row FROM sync_log WHERE tbl = 'receipt' ORDER BY seq");
  assert.equal(JSON.parse(rows[0]!.row).opt_in, null, 'the trigger carries the column; the sender adapts');
  assert.equal(JSON.parse(rows[1]!.row).opt_in, 'screening');
  // A standby on migration 0018 (no receipt.opt_in) applies the whole batch the hub shaped for it.
  const old = mk(18);
  old.sync.setLogging(false);
  const shaped = hub.sync.batch(0, { peerSchema: 18 });
  assert.ok(shaped.rows.filter((r) => r.tbl === 'receipt').every((r) => !('opt_in' in JSON.parse(r.row!))));
  old.sync.apply(shaped, () => {});
  assert.equal(old.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM receipt')!.n, 2);
  // And one the hub didn't shape (a standby that said nothing is taken to be on 19): the column is
  // left out, and the standby records that it is behind.
  const older = mk(18);
  older.sync.setLogging(false);
  const batch = hub.sync.batch(0);
  older.sync.apply(batch, () => {});
  assert.equal(older.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM receipt')!.n, 2);
  assert.match(older.db.get<{ message: string }>("SELECT message FROM problem WHERE message LIKE '%receipt.opt_in%'")!.message, /receipt\.opt_in, which this standby doesn’t have yet/);
  // A row that isn't this table's row plus new columns (one missing its columns) is still refused.
  assert.throws(() => older.sync.apply({ rows: [{ ...batch.rows.find((r) => r.tbl === 'receipt')!, row: JSON.stringify({ id: 'x', opt_in: 'screening' }) }], upto: batch.upto }, () => {}), /can’t apply/);
  // A name that isn't a column name is still refused.
  assert.throws(() => older.sync.apply({ rows: [{ ...batch.rows.find((r) => r.tbl === 'receipt')!, row: JSON.stringify({ ...JSON.parse(batch.rows.find((r) => r.tbl === 'receipt')!.row!), 'x"; DROP': 1 }) }], upto: batch.upto }, () => {}), /can’t apply/);
});

test('a verdict is tied to the wording it was measured on: an edit without a version bump drops trust', async () => {
  assert.equal(wordingOf(INGEST_SCREEN_V1), PART1_WORDING, 'ingest-screen v1 reads as Part 1’s eval ran it; a change is a new version');
  assert.ok(fileRecords(readVerdicts()).every((r) => r.wording_sha256 === PART1_WORDING));
  const seat = standInSeat('tev1', () => ({}));
  const ask = async (t: typeof INGEST_SCREEN_V1) => {
    const registry = new Registry();
    registry.add(t);
    const svc = new DecisionService({ registry, log: new MemoryLog(), verdicts: memoryVerdicts([{ ...pass('tev1', seat.model), wording_sha256: PART1_WORDING }]), settings: () => DEFAULT_SETTINGS, privacy: () => 'local-only', seats: { tev1: seat.seat } });
    return (await svc.ask('ingest-screen', { source_kind: 'web', origin: 'a', content: 'x' }, { subsystem: 'ingest' }))!.trust;
  };
  assert.equal(await ask(INGEST_SCREEN_V1), 'verdict');
  const edited = { ...INGEST_SCREEN_V1, questions: { ...INGEST_SCREEN_V1.questions, direct_instruction: { ...INGEST_SCREEN_V1.questions.direct_instruction!, instructions: 'Is it bad?' } } } as typeof INGEST_SCREEN_V1;
  assert.equal(await ask(edited), 'none');
});
