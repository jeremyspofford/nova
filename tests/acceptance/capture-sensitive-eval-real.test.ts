// capture-sensitive's eval against the REAL model (capture screening, job 1; plan
// docs/plans/ds2-capture-sensitive.md). Not CI: skipped unless NOVA_REAL_CAPTURE_SENSITIVE=1. Needs
// NOVA_PRE_RUN_COMMIT (the commit that fixed the eval) and NOVA_TEMPLATE_COMMIT (the commit that
// fixed the template and its rule). Runs every case once per size (NOVA_TEV1_SIZES, default both)
// against the Ollama at NOVA_REAL_OLLAMA_URL (default http://127.0.0.1:11434), and writes, from the
// results alone:
//   docs/evidence/capture-sensitive-eval.json   per-case results per size (ids and scores only);
//   docs/evidence/capture-sensitive-eval.md     the evidence page;
//   src/core/decision-service/verdicts-capture-sensitive.json  the verdicts (CI recomputes them).
// Synthetic content only. Nothing is tuned after the results: a failing size stays evidence-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIZES, Tev1Seat, modelId, type Size } from '../../src/core/decision-service/seats/tev1.ts';
import { BOUNDS_CS, scoreCS, verdictCS } from '../../src/core/decision-service/eval-capture.ts';
import { CAPTURE_RECORDS_FILE, type RecordsFile, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { CS_QUESTIONS } from '../../src/core/decision-service/templates/capture-sensitive.ts';
import { buildCases, manifest } from '../ingest/capture-sensitive-eval/cases.ts';
import { runCS } from '../ingest/capture-sensitive-eval/harness.ts';
import { render, type CsEvidence, type CsSize } from '../ingest/capture-sensitive-eval/render.ts';

const on = process.env.NOVA_REAL_CAPTURE_SENSITIVE === '1';
const ROOT = join(import.meta.dirname, '..', '..');
export const EVIDENCE_JSON = join(ROOT, 'docs', 'evidence', 'capture-sensitive-eval.json');
export const EVIDENCE_MD = join(ROOT, 'docs', 'evidence', 'capture-sensitive-eval.md');

test('capture-sensitive eval on the real model, per size', { skip: !on && 'set NOVA_REAL_CAPTURE_SENSITIVE=1 to run against the local Ollama', timeout: 6 * 3600_000 }, async () => {
  const pre = process.env.NOVA_PRE_RUN_COMMIT ?? '';
  const tpl = process.env.NOVA_TEMPLATE_COMMIT ?? '';
  assert.match(pre, /^[0-9a-f]{40}$/, 'NOVA_PRE_RUN_COMMIT');
  assert.match(tpl, /^[0-9a-f]{40}$/, 'NOVA_TEMPLATE_COMMIT');
  const url = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const sizes = (process.env.NOVA_TEV1_SIZES ?? SIZES.join(',')).split(',').map((s) => s.trim()) as Size[];
  const cases = buildCases();
  const m = manifest(cases);
  const results: Record<string, CsSize> = {};
  const records: VerdictRecord[] = [];
  for (const size of sizes) {
    const seat = new Tev1Seat({ url, model: size, timeoutMs: 300_000 });
    await seat.refresh();
    const d = seat.detail();
    if (!d.available || !d.digest) { results[size] = { status: 'not-run', why: d.why, deterministic_ok: null, digest: null, ollama: d.ollama, run_at: null, metrics: null, cases: [] }; continue; }
    const at = new Date().toISOString();
    const runs = await runCS(seat, cases);
    const metrics = scoreCS(runs, CS_QUESTIONS);
    const v = verdictCS(metrics);
    results[size] = { status: v.pass ? 'pass' : 'fail', why: v.pass ? 'all three model bounds met' : v.failed.join('; '), deterministic_ok: v.deterministic_ok, digest: d.digest, ollama: d.ollama, run_at: at, metrics, cases: runs };
    records.push({ template_id: 'capture-sensitive', version: 1, seat: 'tev1', model: modelId(size, d.digest), status: v.pass ? 'pass' : 'fail', why: results[size]!.why, run_at: at, ref: `capture-sensitive-eval.json#${size}@${pre}` });
  }
  const evidence: CsEvidence = { template: 'capture-sensitive', version: 1, template_commit: tpl, pre_run_commit: pre, cases_sha256: m.cases_sha256, sizes: results };
  writeFileSync(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 1)}\n`);
  writeFileSync(EVIDENCE_MD, render(evidence, m));
  const file: RecordsFile = { bounds: { ...BOUNDS_CS }, pre_run_commit: pre, cases_sha256: m.cases_sha256, records };
  writeFileSync(CAPTURE_RECORDS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  for (const s of sizes) console.log(`${s}: ${results[s]!.status}: ${results[s]!.why}; deterministic ok: ${results[s]!.deterministic_ok}`);
  assert.ok(records.length > 0, `no size could run: ${sizes.map((s) => results[s]!.why).join('; ')}`);
});
