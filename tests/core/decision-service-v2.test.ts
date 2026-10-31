// ingest-screen v2 (DS2; plan docs/plans/ds2-ingest-v2.md): the re-authored battery passes the
// authoring rules with no warnings (v1 had three), its rule is a full truth table with no "worst
// question wins", its state carries no fence and no preamble, and the service keeps asking the
// version that serves today's behaviour until v2 has earned a passing verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fence } from '../../src/core/ingest/screen.ts';
import { validate, Registry } from '../../src/core/decision-service/registry.ts';
import { rows, checkTable } from '../../src/core/decision-service/policy.ts';
import { buildState } from '../../src/core/decision-service/state.ts';
import { DecisionService } from '../../src/core/decision-service/service.ts';
import { MemoryLog } from '../../src/core/decision-service/log.ts';
import { memoryVerdicts, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { Tev1Seat } from '../../src/core/decision-service/seats/tev1.ts';
import { LegacySeat } from '../../src/core/decision-service/seats/legacy.ts';
import { DEFAULT_SETTINGS } from '../../src/core/decision-service/settings.ts';
import { INGEST_SCREEN_V1 } from '../../src/core/decision-service/templates/ingest-screen.ts';
import { INGEST_SCREEN_V2, V2_QUESTIONS, v2Outcome, DECISIVE, SUPPORTING } from '../../src/core/decision-service/templates/ingest-screen-v2.ts';
import { BUILT_INS } from '../../src/core/decision-service/index.ts';
import { SCREEN, QUESTIONS } from '../../src/core/ingest/screen.ts';
import { validateTemplate, type Decision, type DecisionProvider, type Template } from '../../src/core/decide.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';

test('v2 passes the authoring rules with no warnings: no shared preamble, no "or" lists', () => {
  const { errors, warnings } = validate(INGEST_SCREEN_V2);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.ok(validate(INGEST_SCREEN_V1).warnings.length >= 3, 'v1, for contrast, is flagged');
  for (const [id, q] of Object.entries(INGEST_SCREEN_V2.questions)) {
    assert.equal(q.type, 'noul', id);
    if (q.type !== 'noul') continue;
    assert.doesNotMatch(String(q.instructions), /\bor\b/i, `${id}: one judgment per question`);
    assert.ok(q.criteria?.true && q.criteria?.false, `${id}: both sides described`);
  }
  assert.deepEqual(Object.keys(INGEST_SCREEN_V2.questions), [...V2_QUESTIONS]);
  assert.equal(INGEST_SCREEN_V2.legacy, false, 'the sorting model knows only v1');
  assert.deepEqual(BUILT_INS.map((t) => `${t.template_id}@${t.version}`), ['ingest-screen@1', 'ingest-screen@2']);
});

test('the v2 rule: a full truth table; one decisive sign blocks; the supporting signs count together; no "worst question wins"', () => {
  assert.equal(rows(INGEST_SCREEN_V2).length, 3 ** 6);
  assert.deepEqual(checkTable(INGEST_SCREEN_V2), []);
  const all = (b: string) => Object.fromEntries(V2_QUESTIONS.map((q) => [q, b]));
  assert.equal(v2Outcome(all('no')), 'pass');
  for (const q of DECISIVE) {
    assert.equal(v2Outcome({ ...all('no'), [q]: 'yes' }), 'block', q);
    assert.equal(v2Outcome({ ...all('no'), [q]: 'unsettled' }), 'quarantine', q);
  }
  for (const q of SUPPORTING) {
    assert.equal(v2Outcome({ ...all('no'), [q]: 'yes' }), 'quarantine', q);
    assert.equal(v2Outcome({ ...all('no'), [q]: 'unsettled' }), 'pass', `${q} unsettled alone holds nothing back`);
  }
  assert.equal(v2Outcome({ ...all('no'), wants_private_data: 'yes', keep_from_user: 'yes' }), 'block');
  assert.equal(v2Outcome({ ...all('no'), wants_private_data: 'unsettled', keep_from_user: 'unsettled' }), 'pass');
  // Bands are TypeSafe's starting points, not tuned: no per-question bands in the policy.
  assert.equal(INGEST_SCREEN_V2.policy.bands, undefined);
});

test('the v2 state: what the material is, as a fact; the content without the gate’s fence', () => {
  const b = buildState(INGEST_SCREEN_V2, { source_kind: 'email', origin: 'news@shop.example.com', content: fence('Our sale ends Friday.') });
  assert.deepEqual(b.state, { source: 'an email from news@shop.example.com', content: 'Our sale ends Friday.' });
  assert.match(String(b.values.content), /^BEGIN OUTSIDE DATA [0-9a-f]+\nOur sale ends Friday\.\nEND OUTSIDE DATA [0-9a-f]+$/, 'the raw field keeps the gate’s fence; only the state sent drops it');
});

const pass = (version: number): VerdictRecord => ({ template_id: 'ingest-screen', version, seat: 'tev1', model: 'tev1:4b@aaaa4b', status: 'pass', why: 'test', run_at: null, ref: 'test' });

function sortingModel() {
  const provider: DecisionProvider = {
    id: 'local-model', egress: 'local', questionTypes: ['noul'],
    async decide(t: Template): Promise<Decision> {
      return { template_id: t.template_id, version: t.version, answers: Object.fromEntries(QUESTIONS.map((q) => [q, 0.01])), confidence: 0.9, provider: 'local-model', escalate: false, why: '' };
    },
  };
  const def = validateTemplate(SCREEN);
  const old: Template = { ...def, stats: { uses: 0, agreed: 0, disagreed: 0 }, state: 'active', dry_runs: [], activation_task_id: null, created_by: 'test', created_at: '', updated_at: '' };
  return new LegacySeat({ provider, old: (id) => (id === 'ingest-screen' ? old : null) });
}

async function service(verdicts: VerdictRecord[], legacy: boolean) {
  const s = await startTev1StandIn();
  const registry = new Registry();
  for (const t of BUILT_INS) registry.add(t);
  const tev1 = new Tev1Seat({ url: s.url });
  await tev1.refresh();
  const log = new MemoryLog();
  const svc = new DecisionService({ registry, log, verdicts: memoryVerdicts(verdicts), settings: () => DEFAULT_SETTINGS, privacy: () => 'local-only', seats: { tev1, ...(legacy ? { legacy: sortingModel() } : {}) } });
  return { s, svc, log };
}

const fields = { source_kind: 'web', origin: 'www.example.org', content: fence('Plant peas early.') };

test('which version answers: until v2 has passed, the version today’s sorting model serves (v1) keeps answering', async () => {
  const r = await service([], true);
  try {
    assert.equal(r.svc.version('ingest-screen')!.template.version, 1);
    const d = (await r.svc.ask('ingest-screen', fields, { subsystem: 'ingest' }))!;
    assert.equal(d.version, 1);
    assert.equal(d.seat, 'legacy');
    assert.equal(d.outcome, 'pass', 'today’s behaviour, unchanged');
  } finally { await r.s.close(); }
});

test('which version answers: with no sorting model, the newest (v2), as evidence only until it passes', async () => {
  const r = await service([], false);
  try {
    const d = (await r.svc.ask('ingest-screen', fields, { subsystem: 'ingest' }))!;
    assert.equal(d.version, 2);
    assert.equal(d.trust, 'none');
    assert.equal(d.outcome, 'quarantine');
    const shadow = r.log.records[0]!.shadows[0]!;
    assert.deepEqual(Object.keys(shadow.answers!), [...V2_QUESTIONS]);
    assert.deepEqual(r.s.requests[0]!.state, { source: 'a web page from www.example.org', content: 'Plant peas early.' });
  } finally { await r.s.close(); }
});

test('which version answers: once v2 has passed on a decision seat, v2, even with the sorting model ready', async () => {
  const r = await service([pass(2)], true);
  try {
    const d = (await r.svc.ask('ingest-screen', fields, { subsystem: 'ingest' }))!;
    assert.equal(d.version, 2);
    assert.equal(d.trust, 'verdict');
    assert.equal(d.outcome, 'pass', 'the stand-in says no to everything');
    // A caller can still name a version.
    assert.equal((await r.svc.ask('ingest-screen', fields, { subsystem: 'ingest', version: 1 }))!.version, 1);
  } finally { await r.s.close(); }
});

test('the committed verdicts: v2 failed on both pinned Tev1 builds, so it is evidence only and v1 keeps its place', async () => {
  const { fileVerdicts } = await import('../../src/core/decision-service/verdicts.ts');
  const v = fileVerdicts();
  for (const model of ['tev1:4b@7954dce22bc6c29c3b119656207681d12cb34434fed7caa086bfbc919bef0740', 'tev1:0.8b@abc31fdb0bf52506cc47091145ac19c4cfb509b73a6841789324f9e32200c099']) {
    const l = v.lookup('ingest-screen', 2, 'tev1', model);
    assert.equal(l.trusted, false, model);
    assert.match(l.why, /failed its eval/);
  }
  assert.equal(v.passed('ingest-screen', 2), false);
  assert.equal(v.passed('ingest-screen', 1), false);
});
