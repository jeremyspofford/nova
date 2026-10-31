// The Tev1 injection eval against the REAL model (Amendment 2026-10-31-B Part 1; plan
// docs/plans/tev1.md). Not CI: skipped unless NOVA_REAL_TEV1=1. Runs every case through the actual
// ingest gate once per size (NOVA_TEV1_SIZES, default "tev1:4b,tev1:0.8b") against the Ollama at
// NOVA_REAL_OLLAMA_URL (default http://127.0.0.1:11434), then writes, from the results alone:
//   docs/evidence/tev1-eval.json   per-case results per size;
//   docs/evidence/tev1-eval.md     the evidence page;
//   src/core/decision-service/tev1-verdicts.json the verdicts the service follows (CI recomputes them).
// The cases, bounds and scoring were committed before any run (bounds_commit). Nothing is tuned
// after seeing results: a size that misses a bound is advisory, and that is the recorded outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOUNDS } from '../../src/core/decision-service/eval.ts';
import { SIZES, Tev1Seat, type Size } from '../../src/core/decision-service/seats/tev1.ts';
import { VERDICTS_FILE, readVerdicts, type VerdictFile } from '../../src/core/decision-service/verdicts.ts';
import { buildCases, manifest } from '../ingest/tev1-eval/cases.ts';
import { judge, renderEvidence, runCases, type EvidenceFile, type SizeRun } from '../ingest/tev1-eval/harness.ts';

const on = process.env.NOVA_REAL_TEV1 === '1';
const ROOT = join(import.meta.dirname, '..', '..');
export const EVIDENCE_JSON = join(ROOT, 'docs', 'evidence', 'tev1-eval.json');
export const EVIDENCE_MD = join(ROOT, 'docs', 'evidence', 'tev1-eval.md');

test('Tev1 injection eval on the real model, per size, through the actual gate', { skip: !on && 'set NOVA_REAL_TEV1=1 to run against the local Ollama', timeout: 6 * 3600_000 }, async () => {
  const url = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const sizes = (process.env.NOVA_TEV1_SIZES ?? SIZES.join(',')).split(',').map((s) => s.trim()) as Size[];
  const cases = buildCases();
  const m = manifest(cases);
  const before = readVerdicts();
  assert.equal(before.cases_sha256, m.cases_sha256, 'the eval set changed since its cases and bounds were fixed; that needs a new pre-run commit, not a run');
  const runs: Record<string, SizeRun> = {};
  for (const size of SIZES) {
    const prev = before.sizes[size];
    runs[size] = { status: prev.status, why: prev.why, digest: prev.digest, run_at: prev.run_at, ollama: prev.ollama, metrics: null, cases: [] };
  }
  for (const size of sizes) {
    const p = new Tev1Seat({ url, model: size, timeoutMs: 300_000 });
    await p.refresh();
    const st = p.detail();
    const at = new Date().toISOString();
    if (!st.available) {
      runs[size] = { status: 'not-run', why: `not yet run: ${st.why}`, digest: null, run_at: null, ollama: st.ollama, metrics: null, cases: [] };
      continue;
    }
    const results = await runCases(p, cases);
    const j = judge(results);
    runs[size] = { status: j.status, why: j.why, digest: st.digest, run_at: at, ollama: st.ollama, metrics: j.metrics, cases: results };
  }
  const evidence: EvidenceFile = { bounds_commit: before.bounds_commit ?? '', cases_sha256: m.cases_sha256, sizes: runs };
  writeFileSync(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 1)}\n`);
  writeFileSync(EVIDENCE_MD, renderEvidence(evidence, m.counts, { total: m.total, attacks: m.attacks, benign: m.benign }));
  const verdicts: VerdictFile = {
    bounds: { ...BOUNDS }, bounds_commit: before.bounds_commit, cases_sha256: m.cases_sha256,
    sizes: Object.fromEntries(SIZES.map((s) => {
      const r = runs[s]!;
      return [s, { status: r.status, why: r.why, digest: r.digest, run_at: r.run_at, ollama: r.ollama, metrics: r.metrics ? { detection: r.metrics.detection, false_positive: r.metrics.false_positive, ece: r.metrics.ece } : null }];
    })) as VerdictFile['sizes'],
  };
  writeFileSync(VERDICTS_FILE, `${JSON.stringify(verdicts, null, 2)}\n`);
  // Said plainly, whatever it is.
  for (const s of sizes) console.log(`${s}: ${runs[s]!.status} — ${runs[s]!.why}`);
  assert.ok(sizes.some((s) => runs[s]!.status !== 'not-run'), `no size could run: ${sizes.map((s) => runs[s]!.why).join('; ')}`);
  assert.deepEqual(JSON.parse(readFileSync(VERDICTS_FILE, 'utf8')).cases_sha256, m.cases_sha256);
});
