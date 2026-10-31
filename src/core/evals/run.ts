// Running a suite: each task through the driver (which boots whatever it needs and hands back the
// trace and the world after it), every grader on it, k trials. A task passes only when every trial
// passes. The suite's fingerprint (its tasks by id@version) says which suite a score is for.
import { createHash, randomUUID } from 'node:crypto';
import type { GradeResult, Judge, SuiteName, SuiteRun, TaskBase, TaskResult, Trace, TrialResult } from './types.ts';

export interface Driven<C> {
  trace: Trace;
  ctx: C;
  // Ends what the driver started (a Nova, stand-ins); called after grading, also on failure.
  close?: () => Promise<void> | void;
}

export interface RunOptions<T extends TaskBase<C>, C> {
  suite: SuiteName;
  drive: (task: T, trial: number) => Promise<Driven<C>>;
  trials?: number;
  judge?: Judge;
  // Called after each task, for progress output.
  onResult?: (r: TaskResult) => void;
  now?: () => Date;
}

export function fingerprintOf(entries: readonly string[]): string {
  return `sha256:${createHash('sha256').update([...entries].sort().join('\n')).digest('hex').slice(0, 16)}`;
}

// A suite's manifest: its tasks as id@version, sorted.
export const manifestOf = (tasks: readonly Pick<TaskBase, 'id' | 'version'>[]) => tasks.map((t) => `${t.id}@${t.version}`).sort();

async function trial<T extends TaskBase<C>, C>(task: T, n: number, o: RunOptions<T, C>): Promise<TrialResult> {
  const t0 = performance.now();
  let driven: Driven<C> | null = null;
  try {
    driven = await o.drive(task, n);
    const grades: GradeResult[] = [];
    for (const g of task.graders) {
      if (g.kind === 'model') {
        if (!o.judge) { grades.push({ grader: g.name, kind: 'model', pass: false, ungraded: true, why: 'a model grader with no judge: ungraded' }); continue; }
        const r = await o.judge(g.rubric, driven.trace);
        grades.push({ grader: g.name, kind: 'model', ...r });
        continue;
      }
      try {
        grades.push({ grader: g.name, kind: 'code', ...(await g.check(driven.trace, driven.ctx)) });
      } catch (e) {
        grades.push({ grader: g.name, kind: 'code', pass: false, why: `the grader threw: ${(e as Error).message}` });
      }
    }
    return { passed: grades.every((g) => g.pass), grades, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { passed: false, grades: [], error: (e as Error).message || String(e), ms: Math.round(performance.now() - t0) };
  } finally {
    try { await driven?.close?.(); } catch { /* the trial's result stands */ }
  }
}

export async function runSuite<T extends TaskBase<C>, C>(tasks: readonly T[], o: RunOptions<T, C>): Promise<SuiteRun> {
  const now = o.now ?? (() => new Date());
  const started = now();
  const t0 = performance.now();
  const k = Math.max(1, Math.floor(o.trials ?? 1));
  const mine = tasks.filter((t) => t.suite === o.suite);
  const results: TaskResult[] = [];
  for (const task of mine) {
    const trials: TrialResult[] = [];
    for (let i = 0; i < k; i++) trials.push(await trial(task, i, o));
    const failing = trials.flatMap((tr) => (tr.error ? [`the run broke: ${tr.error}`] : tr.grades.filter((g) => !g.pass && !g.ungraded).map((g) => `${g.grader}: ${g.why}`)));
    const ungraded = !failing.length && trials.some((tr) => tr.grades.some((g) => g.ungraded));
    const r: TaskResult = { id: task.id, version: task.version, suite: task.suite, title: task.title, passed: trials.every((tr) => tr.passed), ungraded, trials, why: [...new Set(failing)].slice(0, 5) };
    results.push(r);
    o.onResult?.(r);
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    run_id: randomUUID(), suite: o.suite, fingerprint: fingerprintOf(manifestOf(mine)),
    started: started.toISOString(), finished: now().toISOString(), duration_ms: Math.round(performance.now() - t0), trials: k,
    results, passed, total: results.length, pass_rate: results.length ? passed / results.length : 0, ungraded: results.filter((r) => r.ungraded).length,
  };
}

// The regression rule. With stand-ins (CI) the bar is every task; for a real model, a drop from its
// previous card is reported plainly, and fails when asked to.
export function regressionVerdict(run: Pick<SuiteRun, 'passed' | 'total' | 'pass_rate' | 'results'>, previous?: { pass_rate: number; failed?: { id: string }[] } | null) {
  const failed = run.results.filter((r) => !r.passed).map((r) => r.id);
  const newly = previous ? failed.filter((id) => !(previous.failed ?? []).some((f) => f.id === id)) : failed;
  const drop = previous ? run.pass_rate < previous.pass_rate || newly.length > 0 : false;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const words = !previous
    ? `${run.passed} of ${run.total} regression tasks pass (${pct(run.pass_rate)}); no earlier scorecard to compare with.`
    : drop
      ? `A drop: ${run.passed} of ${run.total} pass (${pct(run.pass_rate)}), was ${pct(previous.pass_rate)}${newly.length ? `; newly failing: ${newly.join(', ')}` : ''}.`
      : `No drop: ${run.passed} of ${run.total} pass (${pct(run.pass_rate)}), was ${pct(previous.pass_rate)}.`;
  return { all: failed.length === 0, drop, newly, words };
}
