// Relay as a coding agent (M8 plan §2). Relay is a standalone worker service on this computer: it
// runs coding workers in git worktrees and reports back over its HTTP contract v1 (Relay's
// docs/contract-v1.md; a copy of contract/v1.json is in tests/support). Nova never rebuilds Relay; it
// briefs it through this adapter and checks the work itself (ADR-8).
//
// A run: the task's files (already in the task's own folder) are committed into a fresh git
// repository under Nova's state for this attempt, never inside the task's folder. That repository is
// connected to Relay as a project; the brief becomes a Relay task, marked ready; a worker starts on
// the commit with check 'none' (the test is Nova's to run, after asking). Nova polls the run, and on
// `completed` copies the files Relay lists from its worktree into the task's folder, deletions
// included, after checking the list against the worktree itself. The registry then computes the
// diff and runs the test as for any coding agent: Relay's own claim is never the verdict.
//
// Where the data goes is what Relay reports (`workerEgress` in GET /api/status), not the address:
// Relay is always on this computer, but its workers may send the brief to Anthropic.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { summarize } from './prompt.ts';
import { safePath, walk } from './taskspace.ts';
import { NO_REDIRECT, num, reachProblem, str, type Config, type Impl, type Usage, type Where, type WorkInput, type WorkOutcome } from './types.ts';

const run = promisify(execFile);

export const DEFAULT_URL = 'http://127.0.0.1:8766';
export const CONTRACT_API = 1;
const CLIENT = { 'x-relay-client': 'relay-local' };
const MAX_BODY = 32 * 1024;
const FINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const EGRESS = /^(local|remote:[a-z0-9][a-z0-9._-]{0,63})$/;
// How much of Relay's diff the artifact keeps (Relay's own is at most 200,000 characters).
const DIFF_KEPT = 64 * 1024;
export const BUSY = 'Relay is busy with another run';

