// The supervisor under test, as a real process, with releases that are real git tags. The release
// repository is a scratch one made from this working tree (never the project's own repository, so
// no tag or worktree lands there), and every home, state folder and port is the test's own.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COPY = ['src', 'ui', 'templates', 'design-systems', 'package.json', 'package-lock.json'];

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=Nova Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: repo, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

// A repository whose first tag is this working tree as it is, plus a release test that passes.
export function releaseRepo(dir: string) {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  for (const p of COPY) cpSync(join(ROOT, p), join(repo, p), { recursive: true, filter: (src) => !src.includes('node_modules') });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(join(repo, 'tests', 'release.test.js'), "import { test } from 'node:test';\ntest('the release starts its own checks', () => {});\n");
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'v1.0.0');
  git(repo, 'tag', 'v1.0.0');
  return {
    repo,
    // A new tagged release: `change` edits the tree before the commit.
    tag(version: string, change: (root: string) => void) {
      git(repo, 'checkout', '-q', '--detach', 'v1.0.0');
      change(repo);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', version);
      git(repo, 'tag', version);
      git(repo, 'checkout', '-q', 'main');
    },
    edit(root: string, file: string, from: string, to: string) {
      const p = join(root, file);
      const text = readFileSync(p, 'utf8');
      assert.ok(text.includes(from), `${file} has the text the change replaces`);
      writeFileSync(p, text.replace(from, to));
    },
    nextMigration(root: string): string {
      const n = readdirSync(join(root, 'src', 'core', 'migrations')).filter((f) => /^\d{4}_/.test(f)).length + 1;
      return String(n).padStart(4, '0');
    },
  };
}

export interface Supervised { proc: ChildProcess; out: string[]; dir: string; home: string; state: () => any; port: () => number | null; base: () => string; stop: () => Promise<void> }

// Starts `node src/supervisor/main.ts run` for a fresh home, and waits until Nova answers.
export async function supervise(o: { dir: string; repo: string; env?: Record<string, string>; timings?: Record<string, number>; wait?: boolean }): Promise<Supervised> {
  const home = join(o.dir, 'home');
  const state = join(o.dir, 'sup');
  const out: string[] = [];
  const timings = { backoffMs: 200, maxBackoffMs: 1000, crashes: 3, windowMs: 20_000, healthEveryMs: 400, healthFailures: 3, readyMs: 30_000, canaryMs: 3000, probeEveryMs: 400, testsMs: 120_000, ...o.timings };
  const proc = spawn(process.execPath, ['src/supervisor/main.ts', 'run', '--home', home, '--dir', state, '--repo', o.repo, '--tests', 'node --test tests/release.test.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: join(o.dir, 'user'), TZ: 'UTC', NOVA_PORT: '0', NOVA_VAULT_KEY: 'file', NOVA_AGENT_EGRESS: 'none', NOVA_SUPERVISOR_TIMINGS: JSON.stringify(timings), ...o.env },
  });
  proc.stdout!.on('data', (d) => out.push(String(d)));
  proc.stderr!.on('data', (d) => out.push(String(d)));
  const read = () => { try { return JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')); } catch { return null; } };
  const s: Supervised = {
    proc, out, dir: state, home, state: read,
    port: () => read()?.server?.port ?? null,
    base: () => `http://127.0.0.1:${read()?.server?.port}`,
    async stop() {
      const pid = read()?.server?.pid as number | null;
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
        for (let i = 0; i < 400 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(25);
      }
      // The server is the supervisor's child, which this test started: never left running.
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    },
  };
  if (o.wait !== false) await until(() => s.state()?.mode === 'running' && !!s.port(), `the supervisor’s Nova to be running:\n${out.join('')}`);
  return s;
}

export async function until(ok: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(50);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

export async function api(base: string, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

// The command line, as the person runs it.
export function cli(dir: string, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['src/supervisor/main.ts', ...args, '--dir', dir], { cwd: ROOT, env: { PATH: process.env.PATH ?? '' } });
    const out: string[] = [];
    p.stdout.on('data', (d) => out.push(String(d)));
    p.stderr.on('data', (d) => out.push(String(d)));
    p.on('close', (code) => resolve({ code, out: out.join('') }));
  });
}

export const scratch = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
