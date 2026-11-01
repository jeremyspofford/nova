// memory-gate's eval against the REAL model (plan docs/plans/ds2-memory-gate.md). Not CI: skipped
// unless NOVA_REAL_MEMORY_GATE=1. Needs NOVA_PRE_RUN_COMMIT (the commit that fixed the eval) and
// NOVA_TEMPLATE_COMMIT (the commit that fixed the template, rule and bounds). Runs every case once
// per size (NOVA_TEV1_SIZES, default both) against the Ollama at NOVA_REAL_OLLAMA_URL (default
// http://127.0.0.1:11434), and writes, from the results alone:
//   docs/evidence/memory-gate-eval.json   per-case results per size (ids and scores only);
//   docs/evidence/memory-gate-eval.md     the evidence page;
//   src/core/decision-service/verdicts-memory-gate.json  the verdicts (CI recomputes them).
// Synthetic conversations only. Nothing is tuned after the results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SIZES, Tev1Seat, modelId, type Size } from '../../src/core/decision-service/seats/tev1.ts';
import { BOUNDS_MG, scoreMG, verdictMG } from '../../src/core/decision-service/eval-memory.ts';
import { MEMORY_RECORDS_FILE, type RecordsFile, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { MG_QUESTIONS } from '../../src/core/decision-service/templates/memory-gate.ts';
import { buildCases, manifest } from '../ingest/memory-gate-eval/cases.ts';
import { runMG } from '../ingest/memory-gate-eval/harness.ts';
import { render, type MgEvidence, type MgSize } from '../ingest/memory-gate-eval/render.ts';

const on = process.env.NOVA_REAL_MEMORY_GATE === '1';
const ROOT = join(import.meta.dirname, '..', '..');
export const EVIDENCE_JSON = join(ROOT, 'docs', 'evidence', 'memory-gate-eval.json');
export const EVIDENCE_MD = join(ROOT, 'docs', 'evidence', 'memory-gate-eval.md');

test('memory-gate eval on the real model, per size', { skip: !on && 'set NOVA_REAL_MEMORY_GATE=1 to run against the local Ollama', timeout: 6 * 3600_000 }, async () => {
  const pre = process.env.NOVA_PRE_RUN_COMMIT ?? '';
  const tpl = process.env.NOVA_TEMPLATE_COMMIT ?? '';
  assert.match(pre, /^[0-9a-f]{40}$/, 'NOVA_PRE_RUN_COMMIT');
  assert.match(tpl, /^[0-9a-f]{40}$/, 'NOVA_TEMPLATE_COMMIT');
  const url = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const sizes = (process.env.NOVA_TEV1_SIZES ?? SIZES.join(',')).split(',').map((s) => s.trim()) as Size[];
  const cases = buildCases();
  const m = manifest(cases);
  const results: Record<string, MgSize> = {};
  const records: VerdictRecord[] = [];
  for (const size of sizes) {
    const seat = new Tev1Seat({ url, model: size, timeoutMs: 300_000 });
    await seat.refresh();
    const d = seat.detail();
    if (!d.available || !d.digest) { results[size] = { status: 'not-run', why: d.why, digest: null, ollama: d.ollama, run_at: null, metrics: null, cases: [] }; continue; }
    const at = new Date().toISOString();
    const runs = await runMG(seat, cases);
    const metrics = scoreMG(runs, MG_QUESTIONS);
    const v = verdictMG(metrics);
    results[size] = { status: v.pass ? 'pass' : 'fail', why: v.pass ? 'all three bounds met' : v.failed.join('; '), digest: d.digest, ollama: d.ollama, run_at: at, metrics, cases: runs };
    records.push({ template_id: 'memory-gate', version: 1, seat: 'tev1', model: modelId(size, d.digest), status: v.pass ? 'pass' : 'fail', why: results[size]!.why, run_at: at, ref: `memory-gate-eval.json#${size}@${pre}` });
  }
  const evidence: MgEvidence = { template: 'memory-gate', version: 1, template_commit: tpl, pre_run_commit: pre, cases_sha256: m.cases_sha256, sizes: results };
  writeFileSync(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 1)}\n`);
  writeFileSync(EVIDENCE_MD, render(evidence, m));
  const file: RecordsFile = { bounds: { ...BOUNDS_MG }, pre_run_commit: pre, cases_sha256: m.cases_sha256, records };
  writeFileSync(MEMORY_RECORDS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  for (const s of sizes) console.log(`${s}: ${results[s]!.status}: ${results[s]!.why}`);
  assert.ok(records.length > 0, `no size could run: ${sizes.map((s) => results[s]!.why).join('; ')}`);
});
