// The fresh eval of ingest-screen v2, in CI (DS2; plan docs/plans/ds2-ingest-v2.md §2): the manifest
// matches the generator; the attack half is only the merged corpus through transforms, placements
// and carriers v1 didn't use; the gate makes every attack readable; positions land where they say;
// the scoring follows the committed method; the recorded verdicts recompute from the committed
// results; and the harness runs every case (against the loopback stand-in here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from '../../src/core/ingest/checks.ts';
import { CHUNK, OVERLAP, chunks } from '../../src/core/ingest/screen.ts';
import { BOUNDS_V2, combined, scoreV2, verdictV2, type V2CaseResult } from '../../src/core/decision-service/eval-v2.ts';
import { readRecords, recordsOf } from '../../src/core/decision-service/verdicts.ts';
import { Tev1Seat } from '../../src/core/decision-service/seats/tev1.ts';
import { V2_QUESTIONS } from '../../src/core/decision-service/templates/ingest-screen-v2.ts';
import { CARRIERS, MANIFEST_FILE, METADATA_BORNE, PLACEMENTS, STEERING, TEXT_BORNE, TRANSFORMS, UNDO, buildCases, corpus, manifest } from './ingest-v2-eval/cases.ts';
import { judged, runV2, type V2Run } from './ingest-v2-eval/harness.ts';
import { buildCases as v1Cases, ENCODED as V1_ENCODED, PLACEMENTS as V1_PLACEMENTS } from './tev1-eval/cases.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';

const cases = buildCases();
const EVIDENCE_JSON = join(import.meta.dirname, '..', '..', 'docs', 'evidence', 'ingest-v2-eval.json');
const letters = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^a-z]/g, '');

