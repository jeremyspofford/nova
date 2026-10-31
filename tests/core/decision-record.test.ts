// Track 1's parts of DS1 (docs/plans/ds1.md NOTES 3 and 5; docs/plans/gate-decision-service.md):
// receipts accept the person's screening opt-in under local-only (never Box), and the decision
// record has its table, written by the DbLog sink with no content in it. The receipt's opt_in is
// carried to a standby like the rest of the receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Receipts, type ReceiptInput } from '../../src/core/receipts.ts';
import { DbLog, INGEST_SCREEN_V1, Registry, memoryVerdicts, DecisionService, DEFAULT_SETTINGS } from '../../src/core/decision-service/index.ts';
import { fence } from '../../src/core/ingest/screen.ts';

function setup() {
  const db = new Db(':memory:');
  db.migrate();
  const log = new Log(db, null);
  return { db, log, receipts: new Receipts({ db, log, now: () => new Date('2026-10-31T09:00:00Z') }) };
}

const jev = (over: Partial<ReceiptInput> = {}): ReceiptInput => ({ provider: 'jev', model: 'jev-1.14.0', purpose: 'decision: ingest-screen@1', privacy_mode: 'local-only', egress: 'remote:typesafe', context_items: [], ...over });

test('local-only refuses a remote receipt unless it names the screening opt-in, for Jev', () => {
  const { receipts, log } = setup();
  assert.throws(() => receipts.record(jev()), /Local-only mode doesn't allow/);
  const r = receipts.record(jev({ opt_in: 'screening' }));
  assert.equal(r.opt_in, 'screening');
  assert.equal(receipts.get(r.id).opt_in, 'screening', 'stored with the receipt');
  assert.deepEqual(receipts.list({ egress: 'remote' }).map((x) => [x.provider, x.privacy_mode, x.opt_in]), [['jev', 'local-only', 'screening']]);
  // Box is never allowed under local-only, opt-in or not; nor another provider naming the opt-in.
  assert.throws(() => receipts.record(jev({ opt_in: 'box' })), /Local-only mode doesn't allow/);
  assert.throws(() => receipts.record(jev({ provider: 'some-cloud', opt_in: 'screening' })), /Local-only mode doesn't allow/);
  assert.throws(() => receipts.record(jev({ opt_in: 'anything' as never })), /opt_in must be one of screening, box, capture/);
  assert.equal(log.problems({ open: true }).length, 3, 'each refusal is a problem');
  // Elsewhere an opt-in is recorded as given, and a receipt without one has none.
  assert.equal(receipts.record(jev({ privacy_mode: 'local-preferred', opt_in: 'box' })).opt_in, 'box');
  assert.equal(receipts.record(jev({ privacy_mode: 'cloud-allowed' })).opt_in, null);
});

test('migration 0019: the decision_record table, receipt.opt_in, and the receipt carried to a standby with it', () => {
  const { db, receipts } = setup();
  const cols = db.all<{ name: string }>("SELECT name FROM pragma_table_info('decision_record')").map((c) => c.name);
  assert.deepEqual(cols, ['id', 'at', 'task_id', 'subsystem', 'template_id', 'version', 'seat', 'model_asked', 'model', 'privacy_mode', 'egress', 'opt_in', 'state_sha256', 'state_fields', 'pieces', 'requests', 'usage', 'answers', 'bands', 'shadows', 'failures', 'outcome', 'action', 'tier', 'autonomy', 'quality', 'trust', 'verdict_ref', 'why']);
  assert.ok(db.all<{ name: string }>("SELECT name FROM pragma_table_info('receipt')").some((c) => c.name === 'opt_in'));
  // Not replicated: no sync triggers on decision_record. Receipts are, with the new column.
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'decision_record'").length, 0);
  db.run('UPDATE sync_state SET logging = 1 WHERE id = 1');
  const r = receipts.record(jev({ opt_in: 'screening' }));
  const row = db.get<{ row: string }>("SELECT row FROM sync_log WHERE tbl = 'receipt' AND pk = ? ORDER BY seq DESC", r.id)!;
  assert.equal((JSON.parse(row.row) as { opt_in: string }).opt_in, 'screening');
});

test('the DbLog sink writes one row per decision, with hashes and probabilities but never the content', async () => {
  const { db } = setup();
  const registry = new Registry();
  registry.add(INGEST_SCREEN_V1);
  const service = new DecisionService({ registry, verdicts: memoryVerdicts([]), settings: () => DEFAULT_SETTINGS, privacy: () => 'local-only', log: new DbLog(db), seats: {} });
  const secret = 'The door code is 4471 and it is taped under the desk.';
  const d = await service.ask('ingest-screen', { source_kind: 'web', origin: 'www.example.org', content: fence(secret) }, { subsystem: 'ingest', task_id: 't-1' });
  assert.equal(d!.trust, 'none');
  assert.equal(d!.outcome, 'quarantine', 'no trusted answer: the template’s safe default');
  const rows = db.all<Record<string, unknown>>('SELECT * FROM decision_record WHERE task_id = ?', 't-1');
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.template_id, 'ingest-screen');
  assert.equal(row.seat, 'stub');
  assert.equal(row.egress, 'none');
  assert.match(String(row.state_sha256), /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(String(row.state_fields)), ['source_kind', 'origin', 'content']);
  assert.doesNotMatch(JSON.stringify(row), /door code|4471|taped/);
  // A sink that can't write never stops the decision.
  const seen: string[] = [];
  const broken = new DecisionService({ registry, verdicts: memoryVerdicts([]), settings: () => DEFAULT_SETTINGS, privacy: () => 'local-only', log: new DbLog({ run: () => { throw new Error('disk full'); } }, { onError: (e) => seen.push(e.message) }), seats: {} });
  assert.equal((await broken.ask('ingest-screen', { source_kind: 'web', origin: 'x', content: fence('y') }, { subsystem: 'ingest' }))!.outcome, 'quarantine');
  assert.deepEqual(seen, ['disk full']);
});
