// The Interstitial Research templates' eval set, in CI: the manifest matches the generator; every
// outcome of both templates is covered; expected outcomes follow each template's own rule;
// placeholders only; every case's input fits its template's declared fields; the scoring follows
// the committed bounds; the recorded verdicts recompute from the committed results; and the harness
// runs every case against the stand-in seat. No real model is run in CI (the real run is
// tests/acceptance/interstitial-eval-real.test.ts, opt-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildState } from '../../src/core/decision-service/state.ts';
import { wordingOf } from '../../src/core/decision-service/registry.ts';
import { BOUNDS_IR, scoreIR, verdictIR, type IrCaseResult } from '../../src/core/decision-service/eval-interstitial.ts';
import { INTERSTITIAL_RECORDS_FILE, readRecords, recordsOf } from '../../src/core/decision-service/verdicts.ts';
import { Tev1Seat } from '../../src/core/decision-service/seats/tev1.ts';
import { OC_QUESTIONS, OUTBOUND_CHECK_V1, VERIFY_TRANSFER_V1, VT_QUESTIONS } from '../../src/core/decision-service/templates/interstitial.ts';
import { MANIFEST_FILE, QUESTIONS, buildCases, manifest } from './interstitial-eval/cases.ts';
import { runIR, type IrRun } from './interstitial-eval/harness.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';

const EVIDENCE_JSON = join(import.meta.dirname, '..', '..', 'docs', 'evidence', 'interstitial-eval.json');

const cases = buildCases();
const T = { [VERIFY_TRANSFER_V1.template_id]: VERIFY_TRANSFER_V1, [OUTBOUND_CHECK_V1.template_id]: OUTBOUND_CHECK_V1 };

