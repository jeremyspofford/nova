// Running the real server as its own process, as a new user would, with the egress tripwire
// preloaded. Shared by the gate tests.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withPasskey } from './passkey-support.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A process and everything it has printed so far (stdout and stderr, in the order they arrived).
export interface Output { proc: ChildProcess; out: string[] }
export interface Running extends Output { port: number; mesh: string | null }

// Ceilings, not paces: each wait below ends the moment its event happens (a line printed, the
// process gone); these only bound a server that never gets there.
// wait: expiry. Starting is CPU-bound (Node type-stripping and compiling the source, then a fresh
// home's migrations and built-ins), so it stretches with load: 0.47–0.50 s from spawn to "Nova is
// ready" on an idle machine, up to 3.1 s alone beside 40 busy loops on 20 CPUs, and up to 11.1 s
// (11076 ms) with the whole acceptance suite running beside those 40 busy loops. This bounds a hung
// server at about 2.7 times that worst measured start.
export const START_MS = 30_000;
// wait: expiry. A restart in place (a restore or a factory reset finishing what was staged): the
// server stops its work, swaps what is in its home and starts again in the same process, so it is
// a stop and a start back to back. With the whole acceptance suite running beside 40 busy loops on
// 20 CPUs, nine restarts timed from the printed line took 3.0–5.3 s; polled for, as they were before,
// they took up to 8.6 s, and once more than 11.8 s (the poll gave up there and m7-checkpoints
// failed). This allows five times that.
export const RESTART_MS = 60_000;
// wait: expiry. A stop is SIGTERM, then the server's quit (its work stopped within 2 s, the core
// closed). In the same loaded runs the slowest stop measured was 2095 ms.
export const STOP_MS = 5_000;

// Processes whose output has been read to the end ('close'), for a wait that begins after that.
const closed = new WeakSet<ChildProcess>();
const gone = (proc: ChildProcess) => proc.exitCode !== null || proc.signalCode !== null;

// Collects everything a process prints, from the moment it is spawned (call it straight after
// spawn, before any output can go unread), for `said` and `saidTimes` to wait on.
export function output(proc: ChildProcess): Output {
  const out: string[] = [];
  proc.stdout!.on('data', (d) => out.push(String(d)));
  proc.stderr!.on('data', (d) => out.push(String(d)));
  proc.once('close', () => closed.add(proc));
  return { proc, out };
}

// The first match of `re` in everything the process has printed, as soon as it is printed. Fails if
// the process can't be started, or ends (its output read to the end) without printing it, or after
// `ms`.
export function said(r: Output, re: RegExp, ms: number, what: string): Promise<RegExpExecArray> {
  return heard(r, (text) => re.exec(text), ms, what);
}

// Once the process has printed `re` `n` times in all, as soon as it does (a server restarting in
// place says it is ready once more each time). Resolves with the count.
export function saidTimes(r: Output, re: RegExp, n: number, ms: number, what: string): Promise<number> {
  const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return heard(r, (text) => { const c = text.match(all)?.length ?? 0; return c >= n ? c : null; }, ms, what);
}

function heard<T>(r: Output, find: (text: string) => T | null, ms: number, what: string): Promise<T> {
  const { proc, out } = r;
  return new Promise((resolve, reject) => {
    const check = () => {
      const m = find(out.join(''));
      if (m !== null) { done(); resolve(m); }
      return m !== null;
    };
    const fail = (why: string) => { done(); reject(new Error(`${what} (${why}):\n${out.join('')}`)); };
    // 'close', not 'exit': it comes once the last of the output has been read.
    const onClose = () => { if (!check()) fail('the process ended'); };
    const onError = (e: Error) => fail(e.message);
    // wait: expiry (START_MS, RESTART_MS above, or the caller's own).
    const timer = setTimeout(() => fail(`nothing within ${ms} ms`), ms);
    const done = () => {
      clearTimeout(timer);
      proc.stdout!.off('data', check);
      proc.stderr!.off('data', check);
      proc.off('close', onClose);
      proc.off('error', onError);
    };
    // Added after output()'s own listeners, so `out` already holds a chunk when this sees it.
    proc.stdout!.on('data', check);
    proc.stderr!.on('data', check);
    proc.once('close', onClose);
    proc.once('error', onError);
    if (!check() && closed.has(proc)) fail('the process ended');
  });
}

// True once the process has exited (at once if it already has), false if `ms` passes first.
export function exited(proc: ChildProcess, ms: number): Promise<boolean> {
  if (gone(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    // wait: expiry (STOP_MS above).
    const timer = setTimeout(() => { proc.off('exit', onExit); resolve(false); }, ms);
    proc.once('exit', onExit);
  });
}

