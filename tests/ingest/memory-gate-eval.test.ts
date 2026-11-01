// memory-gate's eval, in CI (plan docs/plans/ds2-memory-gate.md): the manifest matches the
// generator; every category is there with placeholder people; expected outcomes follow the
// template's own rule; exact duplicates merge with no model call; the scoring follows the committed
// method; the recorded verdicts recompute; and the harness runs every case against the stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOUNDS_MG, scoreMG, verdictMG, type MgCaseResult } from '../../src/core/decision-service/eval-memory.ts';
import { MEMORY_RECORDS_FILE, readRecords, recordsOf } from '../../src/core/decision-service/verdicts.ts';
import { Tev1Seat } from '../../src/core/decision-service/seats/tev1.ts';
import { MG_QUESTIONS, memoryPolicy, memoryPrecheck } from '../../src/core/decision-service/templates/memory-gate.ts';
import { MANIFEST_FILE, buildCases, manifest } from './memory-gate-eval/cases.ts';
import { runMG, type MgRun } from './memory-gate-eval/harness.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';

const cases = buildCases();
const EVIDENCE_JSON = join(import.meta.dirname, '..', '..', 'docs', 'evidence', 'memory-gate-eval.json');

test('the committed manifest is exactly what the generator produces', () => {
  assert.deepEqual(JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')), manifest(cases));
});

test('the set: ≥50 cases, every category, every outcome, placeholder people only', () => {
  const m = manifest(cases);
  assert.ok(m.total >= 50, `${m.total}`);
  for (const c of ['lasting fact', 'standing preference', 'passing remark', 'today’s plans', 'one-off request', 'only in Nova’s answer', 'more than the person said', 'duplicate', 'contradiction', 'related but different', 'exact duplicate']) assert.ok(m.counts[c], c);
  for (const o of ['save', 'skip', 'merge', 'flag']) assert.ok((m.expected[o] ?? 0) >= 5, `${o}: ${m.expected[o]}`);
  const names = new Set(cases.flatMap((c) => [...JSON.stringify(c.input).matchAll(/\b[A-Z][a-z]+ Placeholder\b/g)].map((x) => x[0])));
  for (const n of names) assert.match(n, /^(Alex|Sam|Jordan|Taylor) Placeholder$/);
  assert.doesNotMatch(JSON.stringify(cases), /@|https?:\/\/|\b\d{6,}\b/, 'no addresses, links or long numbers');
});

test('every expected outcome is the template’s own rule on the case’s labels', () => {
  for (const c of cases) {
    const b = Object.fromEntries(MG_QUESTIONS.map((q) => [q, c.labels[q] ? 'yes' : 'no']));
    assert.equal(c.expected, memoryPolicy(b), c.id);
  }
  // Facts only in Nova's answer never count as the person's words.
  for (const c of cases.filter((x) => x.category === 'only in Nova’s answer')) assert.equal(c.labels.in_person_words, false, c.id);
});

test('deterministic: exactly the cases marked so are decided without a model, as merges', () => {
  for (const c of cases) {
    const p = memoryPrecheck(c.input);
    assert.equal(!!p?.final, c.deterministic, c.id);
    if (c.deterministic) assert.equal(p!.outcome, 'merge', c.id);
  }
});

test('scoring: false saves count unanswered cases too; save recall; the bounds', () => {
  const lab = Object.fromEntries(MG_QUESTIONS.map((q) => [q, false]));
  const s = Object.fromEntries(MG_QUESTIONS.map((q) => [q, 0.05]));
  const r: MgCaseResult[] = [
    { id: 's1', labels: lab, expected: 'save', scores: s, asked: true, outcome: 'save' },
    { id: 's2', labels: lab, expected: 'save', scores: s, asked: true, outcome: 'skip' },
    { id: 's3', labels: lab, expected: 'save', scores: null, asked: true, outcome: null },
    { id: 'k1', labels: lab, expected: 'skip', scores: s, asked: true, outcome: 'save' },
    { id: 'k2', labels: lab, expected: 'skip', scores: null, asked: true, outcome: null },
    { id: 'k3', labels: lab, expected: 'skip', scores: s, asked: true, outcome: 'skip' },
    { id: 'm1', labels: lab, expected: 'merge', scores: null, asked: false, outcome: 'merge' },
  ];
  const m = scoreMG(r, MG_QUESTIONS);
  assert.deepEqual([m.false_save.k, m.false_save.n, m.false_saves], [2, 4, ['k1', 'k2']], 'an unanswered case falls back to save: a false save');
  assert.deepEqual([m.save_recall.k, m.save_recall.n, m.missed_saves], [1, 3, ['s2', 's3']], 'and a missed save where saving is right');
  assert.deepEqual([m.deterministic.k, m.deterministic.n], [1, 1]);
  assert.equal(verdictMG(m).pass, false);
  assert.deepEqual({ ...BOUNDS_MG }, { false_save_max: 0.05, save_recall_min: 0.75, ece_max: 0.1, bins: 10 });
});

test('the recorded verdicts agree with a recomputation from the committed results, on this exact set', () => {
  const f = readRecords(MEMORY_RECORDS_FILE);
  assert.deepEqual(f.bounds, { ...BOUNDS_MG });
  if (!f.records.length) { assert.equal(f.cases_sha256, null); return; }
  assert.equal(f.cases_sha256, manifest(cases).cases_sha256);
  assert.match(String(f.pre_run_commit), /^[0-9a-f]{40}$/);
  assert.ok(existsSync(EVIDENCE_JSON));
  const e = JSON.parse(readFileSync(EVIDENCE_JSON, 'utf8')) as { pre_run_commit: string; sizes: Record<string, { digest: string | null; cases: MgRun[] }> };
  assert.equal(e.pre_run_commit, f.pre_run_commit);
  for (const rec of recordsOf(f, BOUNDS_MG)) {
    const size = rec.model.split('@')[0]!;
    const run = e.sizes[size]!;
    assert.equal(run.cases.length, cases.length);
    assert.equal(`${size}@${run.digest}`, rec.model);
    assert.equal(verdictMG(scoreMG(run.cases, MG_QUESTIONS)).pass ? 'pass' : 'fail', rec.status, size);
  }
});

test('the harness runs every case: exact duplicates without a model, every other case answered', async () => {
  const s = await startTev1StandIn();
  try {
    const seat = new Tev1Seat({ url: s.url, model: 'tev1:4b' });
    await seat.refresh();
    const runs = await runMG(seat, cases);
    assert.equal(runs.length, cases.length);
    assert.deepEqual(runs.filter((r) => r.asked && r.outcome === null).map((r) => `${r.id}: ${r.error}`), []);
    assert.equal(s.requests.length, cases.filter((c) => !c.deterministic).length);
    for (const r of s.requests) assert.deepEqual(Object.keys(r.questions), [...MG_QUESTIONS]);
    // A model that says "no" to everything skips everything: no false saves, but no saves at all.
    const m = scoreMG(runs, MG_QUESTIONS);
    assert.equal(m.false_save.k, 0);
    assert.equal(m.save_recall.k, 0);
    assert.equal(verdictMG(m).pass, false);
  } finally { await s.close(); }
});
