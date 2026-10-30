// A stand-in for the Nova server, for testing the supervisor's own rules quickly and in process:
// a git repository (the release repository, and the base) whose src/server.js says it is ready,
// answers the health check and the smoke probes, says which code it is (marker.txt, as its
// version), and can ask the supervisor for a restart over the IPC channel as a repair would.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';

const SERVER = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const marker = readFileSync(new URL('../marker.txt', import.meta.url), 'utf8').trim();
const waiting = new Map();
const told = [];
process.on('message', (m) => {
  if (m && m.nova === 'reply') { waiting.get(m.id)?.(m); waiting.delete(m.id); }
  else if (m && m.nova === 'problem') told.push(m);
});
let n = 0;
const ask = (type) => new Promise((resolve) => {
  const id = 'q' + (++n);
  waiting.set(id, resolve);
  process.send({ nova: 'request', id, type });
  setTimeout(() => resolve({ ok: false, said: 'no answer' }), 5000).unref();
});
const server = createServer(async (req, res) => {
  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  const u = req.url || '';
  if (u === '/api/v1/health') return json({ ok: true, version: marker, checks: {} });
  if (u === '/api/v1/setup') return json({ done: true });
  if (u.startsWith('/api/v1/tasks') || u.startsWith('/api/v1/memory') || u.startsWith('/api/v1/problems')) return json([]);
  if (u === '/ask/restart') return json(await ask('restart'));
  if (u === '/told') return json(told);
  res.writeHead(404); res.end();
});
server.listen(Number(process.env.NOVA_PORT || 0), '127.0.0.1', () => console.log('Nova is ready at http://localhost:' + server.address().port));
process.on('SIGTERM', () => process.exit(0));
`;

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=Nova Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: repo, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

// The fake release repository, its first commit marked `marker`.
export function fakeRepo(dir: string, marker = 'one'): string {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src', 'core', 'resilience'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo, 'src', 'server.js'), SERVER);
  // Marks the code as able to run in a sandbox (releases.ts: sandboxable).
  writeFileSync(join(repo, 'src', 'core', 'resilience', 'sandbox.ts'), '// fake\n');
  writeFileSync(join(repo, 'marker.txt'), `${marker}\n`);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', marker);
  return repo;
}

// A tagged release whose marker is `marker`, made from the first commit; main is left as it was.
export function fakeRelease(repo: string, tag: string, marker: string): void {
  git(repo, 'checkout', '-q', '--detach', 'main');
  writeFileSync(join(repo, 'marker.txt'), `${marker}\n`);
  git(repo, 'commit', '-q', '-am', marker);
  git(repo, 'tag', tag);
  git(repo, 'checkout', '-q', 'main');
}

export const FAST = { backoffMs: 100, maxBackoffMs: 400, crashes: 3, windowMs: 60_000, healthEveryMs: 60_000, healthFailures: 3, readyMs: 10_000, canaryMs: 2000, probeEveryMs: 500, testsMs: 30_000 };

export async function get(base: string, path: string): Promise<any> {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(8000) });
  return r.json();
}

// One request on the control socket, as the command line sends it.
export function control(dir: string, req: Record<string, unknown>): Promise<{ ok: boolean; said: string }> {
  return new Promise((done) => {
    const sock = connect(join(dir, 'control.sock'));
    let buf = '';
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on('data', (d) => {
      buf += String(d);
      for (const line of buf.split('\n')) {
        try { const m = JSON.parse(line); if (m.done) { done({ ok: m.ok, said: m.said }); sock.destroy(); } } catch { /* partial */ }
      }
    });
    sock.on('error', (e) => done({ ok: false, said: e.message }));
  });
}
