// Running the real server as its own process, as a new user would, with the egress tripwire
// preloaded. Shared by the gate tests.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const freePort = () => new Promise<number>((ok) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); });
});

export interface Running { proc: ChildProcess; out: string[] }

export async function start(env: Record<string, string>): Promise<Running> {
  const out: string[] = [];
  const proc = spawn(process.execPath, ['--import', join(ROOT, 'tests/acceptance/egress-guard.ts'), 'src/server.js'], { cwd: ROOT, env: { ...env, PATH: process.env.PATH ?? '' } });
  proc.stdout!.on('data', (d) => out.push(String(d)));
  proc.stderr!.on('data', (d) => out.push(String(d)));
  for (let i = 0; i < 200 && !out.join('').includes('Nova is ready'); i++) {
    if (proc.exitCode !== null) break;
    await sleep(25);
  }
  assert.ok(out.join('').includes('Nova is ready'), `server did not start:\n${out.join('')}`);
  return { proc, out };
}

export async function stop(r: Running) {
  r.proc.kill('SIGTERM');
  for (let i = 0; i < 200 && r.proc.exitCode === null; i++) await sleep(25);
}

// A blank machine: its own user folder and Nova home, a free port, an empty egress log.
export async function blank(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const egress = join(dir, 'egress.log');
  writeFileSync(egress, '');
  const port = await freePort();
  const home = join(dir, 'nova-home');
  const env = { HOME: join(dir, 'user'), NOVA_HOME: home, NOVA_PORT: String(port), NOVA_EGRESS_LOG: egress, TZ: 'UTC' };
  const base = `http://127.0.0.1:${port}`;
  const api = {
    get: async (p: string) => (await fetch(base + p)).json(),
    send: async (method: string, p: string, body?: unknown, headers: Record<string, string> = { 'x-nova': '1' }) => {
      const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
  return { dir, home, egress, env, base, ...api };
}

export async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, tries = 200): Promise<T> {
  let v = await read();
  for (let i = 0; i < tries && !done(v); i++) {
    await sleep(25);
    v = await read();
  }
  return v;
}
