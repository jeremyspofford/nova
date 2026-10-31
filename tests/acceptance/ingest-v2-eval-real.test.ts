// ingest-screen v2's fresh eval against the REAL model (DS2; plan docs/plans/ds2-ingest-v2.md).
// Not CI: skipped unless NOVA_REAL_INGEST_V2=1. Needs NOVA_PRE_RUN_COMMIT (the commit that fixed
// the cases, bounds, scoring and harness) and NOVA_TEMPLATE_COMMIT (the commit that fixed v2 and its
// rule). Runs every fresh case once per size (NOVA_TEV1_SIZES, default both) against the Ollama at
// NOVA_REAL_OLLAMA_URL (default http://127.0.0.1:11434), plus v1's 99 cases as a held-out table, and
// writes, from the results alone:
//   docs/evidence/ingest-v2-eval.json  per-case results per size;
//   docs/evidence/ingest-v2-eval.md    the evidence page;
//   src/core/decision-service/verdicts.json  the verdicts the service follows (CI recomputes them).
// Nothing is tuned after seeing results: a size that misses a bound stays evidence-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIZES, Tev1Seat, modelId, type Size } from '../../src/core/decision-service/seats/tev1.ts';
import { BOUNDS_V2, scoreV2, verdictV2 } from '../../src/core/decision-service/eval-v2.ts';
import { RECORDS_FILE, type RecordsFile, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { V2_QUESTIONS } from '../../src/core/decision-service/templates/ingest-screen-v2.ts';
import { buildCases, manifest } from '../ingest/ingest-v2-eval/cases.ts';
import { runV2 } from '../ingest/ingest-v2-eval/harness.ts';
import { render, type EvidenceV2, type SizeResult } from '../ingest/ingest-v2-eval/render.ts';
import { buildCases as v1Cases } from '../ingest/tev1-eval/cases.ts';

const on = process.env.NOVA_REAL_INGEST_V2 === '1';
const ROOT = join(import.meta.dirname, '..', '..');
export const EVIDENCE_JSON = join(ROOT, 'docs', 'evidence', 'ingest-v2-eval.json');
export const EVIDENCE_MD = join(ROOT, 'docs', 'evidence', 'ingest-v2-eval.md');

test('ingest-screen v2 fresh eval on the real model, per size', { skip: !on && 'set NOVA_REAL_INGEST_V2=1 to run against the local Ollama', timeout: 6 * 3600_000 }, async () => {
  const pre = process.env.NOVA_PRE_RUN_COMMIT ?? '';
  const tpl = process.env.NOVA_TEMPLATE_COMMIT ?? '';
  assert.match(pre, /^[0-9a-f]{40}$/, 'NOVA_PRE_RUN_COMMIT: the commit that fixed the eval before this run');
  assert.match(tpl, /^[0-9a-f]{40}$/, 'NOVA_TEMPLATE_COMMIT: the commit that fixed v2 and its rule');
  const url = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const sizes = (process.env.NOVA_TEV1_SIZES ?? SIZES.join(',')).split(',').map((s) => s.trim()) as Size[];
  const cases = buildCases();
  const m = manifest(cases);
  const held = v1Cases().map((c) => ({ id: c.id, kind: (c.attack ? 'attack' : 'benign') as 'attack' | 'benign', category: c.category, labels: {}, input: c.input }));
  const results: Record<string, SizeResult> = {};
  const records: VerdictRecord[] = [];
  for (const size of sizes) {
    const seat = new Tev1Seat({ url, model: size, timeoutMs: 300_000 });
    await seat.refresh();
    const d = seat.detail();
    if (!d.available || !d.digest) { results[size] = { status: 'not-run', why: d.why, digest: null, ollama: d.ollama, run_at: null, metrics: null, cases: [], held_out: null }; continue; }
    const at = new Date().toISOString();
    const runs = await runV2(seat, cases);
    const metrics = scoreV2(runs, V2_QUESTIONS);
    const v = verdictV2(metrics);
    const h = await runV2(seat, held);
    const ha = h.filter((c) => c.kind === 'attack');
    const hb = h.filter((c) => c.kind === 'benign');
    const caught = (c: (typeof h)[number]) => c.scores !== null && c.outcome !== 'pass';
    // As in the fresh set: an unanswered benign case counts as a false positive.
    const flagged = (c: (typeof h)[number]) => c.scores === null || c.outcome !== 'pass';
    results[size] = {
      status: v.pass ? 'pass' : 'fail', why: v.pass ? 'all four bounds met' : v.failed.join('; '),
      digest: d.digest, ollama: d.ollama, run_at: at, metrics, cases: runs,
      held_out: { detection: { k: ha.filter(caught).length, n: ha.length }, false_positive: { k: hb.filter(flagged).length, n: hb.length }, missed: ha.filter((c) => !caught(c)).map((c) => c.id), false_positives: hb.filter(flagged).map((c) => c.id) },
    };
    records.push({ template_id: 'ingest-screen', version: 2, seat: 'tev1', model: modelId(size, d.digest), status: v.pass ? 'pass' : 'fail', why: results[size]!.why, run_at: at, ref: `ingest-v2-eval.json#${size}@${pre}` });
  }
  const evidence: EvidenceV2 = { template: 'ingest-screen', version: 2, template_commit: tpl, pre_run_commit: pre, cases_sha256: m.cases_sha256, sizes: results };
  writeFileSync(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 1)}\n`);
  writeFileSync(EVIDENCE_MD, render(evidence, m));
  const file: RecordsFile = { bounds: { ...BOUNDS_V2 }, pre_run_commit: pre, cases_sha256: m.cases_sha256, records };
  writeFileSync(RECORDS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  for (const s of sizes) console.log(`${s}: ${results[s]!.status}: ${results[s]!.why}`);
  assert.ok(records.length > 0, `no size could run: ${sizes.map((s) => results[s]!.why).join('; ')}`);
});
