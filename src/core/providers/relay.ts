// Relay as a coding agent (M8 plan §2). Relay is a standalone worker service on this computer: it
// runs coding workers in git worktrees and reports back over its HTTP contract v1 (Relay's
// docs/contract-v1.md; a copy of contract/v1.json is in tests/support). Nova never rebuilds Relay; it
// briefs it through this adapter and checks the work itself (ADR-8).
//
// A run: the task's files (already in the task's own folder) are committed into a git repository
// under Nova's state for the task, never inside the task's folder, one per content (a retry after the
// files changed gets a new one). That repository is connected to Relay as a project; the brief
// becomes one Relay task per attempt, marked ready; a worker starts on the commit with check 'none'
// (the test is Nova's to run, after asking). Nova polls the run, and on `completed` reads Relay's
// worktree itself (no git there: a plain walk, compared with its own copy), checks Relay's list of
// changes against it, and only then copies the changes into the task's folder, deletions included.
// The registry computes the diff and runs the test as for any coding agent: Relay's own claim is
// never the verdict.
//
// Where the data goes is what Relay reports (`workerEgress` in GET /api/status), not the address:
// Relay is always on this computer, but its workers may send the brief to Anthropic. It is asked
// again right before a worker starts, and the task's privacy mode decides.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { permits } from '../workers.ts';
import { summarize } from './prompt.ts';
import { safePath, walk } from './taskspace.ts';
import { NO_REDIRECT, num, reachProblem, str, type Config, type Impl, type Usage, type Where, type WorkInput, type WorkOutcome } from './types.ts';

const run = promisify(execFile);

export const DEFAULT_URL = 'http://127.0.0.1:8766';
export const CONTRACT_API = 1;
const CLIENT = { 'x-relay-client': 'relay-local' };
const MAX_BODY = 32 * 1024;
// What Nova reads of one answer from Relay, by route: GET /api/state is Relay's whole store, which
// grows with its history; a run record carries the diff (at most 200,000 characters) and the
// worker's text; everything else is small.
const MB = 1024 * 1024;
export function answerCap(method: string, path: string): number {
  if (method === 'GET' && path === '/api/state') return 64 * MB;
  if (method === 'GET' && /^\/api\/workers\/[^/]+$/.test(path)) return 8 * MB;
  return MB;
}
// How far Nova walks a worktree Relay names.
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 64;
const UUID = /^[a-f0-9-]{36}$/;
// What one task may bring back, as for every coding agent (the registry's own limits).
const MAX_FILES = 200;
const MAX_BYTES = 50 * 1024 * 1024;
const FINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const EGRESS = /^(local|remote:[a-z0-9][a-z0-9._-]{0,63})$/;
// How much of Relay's diff the artifact keeps.
const DIFF_KEPT = 64 * 1024;
export const BUSY = 'Relay is busy with another run';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

// A UUID made from the task, its idempotency key, the attempt and the commit Relay starts from. The
// same attempt from the same files always asks Relay with the same requestId, so a repeat of it never
// starts a second run (Relay returns the first); another task with a reused key gets its own.
export function requestId(taskId: string, key: string, attempt: number, base: string): string {
  const h = sha(`nova-relay:${taskId}:${key}:${attempt}:${base}`);
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
// run workers. Read by `where` (which must answer at once); refreshed by every check. A run never
// relies on it: it asks again.
interface Said { egress: string; workers: boolean }
const said = new Map<string, Said>();

interface Answer { status: number; body: Record<string, unknown> | null }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class TooBig extends Error {}

// Reads an answer up to the limit, and no further.
async function capped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { await reader.cancel().catch(() => {}); throw new TooBig(`Relay’s answer was over ${cap / MB} MB, more than Nova reads from it.`); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString('utf8');
}

// `timeoutMs`: how long to wait for the answer (0: as long as the signal allows).
async function call(base: string, method: string, path: string, body?: unknown, signal?: AbortSignal, timeoutMs = 20_000): Promise<Answer> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  if (text !== undefined && Buffer.byteLength(text) > MAX_BODY) throw new Error(`what Nova would send Relay (${path}) is over 32 KB`);
  const res = await fetch(`${base}${path}`, {
    method, ...NO_REDIRECT,
    headers: text === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json', ...CLIENT },
    ...(text === undefined ? {} : { body: text }),
    ...((): { signal?: AbortSignal } => {
      const all = [...(signal ? [signal] : []), ...(timeoutMs ? [AbortSignal.timeout(timeoutMs)] : [])];
      return all.length ? { signal: AbortSignal.any(all) } : {};
    })(),
  });
  const raw = await capped(res, answerCap(method, path));
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not JSON: said below */ }
  return { status: res.status, body: isObj(parsed) ? parsed : null };
}