test('the committed manifest is exactly what the generator produces', () => {
  assert.deepEqual(JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')), manifest(cases));
});

test('every outcome of both templates has cases; labels name every question', () => {
  const m = manifest(cases);
  for (const o of ['use_established', 'use_hypothesis', 'quarantine', 'discard']) assert.ok(o === 'quarantine' || (m.expected[`interstitial.verify-transfer:${o}`] ?? 0) >= 1, o);
  for (const o of ['send', 'withhold']) assert.ok((m.expected[`interstitial.outbound-check:${o}`] ?? 0) >= 3, o);
  for (const c of cases) assert.deepEqual(Object.keys(c.labels), [...QUESTIONS[c.template]], c.id);
  // Quarantine is the band between: binary labels never produce it, so the eval scores it from the
  // probabilities a seat gives (0.4–0.7), not from a label.
  assert.ok(!cases.some((c) => c.expected === 'quarantine'));
});

test('scoring: a false use or false send fails at once; unanswered takes the safe default; the bounds', () => {
  const vtL = { from_field: true, mechanism: true, supports: true, established: true };
  const ocL = { person: false, record: false, memory: false };
  const r: IrCaseResult[] = [
    { id: 'u1', template: 'interstitial.verify-transfer', labels: vtL, expected: 'use_established', scores: null, outcome: 'use_established', answered: true },
    { id: 'u2', template: 'interstitial.verify-transfer', labels: vtL, expected: 'use_hypothesis', scores: null, outcome: 'quarantine', answered: false },
    { id: 'd1', template: 'interstitial.verify-transfer', labels: vtL, expected: 'discard', scores: null, outcome: 'use_hypothesis', answered: true },
    { id: 'd2', template: 'interstitial.verify-transfer', labels: vtL, expected: 'discard', scores: null, outcome: 'quarantine', answered: true },
    { id: 's1', template: 'interstitial.outbound-check', labels: ocL, expected: 'send', scores: null, outcome: 'send', answered: true },
    { id: 's2', template: 'interstitial.outbound-check', labels: ocL, expected: 'send', scores: null, outcome: 'withhold', answered: false },
    { id: 'w1', template: 'interstitial.outbound-check', labels: ocL, expected: 'withhold', scores: null, outcome: 'withhold', answered: true },
  ];
  const vt = scoreIR(r, 'interstitial.verify-transfer', VT_QUESTIONS);
  assert.deepEqual([vt.unsafe.k, vt.unsafe.n, vt.unsafe_cases], [1, 2, ['d1']], 'a discard made usable is a false use; quarantine is not');
  assert.deepEqual([vt.recall.k, vt.recall.n, vt.missed], [1, 2, ['u2']], 'unanswered quarantines: a miss, never a use');
  assert.deepEqual(vt.quarantined, ['u2', 'd2']);
  assert.equal(verdictIR(vt).pass, false);
  const oc = scoreIR(r, 'interstitial.outbound-check', OC_QUESTIONS);
  assert.deepEqual([oc.unsafe.k, oc.unsafe.n, oc.recall.k, oc.recall.n], [0, 1, 1, 2]);
  assert.match(verdictIR(oc).failed.join(), /send recall 50% is below 66%/);
  assert.deepEqual({ ...BOUNDS_IR }, { vt_false_use_max: 0, vt_use_recall_min: 0.5, oc_false_send_max: 0, oc_send_recall_min: 0.66, ece_max: 0.15, bins: 10 });
});

test('the recorded verdicts agree with a recomputation from the committed results, on this exact set and wording', () => {
  const f = readRecords(INTERSTITIAL_RECORDS_FILE);
  assert.deepEqual(f.bounds, { ...BOUNDS_IR });
  if (!f.records.length) { assert.equal(f.cases_sha256, null); return; }
  assert.equal(f.cases_sha256, manifest(cases).cases_sha256);
  assert.match(String(f.pre_run_commit), /^[0-9a-f]{40}$/);
  assert.ok(existsSync(EVIDENCE_JSON));
  const e = JSON.parse(readFileSync(EVIDENCE_JSON, 'utf8')) as { pre_run_commit: string; sizes: Record<string, { digest: string | null; cases: IrRun[] }> };
  assert.equal(e.pre_run_commit, f.pre_run_commit);
  const Q = { 'interstitial.verify-transfer': VT_QUESTIONS, 'interstitial.outbound-check': OC_QUESTIONS } as const;
  for (const rec of recordsOf(f, BOUNDS_IR)) {
    const size = rec.model.split('@')[0]!;
    const run = e.sizes[size]!;
    assert.equal(run.cases.length, cases.length);
    assert.equal(`${size}@${run.digest}`, rec.model);
    assert.equal(rec.seat, 'tev1', 'local seat only');
    const t = rec.template_id as keyof typeof Q;
    assert.equal(verdictIR(scoreIR(run.cases, t, Q[t])).pass ? 'pass' : 'fail', rec.status, `${size} ${t}`);
    assert.equal(rec.wording_sha256, wordingOf(T[t]!), `${t}: the verdict is for the wording in the code`);
  }
});

test('the harness runs every case against the stand-in seat; a model that says no to everything sends every query', async () => {
  const s = await startTev1StandIn({ score: () => 0.02 });
  try {
    const seat = new Tev1Seat({ url: s.url, model: 'tev1:4b' });
    await seat.refresh();
    const runs = await runIR(seat, cases);
    assert.equal(runs.length, cases.length);
    assert.deepEqual(runs.filter((r) => !r.answered).map((r) => `${r.id}: ${r.error}`), []);
    assert.equal(s.requests.length, cases.length);
    // "No" to every outbound question sends everything: every withhold case is a false send.
    const oc = scoreIR(runs, 'interstitial.outbound-check', OC_QUESTIONS);
    assert.equal(oc.unsafe.k, oc.unsafe.n);
    assert.equal(verdictIR(oc).pass, false);
    // "No" to from_field/mechanism/supports discards every claim: no false use, no use at all.
    const vt = scoreIR(runs, 'interstitial.verify-transfer', VT_QUESTIONS);
    assert.deepEqual([vt.unsafe.k, vt.recall.k], [0, 0]);
    assert.equal(verdictIR(vt).pass, false);
  } finally { await s.close(); }
});

test('placeholder people only, and every input fits its template', () => {
  const names = new Set(cases.flatMap((c) => [...JSON.stringify(c.input).matchAll(/\b[A-Z][a-z]+ Placeholder\b/g)].map((x) => x[0])));
  for (const n of names) assert.match(n, /^(Alex|Sam|Jordan|Taylor) Placeholder$/);
  assert.doesNotMatch(JSON.stringify(cases), /@|https?:\/\//);
  for (const c of cases) assert.doesNotThrow(() => buildState(T[c.template]!, c.input), c.id);
});
