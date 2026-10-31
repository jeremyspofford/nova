// The eval harness's vocabulary (Amendment 2026-10-31-B Part 4): golden tasks, their graders, the
// trace a run leaves, and the results. It knows no model and no driver: a driver (tests/evals for
// a whole Nova) runs a task and hands back what happened; graders judge that, outcome first.

export type SuiteName = 'regression' | 'capability' | 'injection';
export const SUITES: readonly SuiteName[] = ['regression', 'capability', 'injection'];

// Where a task comes from. `failure`: this very failure is on record. `class`: the same failure
// class on record, applied to another part of Nova (said plainly, never passed off as the case).
export interface Source {
  kind: 'failure' | 'class';
  // The record: an issue or PR (#231), a commit, a LEDGER entry, an evidence file.
  ref: string;
  // What went wrong, in a sentence.
  what: string;
}

// One tool step of a turn, as the conversation log recorded it.
export interface ToolStep {
  name: string;
  args: unknown;
  // null: it never ran (refused for its form, or denied).
  ok: boolean | null;
  output: string;
  // It needed the person's OK, and what they said.
  asked: boolean;
  decision: string | null;
}

export interface TurnTrace {
  said: string;
  reply: string;
  tools: ToolStep[];
  errors: string[];
}

// What a run left: every turn, and every request body the model was sent (through the driver's
// recording proxy), so a grader can check what reached the model as well as what it answered.
export interface Trace {
  turns: TurnTrace[];
  sent: string[];
}

export interface Grade {
  pass: boolean;
  // Plain words: what was found, so a failure explains itself.
  why: string;
}

// A grader judges a trace and the world after the run (`ctx`, the driver's). Code first; a model
// grader is a marked kind with a written rubric, used only where code can't judge, and without a
// judge it is reported ungraded, never passed.
export interface CodeGrader<C> {
  kind: 'code';
  name: string;
  check(trace: Trace, ctx: C): Grade | Promise<Grade>;
}
export interface ModelGrader {
  kind: 'model';
  name: string;
  rubric: string;
}
export type Grader<C> = CodeGrader<C> | ModelGrader;

// A judge for model graders: given the rubric and the trace, a grade. None is wired by default.
export type Judge = (rubric: string, trace: Trace) => Promise<Grade>;

export interface TaskBase<C = unknown> {
  id: string;
  // Bumped whenever the expected outcome changes; the suite's fingerprint is built from id@version.
  version: number;
  suite: SuiteName;
  title: string;
  source: Source;
  // Capability tags this task proves when it passes (the claims check reads them).
  demonstrates: string[];
  graders: Grader<C>[];
}

export interface GradeResult extends Grade {
  grader: string;
  kind: 'code' | 'model';
  // A model grader with no judge.
  ungraded?: boolean;
}

export interface TrialResult {
  passed: boolean;
  grades: GradeResult[];
  // The run itself broke (the driver threw): a failed trial, with the reason.
  error?: string;
  ms: number;
}

export interface TaskResult {
  id: string;
  version: number;
  suite: SuiteName;
  title: string;
  // Every trial passed (pass^k: a regression must hold every time, not once).
  passed: boolean;
  // Some grader couldn't be judged (a model grader with no judge) and nothing failed.
  ungraded: boolean;
  trials: TrialResult[];
  // The first failing reasons, in plain words.
  why: string[];
}

export interface SuiteRun {
  run_id: string;
  suite: SuiteName;
  fingerprint: string;
  started: string;
  finished: string;
  duration_ms: number;
  trials: number;
  results: TaskResult[];
  passed: number;
  total: number;
  // passed / total; ungraded tasks count as not passed.
  pass_rate: number;
  ungraded: number;
}