export async function start(env: Record<string, string>): Promise<Running> {
  const proc = spawn(process.execPath, ['--import', join(ROOT, 'tests/acceptance/egress-guard.ts'), 'src/server.js'], { cwd: ROOT, env: { ...env, PATH: env.PATH ?? process.env.PATH ?? '' } });
  const r: Running = { ...output(proc), port: 0, mesh: null };
  const { out } = r;
  try {
    // The server picks its own free port (NOVA_PORT=0) and says which, so no other test can take
    // it between choosing and binding.
    const ready = await said(r, /Nova is ready at http:\/\/[^:]+:(\d+)/, START_MS, 'server did not start');
    r.port = Number(ready[1]);
    assert.ok(r.port > 0, `no port in:\n${out.join('')}`);
    // With a mesh listener, it is ready only once that is listening too (it says where; with port 0
    // in NOVA_MESH_URL that is the port it chose).
    if (env.NOVA_MESH_URL) r.mesh = (await said(r, /Devices pair and connect at (\S+) /, START_MS, 'the mesh listener did not start'))[1]!;
  } catch (e) {
    // A server that never said it was ready is still a process: end it before failing, or it
    // outlives the test.
    await halt(r);
    throw e;
  }
  return r;
}

export async function stop(r: Running) {
  r.proc.kill('SIGTERM');
  await exited(r.proc, STOP_MS);
}

// Cleanup's stop: whatever state the server is in, it is gone when this returns (SIGTERM, as
// `stop`, then SIGKILL if it hasn't exited within the same STOP_MS).
export async function halt(r: { proc: ChildProcess }) {
  if (gone(r.proc) || r.proc.pid === undefined) return;
  r.proc.kill('SIGTERM');
  if (await exited(r.proc, STOP_MS)) return;
  const dead = new Promise<void>((ok) => r.proc.once('exit', () => ok()));
  r.proc.kill('SIGKILL');
  await dead;
}

// A blank machine: its own user folder and Nova home, an empty egress log. `start` sets the port.
// Given the test's context, cleanup is registered as it is created: when the test ends, passing or
// failing at any point, every server it started is halted and the folder removed.
export function blank(prefix: string, t?: { after(fn: () => Promise<void>): unknown }) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const started: Running[] = [];
  t?.after(async () => {
    for (const r of started) await halt(r);
    rmSync(dir, { recursive: true, force: true });
  });
  const egress = join(dir, 'egress.log');
  writeFileSync(egress, '');
  const home = join(dir, 'nova-home');
  // The vault's key in a file: a test server never reaches a real keychain (src/core/vault.ts).
  const env = { HOME: join(dir, 'user'), NOVA_HOME: home, NOVA_PORT: '0', NOVA_EGRESS_LOG: egress, TZ: 'UTC', NOVA_VAULT_KEY: 'file' };
  const m = {
    dir, home, egress, env, base: '',
    async start(extra: Record<string, string> = {}) {
      const r = await start({ ...env, ...extra });
      started.push(r);
      m.base = `http://127.0.0.1:${r.port}`;
      return r;
    },
    get: async (p: string) => (await fetch(m.base + p)).json(),
    // As Nova's own screen does, a request with confirm: true carries a passkey approval of exactly
    // it (T2; passkey-support.ts). `plain` sends what it is given, as any other program could.
    send: async (method: string, p: string, body?: unknown, headers: Record<string, string> = { 'x-nova': '1' }) => m.plain(method, p, await withPasskey(m.plain, m.base, method, p, body, headers), headers),
    plain: async (method: string, p: string, body?: unknown, headers: Record<string, string> = { 'x-nova': '1' }) => {
      const res = await fetch(m.base + p, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
  return m;
}

// A state poll, for what nothing announces (a row in the API, a file on disk, another process's
// pid): `read` again and again until `done` holds, or until `ms` has passed, and the last value
// either way (the caller's assertion says what was expected).
// wait: expiry. Time, not a count of tries: each try is a read as well as a pause, and a read of a
// loaded server can take seconds, so 200 tries of 25 ms meant anything from 5 s up. In six runs of
// the whole acceptance suite beside 40 busy loops on 20 CPUs, the slowest poll at this default took
// 6.3 s (6297 ms, nearly all of it one read of the hub); the waits with a longer ceiling of their own
// (m7a-changes' 40 s) took up to 16.2 s. This allows about 4.8 times the slowest.
export const UNTIL_MS = 30_000;
// wait: poll. 25 ms between reads, so a state is seen within a read and 25 ms of reaching it.
const POLL_MS = 25;

export async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = UNTIL_MS): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) {
    await sleep(POLL_MS);
    v = await read();
  }
  return v;
}