const relayError = (a: Answer) => (typeof a.body?.error === 'string' && a.body.error.trim() ? a.body.error.trim().replace(/\.?$/, '.') : `It answered ${a.status}.`);
const workersOf = (status: Record<string, unknown>) => (Array.isArray(status.engines) ? status.engines : []).filter((e) => isObj(e) && e.workersAvailable === true).map((e) => String((e as { id: unknown }).id));
const company = (egress: string) => { const to = egress.slice('remote:'.length); return to === 'anthropic' ? 'Anthropic' : to; };

// Asks Relay about itself and keeps the answer. A reason when it can't take work, else null.
async function status(c: Config, signal?: AbortSignal): Promise<{ problem: string | null; status: Record<string, unknown> | null; egress: string }> {
  const b = relayBase(c.base_url);
  if (!b) return { problem: 'Relay’s address isn’t one on this computer.', status: null, egress: 'remote:unknown' };
  let a: Answer;
  try {
    a = await call(b.url, 'GET', '/api/status', undefined, signal);
  } catch (e) {
    said.delete(b.url);
    if (signal?.aborted) throw signal.reason;
    return { problem: e instanceof TooBig ? e.message : `Relay isn’t running at ${b.host} (${reachProblem(e)}).`, status: null, egress: 'remote:unknown' };
  }
  if (a.status !== 200 || !a.body) { said.delete(b.url); return { problem: `Relay at ${b.host} didn’t answer its status (${a.status}).`, status: null, egress: 'remote:unknown' }; }
  if (a.body.api !== CONTRACT_API) { said.delete(b.url); return { problem: `This Relay speaks a different contract than Nova (v${CONTRACT_API}): it says api ${JSON.stringify(a.body.api ?? null)}.`, status: a.body, egress: 'remote:unknown' }; }
  const egress = typeof a.body.workerEgress === 'string' && EGRESS.test(a.body.workerEgress) ? a.body.workerEgress : 'remote:unknown';
  const workers = workersOf(a.body).length > 0;
  said.set(b.url, { egress, workers });
  if (!workers) return { problem: 'Relay has no worker engine: none of its engines can run workers right now.', status: a.body, egress };
  return { problem: null, status: a.body, egress };
}

// Where Relay's workers send the brief, as Relay last said.
export function relayWhere(c: Config): Where {
  const b = relayBase(c.base_url);
  const s = b ? said.get(b.url) : undefined;
  if (!s) return { coarse: 'remote', receipt: 'remote:unknown', words: 'Where Relay’s workers send the brief isn’t known until Nova has checked Relay; until then it counts as off your devices.' };
  if (s.egress === 'local') {
    return { coarse: 'local', receipt: 'local', words: 'Relay runs on this computer, and it reports that its workers use a model on this computer too. Relay can only tell that the address its workers call is on this computer: a proxy there that passes calls on to the cloud would still look local.' };
  }
  return { coarse: 'remote', receipt: s.egress, words: `Relay runs on this computer, but it reports that its workers send the brief and the files they read to ${company(s.egress)}.` };
}

// ---- git, only in Nova's own repository: the commands Nova needs, without hooks, signing or an
// fsmonitor. Nova never runs git in a folder Relay names.
const gitEnv = () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^GIT_/.test(k)) env[k] = v;
  // No system or personal git settings: what is committed is the task's bytes, whatever a person's
  // excludes, line endings or attributes would do.
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
};
async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await run('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Nova', '-c', 'user.email=nova@localhost', '-c', 'init.defaultBranch=main', ...args], { env: gitEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 });
  return r.stdout;
}
const gitPart = (p: string) => p.split('/').some((x) => x === '.git');

