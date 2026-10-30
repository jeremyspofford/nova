#!/usr/bin/env node
// A stand-in Relay (a standalone worker service, M8 plan §2) speaking its HTTP contract v1
// (tests/support/relay-contract-v1.json, a copy of Relay v0.9.0's contract/v1.json): loopback HTTP,
// no auth, the X-Relay-Client header and a JSON body of at most 32 KB on every POST and PATCH, the
// Host check, one run slot (409 runtime_busy), and runs whose record is read from "saved state".
// Workers are scripted, never a model: each run gets a real git worktree of the connected repository
// at baseCommit, on branch relay/<runId>, and the script's writes are made in it. Relay's review is
// then read from that worktree with git, as Relay does.
//
// As a module (tests):
//   const r = await startFakeRelay({ mode: 'honest', workerEgress: 'local' });
//   r.url, r.requests (method, path, headers, body), r.cancels (run ids), r.runs (live records),
//   r.set({ mode, workerEgress, busy, slowMs, ... }) to change it while it runs, await r.close()
// Options:
//   mode: honest (fixes calc/sum.mjs) | lying (says it fixed it, changes nothing) | mismatched (fixes
//         it and also writes calc/notes.md, but reports only calc/sum.mjs) | failing (the worker
//         errors) | script (use `script`)
//   script: { writes: [{path, content|null}], summary, delayMs, error } — the format of Relay's own
//           fake worker fixture (test/fixtures/fake-claude-worker.mjs, FAKE_WORKER_SCRIPT)
//   busy: answer runtime_busy to the next N worker starts; slowMs: hold the run slot this long while
//   "running" (for cancel); lagMs: how stale a read of a run is (Relay saves about every 300 ms);
//   workerEgress: 'local' | 'remote:anthropic'; workers: false for no worker engine; api: 1.
// From the command line:
//   node scripts/stand-ins/fake-relay.js [--port 0] [--mode honest] [--egress local]
//   It prints "fake-relay listening at <url>".
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BODY = 32 * 1024;
const UUID = /^[a-f0-9-]{36}$/;
const COMMIT = /^[a-f0-9]{40,64}$/;
const FINAL = ['completed', 'failed', 'cancelled', 'interrupted'];
const FIXED_SUM = 'export const sum = (a, b) => a + b;\n';

const SCRIPTS = {
  honest: { writes: [{ path: 'calc/sum.mjs', content: FIXED_SUM }], summary: 'Fixed calc/sum.mjs: it subtracted instead of adding.' },
  lying: { writes: [], summary: 'Fixed calc/sum.mjs and the test passes.' },
  mismatched: { writes: [{ path: 'calc/sum.mjs', content: FIXED_SUM }, { path: 'calc/notes.md', content: 'Left a note.\n' }], summary: 'Fixed calc/sum.mjs.', reportOmits: ['calc/notes.md'] },
  failing: { writes: [], summary: '', error: 'The worker stopped: its engine reported an error.' },
};

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }).toString();
const now = () => new Date().toISOString();

/**
 * @param {{ mode?: string, script?: any, workerEgress?: string, busy?: number, slowMs?: number, lagMs?: number, workers?: boolean, api?: number, dataDir?: string, port?: number }} [opts]
 */