// A UUID made from the brief's idempotency key and the attempt: the same attempt always asks Relay
// with the same requestId, so a retry of it never starts a second run (Relay returns the first).
export function requestId(key: string, attempt: number): string {
  const h = createHash('sha256').update(`nova-relay:${key}:${attempt}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Relay's address: http on this computer only (it binds loopback), with a port and nothing after it.
// Always reached as 127.0.0.1, so the Host Relay checks is 127.0.0.1:<port>.
export function relayBase(v: unknown): { url: string; host: string } | null {
  let u: URL;
  try { u = new URL(str(v)); } catch { return null; }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || !u.port) return null;
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return null;
  return { url: `http://127.0.0.1:${u.port}`, host: `127.0.0.1:${u.port}` };
}

// What Relay last said about itself, per address: where its workers send, and whether any engine can
// run workers. Read by `where` (which must answer at once); refreshed by every check and before
// every run.
interface Said { egress: string; workers: boolean; api: unknown }
const said = new Map<string, Said>();

interface Answer { status: number; body: Record<string, unknown> | null }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function call(base: string, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Answer> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined && Buffer.byteLength(text) > MAX_BODY) throw new Error(`what Nova would send Relay (${path}) is over 32 KB`);
  const res = await fetch(`${base}${path}`, {
    method, ...NO_REDIRECT,
    headers: text === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json', ...CLIENT },
    ...(text === undefined ? {} : { body: text }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  const raw = await res.text();
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not JSON: said below */ }
  return { status: res.status, body: isObj(parsed) ? parsed : null };
}

const relayError = (a: Answer) => (typeof a.body?.error === 'string' && a.body.error.trim() ? a.body.error.trim().replace(/\.?$/, '.') : `It answered ${a.status}.`);
const workersOf = (status: Record<string, unknown>) => (Array.isArray(status.engines) ? status.engines : []).filter((e) => isObj(e) && e.workersAvailable === true).map((e) => String((e as { id: unknown }).id));

// Asks Relay about itself and keeps the answer. A reason when it can't take work, else null.
async function status(c: Config, signal?: AbortSignal): Promise<{ problem: string | null; status: Record<string, unknown> | null }> {
  const b = relayBase(c.base_url);
  if (!b) return { problem: 'Relay’s address isn’t one on this computer.', status: null };
  let a: Answer;
  try {
    a = await call(b.url, 'GET', '/api/status', undefined, signal);
  } catch (e) {
    said.delete(b.url);
    if (signal?.aborted) throw signal.reason;
    return { problem: `Relay isn’t running at ${b.host} (${reachProblem(e)}).`, status: null };
  }
  if (a.status !== 200 || !a.body) { said.delete(b.url); return { problem: `Relay at ${b.host} didn’t answer its status (${a.status}).`, status: null }; }
  if (a.body.api !== CONTRACT_API) { said.delete(b.url); return { problem: `This Relay speaks a different contract than Nova (v${CONTRACT_API}): it says api ${JSON.stringify(a.body.api ?? null)}.`, status: a.body }; }
  const egress = typeof a.body.workerEgress === 'string' && EGRESS.test(a.body.workerEgress) ? a.body.workerEgress : 'remote:unknown';
  const workers = workersOf(a.body).length > 0;
  said.set(b.url, { egress, workers, api: a.body.api });
  if (!workers) return { problem: 'Relay has no worker engine: none of its engines can run workers right now.', status: a.body };
  return { problem: null, status: a.body };
}

// Where Relay's workers send the brief, as Relay last said.
export function relayWhere(c: Config): Where {
  const b = relayBase(c.base_url);
  const s = b ? said.get(b.url) : undefined;
  if (!s) return { coarse: 'remote', receipt: 'remote:unknown', words: 'Where Relay’s workers send the brief isn’t known until Nova has checked Relay; until then it counts as off your devices.' };
  if (s.egress === 'local') return { coarse: 'local', receipt: 'local', words: 'Relay runs on this computer, and it reports that its workers use a model on this computer too.' };
  const to = s.egress.slice('remote:'.length);
  return { coarse: 'remote', receipt: s.egress, words: `Relay runs on this computer, but it reports that its workers send the brief and the files they read to ${to === 'anthropic' ? 'Anthropic' : to}.` };
}

// ---- git, kept to the commands Nova needs, without the person's hooks or signing ----------------
const gitEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^GIT_/.test(k)) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
};
async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await run('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Nova', '-c', 'user.email=nova@localhost', '-c', 'init.defaultBranch=main', ...args], { env: gitEnv(), timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout;
}
const lines0 = (s: string) => s.split('\0').filter(Boolean);
const gitPart = (p: string) => p.split('/').some((x) => x === '.git');

// A repository holding exactly the task's files, committed once: Relay's project for this attempt.
// A fresh folder per attempt, so each is a new project at its own commit (Relay keeps a connected
// folder's commit from when it was first connected). The same attempt again reuses it.
async function baseline(cwd: string, repo: string): Promise<string> {
  try { return (await git(repo, 'rev-parse', '--verify', 'HEAD')).trim(); } catch { /* not made yet, or half made */ }
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  for (const rel of walk(cwd, (p) => gitPart(p))) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    copyFileSync(join(cwd, rel), join(repo, rel));
  }
  await git(repo, 'init', '-q');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '--allow-empty', '-m', 'Nova: the task’s files, for Relay');
  return (await git(repo, 'rev-parse', '--verify', 'HEAD')).trim();
}

