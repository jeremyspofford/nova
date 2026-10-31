// capture-sensitive's eval, in CI (plan docs/plans/ds2-capture-sensitive.md): the manifest matches
// the generator; the content is synthetic; the deterministic layer catches what each case expects,
// redacts or excludes every structured and sensitive-app case, and lets no caught value reach the
// model; the scoring follows the committed method; the recorded verdicts recompute; and the harness
// runs every case (against the loopback stand-in here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOUNDS_CS, scoreCS, verdictCS, type CsCaseResult } from '../../src/core/decision-service/eval-capture.ts';
import { CAPTURE_RECORDS_FILE, readRecords, recordsOf } from '../../src/core/decision-service/verdicts.ts';
import { Tev1Seat } from '../../src/core/decision-service/seats/tev1.ts';
import { CS_QUESTIONS, capturePrecheck } from '../../src/core/decision-service/templates/capture-sensitive.ts';
import { MANIFEST_FILE, buildCases, manifest } from './capture-sensitive-eval/cases.ts';
import { runCS, type CsRun } from './capture-sensitive-eval/harness.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';

const cases = buildCases();
const EVIDENCE_JSON = join(import.meta.dirname, '..', '..', 'docs', 'evidence', 'capture-sensitive-eval.json');

test('the committed manifest is exactly what the generator produces', () => {
  assert.deepEqual(JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')), manifest(cases));
});

test('the set: ≥50 cases, every kind, and the harmless look-alikes asked for', () => {
  const m = manifest(cases);
  assert.ok(m.total >= 50 && m.by_kind.grey! >= 30 && m.by_kind.benign! >= 30 && m.by_kind.structured! >= 10 && m.by_kind.app! >= 4, JSON.stringify(m.by_kind));
  for (const id of ['b-docs-api-keys', 'b-recipe-vitamin', 'b-bank-ad']) assert.ok(cases.some((c) => c.id === id), id);
  for (const q of CS_QUESTIONS) assert.ok(cases.some((c) => c.kind === 'grey' && c.labels[q]), `a grey case for ${q}`);
  for (const c of cases) if (c.kind === 'benign') assert.ok(CS_QUESTIONS.every((q) => !c.labels[q]), c.id);
});

test('synthetic only: placeholder people, example hosts, published test numbers, canary secrets', () => {
  const all = cases.map((c) => JSON.stringify(c.input)).join('\n');
  for (const m of all.matchAll(/[\w.+-]+@([\w.-]+)/g)) assert.match(m[1]!, /(?:^|\.)example\.(?:com|org|dev)$/, m[0]);
  for (const m of all.matchAll(/https?:\/\/([^/\s"]+)/g)) assert.match(m[1]!.replace(/^[^@]*@/, ''), /(?:^|\.)example(?:bank)?\.(?:com|org|dev)(?::\d+)?$|^(?:online\.)?examplebank\.com$/, m[0]);
  const cards = [...all.replaceAll('GB82 WEST 1234 5698 7654 32', '').matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)].map((m) => m[0].replace(/\D/g, ''));
  for (const d of cards) assert.ok(['4242424242424242', '4111111111111111', '5555555555554444'].includes(d), `card ${d} is a published test number`);
  assert.deepEqual([...all.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)].map((m) => m[0]), ['123-45-6789'], 'only the example SSN');
  assert.deepEqual([...all.matchAll(/\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){4,}(?: [A-Z0-9]{1,4})?\b/g)].map((m) => m[0]), ['GB82 WEST 1234 5698 7654 32'], 'only the documented example IBAN');
  const people = new Set([...all.matchAll(/\b(Alex|Sam|Jordan|Taylor)( Placeholder| P\.)?/g)].map((m) => m[1]));
  assert.ok(people.size > 0);
  for (const c of cases.filter((x) => x.kind === 'structured')) assert.ok(c.secrets.some((s) => /canary|EXAMPLE|4111|5555|GB82|123-45|4821/i.test(s) || s.split('.').some((part) => /canary/i.test(Buffer.from(part, 'base64url').toString('utf8')))), `${c.id}'s secret is a canary or a test value`);
});

test('the deterministic layer: each case’s expectation holds; every structured and app case is redacted or excluded; no caught value survives', () => {
  for (const c of cases) {
    const p = capturePrecheck(c.input);
    assert.equal(!!p, c.pattern, `${c.id}: deterministic ${c.pattern ? 'finds' : 'finds nothing'}`);
    if (c.kind === 'app') assert.equal(p!.final, true, c.id);
    if (c.kind === 'structured') {
      assert.equal(p!.outcome, 'redact', c.id);
      const text = (p!.fields as { text: string }).text;
      for (const s of c.secrets) assert.ok(!text.includes(s), `${c.id}: ${s} is redacted`);
    }
  }
});

test('scoring: detection and false holds by the model’s outcome; unanswered counts against it; the deterministic bound is separate', () => {
  const lab = (on: boolean) => Object.fromEntries(CS_QUESTIONS.map((q) => [q, on && q === 'health_details']));
  const s = (p: number) => Object.fromEntries(CS_QUESTIONS.map((q) => [q, q === 'health_details' ? p : 0.05]));
  const r: CsCaseResult[] = [
    { id: 'g1', kind: 'grey', labels: lab(true), scores: s(0.9), model_outcome: 'hold', pipeline: 'hold', asked: true, leaked: false },
    { id: 'g2', kind: 'grey', labels: lab(true), scores: s(0.1), model_outcome: 'index', pipeline: 'index', asked: true, leaked: false },
    { id: 'g3', kind: 'grey', labels: lab(true), scores: null, model_outcome: null, pipeline: 'index', asked: true, leaked: false },
    { id: 'b1', kind: 'benign', labels: lab(false), scores: s(0.05), model_outcome: 'index', pipeline: 'index', asked: true, leaked: false },
    { id: 'b2', kind: 'benign', labels: lab(false), scores: s(0.5), model_outcome: 'hold', pipeline: 'hold', asked: true, leaked: false },
    { id: 'b3', kind: 'benign', labels: lab(false), scores: s(0.05), model_outcome: 'index', pipeline: 'redact', asked: true, leaked: false },
    { id: 's1', kind: 'structured', labels: lab(false), scores: s(0.05), model_outcome: 'index', pipeline: 'redact', asked: true, leaked: false },
    { id: 'a1', kind: 'app', labels: lab(false), scores: null, model_outcome: null, pipeline: 'exclude', asked: false, leaked: false },
  ];
  const m = scoreCS(r, CS_QUESTIONS);
  assert.deepEqual([m.detection.k, m.detection.n, m.missed], [1, 3, ['g2', 'g3']]);
  assert.deepEqual([m.false_hold.k, m.false_hold.n, m.false_holds], [1, 3, ['b2']]);
  assert.deepEqual([m.pipeline_false_hold.k, m.pipeline_false_hold.n], [2, 3], 'the pattern’s redact counts in the pipeline line only');
  assert.deepEqual([m.deterministic.k, m.deterministic.n], [2, 2]);
  assert.deepEqual(m.unanswered, ['g3']);
  const v = verdictCS(m);
  assert.equal(v.pass, false);
  assert.equal(v.deterministic_ok, true);
  assert.deepEqual(Object.keys(BOUNDS_CS), ['detection_min', 'false_hold_max', 'ece_max', 'bins', 'deterministic_min']);
  assert.equal(BOUNDS_CS.detection_min, 0.95);
  assert.equal(BOUNDS_CS.false_hold_max, 0.2);
});

test('the recorded verdicts agree with a recomputation from the committed results, on this exact set', () => {
  const f = readRecords(CAPTURE_RECORDS_FILE);
  assert.deepEqual(f.bounds, { ...BOUNDS_CS });
  if (!f.records.length) { assert.equal(f.cases_sha256, null); return; }
  assert.equal(f.cases_sha256, manifest(cases).cases_sha256);
  assert.match(String(f.pre_run_commit), /^[0-9a-f]{40}$/);
  assert.ok(existsSync(EVIDENCE_JSON));
  const e = JSON.parse(readFileSync(EVIDENCE_JSON, 'utf8')) as { pre_run_commit: string; cases_sha256: string; sizes: Record<string, { status: string; digest: string | null; cases: CsRun[] }> };
  assert.equal(e.pre_run_commit, f.pre_run_commit);
  for (const rec of recordsOf(f, BOUNDS_CS)) {
    const size = rec.model.split('@')[0]!;
    const run = e.sizes[size]!;
    assert.equal(run.cases.length, cases.length);
    assert.equal(`${size}@${run.digest}`, rec.model);
    const v = verdictCS(scoreCS(run.cases, CS_QUESTIONS));
    assert.equal(v.pass ? 'pass' : 'fail', rec.status, size);
  }
  assert.doesNotMatch(readFileSync(EVIDENCE_JSON, 'utf8'), /CANARY|bluefinch42|Pepper2019|Summer-Rain-22/, 'the evidence holds ids and scores, never case text');
});

test('the harness runs every case: no model call for sensitive apps, every model case answered, no caught value reaches the model', async () => {
  const s = await startTev1StandIn();
  try {
    const seat = new Tev1Seat({ url: s.url, model: 'tev1:4b' });
    await seat.refresh();
    const sent = () => s.requests.map((r) => JSON.stringify(r.state)).join('\n');
    const runs = await runCS(seat, cases, sent);
    assert.equal(runs.length, cases.length);
    assert.deepEqual(runs.filter((r) => r.asked && r.scores === null).map((r) => `${r.id}: ${r.error}`), []);
    for (const r of runs.filter((x) => x.kind === 'app')) { assert.equal(r.asked, false); assert.equal(r.pipeline, 'exclude'); }
    for (const r of runs.filter((x) => x.kind === 'structured')) assert.equal(r.pipeline, 'redact', r.id);
    assert.deepEqual(runs.filter((r) => r.leaked).map((r) => r.id), []);
    const everything = sent();
    for (const c of cases.filter((x) => x.kind === 'structured')) for (const v of c.secrets) assert.ok(!everything.includes(v), `${c.id}: ${v} never sent`);
    // A model that sees nothing indexes every grey case: detection 0, so it fails.
    const m = scoreCS(runs, CS_QUESTIONS);
    assert.equal(m.detection.k, 0);
    assert.equal(verdictCS(m).deterministic_ok, true);
  } finally { await s.close(); }
});
