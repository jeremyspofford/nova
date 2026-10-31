// The eval runner (scripts/evals.sh runs this with a temp folder of its own).
//
//   sh scripts/evals.sh [--suite regression|capability|injection|all] [--model <name>] [--upstream <url>]
//                       [--stand-in grounded|priors] [--trials N] [--only <id,id>] [--home <Nova home>]
//                       [--fail-on-drop] [--json <file>] [--screen-model <name>]
//
// With no --model, the stand-ins play the model (as in CI: no model is called). With --model, the
// model on the local Ollama (--upstream, default http://127.0.0.1:11434) plays it, through the
// provider registry's openai-compatible provider: loopback only, never a cloud model. --home writes
// the run to that Nova home's scorecard (workers/evals/), which Settings › Models reads; without
// it nothing is kept. Exit 1: a regression task failed with stand-ins, or (--fail-on-drop) a real
// model's regression dropped from its previous scorecard.
import { writeFileSync } from 'node:fs';
import { evals } from '../../src/core/index.ts';
import { assertLocal, type TargetSpec } from './driver.ts';
import { digestOf, keep, runGolden, runInjection } from './run.ts';

function args(argv: string[]) {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Unexpected ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[a.slice(2)] = true;
    else { o[a.slice(2)] = next; i++; }
  }
  return o;
}

const a = args(process.argv.slice(2));
const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
const suites = (str('suite') ?? 'regression') === 'all' ? ['regression', 'capability', 'injection'] : [str('suite') ?? 'regression'];
const model = str('model');
const upstream = str('upstream') ?? 'http://127.0.0.1:11434';
const persona = (str('stand-in') ?? 'grounded') as 'grounded' | 'priors';
const target: TargetSpec = model
  ? { provider: 'openai-compatible', model, upstream }
  : { provider: 'openai-compatible', model: `stand-in-${persona}`, standIn: persona === 'grounded' ? {} : { persona } };
if (model) assertLocal(upstream);
const log = (s: string) => console.log(s);
const runs: evals.SuiteRun[] = [];
let exit = 0;
const digest = model ? await digestOf(upstream, model) : null;
log(`Target: ${target.provider} · ${target.model}${digest ? ` · ${digest.slice(0, 19)}` : ''}${model ? ` at ${upstream}` : ' (stand-in, no model called)'}`);

for (const suite of suites) {
  log(`\n== ${suite.toUpperCase()} ==`);
  let run: evals.SuiteRun;
  if (suite === 'injection') {
    const sm = str('screen-model');
    run = await runInjection({ screenModel: sm ? { upstream, model: sm } : null, log });
  } else if (suite === 'regression' || suite === 'capability') {
    const only = str('only')?.split(',').map((s) => s.trim()).filter(Boolean);
    run = await runGolden({ suite, target, trials: Number(str('trials') ?? 1), ...(only ? { only } : {}), log });
  } else throw new Error(`No suite called ${suite}.`);
  runs.push(run);
  log(`${suite}: ${run.passed} of ${run.total} passed (${Math.round(run.pass_rate * 100)}%), ${run.ungraded} ungraded, fingerprint ${run.fingerprint}, ${Math.round(run.duration_ms / 1000)} s.`);
  if (suite === 'regression' && !model && run.passed < run.total) exit = 1;
  const home = str('home');
  if (home) {
    const t: evals.Target = { provider: target.provider, model: target.model, digest, where: 'local' };
    const k = keep(home, t, run, model ? upstream : null);
    log(`Scorecard kept in ${home}/${evals.SCORECARD_DIR}.${k.verdict ? ` ${k.verdict.words}` : ''}`);
    if (k.verdict?.drop && a['fail-on-drop']) exit = 1;
  } else if (suite === 'regression') {
    log(evals.regressionVerdict(run, null).words);
  }
}
const json = str('json');
if (json) writeFileSync(json, JSON.stringify({ target: { ...target, digest }, runs }, null, 2));
process.exit(exit);