test('the committed manifest is exactly what the generator produces', () => {
  assert.deepEqual(JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')), manifest(cases), 'regenerate with node tests/ingest/ingest-v2-eval/write-manifest.ts, only before a run');
});

test('the fresh set: ≥50 cases, a fair balance, steering cases, and nothing from v1’s transforms or placements', () => {
  const m = manifest(cases);
  assert.ok(m.total >= 50 && m.attacks >= 40 && m.benign >= 40 && m.steering >= 8, JSON.stringify({ total: m.total, attacks: m.attacks, benign: m.benign, steering: m.steering }));
  const used = new Set(cases.filter((c) => c.kind !== 'benign').map((c) => c.transform));
  for (const t of [...Object.keys(V1_ENCODED), ...Object.keys(V1_PLACEMENTS)]) assert.ok(!used.has(t), `${t} was v1’s`);
  for (const t of [...Object.keys(TRANSFORMS), ...Object.keys(PLACEMENTS), ...Object.keys(CARRIERS), ...Object.keys(STEERING)]) assert.ok(used.has(t), t);
  // Every v1 benign case is in the fresh benign half, and every new control and carrier-only too.
  const v1b = v1Cases().filter((c) => !c.attack).map((c) => `v1:${c.id}`);
  for (const id of v1b) assert.ok(cases.some((c) => c.id === id && c.kind === 'benign'), id);
  assert.equal(cases.filter((c) => c.kind === 'benign').length, v1b.length + corpus().controls.length + Object.keys(CARRIERS).length);
  for (const c of cases) {
    if (c.kind === 'benign') assert.ok(V2_QUESTIONS.every((q) => c.labels[q] === false), c.id);
    else assert.ok(V2_QUESTIONS.some((q) => c.labels[q]), `${c.id} is true on some question`);
  }
  // Metadata-borne payloads are not model cases.
  for (const id of METADATA_BORNE) assert.ok(!cases.some((c) => c.from === `injection.json#${id}`), id);
  assert.ok(Object.keys(TEXT_BORNE).every((id) => cases.some((c) => c.from === `injection.json#${id}`)), 'every text-borne payload is used');
});

test('no new attack text: every attack and steering case is a corpus payload, transformed or embedded whole', () => {
  const { injection } = corpus();
  for (const c of cases.filter((x) => x.kind !== 'benign')) {
    const it = injection.find((i) => `injection.json#${i.id}` === c.from);
    assert.ok(it?.text, c.id);
    const body = c.input.text ?? c.input.html!;
    if (UNDO[c.transform]) { assert.equal(UNDO[c.transform]!(body), it.text, `${c.id} reverses to the corpus text exactly`); continue; }
    if (c.transform === 'tags') { const spelled = [...body].filter((ch) => ch.codePointAt(0)! >= 0xe0000).map((ch) => String.fromCharCode(ch.codePointAt(0)! - 0xe0000)).join(''); assert.equal(spelled, [...it.text!].filter((ch) => ch.codePointAt(0)! >= 0x20 && ch.codePointAt(0)! < 0x7f).join('')); continue; }
    if (c.transform === 'spaced') { assert.equal(body.replace(/ /g, ''), it.text!.replace(/ /g, '')); continue; }
    // Embedded whole (escaped as its carrier needs).
    const forms = [it.text!, it.text!.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), JSON.stringify(it.text!).slice(1, -1), it.text!.replace(/"/g, '""')];
    const found = forms.find((f) => body.includes(f));
    assert.ok(found, `${c.id} carries the corpus text whole`);
    assert.doesNotMatch(body.replace(found, ''), /assistant|instruction|password|collector|tool_call/i, `${c.id}: everything else is benign carrier or filler`);
  }
});

test('the gate makes every attack readable: its checks decode or fold each transform', () => {
  const { injection } = corpus();
  for (const c of cases.filter((x) => x.kind !== 'benign')) {
    const src = injection.find((i) => `injection.json#${i.id}` === c.from)!.text!;
    assert.ok(letters(judged(check(c.input as never))).includes(letters(check({ text: src }).visible)), c.id);
  }
});

test('the placements land where they say, in the gate’s own chunks, and nothing is sampled', () => {
  const { injection } = corpus();
  for (const c of cases.filter((x) => x.category.startsWith('placement'))) {
    const p = check({ text: injection.find((i) => `injection.json#${i.id}` === c.from)!.text! }).visible;
    const visible = check({ text: c.input.text! }).visible;
    const at = visible.indexOf(p);
    const { parts, partial } = chunks(visible);
    assert.equal(partial, false, c.id);
    if (c.transform === 'first-of-12') { assert.equal(at, 0); assert.equal(parts.length, 12); }
    if (c.transform === 'mid-chunk-3') assert.ok(at >= 2 * CHUNK && at + p.length <= 3 * CHUNK, `${c.id} at ${at}`);
    if (c.transform === 'after-boundary-3') assert.equal(at, 3 * CHUNK);
    if (c.transform === 'split-boundary-2') assert.ok(at < 2 * CHUNK && at + p.length > 2 * CHUNK, `${c.id} straddles ${2 * CHUNK}`);
    // Since the gate's chunks overlap by 200 (Tev1 NOTE 4, #258), this document is 16 of them, not
    // 15; the payload is still in the second to last, and the cases are unchanged.
    if (c.transform === 'second-to-last-of-15') { assert.equal(parts.length, Math.ceil((visible.length - OVERLAP) / (CHUNK - OVERLAP))); assert.ok(parts.at(-2)!.includes(p), c.id); }
  }
});

test('scoring: caught by outcome, unanswered against the model both ways, steering on the combined verdict', () => {
  const l = (on: boolean) => Object.fromEntries(V2_QUESTIONS.map((q) => [q, on && q === 'override']));
  const s = (p: number) => Object.fromEntries(V2_QUESTIONS.map((q) => [q, q === 'override' ? p : 0.05]));
  const r: V2CaseResult[] = [
    { id: 'a1', kind: 'attack', labels: l(true), scores: s(0.95), outcome: 'block', combined: 'block' },
    { id: 'a2', kind: 'attack', labels: l(true), scores: s(0.1), outcome: 'pass', combined: 'quarantine' },
    { id: 'a3', kind: 'attack', labels: l(true), scores: null, outcome: 'quarantine', combined: 'quarantine' },
    { id: 'b1', kind: 'benign', labels: l(false), scores: s(0.05), outcome: 'pass', combined: 'pass' },
    { id: 'b2', kind: 'benign', labels: l(false), scores: null, outcome: 'quarantine', combined: 'quarantine' },
    { id: 's1', kind: 'steering', labels: l(true), scores: s(0.1), outcome: 'pass', combined: 'quarantine' },
    { id: 's2', kind: 'steering', labels: l(true), scores: s(0.1), outcome: 'pass', combined: 'pass' },
  ];
  const m = scoreV2(r, V2_QUESTIONS);
  assert.deepEqual([m.detection.k, m.detection.n, m.missed], [1, 3, ['a2', 'a3']]);
  assert.deepEqual([m.false_positive.k, m.false_positive.n, m.false_positives], [1, 2, ['b2']]);
  assert.deepEqual([m.steering_held.k, m.steering_held.n, m.steering_passed], [1, 2, ['s2']]);
  assert.equal(m.steering_model_caught.k, 0, 'information only');
  const v = verdictV2(m);
  assert.equal(v.pass, false);
  assert.match(v.failed.join(' | '), /1 steering case passed the combined gate/);
  assert.deepEqual(Object.keys(BOUNDS_V2), ['detection_min', 'false_positive_max', 'ece_max', 'bins', 'steering_min']);
  // The gate's combination: a flag or the outcome, the stricter wins.
  assert.equal(combined([{ level: 'block' }], false, 'pass'), 'block');
  assert.equal(combined([{ level: 'quarantine' }], false, 'pass'), 'quarantine');
  assert.equal(combined([], true, 'pass'), 'quarantine');
  assert.equal(combined([{ level: 'note' }], false, 'pass'), 'pass');
  assert.equal(combined([], false, 'block'), 'block');
});

test('the recorded v2 verdicts agree with a recomputation from the committed results, on this exact set', () => {
  const f = readRecords();
  assert.deepEqual(f.bounds, { ...BOUNDS_V2 });
  if (!f.records.length) { assert.equal(f.cases_sha256, null); return; }
  assert.equal(f.cases_sha256, manifest(cases).cases_sha256, 'recorded on this exact eval set');
  assert.match(String(f.pre_run_commit), /^[0-9a-f]{40}$/);
  assert.ok(existsSync(EVIDENCE_JSON), 'the per-case results are committed');
  const e = JSON.parse(readFileSync(EVIDENCE_JSON, 'utf8')) as { pre_run_commit: string; cases_sha256: string; sizes: Record<string, { status: string; digest: string | null; cases: V2Run[] }> };
  assert.equal(e.pre_run_commit, f.pre_run_commit);
  assert.equal(e.cases_sha256, f.cases_sha256);
  for (const rec of recordsOf(f)) {
    const size = rec.model.split('@')[0]!;
    const run = e.sizes[size]!;
    assert.equal(run.cases.length, cases.length, size);
    assert.equal(`${size}@${run.digest}`, rec.model);
    const v = verdictV2(scoreV2(run.cases, V2_QUESTIONS));
    assert.equal(v.pass ? 'pass' : 'fail', rec.status, `${size}: the record is what the results score to`);
    assert.equal(run.status, rec.status);
  }
});

test('the harness runs every fresh case through the gate’s pieces and the Tev1 seat: all answered, every request within both caps', async () => {
  const s = await startTev1StandIn();
  try {
    const seat = new Tev1Seat({ url: s.url, model: 'tev1:4b' });
    await seat.refresh();
    const runs = await runV2(seat, cases);
    assert.equal(runs.length, cases.length);
    assert.deepEqual(runs.filter((r) => r.scores === null).map((r) => `${r.id}: ${r.error}`), []);
    for (const r of s.requests) {
      assert.ok(r.bytes <= 64 * 1024);
      assert.deepEqual(Object.keys(r.questions), [...V2_QUESTIONS]);
      assert.doesNotMatch(JSON.stringify(r.state), /BEGIN OUTSIDE DATA/, 'v2’s state carries no fence');
    }
    // A model that sees nothing passes everything: detection 0, so the bounds fail.
    const v = verdictV2(scoreV2(runs, V2_QUESTIONS));
    assert.equal(v.pass, false);
    // The deterministic layer still holds most steering cases on its own.
    assert.ok(runs.filter((r) => r.kind === 'steering').some((r) => r.combined !== 'pass'));
  } finally { await s.close(); }
});
