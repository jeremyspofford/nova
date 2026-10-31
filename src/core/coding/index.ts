// Coding through chat (M10c, docs/plans/M10c.md). A coding request becomes a coding run: a plan
// carried by a chain of Work Ledger tasks for the `coding` worker, each made only once the one before
// is verified done:
//
//   write (tier 1: Nova's own worktree; undo removes it) → check (tier 2: runs the agent's code, as
//   the person: the tests, then the preview) → merge (tier 3, every time: the person's branch)
//
// and, when the person's branch moved after the review, update → check → merge again. Nothing is
// written to the person's repository before the merge, and nothing is ever pushed. Built on what
// exists: the ledger's tiers, privacy gate and recovery; the provider registry's adapters and gates
// (Providers.workIn); the task folder's rules on what an agent may change (taskspace.ts); the test
// runner's environment (checks.ts); children.ts for every process.
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, PRIVACY_MODES, type Brief, type Evidence, type PrivacyMode, type Report, type Tier } from '../envelope.ts';
import { sha256 } from '../workspace.ts';
import { checkFolder } from '../computer/policy.ts';
import { runLines, tail } from '../providers/cli.ts';
import { testEnv } from '../providers/checks.ts';
import { editableList, outOfScope, scopeOf } from '../providers/taskspace.ts';
import { Git, OID, checkBranch } from './git.ts';
import { applyChanges, changes as changesOf, copyWalk, digest, refusals, walk, type Change } from './tree.ts';
import { alive, freePort, startPreview, stopPreview } from './preview.ts';
import type { ChildProcess } from 'node:child_process';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Ledger, LanedWorker, Task, TaskInput } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { Providers } from '../providers/registry.ts';
import type { Usage } from '../providers/types.ts';
import type { Egress } from '../workers.ts';

export const CODING_WORKER = 'coding';
export const CONFIRMATION_SYSTEM = 'nova-coding';
export const TEST_PREFIX = 'nova-coding-run:';
export const STEPS = ['write', 'update', 'check', 'merge'] as const;
export type Step = (typeof STEPS)[number];
export const RUN_STATES = ['writing', 'checking', 'review', 'merging', 'moved', 'merged', 'declined', 'failed', 'conflict', 'cancelled', 'discarded'] as const;
export type RunState = (typeof RUN_STATES)[number];
const ENDED: readonly RunState[] = ['merged', 'declined', 'failed', 'conflict', 'cancelled', 'discarded'];
const TIER: Record<Step, Tier> = { write: 1, update: 1, check: 2, merge: 3 };
// The reviewed diff as shown, at most (the record keeps the whole list of files).
const MAX_DIFF = 512 * 1024;
const MAX_GOAL = 4000;
const MAX_COMMAND = 1000;

interface RunRow {
  id: string; title: string; goal: string; repo: string; branch: string; agent: string; test_command: string; preview_command: string | null;
  editable: string | null; privacy_mode: PrivacyMode; session_id: string | null; state: RunState; reason: string | null; round: number;
  base: string | null; head: string | null; tree_digest: string | null; changes: string | null; diff: string | null; test: string | null; preview: string | null;
  tasks: string; created_at: string; updated_at: string;
}
export interface FileChange { path: string; kind: Change['kind']; added: number | null; removed: number | null }
export interface TestRecord { id: string; task_id: string; run_id: string; round: number; command: string; commit: string; passed: boolean; exit: number | null; output: string; ms: number; at: string }
export interface PreviewRecord { run_id: string; round: number; task_id: string; command: string; commit: string; url: string; port: number; pid: number; status: number; loopback: 'yes' | 'unchecked'; started_at: string; stopped_at: string | null; why_stopped: string | null }
interface TaskRef { step: Step; round: number; id: string }
type More = Omit<Partial<Report>, 'usage'> & { usage?: Usage };
type Reporter = (status: Report['status'], summary: string, more?: More) => Report;

export interface StartInput { repo?: unknown; branch?: unknown; goal?: unknown; test_command?: unknown; preview_command?: unknown; agent?: unknown; editable?: unknown; privacy_mode?: unknown; title?: unknown }

export interface CodingOptions {
  db: Db; log: Log; home: string; ledger: Ledger; verifier: Verifier; providers: Providers;
  privacy: () => PrivacyMode;
  // Whose home folder a repository may never be (os.homedir() unless a test says).
  userHome?: string;
  // Telling the person (the trigger engine's proactive message): a run is ready for review, failed,
  // or merged.
  notify?: (key: string, text: string) => void;
  // Seconds: the test run and the preview's start (tests shorten them).
  testTimeoutS?: number;
  previewTimeoutS?: number;
  now?: () => Date;
}

