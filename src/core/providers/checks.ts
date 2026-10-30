// Nova's own checks on a provider's work (M5 plan §1, WORK-LEDGER verification). A provider's word
// that it succeeded is a claim; these read the task's folder themselves.
// - test_result: Nova runs the brief's declared test command itself in the task's folder and keeps
//   a record of the run. The evidence names that record; the checker reads it back, and refuses it
//   if the files changed after the run.
// - file_diff: the checker compares a file in the task's folder with the copy it started from, and
//   the diff must be what the report shows.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { CoreError } from '../errors.ts';
import { runLines, tail } from './cli.ts';
import { TaskSpace, outOfScope, safePath, treeHash, unifiedDiff } from './taskspace.ts';
import type { Brief, Evidence } from '../envelope.ts';
import type { Workspace } from '../workspace.ts';

export const TEST_PREFIX = 'nova-run:';

export interface TestRun { id: string; task_id: string; command: string; passed: boolean; exit: number | null; output: string; ms: number; tree: string; at: string }

export const testCommand = (brief: Brief): string => (typeof brief.inputs?.test_command === 'string' ? brief.inputs.test_command.trim() : '');

// What a test run is handed: a PATH (with the node Nova runs on first, so `node` is a real one), a
// home and a temp folder of its own, and the locale. Nothing else: no keys, no tokens, no settings
// from the person's own environment, because the code it runs may be a provider's.
export function testEnv(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { PATH: [dirname(process.execPath), env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(delimiter), HOME: home, TMPDIR: home };
  for (const k of ['LANG', 'LC_ALL']) { const v = env[k]; if (v) out[k] = v; }
  return out;
}

export class Checks {
  readonly runs: string;
  #ws: Workspace;
  #state: string;

  constructor(ws: Workspace, stateRoot: string) {
    this.#ws = ws;
    this.#state = stateRoot;
    this.runs = join(stateRoot, 'runs');
  }

  space(taskId: string): TaskSpace {
    return new TaskSpace(this.#ws, this.#state, taskId);
  }

  // Runs the test command in the task's folder (through the shell, as a person would type it),
  // and keeps what happened. The provider has finished by now; nothing of it runs alongside. The
  // files the provider wasn't allowed to change are checked against the copy it started from
  // first: a test only proves something if it is the test the brief came with.
  async runTest(space: TaskSpace, command: string, signal: AbortSignal, timeoutS = 300, brief?: Brief): Promise<TestRun> {
    if (brief) {
      const bad = outOfScope(space.changes(), space.scope(brief));
      if (bad) throw new CoreError('forbidden', `Nova didn’t run \`${command}\`: ${bad}.`);
    }
    let output = '';
    const home = mkdtempSync(join(tmpdir(), 'nova-test-home-'));
    let ran;
    try {
      ran = await runLines({ argv: [`(${command}) 2>&1`], shell: true, cwd: space.root, env: testEnv(home), signal, timeoutMs: timeoutS * 1000, onLine: (l) => { output = (output + l + '\n').slice(-16_000); } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const run: TestRun = {
      id: randomUUID(), task_id: space.id, command, passed: ran.code === 0 && !ran.timedOut && !ran.aborted, exit: ran.code,
      output: ran.timedOut ? `${tail(output)}\n(stopped after ${timeoutS} s)` : tail(output, 40, 4000), ms: Math.round(ran.ms), tree: treeHash(space.root), at: new Date().toISOString(),
    };
    mkdirSync(this.runs, { recursive: true });
    writeFileSync(join(this.runs, `${run.id}.json`), JSON.stringify(run));
    return run;
  }

  #run(id: string): TestRun | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    const f = join(this.runs, `${id}.json`);
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as TestRun) : null;
  }

  checkTest(e: Evidence, brief: Brief): { ok: boolean; why: string } {
    if (e.kind !== 'test_result') return { ok: false, why: 'Not a test result.' };
    const run = this.#run(e.name.slice(TEST_PREFIX.length));
    if (!run) return { ok: false, why: `Nova has no record of running "${e.name}"; a provider can’t vouch for its own tests.` };
    if (run.task_id !== brief.task_id) return { ok: false, why: 'That test run was for other work.' };
    const want = testCommand(brief);
    if (run.command !== want) return { ok: false, why: `That run was \`${run.command}\`, not the brief’s \`${want}\`.` };
    const last = run.output.trim().split('\n').slice(-3).join(' / ');
    if (!run.passed) return { ok: false, why: `Nova ran \`${run.command}\` itself in the task’s folder and it failed (exit ${run.exit ?? 'none'})${last ? `: ${last}` : ''}.` };
    if (e.passed !== true) return { ok: false, why: 'The report says the test failed.' };
    const space = this.space(brief.task_id);
    if (!space.exists()) return { ok: false, why: 'The task’s folder is gone, so Nova can’t tell the files are the ones it tested.' };
    if (treeHash(space.root) !== run.tree) return { ok: false, why: `The files in the task’s folder changed after Nova ran \`${run.command}\`, so that run no longer proves anything.` };
    const bad = this.#outside(space, brief);
    if (bad) return { ok: false, why: `${bad.charAt(0).toUpperCase()}${bad.slice(1)}, so the test run proves nothing.` };
    return { ok: true, why: `Nova ran \`${run.command}\` itself in the task’s folder: it passed (exit 0, ${(run.ms / 1000).toFixed(1)} s).` };
  }

  // A change the provider wasn't allowed to make, in words, or null. An unreadable editable list
  // counts as one: nothing the provider did can be judged against it.
  #outside(space: TaskSpace, brief: Brief): string | null {
    try { return outOfScope(space.changes(), space.scope(brief)); } catch (e) { return (e as Error).message; }
  }

  checkDiff(e: Evidence, brief: Brief): { ok: boolean; why: string } {
    if (e.kind !== 'file_diff') return { ok: false, why: 'Not a file diff.' };
    const space = this.space(brief.task_id);
    if (!space.exists()) return { ok: false, why: 'Nova checks a file diff in the task’s own folder, and this task has none.' };
    const bad = this.#outside(space, brief);
    if (bad) return { ok: false, why: `${bad.charAt(0).toUpperCase()}${bad.slice(1)}.` };
    // The path is read in the task's own folder, where the provider worked.
    let rel: string;
    try { rel = safePath(space.root, e.target.replace(/^workspace:/, '')).rel; } catch (err) { return { ok: false, why: (err as Error).message }; }
    const actual = unifiedDiff(rel, space.readBaseline(rel), space.read(rel));
    if (!actual) return { ok: false, why: `Nova compared ${rel} in the task’s folder with the copy it started from: nothing changed.` };
    if (actual !== e.diff) return { ok: false, why: `Nova compared ${rel} in the task’s folder with the copy it started from, and the change isn’t the one the report shows.` };
    const lines = actual.split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    return { ok: true, why: `Nova compared ${rel} in the task’s folder with the copy it started from: ${added} line${added === 1 ? '' : 's'} added, ${removed} removed, as reported.` };
  }
}
