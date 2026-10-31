// Running suites against a target, and keeping the scorecard: shared by the CLI (cli.ts), the CI
// gate (tests/acceptance/evals-regression.test.ts) and the opt-in real-model run.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, evals } from '../../src/core/index.ts';
import { drive, type GoldenTask, type TargetSpec, type World } from './driver.ts';
import { CAPABILITY, REGRESSION } from './tasks/index.ts';

const ROOT = join(import.meta.dirname, '..', '..');

export function novaBuild(): { version: string; commit: string | null } {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  let commit: string | null = null;
  try { commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* not a checkout */ }
  return { version, commit };
}

// The digest the runtime reports for a model (Ollama's /api/tags), or null.
export async function digestOf(upstream: string, model: string): Promise<string | null> {
  try {
    const r = await fetch(`${upstream.replace(/\/v1\/?$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { models?: { name: string; digest?: string }[] };
    return j.models?.find((m) => m.name === model)?.digest ?? null;
  } catch {
    return null;
  }
}

export interface RunGoldenOptions {
  suite: 'regression' | 'capability';
  target: TargetSpec;
  trials?: number;
  only?: string[];
  tasks?: GoldenTask[];
  log?: (s: string) => void;
  turnTimeoutMs?: number;
}

export async function runGolden(o: RunGoldenOptions): Promise<evals.SuiteRun> {
  const all = o.tasks ?? (o.suite === 'regression' ? REGRESSION : CAPABILITY);
  const tasks = o.only?.length ? all.filter((t) => o.only!.includes(t.id)) : all;
  return evals.runSuite<GoldenTask, World>(tasks, {
    suite: o.suite,
    trials: o.trials ?? 1,
    drive: (task) => drive(task, o.target, { ...(o.log ? { log: o.log } : {}), ...(o.turnTimeoutMs ? { turnTimeoutMs: o.turnTimeoutMs } : {}) }),
    onResult: (r) => o.log?.(`${r.passed ? 'PASS' : r.ungraded ? 'UNGRADED' : 'FAIL'} ${r.id}${r.passed ? '' : `: ${r.why.join(' | ')}`}`),
  });
}

// The INJECTION suite through the actual ingest battery: a core of its own in a temp home, with no
// screening model (the deterministic layer alone) unless one is named on a local Ollama.
export async function runInjection(o: { paths?: string[]; screenModel?: { upstream: string; model: string } | null; log?: (s: string) => void } = {}): Promise<evals.SuiteRun> {
  const cases = evals.loadInjectionSet(o.paths);
  const tasks = evals.injectionTasks(cases);
  const home = mkdtempSync(join(tmpdir(), 'nova-eval-injection-'));
  const core = createCore({ home, version: novaBuild().version, trustedOrigin: () => true, ...(o.screenModel ? { models: { ollamaUrl: o.screenModel.upstream } } : {}) });
  try {
    core.profile.set('privacy', 'default', 'local-only', 'settings');
    if (o.screenModel) await core.models.assign('triage-text', { model: o.screenModel.model });
    const model = !!o.screenModel;
    return await evals.runSuite<evals.InjectionTask, evals.Screening>(tasks, {
      suite: 'injection',
      drive: async (task) => {
        const c = task.case;
        const r = await core.ingest.screen({ ...(c.text !== undefined ? { text: c.text } : {}), ...(c.html !== undefined ? { html: c.html } : {}), ...(c.headers ? { headers: c.headers } : {}), ...(c.attachments ? { attachments: c.attachments } : {}), source: c.source as never });
        return { trace: { turns: [], sent: [] }, ctx: { verdict: r.verdict, max: r.max, flags: r.flags.filter((f: { level: string }) => f.level !== 'note').map((f: { kind: string }) => f.kind), model } };
      },
      onResult: (r) => o.log?.(`${r.passed ? 'PASS' : 'FAIL'} ${r.id}${r.passed ? '' : `: ${r.why.join(' | ')}`}`),
    });
  } finally {
    await core.close();
  }
}

// Keeps a run on the target's scorecard in a Nova home, and says whether the regression dropped.
export function keep(home: string, target: evals.Target, run: evals.SuiteRun, endpoint: string | null) {
  const store = new evals.Scorecards(home);
  const before = store.get(target.provider, target.model)?.suites[run.suite] ?? null;
  const card = store.record(target, run, { nova: novaBuild(), endpoint });
  // A drop is judged only against a card from the same tasks: another fingerprint isn't comparable.
  const comparable = before && before.fingerprint === run.fingerprint ? before : null;
  const verdict = run.suite === 'regression' ? evals.regressionVerdict(run, comparable) : null;
  if (verdict && before && !comparable) verdict.words += ' The previous card was for other tasks (the suite changed since), so no drop is judged.';
  return { card, before, verdict };
}