const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : '');
const clip = (s: string, n = 80) => { const t = s.trim().replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const parse = <T>(s: string | null): T | null => (s ? JSON.parse(s) as T : null);

export class Coding {
  readonly worker: LanedWorker;
  readonly dir: string;
  #o: CodingOptions;
  #git: Git;
  #now: () => Date;
  #key = Symbol('coding');
  #previews = new Map<string, ChildProcess>();
  // One thing at a time in each of Nova's repositories (a fetch, a worktree made or removed): two
  // runs on one repository would otherwise race for its refs.
  #queues = new Map<string, Promise<unknown>>();

  constructor(o: CodingOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.dir = join(o.home, 'workers', 'coding');
    this.#git = new Git({ home: join(this.dir, 'git-home') });
    const self = this;
    this.worker = {
      id: CODING_WORKER,
      name: 'Coding',
      about: 'Makes a code change you asked for in chat: a coding agent writes it in a git worktree of Nova’s own, Nova runs the tests and a preview (asking first), and merges into your branch only when you confirm. It never pushes.',
      // The most it could reach: the coding agent's; each step's own reach is its brief's.
      egress: 'remote',
      evidence: ['confirmation', 'test_result'],
      timeoutMs: 4 * 3600_000,
      lane: (brief: Brief) => ({ key: `run:${String(brief.inputs?.run_id ?? '')}`, max: 1 }),
      egressFor: (brief: Brief): Egress => {
        const step = brief.inputs?.step;
        if (step !== 'write') return 'none';
        try { return self.#o.providers.where(String(brief.inputs?.agent ?? '')).coarse; } catch { return 'remote'; }
      },
      minTier: (input: Pick<TaskInput, 'inputs' | 'evidence_required'>): Tier => TIER[input.inputs?.step as Step] ?? 3,
      // Running the agent's code (check) and moving the person's branch (merge) may already have
      // happened by the time a step stops: neither runs again by itself. A merge marks its point.
      effects: (brief: Brief) => (brief.inputs?.step === 'check' || brief.inputs?.step === 'merge' ? 'external' : 'none'),
      commits: (brief: Brief) => brief.inputs?.step === 'merge',
      internal: { key: this.#key, why: 'Only Nova’s coding runs make their own tasks. Ask for a change in chat, or start one with POST /coding.' },
      health: () => ({ ok: true }),
      run: (brief: Brief, signal: AbortSignal) => self.#run(brief, signal),
    };
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => this.#confirm(e, brief));
    o.verifier.registerTest(TEST_PREFIX, (e, brief) => this.#checkTest(e, brief));
    o.ledger.on('task', (t: Task) => {
      if (t.owner !== CODING_WORKER) return;
      try { this.#advance(t); } catch (e) { o.log.problem('coding', `Nova couldn’t take a coding run to its next step: ${(e as Error).message}`, { detail: (e as Error).stack, taskId: t.id }); }
    });
  }

  // ---- starting a run ---------------------------------------------------------------------------

  // A coding request, checked, as a run and its first task (write, tier 1). Throws in plain words.
  async start(input: StartInput, o: { session?: string | null; origin?: TaskInput['origin'] } = {}): Promise<{ run: ReturnType<Coding['view']>; task: Task }> {
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (!goal) throw new CoreError('validation', 'goal says what the change should do, in plain words.');
    if (goal.length > MAX_GOAL) throw new CoreError('validation', `goal is at most ${MAX_GOAL} characters.`);
    const test = typeof input.test_command === 'string' ? input.test_command.trim() : '';
    if (!test) throw new CoreError('validation', 'test_command is the command that runs the project’s tests, like npm test. Nova never asks you to merge a change it hasn’t tested.');
    if (test.length > MAX_COMMAND || test.includes('\0')) throw new CoreError('validation', `test_command is one command, at most ${MAX_COMMAND} characters.`);
    const preview = typeof input.preview_command === 'string' && input.preview_command.trim() ? input.preview_command.trim() : null;
    if (preview && (preview.length > MAX_COMMAND || preview.includes('\0'))) throw new CoreError('validation', `preview_command is one command, at most ${MAX_COMMAND} characters.`);
    if (input.preview_command !== undefined && input.preview_command !== null && typeof input.preview_command !== 'string') throw new CoreError('validation', 'preview_command is a command, like npm start.');
    const editable = editableList(input.editable);
    const privacy = input.privacy_mode === undefined ? this.#o.privacy() : input.privacy_mode;
    if (!PRIVACY_MODES.includes(privacy as PrivacyMode)) throw new CoreError('validation', `privacy_mode is one of ${PRIVACY_MODES.join(', ')}.`);
    const { repo, branch } = await this.#source(input.repo, input.branch);
    const agent = this.#agent(input.agent);
    const id = `r${randomBytes(5).toString('hex')}`;
    const at = this.#now().toISOString();
    const title = typeof input.title === 'string' && input.title.trim() ? clip(input.title, 80) : clip(goal.split('\n')[0]!, 80);
    this.#o.db.run(
      `INSERT INTO coding_run (id, title, goal, repo, branch, agent, test_command, preview_command, editable, privacy_mode, session_id, state, reason, round, tasks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'writing', NULL, 1, '[]', ?, ?)`,
      id, title, goal, repo, branch, agent, test, preview, editable ? JSON.stringify(editable) : null, privacy as PrivacyMode, o.session ?? null, at, at,
    );
    let task: Task;
    try {
      task = this.#make(this.#row(id), 'write', 1, o.origin ?? { kind: 'user' });
    } catch (e) {
      this.#o.db.run('DELETE FROM coding_run WHERE id = ?', id);
      throw e;
    }
    return { run: this.view(id), task };
  }

  // The person's repository: a folder that may be a project's (checkFolder: not their home, not
  // hidden, not Nova's, not the system's), the top of a git repository, and the branch, which must
  // exist. Read with Nova's git, which writes nothing there.
  async #source(repoIn: unknown, branchIn: unknown): Promise<{ repo: string; branch: string }> {
    if (typeof repoIn !== 'string' || !repoIn.trim()) throw new CoreError('validation', 'repo is the full path to the repository’s folder.');
    const repo = checkFolder(repoIn.trim(), { home: this.#o.home, userHome: this.#o.userHome ?? homedir() });
    const probe = await this.#git.run(['-C', repo, 'rev-parse', '--is-bare-repository', '--absolute-git-dir'], { allow: [128] });
    if (probe.code !== 0) throw new CoreError('validation', `${repo} isn’t a git repository.`);
    const [bare, gitDir] = probe.out.trim().split('\n');
    if (bare === 'true') {
      if (gitDir !== repo) throw new CoreError('validation', `${repo} is inside a git repository (${gitDir}); name the repository’s own folder.`);
    } else {
      const top = (await this.#git.run(['-C', repo, 'rev-parse', '--show-toplevel'])).out.trim();
      if (top !== repo) throw new CoreError('validation', `${repo} is inside the repository at ${top}; name the repository’s own folder.`);
    }
    let branch: string;
    if (branchIn === undefined || branchIn === null || branchIn === '') {
      const head = await this.#git.run(['-C', repo, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { allow: [1, 128] });
      if (head.code !== 0) throw new CoreError('validation', `${repo} has no branch checked out; say which branch to change (branch).`);
      branch = checkBranch(head.out.trim());
    } else branch = checkBranch(branchIn);
    const tip = await this.#git.run(['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { allow: [1, 128] });
    if (tip.code !== 0 || !OID.test(tip.out.trim())) throw new CoreError('validation', `${repo} has no branch called ${branch}.`);
    return { repo, branch };
  }

  // The coding agent: one named, or the person's default coding agent. It must be on, and be a
  // coding agent or a chat model (which answers in the JSON files contract).
  #agent(v: unknown): string {
    const ch = this.#o.providers.choices();
    const id = typeof v === 'string' && v.trim() ? v.trim() : ch.defaults['coding-agent'].current ?? ch.defaults['coding-agent'].recommended.id;
    if (!id) throw new CoreError('conflict', `No coding agent is on. ${ch.defaults['coding-agent'].recommended.why}`);
    let p;
    try { p = this.#o.providers.view(id); } catch { throw new CoreError('validation', `There is no provider called “${id}”.`); }
    if (p.class !== 'coding-agent' && p.class !== 'chat') throw new CoreError('validation', `${p.name} isn’t a coding agent.`);
    if (!p.enabled) throw new CoreError('conflict', `${p.name} is turned off. Turn it on in Settings › Providers first.`);
    return id;
  }

  // ---- the chain of tasks -------------------------------------------------------------------------

  #make(r: RunRow, step: Step, round: number, origin: TaskInput['origin'] = { kind: 'user' }): Task {
    const words: Record<Step, string> = {
      write: `Write: ${r.title}`,
      update: `Bring up to date with ${r.branch}: ${r.title}`,
      check: `Test and preview: ${r.title}`,
      merge: `Merge into ${r.branch}: ${r.title}`,
    };
    const goals: Record<Step, string> = {
      write: r.goal,
      update: `Merge the newest ${r.branch} of ${r.repo} into Nova’s branch for “${r.title}”, so it can be reviewed again against it.`,
      check: `Run \`${r.test_command}\` on the change for “${r.title}” (Nova’s commit ${short(r.head)})${r.preview_command ? `, then start its preview with \`${r.preview_command}\`` : ''}, on this computer. This runs code the coding agent wrote, as you.`,
      merge: `Move ${r.branch} in ${r.repo} from ${short(r.base)} to ${short(r.head)}: exactly the reviewed change for “${r.title}”. Nova doesn’t push.`,
    };
    const evidence = step === 'check'
      ? [{ kind: 'test_result' as const, note: `Nova runs \`${r.test_command}\` itself` }, ...(r.preview_command ? [{ kind: 'confirmation' as const, note: 'the preview answering on this computer' }] : [])]
      : [{ kind: 'confirmation' as const, note: step === 'merge' ? `Nova reads ${r.branch} back` : 'Nova’s commit on its own branch' }];
    const plan = [
      `Write the change in a git worktree of Nova’s own, on nova/${r.id} from ${r.branch} (${this.#agentName(r.agent)}).`,
      `Run \`${r.test_command}\`${r.preview_command ? ` and start the preview \`${r.preview_command}\`` : ''} on it, after your OK.`,
      `Merge into ${r.branch}, only when you confirm. Nothing is pushed.`,
    ];
    const t = this.#o.ledger.create({
      title: words[step], owner: CODING_WORKER, goal: goals[step], origin, evidence_required: evidence, privacy_mode: r.privacy_mode, approval_tier: TIER[step],
      inputs: { step, run_id: r.id, round, agent: r.agent, repo: r.repo, branch: r.branch, test_command: r.test_command, ...(r.preview_command ? { preview_command: r.preview_command } : {}),
        ...(r.editable ? { editable: JSON.parse(r.editable) } : {}), ...(step === 'write' ? { plan } : {}), ...(r.head && step !== 'write' && step !== 'update' ? { head: r.head, base: r.base } : {}) },
      idempotency_key: `coding:${r.id}:${step}:${round}`,
      ...(this.#tasks(r)[0] ? { parent_id: this.#tasks(r)[0]!.id } : {}),
    }, { as: this.#key });
    const tasks = this.#tasks(r);
    if (!tasks.some((x) => x.id === t.id)) {
      tasks.push({ step, round, id: t.id });
      this.#o.db.run('UPDATE coding_run SET tasks = ?, updated_at = ? WHERE id = ?', JSON.stringify(tasks), this.#now().toISOString(), r.id);
    }
    return t;
  }

  #tasks(r: RunRow): TaskRef[] { return parse<TaskRef[]>(this.#row(r.id).tasks) ?? []; }

  #agentName(id: string): string { try { return this.#o.providers.view(id).name; } catch { return id; } }

  // What follows a step, once the ledger has settled it. Each next task's idempotency key is its run,
  // step and round, so seeing the same event twice makes nothing twice.
  #advance(t: Task): void {
    const step = t.brief.inputs?.step as Step;
    const runId = String(t.brief.inputs?.run_id ?? '');
    const round = Number(t.brief.inputs?.round ?? 1);
    const r = this.#o.db.get<RunRow>('SELECT * FROM coding_run WHERE id = ?', runId);
    if (!r || r.round !== round) return;
    if (t.state === 'done') {
      if (step === 'write' || step === 'update') {
        this.#set(r.id, { state: 'checking', reason: `Nova needs your OK to run \`${r.test_command}\`${r.preview_command ? ' and the preview' : ''} on the change.` });
        this.#make(this.#row(r.id), 'check', round);
      } else if (step === 'check') {
        const p = parse<PreviewRecord>(this.#row(r.id).preview);
        this.#set(r.id, { state: 'review', reason: `Ready for you: \`${r.test_command}\` passed${p ? `, and the preview is at ${p.url}` : ''}. Nova asks before it merges into ${r.branch}.` });
        this.#make(this.#row(r.id), 'merge', round);
        this.#tell(r.id, `review:${round}`, `The change “${r.title}” is ready for you to review: \`${r.test_command}\` passed${p ? `, and its preview is at ${p.url} (on this computer)` : ''}. Nova merges it into ${r.branch} only when you confirm, in Tasks.`);
      } else if (step === 'merge') {
        this.#set(r.id, { state: 'merged', reason: `Merged: ${r.branch} is at ${short(r.head)}, the reviewed commit. Nothing was pushed.` });
        this.#cleanup(r.id, 'the change was merged');
        this.#tell(r.id, 'merged', `Merged “${r.title}” into ${r.branch} in ${r.repo}: it is at ${short(r.head)}, exactly the reviewed change. Nothing was pushed.`);
      }
      return;
    }
    if (t.state === 'failed') {
      if (step === 'merge' && r.state === 'moved') {
        // The person's branch moved: nothing unreviewed is merged. A new round brings the change up
        // to date and asks again.
        this.#o.db.run(`UPDATE coding_run SET round = round + 1, state = 'writing', updated_at = ? WHERE id = ?`, this.#now().toISOString(), r.id);
        this.#stopPreview(r.id, 'the branch moved; a new round starts');
        this.#make(this.#row(r.id), 'update', round + 1);
        return;
      }
      // A conflict is set by the update step itself, just before it fails; any other ended run is
      // already settled.
      if (ENDED.includes(r.state) && r.state !== 'conflict') return;
      this.#set(r.id, { state: r.state === 'conflict' ? 'conflict' : 'failed', reason: t.reason });
      this.#cleanup(r.id, 'the run ended');
      this.#tell(r.id, `failed:${round}`, `The change “${r.title}” stopped: ${clip(t.reason ?? 'it failed', 400)} Nothing was merged.`);
      return;
    }
    if (t.state === 'cancelled') {
      if (ENDED.includes(r.state)) return;
      const declined = step === 'merge';
      this.#set(r.id, { state: declined ? 'declined' : 'cancelled', reason: declined ? `You declined the merge. ${r.branch} is as it was; nothing was merged or pushed.` : `Cancelled: ${t.reason ?? ''}`.trim() });
      this.#cleanup(r.id, declined ? 'you declined the merge' : 'the run was cancelled');
    }
  }

  #set(id: string, f: Partial<Pick<RunRow, 'state' | 'reason' | 'base' | 'head' | 'tree_digest' | 'changes' | 'diff' | 'test' | 'preview'>>): void {
    const keys = Object.keys(f) as (keyof typeof f)[];
    if (!keys.length) return;
    this.#o.db.run(`UPDATE coding_run SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (f[k] ?? null) as string | number | null), this.#now().toISOString(), id);
  }

  #tell(id: string, what: string, text: string): void {
    try { this.#o.notify?.(`coding:${id}:${what}`, text); } catch { /* the run's record says it too */ }
  }

  // ---- running a step ------------------------------------------------------------------------------

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = performance.now();
    const report: Reporter = (status, summary, more = {}) => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], follow_up_suggestions: [],
      ...more, usage: { ...(more.usage ?? {}), duration_ms: Math.round(performance.now() - started) },
    });
    const step = brief.inputs?.step as Step;
    const r = this.#o.db.get<RunRow>('SELECT * FROM coding_run WHERE id = ?', String(brief.inputs?.run_id ?? ''));
    if (!r) return report('failed', 'This coding run isn’t in Nova’s record any more.');
    if (ENDED.includes(r.state)) return report('failed', `This coding run has ended (${r.state}).`);
    if (r.round !== Number(brief.inputs?.round ?? 1)) return report('failed', 'This step belongs to an earlier round of the run.');
    try {
      if (step === 'write') return await this.#write(r, brief, signal, report);
      if (step === 'update') return await this.#update(r, report);
      if (step === 'check') return await this.#check(r, brief, signal, report);
      if (step === 'merge') return await this.#merge(r, brief, report);
      return report('failed', `There is no coding step called “${String(step)}”.`);
    } catch (e) {
      if (signal.aborted) throw e;
      return report('failed', (e as Error).message);
    }
  }

  #mirror(repo: string): string { return join(this.dir, 'repos', `${sha256(repo).slice(0, 16)}.git`); }
  #runDir(id: string): string { return join(this.dir, 'runs', id); }
  #tree(id: string): string { return join(this.#runDir(id), 'tree'); }
  #work(id: string): string { return join(this.#runDir(id), 'work'); }
  #novaBranch(id: string): string { return `nova/${id}`; }

  #serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.#queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.#queues.set(key, next);
    void next.finally(() => { if (this.#queues.get(key) === next) this.#queues.delete(key); }).catch(() => {});
    return next;
  }

  // Nova's copy of the person's repository, with the branch fetched (a read of theirs).
  #fetch(r: RunRow): Promise<{ mirror: string; tip: string }> {
    return this.#serial(this.#mirror(r.repo), () => this.#fetchNow(r));
  }

  async #fetchNow(r: RunRow): Promise<{ mirror: string; tip: string }> {
    const mirror = this.#mirror(r.repo);
    if (!existsSync(join(mirror, 'HEAD'))) {
      mkdirSync(mirror, { recursive: true });
      await this.#git.run(['init', '--bare', '--quiet', mirror]);
    }
    await this.#git.run(['--git-dir', mirror, 'fetch', '--no-tags', '--no-write-fetch-head', '--quiet', r.repo, `+refs/heads/${r.branch}:refs/source/${r.branch}`]);
    const tip = (await this.#git.run(['--git-dir', mirror, 'rev-parse', '--verify', `refs/source/${r.branch}^{commit}`])).out.trim();
    if (!OID.test(tip)) throw new CoreError('conflict', `Nova couldn’t read ${r.branch} from ${r.repo}.`);
    return { mirror, tip };
  }

  // Removes the run's worktree and its branch from Nova's repository (the tier-1 undo).
  #dropTree(r: RunRow): Promise<void> {
    return this.#serial(this.#mirror(r.repo), () => this.#dropTreeNow(r));
  }

  async #dropTreeNow(r: RunRow): Promise<void> {
    const mirror = this.#mirror(r.repo);
    if (existsSync(join(mirror, 'HEAD'))) {
      await this.#git.run(['--git-dir', mirror, 'worktree', 'remove', '--force', '--force', this.#tree(r.id)], { allow: [128, 1] });
      rmSync(this.#tree(r.id), { recursive: true, force: true });
      await this.#git.run(['--git-dir', mirror, 'worktree', 'prune'], { allow: [128, 1] });
      await this.#git.run(['--git-dir', mirror, 'branch', '--quiet', '-D', this.#novaBranch(r.id)], { allow: [1, 128] });
    }
    rmSync(this.#runDir(r.id), { recursive: true, force: true });
  }

  async #write(r: RunRow, brief: Brief, signal: AbortSignal, report: Reporter): Promise<Report> {
    // A fresh start for each attempt.
    this.#stopPreview(r.id, 'the change is being written again');
    await this.#dropTree(r);
    const { mirror, tip: base } = await this.#fetch(r);
    const tree = this.#tree(r.id);
    mkdirSync(this.#runDir(r.id), { recursive: true });
    await this.#serial(mirror, () => this.#git.run(['--git-dir', mirror, 'worktree', 'add', '--quiet', '-b', this.#novaBranch(r.id), tree, base]));
    const before = walk(tree, { skipTopGit: true });
    if (before.refused.length) return report('failed', `Nova can’t work on ${r.repo} at ${short(base)}: ${before.refused.slice(0, 3).map((x) => `${x.path} (${x.why})`).join('; ')}.`);
    copyWalk(tree, before.entries, this.#work(r.id));
    const files = [...before.entries].filter(([, e]) => e.kind === 'file').map(([p, e]) => ({ path: p, sha256: e.hash }));
    const tops = (paths: string[]) => [...new Set(paths.map((p) => p.split('/')[0]!))];
    const inputs = { ...(r.editable ? { editable: JSON.parse(r.editable) } : {}), test_command: r.test_command };
    const may = scopeOf(tops(files.map((f) => f.path)), inputs, files.map((f) => f.path)).words;
    const out = await this.#o.providers.workIn(r.agent, { brief, cwd: this.#work(r.id), files, may, signal });
    const artifacts = (out.artifacts ?? []) as Report['artifacts'];
    if (out.status !== 'done') return report(out.status, out.summary, { ...(out.blockers ? { blockers: out.blockers } : {}), usage: out.usage, artifacts });

    // What the agent changed, read by Nova from its folder.
    const after = walk(this.#work(r.id));
    const cs = changesOf(before.entries, after.entries);
    const refused = refusals(cs, after);
    if (refused) return report('failed', refused, { usage: out.usage, artifacts });
    if (!cs.length) return report('failed', `${out.provider_name} changed nothing. ${clip(out.summary, 300)}`.trim(), { usage: out.usage, artifacts });
    const scope = scopeOf(tops([...files.map((f) => f.path), ...cs.map((c) => c.path)]), inputs, files.map((f) => f.path));
    const bad = outOfScope(cs.map((c) => ({ path: c.path, kind: c.kind, sha256: c.entry?.hash ?? null })), scope);
    if (bad) return report('failed', `Nova refused the work: ${bad}. Nothing was committed.`, { usage: out.usage, artifacts });

    // Into the worktree, and committed.
    applyChanges(this.#work(r.id), tree, cs);
    await this.#git.run(['-C', tree, 'add', '--all']);
    const message = `${clip(r.title, 72)}\n\n${r.goal.slice(0, 2000)}\n\nWritten by ${out.provider_name} in Nova coding run ${r.id}; reviewed before any merge.`;
    await this.#git.run(['-C', tree, 'commit', '--quiet', '--no-verify', '--file', '-'], { input: message });
    const head = (await this.#git.run(['-C', tree, 'rev-parse', '--verify', 'HEAD^{commit}'])).out.trim();
    // Nova's commit holds exactly what the agent left: its walk of the worktree is the agent's, and
    // git lists exactly the changes.
    const committed = walk(tree, { skipTopGit: true });
    if (digest(committed.entries) !== digest(after.entries)) return report('failed', 'Nova’s commit doesn’t hold exactly what the agent left in its folder, so Nova stopped. Nothing was merged.', { usage: out.usage, artifacts });
    const recorded = await this.#record(mirror, base, head);
    const listed = new Set(recorded.changes.map((c) => c.path));
    if (listed.size !== cs.length || cs.some((c) => !listed.has(c.path))) return report('failed', `git lists other changes than the ones Nova took (${[...listed].slice(0, 5).join(', ')}), so Nova stopped. Nothing was merged.`, { usage: out.usage, artifacts });
    this.#set(r.id, { base, head, tree_digest: digest(committed.entries), changes: JSON.stringify(recorded.changes), diff: recorded.diff });
    rmSync(this.#work(r.id), { recursive: true, force: true });
    const names = cs.slice(0, 5).map((c) => c.path).join(', ') + (cs.length > 5 ? `, and ${cs.length - 5} more` : '');
    return report('done', `${out.provider_name} changed ${plural(cs.length, 'file')} (${names}). Nova committed it as ${short(head)} on nova/${r.id} in its own copy of the repository; ${r.branch} in ${r.repo} is untouched. ${clip(out.summary, 300)}`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `commit:${r.id}:${head}` }],
      artifacts: [{ kind: 'git-commit', ref: head }, ...artifacts], usage: out.usage,
    });
  }

  // The reviewed diff and its files, from Nova's own repository.
  async #record(mirror: string, base: string, head: string): Promise<{ changes: FileChange[]; diff: string }> {
    const status = (await this.#git.run(['--git-dir', mirror, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, head])).out.split('\0').filter(Boolean);
    const kinds = new Map<string, Change['kind']>();
    for (let i = 0; i + 1 < status.length; i += 2) kinds.set(status[i + 1]!, status[i]!.startsWith('A') ? 'added' : status[i]!.startsWith('D') ? 'deleted' : 'modified');
    const num = (await this.#git.run(['--git-dir', mirror, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', base, head])).out.split('\0').filter(Boolean);
    const counts = new Map<string, [number | null, number | null]>();
    for (const line of num) {
      const [a, d, ...p] = line.split('\t');
      counts.set(p.join('\t'), [a === '-' ? null : Number(a), d === '-' ? null : Number(d)]);
    }
    let diff = (await this.#git.run(['--git-dir', mirror, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', base, head], { maxBytes: 256 * 1024 * 1024 })).out;
    if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n… (the diff goes on; ${plural(kinds.size, 'file')} in all)\n`;
    const changes = [...kinds].map(([path, kind]) => ({ path, kind, added: counts.get(path)?.[0] ?? null, removed: counts.get(path)?.[1] ?? null }));
    return { changes, diff };
  }

  // A new round: the newest tip of the person's branch merged into Nova's, in the worktree.
  async #update(r: RunRow, report: Reporter): Promise<Report> {
    if (!r.head) return report('failed', 'This run has no change to bring up to date.');
    const { mirror, tip } = await this.#fetch(r);
    const tree = this.#tree(r.id);
    if (!existsSync(tree)) return report('failed', 'The run’s worktree is gone, so there is nothing to bring up to date.');
    // The worktree back at Nova's commit, with nothing the tests or the preview left.
    await this.#git.run(['-C', tree, 'reset', '--hard', '--quiet', r.head]);
    await this.#git.run(['-C', tree, 'clean', '-ffdxq']);
    const m = await this.#git.run(['-C', tree, 'merge', '--no-ff', '--no-edit', '--quiet', '-m', `Merge ${r.branch} into nova/${r.id} for review`, tip], { allow: [1, 128] });
    if (m.code !== 0) {
      const conflicted = (await this.#git.run(['-C', tree, 'diff', '--name-only', '--diff-filter=U'], { allow: [1, 128] })).out.trim().split('\n').filter(Boolean);
      await this.#git.run(['-C', tree, 'merge', '--abort'], { allow: [1, 128] });
      this.#set(r.id, { state: 'conflict' });
      return report('failed', `${r.branch} moved since review, and the change conflicts with what is there now${conflicted.length ? ` (${conflicted.slice(0, 5).join(', ')})` : ''}. Nothing was merged; ask again for the change on the new ${r.branch}.`);
    }
    const head = (await this.#git.run(['-C', tree, 'rev-parse', '--verify', 'HEAD^{commit}'])).out.trim();
    const recorded = await this.#record(mirror, tip, head);
    const committed = walk(tree, { skipTopGit: true });
    this.#set(r.id, { base: tip, head, tree_digest: digest(committed.entries), changes: JSON.stringify(recorded.changes), diff: recorded.diff, test: null, preview: null });
    return report('done', `${r.branch} had moved to ${short(tip)}. Nova merged it into its branch (now ${short(head)}), so the change can be reviewed again against it.`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `commit:${r.id}:${head}` }],
      artifacts: [{ kind: 'git-commit', ref: head }],
    });
  }

  async #check(r: RunRow, brief: Brief, signal: AbortSignal, report: Reporter): Promise<Report> {
    const head = String(brief.inputs?.head ?? '');
    if (!r.head || head !== r.head) return report('failed', 'The change moved on since this step was made; Nova didn’t run anything.');
    const tree = this.#tree(r.id);
    // What runs is exactly the commit: HEAD is it, and Nova's walk of the files is the commit's.
    const at = (await this.#git.run(['-C', tree, 'rev-parse', '--verify', 'HEAD^{commit}'])).out.trim();
    if (at !== r.head) return report('failed', `The worktree isn’t at Nova’s commit ${short(r.head)}, so Nova didn’t run anything.`);
    if (digest(walk(tree, { skipTopGit: true }).entries) !== r.tree_digest) return report('failed', 'The worktree’s files aren’t the commit’s any more, so Nova didn’t run anything.');
    this.#stopPreview(r.id, 'a new check started');

    // The tests, as a person would type them, with nothing of Nova's or the person's environment.
    const home = mkdtempSync(join(tmpdir(), 'nova-coding-test-'));
    let output = '';
    let ran;
    try {
      ran = await runLines({ argv: [`(${r.test_command}) 2>&1`], shell: true, cwd: tree, env: testEnv(home), signal, timeoutMs: (this.#o.testTimeoutS ?? 600) * 1000, onLine: (l) => { output = (output + l + '\n').slice(-16_000); } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    if (signal.aborted) throw signal.reason ?? new Error('stopped');
    const rec: TestRecord = {
      id: randomUUID(), task_id: brief.task_id, run_id: r.id, round: r.round, command: r.test_command, commit: r.head, passed: ran.code === 0 && !ran.timedOut && !ran.aborted, exit: ran.code,
      output: ran.timedOut ? `${tail(output, 40, 4000)}\n(stopped after ${this.#o.testTimeoutS ?? 600} s)` : tail(output, 40, 4000), ms: Math.round(ran.ms), at: this.#now().toISOString(),
    };
    this.#writeRecord('tests', rec.id, rec);
    this.#set(r.id, { test: JSON.stringify(rec) });
    const testEvidence: Evidence = { kind: 'test_result', name: `${TEST_PREFIX}${rec.id}`, passed: rec.passed, output: rec.output };
    if (!rec.passed) {
      const last = rec.output.trim().split('\n').slice(-3).join(' / ');
      return report('failed', `Nova ran \`${r.test_command}\` itself on ${short(r.head)}: it failed (exit ${rec.exit ?? 'none'})${last ? `: ${clip(last, 300)}` : ''}. Nova won’t ask you to merge it.`, { evidence: [testEvidence] });
    }
    let summary = `Nova ran \`${r.test_command}\` itself on ${short(r.head)}: it passed (${(rec.ms / 1000).toFixed(1)} s).`;
    const evidence: Evidence[] = [testEvidence];
    if (r.preview_command) {
      const port = await freePort();
      const home2 = join(this.#runDir(r.id), 'preview-home');
      mkdirSync(home2, { recursive: true });
      let started;
      try {
        started = await startPreview({ command: r.preview_command, cwd: tree, env: testEnv(home2), port, timeoutMs: (this.#o.previewTimeoutS ?? 60) * 1000, signal });
      } catch (e) {
        if (signal.aborted) throw e;
        return report('failed', `${summary} The preview didn’t come up: ${(e as Error).message}`, { evidence });
      }
      this.#previews.set(r.id, started.child);
      started.child.once('exit', () => { if (this.#previews.get(r.id) === started.child) { this.#previews.delete(r.id); this.#markStopped(r.id, 'it exited'); } });
      const p: PreviewRecord = { run_id: r.id, round: r.round, task_id: brief.task_id, command: r.preview_command, commit: r.head, url: started.url, port, pid: started.child.pid!, status: started.status, loopback: started.loopback, started_at: this.#now().toISOString(), stopped_at: null, why_stopped: null };
      this.#writeRecord('previews', `${r.id}-${r.round}`, p);
      this.#set(r.id, { preview: JSON.stringify(p) });
      evidence.push({ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `preview:${r.id}:${r.round}` });
      summary = `${summary} The preview is up at ${started.url}, on this computer only${started.loopback === 'unchecked' ? ' (Nova couldn’t check what it listens on here)' : ''}.`;
    }
    return report('done', summary, { evidence });
  }

  async #merge(r: RunRow, brief: Brief, report: Reporter): Promise<Report> {
    const head = String(brief.inputs?.head ?? '');
    const base = String(brief.inputs?.base ?? '');
    if (r.state !== 'review' && r.state !== 'merging') return report('failed', `This run isn’t waiting to be merged (it is ${r.state}).`);
    if (!OID.test(head) || head !== r.head || base !== r.base) return report('failed', 'The change isn’t the one you reviewed any more, so Nova merged nothing.');
    const mirror = this.#mirror(r.repo);
    const ours = (await this.#git.run(['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', `refs/heads/${this.#novaBranch(r.id)}^{commit}`], { allow: [1, 128] })).out.trim();
    if (ours !== head) return report('failed', `Nova’s branch nova/${r.id} isn’t at the reviewed commit ${short(head)} any more, so Nova merged nothing.`);
    // The person's branch, read now. Moved since the review: nothing unreviewed is merged.
    const now = (await this.#git.run(['-C', r.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}^{commit}`], { allow: [1, 128] })).out.trim();
    if (now !== base) {
      this.#set(r.id, { state: 'moved', reason: `${r.branch} moved since the review.` });
      return report('failed', `${r.branch} moved since you reviewed the change (it is at ${short(now) || 'nothing'} now; the review was against ${short(base)}). Nova merged nothing, and brings the change up to date to ask you again.`);
    }
    // Checked out somewhere: that working tree must have no changes, and it moves with the branch.
    const listed = (await this.#git.run(['-C', r.repo, 'worktree', 'list', '--porcelain', '-z'])).out.split('\0');
    let checkedOut: string | null = null;
    let current: string | null = null;
    for (const field of listed) {
      if (field.startsWith('worktree ')) current = field.slice('worktree '.length);
      else if (field === `branch refs/heads/${r.branch}`) checkedOut = current;
    }
    if (checkedOut) {
      const dirty = (await this.#git.run(['-C', checkedOut, 'status', '--porcelain=v1', '--untracked-files=no', '-z'])).out;
      if (dirty) return report('blocked', `${r.branch} is checked out in ${checkedOut}, which has changes that aren’t committed. Nova doesn’t merge over them. Commit or put them away, then retry; Nova asks you again.`);
    }
    this.#set(r.id, { state: 'merging' });
    this.#o.ledger.committing(brief.task_id, `move ${r.branch} to the reviewed commit`);
    // The reviewed commit's objects into the person's repository (from Nova's, no refs made), then
    // the branch: a fast-forward in the working tree that has it, or a compare-and-swap of the ref.
    await this.#git.run(['-C', r.repo, 'fetch', '--no-tags', '--no-write-fetch-head', '--quiet', mirror, `refs/heads/${this.#novaBranch(r.id)}`]);
    await this.#git.run(['-C', r.repo, 'cat-file', '-e', `${head}^{commit}`]);
    if (checkedOut) await this.#git.run(['-C', checkedOut, 'merge', '--ff-only', '--quiet', head]);
    else await this.#git.run(['-C', r.repo, 'update-ref', '-m', `nova: merge the reviewed change of coding run ${r.id}`, `refs/heads/${r.branch}`, head, base]);
    const after = (await this.#git.run(['-C', r.repo, 'rev-parse', '--verify', `refs/heads/${r.branch}^{commit}`])).out.trim();
    if (after !== head) return report('failed', `Nova moved ${r.branch}, and reading it back finds ${short(after)}, not the reviewed ${short(head)}.`);
    return report('done', `${r.branch} in ${r.repo} moved from ${short(base)} to ${short(head)}: exactly the reviewed change. Nothing was pushed.`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `merge:${r.id}:${head}` }],
      artifacts: [{ kind: 'git-commit', ref: head }],
    });
  }

  // ---- records and checks ---------------------------------------------------------------------------

  #writeRecord(kind: 'tests' | 'previews', id: string, v: unknown): void {
    const dir = join(this.dir, 'records', kind);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${id}.json`);
    writeFileSync(`${f}.tmp`, JSON.stringify(v));
    renameSync(`${f}.tmp`, f);
  }

  #readRecord<T>(kind: 'tests' | 'previews', id: string): T | null {
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) return null;
    try { return JSON.parse(readFileSync(join(this.dir, 'records', kind, `${id}.json`), 'utf8')) as T; } catch { return null; }
  }

  #checkTest(e: Evidence, brief: Brief): { ok: boolean; why: string } {
    if (e.kind !== 'test_result') return { ok: false, why: 'Not a test result.' };
    const rec = this.#readRecord<TestRecord>('tests', e.name.slice(TEST_PREFIX.length));
    if (!rec) return { ok: false, why: `Nova has no record of running “${e.name}”; nobody can vouch for a test but Nova.` };
    const r = this.#o.db.get<RunRow>('SELECT * FROM coding_run WHERE id = ?', String(brief.inputs?.run_id ?? ''));
    if (!r || rec.run_id !== r.id || rec.task_id !== brief.task_id) return { ok: false, why: 'That test run was for other work.' };
    if (rec.command !== r.test_command) return { ok: false, why: `That run was \`${rec.command}\`, not the run’s \`${r.test_command}\`.` };
    if (rec.commit !== r.head || rec.commit !== brief.inputs?.head) return { ok: false, why: `That run was on ${short(rec.commit)}, not the change under review (${short(r.head)}).` };
    if (!rec.passed) return { ok: false, why: `Nova ran \`${rec.command}\` itself on ${short(rec.commit)} and it failed (exit ${rec.exit ?? 'none'}).` };
    if (e.passed !== true) return { ok: false, why: 'The report says the test failed.' };
    return { ok: true, why: `Nova ran \`${rec.command}\` itself in its worktree at ${short(rec.commit)}: it passed (exit 0, ${(rec.ms / 1000).toFixed(1)} s).` };
  }

  #confirm(e: Evidence, brief: Brief): { ok: boolean; why: string } {
    if (e.kind !== 'confirmation') return { ok: false, why: 'Not a confirmation.' };
    const [what, runId, ref] = e.id.split(':');
    const r = this.#o.db.get<RunRow>('SELECT * FROM coding_run WHERE id = ?', runId ?? '');
    if (!r || runId !== brief.inputs?.run_id) return { ok: false, why: 'That confirmation is for another coding run.' };
    try {
      if (what === 'commit') {
        if (!ref || !OID.test(ref) || ref !== r.head) return { ok: false, why: `${short(ref)} isn’t the run’s commit.` };
        const mirror = this.#mirror(r.repo);
        const branch = this.#git.runSync(['--git-dir', mirror, 'rev-parse', '--verify', '--quiet', `refs/heads/${this.#novaBranch(r.id)}^{commit}`], { allow: [1, 128] }).out.trim();
        if (branch !== ref) return { ok: false, why: `Nova’s branch nova/${r.id} isn’t at ${short(ref)}.` };
        if (!r.base || this.#git.runSync(['--git-dir', mirror, 'merge-base', '--is-ancestor', r.base, ref], { allow: [1] }).code !== 0 || r.base === ref) return { ok: false, why: `${short(ref)} doesn’t build on ${short(r.base)}.` };
        const names = this.#git.runSync(['--git-dir', mirror, 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', r.base, ref]).out.split('\0').filter(Boolean).sort();
        const want = (parse<FileChange[]>(r.changes) ?? []).map((c) => c.path).sort();
        if (JSON.stringify(names) !== JSON.stringify(want)) return { ok: false, why: 'git lists other files in the commit than Nova recorded.' };
        return { ok: true, why: `Nova read its own repository: nova/${r.id} is at ${short(ref)}, on ${short(r.base)}, changing ${plural(names.length, 'file')}, as recorded.` };
      }
      if (what === 'preview') {
        const p = this.#readRecord<PreviewRecord>('previews', `${r.id}-${ref}`);
        if (!p || p.run_id !== r.id || String(p.round) !== ref || p.task_id !== brief.task_id) return { ok: false, why: 'Nova has no record of that preview.' };
        if (p.commit !== r.head) return { ok: false, why: `That preview was of ${short(p.commit)}, not the change under review.` };
        if (!alive(p.pid) || p.stopped_at) return { ok: false, why: 'That preview isn’t running any more.' };
        return { ok: true, why: `Nova started the preview itself at ${p.url} (it answered HTTP ${p.status}${p.loopback === 'yes' ? ', and listens on this computer only' : ''}).` };
      }
      if (what === 'merge') {
        const now = this.#git.runSync(['-C', r.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${r.branch}^{commit}`], { allow: [1, 128] }).out.trim();
        if (!ref || ref !== r.head || now !== ref) return { ok: false, why: `Nova read ${r.branch} in ${r.repo}: it is at ${short(now) || 'nothing'}, not the reviewed ${short(ref)}.` };
        return { ok: true, why: `Nova read ${r.branch} in ${r.repo} itself: it is at ${short(ref)}, the reviewed commit.` };
      }
    } catch (err) {
      return { ok: false, why: (err as Error).message };
    }
    return { ok: false, why: `Nova doesn’t know a coding confirmation called “${what}”.` };
  }

  // ---- the preview and the worktree -------------------------------------------------------------

  #markStopped(id: string, why: string): void {
    const r = this.#o.db.get<RunRow>('SELECT preview FROM coding_run WHERE id = ?', id);
    const p = parse<PreviewRecord>(r?.preview ?? null);
    if (!p || p.stopped_at) return;
    const next = { ...p, stopped_at: this.#now().toISOString(), why_stopped: why };
    this.#writeRecord('previews', `${id}-${p.round}`, next);
    this.#set(id, { preview: JSON.stringify(next) });
  }

  #stopPreview(id: string, why: string): void {
    const child = this.#previews.get(id);
    this.#previews.delete(id);
    if (child) stopPreview(child);
    this.#markStopped(id, why);
  }

  // When a run ends: its preview stops, and its worktree and branch go (they are Nova's own).
  #cleanup(id: string, why: string): void {
    this.#stopPreview(id, why);
    const r = this.#o.db.get<RunRow>('SELECT * FROM coding_run WHERE id = ?', id);
    if (r) void this.#dropTree(r).catch((e) => this.#o.log.warn('coding', 'Nova couldn’t remove a coding run’s worktree.', { run: id, error: (e as Error).message }));
  }

  // ---- what callers see -----------------------------------------------------------------------------

  #row(id: string): RunRow {
    const r = this.#o.db.get<RunRow>('SELECT * FROM coding_run WHERE id = ?', id);
    if (!r) throw new CoreError('not_found', `There is no coding run ${id}.`);
    return r;
  }

  list() {
    return this.#o.db.all<RunRow>('SELECT * FROM coding_run ORDER BY created_at DESC LIMIT 100').map((r) => this.#summary(r));
  }

  #summary(r: RunRow) {
    const tasks = (parse<TaskRef[]>(r.tasks) ?? []).map((x) => {
      let t: Task | null = null;
      try { t = this.#o.ledger.get(x.id); } catch { /* gone */ }
      return { ...x, state: t?.state ?? 'gone', reason: t?.reason ?? null, approval_tier: t?.approval_tier ?? TIER[x.step], approved_at: t?.approved_at ?? null };
    });
    const open = [...tasks].reverse().find((t) => !['done', 'failed', 'cancelled', 'gone'].includes(t.state)) ?? null;
    return {
      id: r.id, title: r.title, state: r.state, reason: r.reason, repo: r.repo, branch: r.branch, agent: r.agent, agent_name: this.#agentName(r.agent),
      round: r.round, base: r.base, head: r.head, nova_branch: this.#novaBranch(r.id), test_command: r.test_command, preview_command: r.preview_command,
      session_id: r.session_id, tasks, current: open, created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  // One run: its steps and their tasks, and everything the person reviews.
  view(id: string) {
    const r = this.#row(id);
    const p = parse<PreviewRecord>(r.preview);
    return {
      ...this.#summary(r), goal: r.goal, privacy_mode: r.privacy_mode, editable: parse<string[]>(r.editable),
      changes: parse<FileChange[]>(r.changes) ?? [], diff: r.diff, test: parse<TestRecord>(r.test),
      preview: p ? { url: p.url, port: p.port, commit: p.commit, status: p.status, loopback: p.loopback, started_at: p.started_at, running: !p.stopped_at && alive(p.pid) && this.#previews.has(r.id), stopped_at: p.stopped_at, why_stopped: p.why_stopped ?? (!alive(p.pid) || !this.#previews.has(r.id) ? 'Nova restarted, or it exited' : null) } : null,
      merge: r.head && r.base ? `Merging moves ${r.branch} in ${r.repo} from ${short(r.base)} to ${short(r.head)}: exactly this diff. Nova doesn’t push.` : null,
    };
  }

  // The run a task belongs to, or null.
  runOf(taskId: string): string | null {
    let t: Task;
    try { t = this.#o.ledger.get(taskId); } catch { return null; }
    return t.owner === CODING_WORKER ? String(t.brief.inputs?.run_id ?? '') || null : null;
  }

  // The person says no to the merge: its task is cancelled (the run then ends, declined).
  decline(id: string): ReturnType<Coding['view']> {
    const r = this.#row(id);
    const merge = (parse<TaskRef[]>(r.tasks) ?? []).filter((x) => x.step === 'merge' && x.round === r.round).at(-1);
    const t = merge ? this.#o.ledger.get(merge.id) : null;
    if (!t || ['done', 'failed', 'cancelled'].includes(t.state)) throw new CoreError('conflict', 'This run isn’t waiting for you to merge it.');
    this.#o.ledger.cancel(t.id, 'You declined the merge.');
    return this.view(id);
  }

  // The tier-1 undo of the write: the worktree and Nova's branch go, and the run ends. Anything of the
  // run still open is cancelled first. A merged run can't be undone here.
  async discard(id: string): Promise<ReturnType<Coding['view']>> {
    const r = this.#row(id);
    if (r.state === 'merged') throw new CoreError('conflict', `This change is merged into ${r.branch}; going back is a revert in your repository.`);
    if (r.state === 'merging') throw new CoreError('conflict', 'This change is being merged right now.');
    for (const x of parse<TaskRef[]>(r.tasks) ?? []) {
      try { const t = this.#o.ledger.get(x.id); if (!['done', 'failed', 'cancelled'].includes(t.state)) this.#o.ledger.cancel(t.id, 'You undid the change: Nova removed its worktree.'); } catch { /* gone */ }
    }
    this.#stopPreview(id, 'you undid the change');
    await this.#dropTree(this.#row(id));
    this.#set(id, { state: 'discarded', reason: `You undid it: Nova removed its worktree and nova/${id}. ${r.branch} is as it was.` });
    return this.view(id);
  }

  // After a restart: previews didn't survive it, and a step that was settled while Nova stopped is
  // followed by its next one now.
  recover(): void {
    for (const r of this.#o.db.all<RunRow>(`SELECT * FROM coding_run WHERE state NOT IN (${ENDED.map(() => '?').join(', ')})`, ...ENDED)) {
      if (!this.#previews.has(r.id)) this.#markStopped(r.id, 'Nova restarted');
      const last = (parse<TaskRef[]>(r.tasks) ?? []).filter((x) => x.round === r.round).at(-1);
      if (!last) continue;
      try { this.#advance(this.#o.ledger.get(last.id)); } catch (e) { this.#o.log.warn('coding', 'Nova couldn’t pick a coding run up again after a restart.', { run: r.id, error: (e as Error).message }); }
    }
  }

  // Every preview stops when Nova does (children.ts would end them anyway).
  close(): void {
    for (const [id] of this.#previews) this.#stopPreview(id, 'Nova stopped');
  }
}