// The task's files as they are now (never a .git), with one hash for all of them.
function snapshot(cwd: string): { files: Map<string, Buffer>; key: string } {
  const files = new Map<string, Buffer>();
  for (const rel of walk(cwd, (p) => gitPart(p))) files.set(rel, readFileSync(join(cwd, rel)));
  const key = sha([...files.entries()].map(([p, b]) => `${p}\0${sha(b)}`).join('\n'));
  return { files, key };
}

// A repository holding exactly those files, committed once. One per content: the same files reuse it
// (Relay keeps a connected folder's commit from when it was first connected, so it must not move),
// and changed files get a new one.
async function baseline(files: Map<string, Buffer>, repo: string): Promise<string> {
  if (existsSync(join(repo, '.git'))) {
    try { return (await git(repo, 'rev-parse', '--verify', 'HEAD')).trim(); } catch { /* half made: made again below */ }
  }
  const fresh = `${repo}.${process.pid}.${Date.now()}`;
  mkdirSync(fresh, { recursive: true });
  for (const [rel, data] of files) {
    mkdirSync(dirname(join(fresh, rel)), { recursive: true });
    writeFileSync(join(fresh, rel), data);
  }
  await git(fresh, 'init', '-q');
  // The task's own .gitattributes can't change the bytes either, on the way in or in Relay's
  // checkout (its worktrees share this repository's info/attributes, which come first).
  mkdirSync(join(fresh, '.git', 'info'), { recursive: true });
  writeFileSync(join(fresh, '.git', 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
  // Every file, ignored or not: Nova compares the worktree with all of them.
  await git(fresh, 'add', '-A', '-f');
  await git(fresh, 'commit', '-q', '--allow-empty', '-m', 'Nova: the task’s files, for Relay');
  // What was committed is exactly the task's files, byte for byte.
  const staged = new Map((await git(fresh, 'ls-files', '-s', '-z')).split('\0').filter(Boolean).map((l) => { const m = /^\d+ ([0-9a-f]+) \d+\t(.*)$/s.exec(l)!; return [m[2]!, m[1]!] as const; }));
  const blob = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
  if (staged.size !== files.size || [...files].some(([p, b]) => staged.get(p) !== blob(b))) throw new Error('git didn’t commit the task’s files exactly as they are');
  rmSync(repo, { recursive: true, force: true });
  renameSync(fresh, repo);
  return (await git(repo, 'rev-parse', '--verify', 'HEAD')).trim();
}

// Everything in a folder Relay names, read without following a link and without .git, by kind.
type Entry = { kind: 'file' | 'link' | 'other'; size: number };
// A file with more than one name (a hard link) counts as a link: it may be a file outside.
function survey(root: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  let seen = 0;
  const go = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error(`it is deeper than ${MAX_DEPTH} folders`);
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue;
      if (++seen > MAX_ENTRIES) throw new Error(`it has more than ${MAX_ENTRIES.toLocaleString('en-US')} entries`);
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      const st = lstatSync(abs);
      if (st.isDirectory()) go(abs, depth + 1);
      else out.set(rel, { kind: st.isFile() && st.nlink === 1 ? 'file' : st.isFile() || st.isSymbolicLink() ? 'link' : 'other', size: st.size });
    }
  };
  go(root, 1);
  return out;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((ok, fail) => {
  if (signal.aborted) return fail(signal.reason);
  const t = setTimeout(() => { signal.removeEventListener('abort', stop); ok(); }, ms);
  const stop = () => { clearTimeout(t); fail(signal.reason); };
  signal.addEventListener('abort', stop, { once: true });
});

const list = (xs: string[]) => (xs.length > 5 ? `${xs.slice(0, 5).join(', ')} and ${xs.length - 5} more` : xs.join(', '));

// What Nova keeps for one attempt: the repository it handed Relay, Relay's project and task for it,
// and the run once one exists.
interface AttemptState { repo: string; head: string; project?: string; task?: string; run?: string }

export const relay: Impl = {
  id: 'relay',
  check(c: Config) {
    const out: string[] = [];
    if (str(c.base_url) && !relayBase(c.base_url)) out.push('base_url is Relay’s address on this computer (loopback), like http://127.0.0.1:8766: http, 127.0.0.1 or localhost, a port, and nothing after it.');
    if (c.profile !== undefined && (typeof c.profile !== 'string' || c.profile.length > 120)) out.push('profile is the name of a Relay profile, or empty for the first one that can run workers.');
    if (c.poll_ms !== undefined && !(Number.isInteger(c.poll_ms) && (c.poll_ms as number) >= 10 && (c.poll_ms as number) <= 60_000)) out.push('poll_ms is how often Nova reads the run, 10 to 60000 milliseconds.');
    if (c.busy_retry_s !== undefined && !(Number.isInteger(c.busy_retry_s) && (c.busy_retry_s as number) >= 1 && (c.busy_retry_s as number) <= 3600)) out.push('busy_retry_s is how long Nova waits before asking a busy Relay again, 1 to 3600 seconds.');
    if (c.request_timeout_s !== undefined && !(Number.isInteger(c.request_timeout_s) && (c.request_timeout_s as number) >= 1 && (c.request_timeout_s as number) <= 600)) out.push('request_timeout_s is how long Nova waits for one answer from Relay, 1 to 600 seconds.');
    if (c.busy_limit !== undefined && !(Number.isInteger(c.busy_limit) && (c.busy_limit as number) >= 1 && (c.busy_limit as number) <= 10_000)) out.push('busy_limit is how many times in a row Nova asks a busy Relay before it waits for you, 1 to 10000.');
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
    const blocked = (summary: string): WorkOutcome => ({ status: 'blocked', summary, blockers: [summary], usage });
    const b = relayBase(i.config.base_url);
    if (!b || !i.cwd) return failed('Relay’s address isn’t set.');
    const cwd = i.cwd;
    const attempt = i.attempt ?? 1;
    const signal = i.signal;
    const wait = num(i.config.request_timeout_s, 20) * 1000;
    const ask = (method: string, path: string, body?: unknown) => call(b.url, method, path, body, signal, wait);
    // Where Relay says the brief would go, against the task's privacy mode: asked now, and again
    // right before a worker starts.
    const fresh = async () => {
      const st = await status(i.config, signal);
      if (!st.status || st.problem) return { refused: blocked(st.problem ?? 'Relay didn’t answer.'), st };
      if (i.privacy && !permits(i.privacy, st.egress === 'local' ? 'local' : 'remote')) {
        return { refused: blocked(`Waiting on local capacity: Relay now reports that its workers send the brief to ${company(st.egress)}, and this task is ${i.privacy}.`), st };
      }
      return { refused: null, st };
    };
    const first = await fresh();
    if (first.refused) return first.refused;

    const dir = join(i.stateDir, 'relay');
    mkdirSync(dir, { recursive: true });
    const stateFile = join(dir, `attempt-${attempt}.json`);
    const load = (f: string): AttemptState | null => { try { return JSON.parse(readFileSync(f, 'utf8')) as AttemptState; } catch { return null; } };
    const save = (s: AttemptState) => writeFileSync(stateFile, JSON.stringify(s));
    // A run an earlier attempt left going (Nova restarted meanwhile) gives up Relay's only slot.
    for (const name of readdirSync(dir)) {
      const m = /^attempt-(\d+)\.json$/.exec(name);
      const s = m && Number(m[1]) !== attempt ? load(join(dir, name)) : null;
      if (s?.run) await ask('POST', `/api/runs/${encodeURIComponent(s.run)}/cancel`, {}).catch(() => null);
    }

    // The task's files as they are now; a retry after they changed starts from the new ones.
    const now = snapshot(cwd);
    const repo = join(dir, `repo-${now.key.slice(0, 16)}`);
    let head: string;
    try { head = await baseline(now.files, repo); } catch (e) { return failed(`Nova couldn’t make the repository Relay works from: ${(e as Error).message.split('\n')[0]}`); }
    const kept = load(stateFile);
    let s: AttemptState = kept && kept.head === head && kept.repo === repo ? kept : { repo, head };

    let runId: string;
    let profileName: string;
    let seen = '';
    let dataDir = '';
    try {
      const state = await ask('GET', '/api/state');
      const profiles = (Array.isArray(state.body?.profiles) ? state.body.profiles : []).filter(isObj) as { id: string; name: string; revision: number; engine: string }[];
      const workers = workersOf(first.st.status!);
      const want = str(i.config.profile);
      const profile = want ? profiles.find((p) => p.name === want) ?? profiles.find((p) => p.name?.toLowerCase() === want.toLowerCase()) : profiles.find((p) => workers.includes(p.engine));
      if (!profile) return failed(want ? `Relay has no profile called “${want}”. Its profiles: ${profiles.map((p) => p.name).join(', ') || 'none'}.` : 'None of Relay’s profiles uses an engine that can run workers.');
      if (!workers.includes(profile.engine)) return failed(`Relay’s profile “${profile.name}” uses ${profile.engine}, which can’t run workers there right now.`);
      profileName = profile.name;
      usage.model = `Relay worker (${profile.name})`;

      let started: Answer | null = null;
      for (let round = 0; round < 2 && !started; round++) {
        // Relay's project and task for this attempt: made once, kept for its retries.
        if (!s.project) {
          const project = await ask('POST', '/api/projects', { directory: repo, name: `nova-${i.brief.task_id.slice(0, 8)}-${attempt}` });
          if (project.status !== 201 && project.status !== 200) return failed(`Relay wouldn’t connect the task’s files: ${relayError(project)}`);
          if (project.body?.commit !== head) return failed(`Relay sees the task’s files at a different commit (${String(project.body?.commit ?? 'none').slice(0, 12)}) than Nova made (${head.slice(0, 12)}), so Nova didn’t start a worker.`);
          s = { ...s, project: String(project.body.id) };
          save(s);
        }
        if (!s.task) {
          const goal = i.brief.goal.trim();
          const title = (goal.split('\n')[0] ?? goal).slice(0, 120).trim() || 'A task from Nova';
          const task = await ask('POST', '/api/tasks', { title, outcome: i.prompt.slice(0, 10_000) });
          if (task.status !== 201 || typeof task.body?.id !== 'string') return failed(`Relay wouldn’t take the brief: ${relayError(task)}`);
          const ready = await ask('PATCH', `/api/tasks/${encodeURIComponent(task.body.id)}`, { status: 'ready' });
          if (ready.status !== 200) return failed(`Relay wouldn’t mark the brief ready: ${relayError(ready)}`);
          s = { ...s, task: task.body.id };
          save(s);
        }

        // Right before the worker starts: where Relay says it would send the brief, now.
        const last = await fresh();
        if (last.refused) return last.refused;
        seen = last.st.egress;
        dataDir = typeof last.st.status!.dataDirectory === 'string' ? last.st.status!.dataDirectory : '';
        const body = {
          taskId: s.task, projectId: s.project, profileId: profile.id, profileRevision: profile.revision, baseCommit: head,
          requestId: requestId(i.brief.task_id, i.brief.idempotency_key, attempt, head), context: i.system.slice(0, 8000), check: 'none', allowTests: false,
        };
        let a: Answer;
        try {
          a = await call(b.url, 'POST', '/api/workers', body, signal, wait);
        } catch (e) {
          if (!signal.aborted && !(e instanceof TooBig)) {
            // The start may have reached Relay and the answer been lost or slow. The same request
            // again (the same requestId) names the run if one was started, so it is followed rather
            // than left behind; this time Nova waits as long as the task does.
            i.log('Relay’s answer to the start didn’t come; asking again with the same request');
            a = await call(b.url, 'POST', '/api/workers', body, signal, 0);
          } else if (signal.aborted) {
            // Cancelled with the start on its way: Relay may have started the run. The same request
            // again names it (Relay returns the run for a repeated requestId), and it is cancelled.
            const again = await call(b.url, 'POST', '/api/workers', body).catch(() => null);
            if (again?.status === 202 && typeof again.body?.id === 'string') {
              save({ ...s, run: again.body.id });
              await call(b.url, 'POST', `/api/runs/${encodeURIComponent(again.body.id)}/cancel`, {}).catch(() => null);
              i.log(`asked Relay to cancel run ${again.body.id}, started as the task was cancelled`);
            }
            throw e;
          } else throw e;
        }
        if (a.status === 409 && a.body?.code === 'runtime_busy') {
          // Relay turned it away before any run existed (it records a run only after this check), so
          // this isn't an attempt; asking again later reuses this attempt's Relay task and requestId.
          i.log('Relay is busy with another run; trying again later');
          const words = `${BUSY}. Nova asks it again by itself.`;
          return { ...blocked(words), retry_after_s: num(i.config.busy_retry_s, 30), not_started: 'Relay was busy' };
        }
        // Relay doesn't know this attempt's project or task any more (its data was reset): made again, once.
        if ((a.status === 404 || a.status === 422) && round === 0 && (kept?.task || kept?.project)) { s = { repo, head }; save(s); continue; }
        if (a.status !== 202 || typeof a.body?.id !== 'string') return failed(`Relay didn’t start a worker: ${relayError(a)}`);
        if (!UUID.test(a.body.id)) return failed(`Relay answered with a run id Nova won’t use (${JSON.stringify(a.body.id.slice(0, 60))}); a run id is a UUID.`);
        started = a;
      }
      runId = String(started!.body!.id);
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      return failed(e instanceof TooBig ? e.message : `Nova lost touch with Relay at ${b.host}: ${reachProblem(e)}.`);
    }
    save({ ...s, run: runId });
    i.log(`Relay run ${runId} started`);
    // The brief has gone to a worker: the receipt says where Relay said it would go.
    try { i.receipt?.(seen); } catch (e) {
      await call(b.url, 'POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, {}).catch(() => null);
      return failed(`Nova stopped Relay’s run: ${(e as Error).message}`);
    }

    // Read the run until it ends. Relay saves its state every few hundred milliseconds, so a run just
    // started may not be readable yet, and reads may lag a step behind.
    const every = num(i.config.poll_ms, 1000);
    let rec: Record<string, unknown> | null = null;
    let misses = 0;
    try {
      for (;;) {
        let a: Answer | null = null;
        try { a = await ask('GET', `/api/workers/${encodeURIComponent(runId)}`); } catch (e) { if (signal.aborted || e instanceof TooBig) throw e; }
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
      // Cancelled or out of time: the run in Relay stops too. So does one whose answers are too big.
      await call(b.url, 'POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, {}).catch(() => null);
      if (signal.aborted) { i.log(`asked Relay to cancel run ${runId}`); throw e; }
      if (e instanceof TooBig) return failed(`${e.message} Nothing was copied back.`);
      throw e;
    }

    const why = typeof rec.error === 'string' && rec.error.trim() ? rec.error.trim().replace(/\.?$/, '.') : '';
    if (rec.status === 'failed') return failed(`Relay’s run failed${why ? `: ${why}` : '.'} Nothing was copied back.`);
    if (rec.status === 'cancelled') return failed(`Relay’s run was cancelled in Relay${why ? `: ${why}` : '.'} Nothing was copied back.`);
    if (rec.status === 'interrupted') return failed(`Relay’s run was interrupted: Relay restarted while it ran${why ? ` (${why.replace(/\.$/, '')})` : ''}. Nothing was copied back.`);

    // Completed. The worktree must be the one Relay keeps for this run, in its own data folder.
    const wt = isObj(rec.worktree) ? rec.worktree : null;
    const review = isObj(rec.review) ? rec.review : null;
    let root: string;
    try {
      if (!wt || typeof wt.directory !== 'string' || !isAbsolute(wt.directory) || !dataDir || !isAbsolute(dataDir)) throw new Error('no worktree');
      root = realpathSync(wt.directory);
      if (root !== realpathSync(join(dataDir, 'worktrees', runId)) || !lstatSync(root).isDirectory()) throw new Error('elsewhere');
    } catch {
      return failed(`Relay’s worktree for this run isn’t in Relay’s own worktrees folder (${dataDir ? join(dataDir, 'worktrees', runId) : 'Relay didn’t say where that is'}), so Nova didn’t read it. Nothing was copied back.`);
    }
    if (wt!.baseCommit !== head) return failed(`Relay’s worktree starts from ${String(wt!.baseCommit).slice(0, 12)}, not the commit Nova asked for (${head.slice(0, 12)}). Nothing was copied back.`);
    if (!review || !Array.isArray(review.files)) return failed('Relay said the run completed but gave no list of what changed. Nothing was copied back.');
    const listed = review.files.map(String);
    if (review.totalFiles !== listed.length) return failed(`Relay listed ${listed.length} of the ${String(review.totalFiles)} files its worker changed, so Nova can’t check what it would copy. Nothing was copied back.`);
    const bad = listed.filter((p) => !p || isAbsolute(p) || p.includes('\\') || p.includes('\0') || p.split('/').some((x) => x === '..' || x === '' || x === '.') || gitPart(p));
    if (bad.length) return failed(`Relay listed paths Nova won’t copy: ${list(bad)}. Nothing was copied back.`);

    // What the worktree changed, read by Nova itself: a walk that follows no link and skips .git,
    // compared with the files Nova handed Relay.
    let found: Map<string, Entry>;
    try { found = survey(root); } catch (e) { return failed(`Nova couldn’t read Relay’s worktree: ${(e as Error).message}. Nothing was copied back.`); }
    const actual = new Set<string>();
    for (const [p, e] of found) {
      const was = now.files.get(p);
      if (e.kind !== 'file' || !was || was.length !== e.size || !was.equals(readFileSync(join(root, p)))) actual.add(p);
    }
    for (const p of now.files.keys()) if (found.get(p)?.kind !== 'file') actual.add(p);
    const unlisted = [...actual].filter((p) => !listed.includes(p)).sort();
    const unchanged = listed.filter((p) => !actual.has(p));
    if (unlisted.length || unchanged.length) {
      return failed(`Relay’s file list and its worktree differ: ${[unlisted.length ? `it changed ${list(unlisted)} without listing ${unlisted.length === 1 ? 'it' : 'them'}` : '', unchanged.length ? `it listed ${list(unchanged)}, which didn’t change` : ''].filter(Boolean).join('; ')}. Nothing was copied back.`);
    }

    // Every operation is planned and checked, and its content read, before anything is written.
    const writes: { path: string; to: string; data?: Buffer; size: number }[] = [];
    const deletes: { path: string; to: string }[] = [];
    try {
      for (const p of listed) {
        const e = found.get(p);
        const to = safePath(cwd, p).abs;
        if (!e) { deletes.push({ path: p, to }); continue; }
        if (e.kind !== 'file') throw new Error(`${p} in Relay’s worktree isn’t a plain file of its own (a link, or a file with another name elsewhere)`);
        writes.push({ path: p, to, size: e.size });
      }
      const bytes = writes.reduce((n, w) => n + w.size, 0);
      if (writes.length + deletes.length > MAX_FILES || bytes > MAX_BYTES) {
        throw new Error(`Relay’s worker changed ${writes.length + deletes.length} files (${Math.ceil(bytes / 1024 / 1024)} MB); Nova takes at most ${MAX_FILES} files and ${MAX_BYTES / 1024 / 1024} MB from one task`);
      }
      for (const w of writes) {
        const from = join(root, w.path);
        if (realpathSync(from) !== from || !lstatSync(from).isFile() || lstatSync(from).nlink !== 1) throw new Error(`${w.path} in Relay’s worktree leads somewhere else`);
        w.data = readFileSync(from);
        if (w.data.length !== w.size) throw new Error(`${w.path} changed in Relay’s worktree while Nova read it`);
      }
    } catch (e) {
      return failed(`Nova didn’t copy Relay’s work: ${(e as Error).message}. Nothing was copied back.`);
    }
    for (const d of deletes) if (existsSync(d.to) && lstatSync(d.to).isFile()) unlinkSync(d.to);
    // Folders a deletion emptied go too, so a file can take their place.
    for (const d of deletes) {
      for (let at = dirname(d.to); at.startsWith(cwd + sep); at = dirname(at)) {
        try { rmdirSync(at); } catch { break; }
      }
    }
    for (const w of writes) {
      mkdirSync(dirname(w.to), { recursive: true });
      writeFileSync(w.to, w.data!);
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
        kind: 'relay-run', ref: runId, worktree: root, branch: String(wt!.branch ?? ''), baseCommit: head, profile: profileName!, egress: seen,
        files: listed, diff: diff.slice(0, DIFF_KEPT), diff_truncated: review.truncated === true || diff.length > DIFF_KEPT, reported_by: 'relay',
      }],
    };
  },
};