// What a worktree changed against a commit, read by Nova itself: tracked changes and new files.
async function changedIn(dir: string, base: string): Promise<Set<string>> {
  const tracked = lines0(await git(dir, 'diff', '--name-only', '--no-renames', '-z', base));
  const untracked = lines0(await git(dir, 'ls-files', '--others', '--exclude-standard', '-z'));
  return new Set([...tracked, ...untracked]);
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((ok, fail) => {
  if (signal.aborted) return fail(signal.reason);
  const t = setTimeout(() => { signal.removeEventListener('abort', stop); ok(); }, ms);
  const stop = () => { clearTimeout(t); fail(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});

const list = (xs: string[]) => (xs.length > 5 ? `${xs.slice(0, 5).join(', ')} and ${xs.length - 5} more` : xs.join(', '));

export const relay: Impl = {
  id: 'relay',
  check(c: Config) {
    const out: string[] = [];
    if (str(c.base_url) && !relayBase(c.base_url)) out.push('base_url is Relay’s address on this computer (loopback), like http://127.0.0.1:8766: http, 127.0.0.1 or localhost, a port, and nothing after it.');
    if (c.profile !== undefined && (typeof c.profile !== 'string' || c.profile.length > 120)) out.push('profile is the name of a Relay profile, or empty for the first one that can run workers.');
    if (c.poll_ms !== undefined && !(Number.isInteger(c.poll_ms) && (c.poll_ms as number) >= 10 && (c.poll_ms as number) <= 60_000)) out.push('poll_ms is how often Nova reads the run, 10 to 60000 milliseconds.');
    if (c.busy_retry_s !== undefined && !(Number.isInteger(c.busy_retry_s) && (c.busy_retry_s as number) >= 1 && (c.busy_retry_s as number) <= 3600)) out.push('busy_retry_s is how long Nova waits before asking a busy Relay again, 1 to 3600 seconds.');
    return out;
  },
  unconfigured(c) {
    return relayBase(c.base_url) ? null : 'It needs Relay’s address on this computer, like http://127.0.0.1:8766.';
  },
  url: (c) => relayBase(c.base_url)?.url ?? null,
  model: (c) => `Relay worker${str(c.profile) ? ` (${str(c.profile)})` : ''}`,
  reportedWhere: relayWhere,
  plainProbe: true,
  async probe(c, _secret, signal) {
    return (await status(c, signal)).problem;
  },
  async work(i: WorkInput): Promise<WorkOutcome> {
    const usage: Usage = { model: relay.model(i.config) };
    const failed = (summary: string): WorkOutcome => ({ status: 'failed', summary, usage });
    const b = relayBase(i.config.base_url);
    if (!b || !i.cwd) return failed('Relay’s address isn’t set.');
    const attempt = i.attempt ?? 1;
    const signal = i.signal;
    const ask = (method: string, path: string, body?: unknown) => call(b.url, method, path, body, signal);

    // Relay may have changed since the registry checked; its engines decide the profile.
    const st = await status(i.config, signal);
    if (!st.status || st.problem) return { status: 'blocked', summary: st.problem ?? 'Relay didn’t answer.', blockers: [st.problem ?? 'Relay didn’t answer.'], usage };
    const workers = workersOf(st.status);

    const dir = join(i.stateDir, 'relay', `attempt-${attempt}`);
    // A run an earlier attempt left going (Nova restarted meanwhile) gives up its slot.
    const lastFile = join(i.stateDir, 'relay', 'last-run.json');
    try {
      const last = JSON.parse(readFileSync(lastFile, 'utf8')) as { attempt: number; run: string };
      if (last.attempt !== attempt) await ask('POST', `/api/runs/${encodeURIComponent(last.run)}/cancel`, {}).catch(() => null);
    } catch { /* no earlier run */ }

    let head: string;
    try { head = await baseline(i.cwd, join(dir, 'repo')); } catch (e) { return failed(`Nova couldn’t make the repository Relay works from: ${(e as Error).message.split('\n')[0]}`); }

    let runId: string;
    let profileName: string;
    try {
      const state = await ask('GET', '/api/state');
      const profiles = (Array.isArray(state.body?.profiles) ? state.body.profiles : []).filter(isObj) as { id: string; name: string; revision: number; engine: string }[];
      const want = str(i.config.profile);
      const profile = want ? profiles.find((p) => p.name === want) ?? profiles.find((p) => p.name?.toLowerCase() === want.toLowerCase()) : profiles.find((p) => workers.includes(p.engine));
      if (!profile) return failed(want ? `Relay has no profile called “${want}”. Its profiles: ${profiles.map((p) => p.name).join(', ') || 'none'}.` : 'None of Relay’s profiles uses an engine that can run workers.');
      if (!workers.includes(profile.engine)) return failed(`Relay’s profile “${profile.name}” uses ${profile.engine}, which can’t run workers there right now.`);
      profileName = profile.name;
      usage.model = `Relay worker (${profile.name})`;

      const project = await ask('POST', '/api/projects', { directory: join(dir, 'repo'), name: `nova-${i.brief.task_id.slice(0, 8)}-${attempt}` });
      if (project.status !== 201 && project.status !== 200) return failed(`Relay wouldn’t connect the task’s files: ${relayError(project)}`);
      if (project.body?.commit !== head) return failed(`Relay sees the task’s files at a different commit (${String(project.body?.commit ?? 'none').slice(0, 12)}) than Nova made (${head.slice(0, 12)}), so Nova didn’t start a worker.`);
      const goal = i.brief.goal.trim();
      const title = (goal.split('\n')[0] ?? goal).slice(0, 120).trim() || 'A task from Nova';
      const task = await ask('POST', '/api/tasks', { title, outcome: i.prompt.slice(0, 10_000) });
      if (task.status !== 201 || typeof task.body?.id !== 'string') return failed(`Relay wouldn’t take the brief: ${relayError(task)}`);
      const ready = await ask('PATCH', `/api/tasks/${encodeURIComponent(task.body.id)}`, { status: 'ready' });
      if (ready.status !== 200) return failed(`Relay wouldn’t mark the brief ready: ${relayError(ready)}`);

      const started = await ask('POST', '/api/workers', {
        taskId: task.body.id, projectId: project.body.id, profileId: profile.id, profileRevision: profile.revision, baseCommit: head,
        requestId: requestId(i.brief.idempotency_key, attempt), context: i.system.slice(0, 8000), check: 'none', allowTests: false,
      });
      if (started.status === 409 && started.body?.code === 'runtime_busy') {
        i.log('Relay is busy with another run; trying again later');
        const words = `${BUSY}. Nova asks it again by itself.`;
        // Relay turned it away before any run existed (it records a run only after this check), so
        // this isn't an attempt, and asking again later with the same requestId starts a fresh run.
        return { status: 'blocked', summary: words, blockers: [words], usage, retry_after_s: num(i.config.busy_retry_s, 30), not_started: 'Relay was busy' };
      }
      if (started.status !== 202 || typeof started.body?.id !== 'string') return failed(`Relay didn’t start a worker: ${relayError(started)}`);
      runId = started.body.id;
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      return failed(`Nova lost touch with Relay at ${b.host}: ${reachProblem(e)}.`);
    }
    mkdirSync(dirname(lastFile), { recursive: true });
    writeFileSync(lastFile, JSON.stringify({ attempt, run: runId }));
    i.log(`Relay run ${runId} started`);

    // Read the run until it ends. Relay saves its state every few hundred milliseconds, so a run just
    // started may not be readable yet, and reads may lag a step behind.
    const every = num(i.config.poll_ms, 1000);
    let rec: Record<string, unknown> | null = null;
    let misses = 0;
    try {
      for (;;) {
        let a: Answer | null = null;
        try { a = await ask('GET', `/api/workers/${encodeURIComponent(runId)}`); } catch (e) { if (signal.aborted) throw e; }
        if (a?.status === 200 && a.body) {
          misses = 0;
          rec = a.body;
          if (FINAL.has(String(rec.status))) break;
        } else if (++misses * every > 60_000) {
          return failed(`Nova lost touch with Relay’s run ${runId}: for a minute it ${a ? `answered ${a.status}` : 'didn’t answer'}.`);
        }
        await sleep(every, signal);
      }
    } catch (e) {
      if (signal.aborted) {
        // Cancelled or out of time: the run in Relay stops too.
        await call(b.url, 'POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, {}).catch(() => null);
        i.log(`asked Relay to cancel run ${runId}`);
      }
      throw e;
    }

    const why = typeof rec.error === 'string' && rec.error.trim() ? rec.error.trim().replace(/\.?$/, '.') : '';
    if (rec.status === 'failed') return failed(`Relay’s run failed${why ? `: ${why}` : '.'} Nothing was copied back.`);
    if (rec.status === 'cancelled') return failed(`Relay’s run was cancelled in Relay${why ? `: ${why}` : '.'} Nothing was copied back.`);
    if (rec.status === 'interrupted') return failed(`Relay’s run was interrupted: Relay restarted while it ran${why ? ` (${why.replace(/\.$/, '')})` : ''}. Nothing was copied back.`);

    // Completed: Relay's list of what changed, checked against its worktree, then copied in.
    const wt = isObj(rec.worktree) ? rec.worktree : null;
    const review = isObj(rec.review) ? rec.review : null;
    if (!wt || typeof wt.directory !== 'string' || !isAbsolute(wt.directory) || !existsSync(wt.directory)) return failed('Relay said the run completed but gave no worktree Nova can read. Nothing was copied back.');
    if (wt.baseCommit !== head) return failed(`Relay’s worktree starts from ${String(wt.baseCommit).slice(0, 12)}, not the commit Nova asked for (${head.slice(0, 12)}). Nothing was copied back.`);
    if (!review || !Array.isArray(review.files)) return failed('Relay said the run completed but gave no list of what changed. Nothing was copied back.');
    const listed = review.files.map(String);
    if (review.totalFiles !== listed.length) return failed(`Relay listed ${listed.length} of the ${String(review.totalFiles)} files its worker changed, so Nova can’t check what it would copy. Nothing was copied back.`);
    const bad = listed.filter((p) => !p || isAbsolute(p) || p.split('/').some((x) => x === '..' || x === '' || x === '.') || gitPart(p));
    if (bad.length) return failed(`Relay listed paths Nova won’t copy: ${list(bad)}. Nothing was copied back.`);
    let actual: Set<string>;
    try { actual = await changedIn(wt.directory, head); } catch (e) { return failed(`Nova couldn’t read Relay’s worktree: ${(e as Error).message.split('\n')[0]}. Nothing was copied back.`); }
    const unlisted = [...actual].filter((p) => !listed.includes(p)).sort();
    const unchanged = listed.filter((p) => !actual.has(p));
    if (unlisted.length || unchanged.length) {
      return failed(`Relay’s file list and its worktree differ: ${[unlisted.length ? `it changed ${list(unlisted)} without listing ${unlisted.length === 1 ? 'it' : 'them'}` : '', unchanged.length ? `it listed ${list(unchanged)}, which didn’t change` : ''].filter(Boolean).join('; ')}. Nothing was copied back.`);
    }
    // Every path is checked before anything is written, so one bad path changes nothing.
    const plan: { from: string | null; to: string }[] = [];
    try {
      for (const p of listed) {
        const from = join(wt.directory, p);
        const to = safePath(i.cwd, p).abs;
        let st = null;
        try { st = lstatSync(from); } catch { /* deleted in the worktree */ }
        if (st && !st.isFile()) throw new Error(`${p} in Relay’s worktree isn’t a plain file`);
        safePath(wt.directory, p);
        plan.push({ from: st ? from : null, to });
      }
    } catch (e) {
      return failed(`Nova didn’t copy Relay’s work: ${(e as Error).message}. Nothing was copied back.`);
    }
    for (const f of plan) {
      if (f.from) { mkdirSync(dirname(f.to), { recursive: true }); copyFileSync(f.from, f.to); }
      else if (existsSync(f.to)) unlinkSync(f.to);
    }

    const u = isObj(rec.usage) ? rec.usage : {};
    if (typeof u.inputTokens === 'number') usage.tokens_in = u.inputTokens;
    if (typeof u.outputTokens === 'number') usage.tokens_out = u.outputTokens;
    if (typeof rec.costUsd === 'number') usage.cost_usd = rec.costUsd;
    const diff = typeof review.diff === 'string' ? review.diff : '';
    return {
      status: 'done',
      summary: summarize(typeof rec.text === 'string' ? rec.text : '', 'Relay’s worker finished without a summary.'),
      usage,
      // Relay's own record of the run: where its worktree and branch are, and the diff Relay
      // reported. Provider-reported, kept for the person; Nova's own diff and test decide.
      artifacts: [{
        kind: 'relay-run', ref: runId, worktree: wt.directory, branch: String(wt.branch ?? ''), baseCommit: head, profile: profileName,
        files: listed, diff: diff.slice(0, DIFF_KEPT), diff_truncated: review.truncated === true || diff.length > DIFF_KEPT, reported_by: 'relay',
      }],
    };
  },
};
