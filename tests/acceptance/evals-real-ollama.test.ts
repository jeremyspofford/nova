// A local model's scorecard (not CI): the regression and capability suites with a model on this
// machine's Ollama as the chat model, through the provider registry's openai-compatible provider.
// Free and local; skipped unless NOVA_REAL_OLLAMA=1. Model: NOVA_REAL_MODEL (default gemma4:12b), at
// NOVA_REAL_OLLAMA_URL (default http://127.0.0.1:11434). Never a cloud model, never a pull.
// The scorecard is kept in a temp home (or NOVA_EVALS_HOME, a Nova home of your choice) and
// NOVA_EVALS_REAL_EVIDENCE=<file> writes the run as Markdown. It asserts only that the run finished
// and was kept: how well the model does is the scorecard's to say, not a pass/fail here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evals } from '../../src/core/index.ts';
import { assertLocal, type TargetSpec } from '../evals/driver.ts';
import { digestOf, keep, runGolden } from '../evals/run.ts';

const on = process.env.NOVA_REAL_OLLAMA === '1';

test('a local model’s scorecard: regression and capability suites, kept', { skip: !on && 'set NOVA_REAL_OLLAMA=1 to run against the local Ollama', timeout: 4 * 3_600_000 }, async () => {
  const model = process.env.NOVA_REAL_MODEL ?? 'gemma4:12b';
  const upstream = process.env.NOVA_REAL_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  assertLocal(upstream);
  const digest = await digestOf(upstream, model);
  assert.ok(digest, `${model} isn’t installed on ${upstream} (this test never pulls a model)`);
  const target: TargetSpec = { provider: 'openai-compatible', model, upstream };
  const home = process.env.NOVA_EVALS_HOME ?? mkdtempSync(join(tmpdir(), 'nova-eval-real-'));
  const trials = Number(process.env.NOVA_EVALS_TRIALS ?? 1);
  const out: string[] = [`### ${model} (${digest!.slice(0, 19)}…), ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const suite of ['regression', 'capability'] as const) {
    const run = await runGolden({ suite, target, trials, log: (s) => console.log(s) });
    const k = keep(home, { provider: target.provider, model, digest, where: 'local' }, run, upstream);
    out.push(`**${suite}:** ${run.passed} of ${run.total} (${Math.round(run.pass_rate * 100)}%), ${trials} trial(s), ${Math.round(run.duration_ms / 1000)} s, fingerprint \`${run.fingerprint}\`, Nova ${k.card.suites[suite]!.nova.commit ?? '?'}.`, '');
    out.push('| task | result | why (first failing grader) |', '|---|---|---|', ...run.results.map((r) => `| \`${r.id}\` | ${r.passed ? 'pass' : 'fail'} | ${r.passed ? '' : (r.why[0] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} |`), '');
    assert.equal(run.total, suite === 'regression' ? evals.REGRESSION_MANIFEST.length : run.total);
  }
  const status = new evals.Scorecards(home).status({ provider: target.provider, model, digest }, evals.REGRESSION_FINGERPRINT);
  out.push(`Settings › Models would say: “${status.words}”`, '');
  console.log(out.join('\n'));
  if (process.env.NOVA_EVALS_REAL_EVIDENCE) writeFileSync(process.env.NOVA_EVALS_REAL_EVIDENCE, out.join('\n'));
  assert.equal(status.state, 'current');
});
