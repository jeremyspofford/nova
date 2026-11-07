// The Interstitial Research templates' eval against the REAL local model (Part 3 of the packet,
// docs/builder-packet/interstitial-research/). Not CI: skipped unless NOVA_REAL_INTERSTITIAL=1.
// Needs NOVA_PRE_RUN_COMMIT (the commit that fixed the eval and its bounds) and
// NOVA_TEMPLATE_COMMIT (the commit that fixed the templates and their rules). Runs every case once
// per Tev1 size (NOVA_TEV1_SIZES, default tev1:4b) against the Ollama at NOVA_REAL_OLLAMA_URL
// (default http://127.0.0.1:11434; only an address on this machine), and writes, from the results
// alone:
//   docs/evidence/interstitial-eval.json   per-case results per size (ids and scores only);
//   docs/evidence/interstitial-eval.md     the evidence page;
//   src/core/decision-service/verdicts-interstitial.json  the verdicts (CI recomputes them).
// Local seat only: the cloud seat is never asked here. Synthetic content only. Nothing is tuned
// after the results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Tev1Seat, modelId, type Size } from '../../src/core/decision-service/seats/tev1.ts';
import { BOUNDS_IR, IR_TEMPLATES, scoreIR, verdictIR } from '../../src/core/decision-service/eval-interstitial.ts';
import { INTERSTITIAL_RECORDS_FILE, type RecordsFile, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { wordingOf } from '../../src/core/decision-service/registry.ts';
import { OC_QUESTIONS, OUTBOUND_CHECK_V1, VERIFY_TRANSFER_V1, VT_QUESTIONS } from '../../src/core/decision-service/templates/interstitial.ts';
import { buildCases, manifest } from '../ingest/interstitial-eval/cases.ts';
import { runIR } from '../ingest/interstitial-eval/harness.ts';
import { render, type IrEvidence, type IrSize } from '../ingest/interstitial-eval/render.ts';

const on = process.env.NOVA_REAL_INTERSTITIAL === '1';
const ROOT = join(import.meta.dirname, '..', '..');
export const EVIDENCE_JSON = join(ROOT, 'docs', 'evidence', 'interstitial-eval.json');
export const EVIDENCE_MD = join(ROOT, 'docs', 'evidence', 'interstitial-eval.md');
const Q = { 'interstitial.verify-transfer': VT_QUESTIONS, 'interstitial.outbound-check': OC_QUESTIONS } as const;

test('Interstitial Research templates: eval on the real local model, per size', { skip: !on && 'set NOVA_REAL_INTERSTITIAL=1 to run against the local Ollama', timeout: 6 * 3600_000 }, async () => {
  const pre = process.env.NOVA_PRE_RUN_COMMIT ?? '';
  const tpl = process.env.NOVA_TEMPLATE_COMMIT ?? '';
  assert.match(pre, /^[0-9a-f]{40}$/, 'NOVA_PRE_RUN_COMMIT');
  assert.match(tpl, /^[0-9a-f]{40}$/, 'NOVA_TEMPLATE_COMMIT');
  const url = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  assert.match(new URL(url).hostname, /^(127\.0\.0\.1|localhost|\[::1\])$/, 'only a model on this machine');
  const sizes = (process.env.NOVA_TEV1_SIZES ?? 'tev1:4b').split(',').map((s) => s.trim()) as Size[];
  const cases = buildCases();
  const m = manifest(cases);
  const wording = { [VERIFY_TRANSFER_V1.template_id]: wordingOf(VERIFY_TRANSFER_V1), [OUTBOUND_CHECK_V1.template_id]: wordingOf(OUTBOUND_CHECK_V1) };
  const results: Record<string, IrSize> = {};
  const records: VerdictRecord[] = [];
  for (const size of sizes) {
    const seat = new Tev1Seat({ url, model: size, timeoutMs: 300_000 });
    await seat.refresh();
    const d = seat.detail();
    if (!d.available || !d.digest) { results[size] = { status: 'not-run', why: d.why, digest: null, ollama: d.ollama, run_at: null, templates: {}, cases: [] }; continue; }
    const at = new Date().toISOString();
    const runs = await runIR(seat, cases);
    const templates: IrSize['templates'] = {};
    for (const t of IR_TEMPLATES) {
      const metrics = scoreIR(runs, t, Q[t]);
      const v = verdictIR(metrics);
      const why = v.pass ? 'all bounds met' : v.failed.join('; ');
      templates[t] = { status: v.pass ? 'pass' : 'fail', why, metrics };
      records.push({ template_id: t, version: 1, seat: 'tev1', model: modelId(size, d.digest), status: v.pass ? 'pass' : 'fail', why, run_at: at, ref: `interstitial-eval.json#${size}@${pre}`, wording_sha256: wording[t]! });
    }
    results[size] = { status: 'ran', why: '', digest: d.digest, ollama: d.ollama, run_at: at, templates, cases: runs };
  }
  const evidence: IrEvidence = { templates: [...IR_TEMPLATES], version: 1, template_commit: tpl, pre_run_commit: pre, cases_sha256: m.cases_sha256, wording, sizes: results };
  writeFileSync(EVIDENCE_JSON, `${JSON.stringify(evidence, null, 1)}\n`);
  writeFileSync(EVIDENCE_MD, render(evidence, m));
  const file: RecordsFile = { bounds: { ...BOUNDS_IR }, pre_run_commit: pre, cases_sha256: m.cases_sha256, records };
  writeFileSync(INTERSTITIAL_RECORDS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  for (const r of records) console.log(`${r.model} ${r.template_id}: ${r.status}: ${r.why}`);
  assert.ok(records.length > 0, `no size could run: ${sizes.map((s) => results[s]!.why).join('; ')}`);
});