export function startFakeRelay(opts = {}) {
  const o = { mode: 'honest', workerEgress: 'local', busy: 0, slowMs: 0, lagMs: 0, workers: true, api: 1, ...opts };
  const data = o.dataDir ?? mkdtempSync(join(tmpdir(), 'fake-relay-'));
  const requests = [];
  const cancels = [];
  const projects = new Map();
  const tasks = new Map();
  const runs = new Map();     // live records
  const saved = new Map();    // what a read sees: the live record, as of lagMs ago
  const timers = new Set();
  const profiles = [
    { id: randomUUID(), revision: 1, name: 'Builder', description: 'Writes code in a worktree.', engine: 'claude', model: 'stand-in', effort: 'medium' },
    { id: randomUUID(), revision: 1, name: 'Second opinion', description: 'Codex, not available here.', engine: 'codex', model: 'stand-in', effort: 'low' },
  ];
  let port = 0;

  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const save = (run) => {
    const copy = structuredClone(run);
    if (o.lagMs > 0) later(o.lagMs, () => saved.set(run.id, copy));
    else saved.set(run.id, copy);
  };
  const change = (run, patch) => { Object.assign(run, patch); save(run); };
  const active = () => [...runs.values()].find((r) => !FINAL.includes(r.status));
  const engines = () => [
    { id: 'claude', label: 'Claude Code', available: o.workers, workersAvailable: o.workers, version: '0.0.0 (stand-in)', error: o.workers ? null : 'Claude Code was not found.' },
    { id: 'codex', label: 'Codex', available: false, workersAvailable: false, error: 'Codex was not found.' },
  ];

  // What changed in a worktree against its base, the way Relay reads it: tracked changes and new
  // untracked files, then the diff with untracked previews.
  function review(dir, base, omit = []) {
    const changed = git(dir, 'diff', '--name-only', '--no-renames', base).split('\n').filter(Boolean);
    const untracked = git(dir, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
    const all = [...new Set([...changed, ...untracked])].sort().filter((p) => !omit.includes(p));
    let diff = git(dir, 'diff', '--stat', '--patch', '--no-renames', base);
    for (const p of untracked) if (!omit.includes(p)) diff += `\n--- new file ${p}\n${readFileSync(join(dir, p), 'utf8').slice(0, 2000)}`;
    return { files: all.slice(0, 500), totalFiles: all.length, diff: diff.slice(0, 200_000), truncated: diff.length > 200_000 || all.length > 500 };
  }

  function launch(run, project, script) {
    const dir = join(data, 'worktrees', run.id);
    const branch = `relay/${run.id}`;
    later(5, () => {
      if (run.status !== 'starting') return;
      try {
        mkdirSync(dirname(dir), { recursive: true });
        git(project.directory, 'worktree', 'add', '-q', '-b', branch, dir, run.baseCommit);
      } catch (e) {
        change(run, { status: 'failed', error: `Worktree setup failed: ${e.message.split('\n')[0]}`, finishedAt: now() });
        return;
      }
      change(run, { status: 'running', worktree: { directory: dir, branch, baseCommit: run.baseCommit } });
      later(Math.max(5, o.slowMs, script.delayMs ?? 0), () => {
        if (run.status !== 'running') return;
        for (const w of script.writes ?? []) {
          const target = resolve(dir, w.path);
          if (isAbsolute(w.path) || !target.startsWith(dir + sep) || w.path.split('/').includes('.git')) continue;
          if (w.content === null) rmSync(target, { force: true });
          else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, w.content); }
        }
        const usage = { inputTokens: 1200, outputTokens: 80 };
        if (script.error) {
          change(run, { status: 'failed', text: '', usage, costUsd: 0, error: script.error, review: review(dir, run.baseCommit), finishedAt: now() });
          return;
        }
        change(run, { status: 'reviewing', text: script.summary ?? 'Done.', usage, costUsd: 0 });
        later(5, () => {
          if (run.status !== 'reviewing') return;
          const r = review(dir, run.baseCommit, script.reportOmits ?? []);
          const validation = { status: 'not-run', command: null, output: '', finishedAt: now() };
          change(run, { status: 'completed', review: r, validation, finishedAt: now() });
          run.handoff = {
            task: { id: run.taskId, title: tasks.get(run.taskId)?.title ?? '', outcome: tasks.get(run.taskId)?.outcome ?? '' },
            profile: { id: run.profileId, revision: run.profileRevision, engine: 'claude' },
            worktree: run.worktree, summary: run.text, skillSnapshots: [], validation, validationTree: null, review: r,
          };
        });
      });
    });
  }

  const record = (run) => {
    const r = saved.get(run.id) ?? run;
    return { id: r.id, taskId: r.taskId, projectId: r.projectId, status: r.status, text: r.text, usage: r.usage, costUsd: r.costUsd, worktree: r.worktree, validation: r.validation, review: r.review, error: r.error, createdAt: r.createdAt, finishedAt: r.finishedAt };
  };

  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const fail = (status, error, code) => send(status, code ? { error, code } : { error });
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size <= MAX_BODY + 1) chunks.push(c); }
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url, 'http://x').pathname;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* checked below */ }
    requests.push({ method: req.method, path, headers: req.headers, body });

    // Transport: the Host check, no foreign Origin, and for a mutation the header, JSON, 32 KB.
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host))) return fail(403, 'Unexpected host.');
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return fail(403, 'Cross-origin requests are refused.');
    if (req.method === 'POST' || req.method === 'PATCH') {
      if (req.headers['x-relay-client'] !== 'relay-local') return fail(403, 'Missing X-Relay-Client header.');
      if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) return fail(415, 'Send JSON.');
      if (size > MAX_BODY) return fail(413, 'Body over 32 KB.');
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, 'The body must be a JSON object.');
    }
    const route = `${req.method} ${path.replace(/^\/api\/(tasks|workers|runs)\/[^/]+/, '/api/$1/:id')}`;
    const id = /^\/api\/(?:tasks|workers|runs)\/([^/]+)/.exec(path)?.[1];

    switch (route) {
      case 'GET /api/status':
        return send(200, {
          name: 'Relay', version: '0.9.0-stand-in', api: o.api, workerEgress: o.workerEgress, mode: 'local-workers',
          features: { workers: true }, engines: engines(), dataDirectory: data,
          limits: { concurrentRuns: 1, timeoutSeconds: 600, workerTimeoutSeconds: 900, contextCharacters: 8000 },
        });
      case 'POST /api/projects': {
        if (typeof body.directory !== 'string' || !isAbsolute(body.directory)) return fail(400, 'directory is an absolute path.');
        let dir;
        let commit;
        try {
          dir = realpathSync(body.directory);
          if (realpathSync(git(dir, 'rev-parse', '--show-toplevel').trim()) !== dir) throw new Error('not the root');
          commit = git(dir, 'rev-parse', 'HEAD').trim();
        } catch { return fail(422, 'That folder is not the root of a Git repository with a commit.'); }
        // Connecting a folder again returns the record as it was, its old commit included.
        const have = [...projects.values()].find((p) => p.directory === dir);
        if (have) return send(201, have);
        const p = {
          id: randomUUID(), name: typeof body.name === 'string' ? body.name : dir.split(sep).pop(), directory: dir, commit,
          branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), dirty: git(dir, 'status', '--porcelain').trim() !== '', submodulesOmitted: false, createdAt: now(),
        };
        projects.set(p.id, p);
        return send(201, p);
      }
      case 'POST /api/tasks': {
        const { title, outcome } = body;
        if (typeof title !== 'string' || !title.length || title.length > 120) return fail(400, 'title is 1 to 120 characters.');
        if (typeof outcome !== 'string' || !outcome.length || outcome.length > 10_000) return fail(400, 'outcome is 1 to 10,000 characters.');
        const t = { id: randomUUID(), title, outcome, status: 'draft', createdAt: now(), updatedAt: now(), sourceConversationId: null };
        tasks.set(t.id, t);
        return send(201, t);
      }
      case 'PATCH /api/tasks/:id': {
        const t = tasks.get(id);
        if (!t) return fail(404, 'No such task.');
        if (!['draft', 'ready', 'archived'].includes(body.status)) return fail(400, 'status is draft, ready or archived.');
        Object.assign(t, { status: body.status, updatedAt: now() });
        return send(200, t);
      }
      case 'GET /api/state':
        return send(200, { profiles, projects: [...projects.values()], tasks: [...tasks.values()] });
      case 'POST /api/workers': {
        const b = body;
        for (const k of ['taskId', 'projectId', 'profileId', 'requestId']) if (typeof b[k] !== 'string' || !UUID.test(b[k])) return fail(400, `${k} is a UUID.`);
        if (!Number.isInteger(b.profileRevision) || b.profileRevision < 1) return fail(400, 'profileRevision is a whole number.');
        if (typeof b.baseCommit !== 'string' || !COMMIT.test(b.baseCommit)) return fail(400, 'baseCommit is a commit id.');
        if (b.context !== undefined && (typeof b.context !== 'string' || b.context.length > 8000)) return fail(400, 'context is at most 8,000 characters.');
        const check = b.check ?? 'none';
        if (!['none', 'node-test', 'npm-test'].includes(check)) return fail(400, 'check is none, node-test or npm-test.');
        if (check !== 'none' && b.allowTests !== true) return fail(422, 'Running tests needs allowTests.');
        const settings = JSON.stringify([b.taskId, b.projectId, b.profileId, b.profileRevision, b.baseCommit, b.context ?? '', check, b.allowTests ?? false]);
        const again = [...runs.values()].find((r) => r.requestId === b.requestId);
        if (again) return again.settings === settings ? send(202, { id: again.id, taskId: again.taskId, projectId: again.projectId, status: record(again).status, createdAt: again.createdAt }) : fail(409, 'That requestId was used with different settings.');
        if (o.busy > 0) { o.busy--; return fail(409, 'A run is already active. Try again when it finishes.', 'runtime_busy'); }
        if (active()) return fail(409, 'A run is already active. Try again when it finishes.', 'runtime_busy');
        const task = tasks.get(b.taskId);
        const project = projects.get(b.projectId);
        const profile = profiles.find((p) => p.id === b.profileId);
        if (!task || !project || !profile) return fail(404, 'No such task, project or profile.');
        if (task.status !== 'ready') return fail(422, 'Only a ready task can launch a worker.');
        if (profile.revision !== b.profileRevision) return fail(409, 'That profile has changed since you read it.');
        if (!engines().find((e) => e.id === profile.engine)?.workersAvailable) return fail(422, 'That profile’s engine can’t run workers.');
        const run = {
          id: randomUUID(), taskId: task.id, projectId: project.id, status: 'starting', text: '', usage: null, costUsd: null, worktree: null, validation: null, review: null, error: null,
          createdAt: now(), finishedAt: null, requestId: b.requestId, settings, baseCommit: b.baseCommit, profileId: profile.id, profileRevision: profile.revision, handoff: null,
        };
        runs.set(run.id, run);
        // A setup failure is still 202: the repository moved on from the commit asked for.
        let head = '';
        try { head = git(project.directory, 'rev-parse', 'HEAD').trim(); } catch { /* gone */ }
        if (head !== b.baseCommit) change(run, { status: 'failed', error: 'HEAD changed since baseCommit was read.', finishedAt: now() });
        else {
          save(run);
          launch(run, project, o.mode === 'script' ? o.script ?? {} : SCRIPTS[o.mode] ?? SCRIPTS.honest);
        }
        return send(202, { id: run.id, taskId: run.taskId, projectId: run.projectId, status: run.status, ...(run.error ? { error: run.error } : {}), createdAt: run.createdAt });
      }
      case 'GET /api/workers/:id': {
        const run = runs.get(id);
        if (!run || !saved.has(id)) return fail(404, 'No such worker run.');
        return send(200, record(run));
      }
      default: {
        if (req.method === 'GET' && /^\/api\/workers\/[^/]+\/handoff\.json$/.test(path)) {
          const run = runs.get(id);
          if (!run?.handoff) return fail(404, 'No handoff for that run yet.');
          return send(200, run.handoff);
        }
        if (req.method === 'POST' && /^\/api\/runs\/[^/]+\/cancel$/.test(path)) {
          const run = runs.get(id);
          if (!run) return fail(404, 'No such run.');
          if (FINAL.includes(run.status) || run !== active()) return fail(409, 'That run is not the active one.');
          cancels.push(run.id);
          change(run, { status: 'cancelling' });
          later(10, () => change(run, { status: 'cancelled', error: 'Cancelled by request.', finishedAt: now(), ...(run.worktree ? { review: review(run.worktree.directory, run.baseCommit) } : {}) }));
          return send(202, { status: 'cancelling' });
        }
        return fail(404, 'No such route.');
      }
    }
  });

  return new Promise((ok) => {
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      port = server.address().port;
      ok({
        url: `http://127.0.0.1:${port}`, port, data, requests, cancels, runs, profiles,
        set(patch) { Object.assign(o, patch); },
        close: () => new Promise((done) => {
          for (const t of timers) clearTimeout(t);
          server.closeAllConnections?.();
          server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
  const r = await startFakeRelay({ port: Number(arg('--port', '0')), mode: arg('--mode', 'honest'), workerEgress: arg('--egress', 'local') });
  console.log(`fake-relay listening at ${r.url}`);
}

