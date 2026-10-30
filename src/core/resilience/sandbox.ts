// A sandbox Nova (M7 plan §2–§3): a real server process started from some code (this Nova's own,
// or a release's) on a scratch home, on a port of its own, that can do nothing outside itself. It
// is M7a's sandbox mode (changes/sandbox.ts): NOVA_SANDBOX=1, so no heartbeat, schedules,
// connectors, capture or model watch start, no mesh address, a model command that does nothing, a
// vault key file of its own; and its database is made inert first (`inert`: queued work cancelled,
// rules paused, providers and connectors off, no device addresses). M7a's Sandbox class snapshots
// the live database in process and runs this Nova's own code; these two uses need a release's
// code from another process (the supervisor) and a restored backup (the drill), so they start the
// process here and share the rest.
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { backupFiles } from './backup.ts';
import { inert } from '../changes/sandbox.ts';

export { inert };

// This Nova's own code: the folder that holds src/server.js.
export const CODE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface Sandbox { proc: ChildProcess; port: number; base: string; output: () => string; stop: () => Promise<void> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The environment a sandbox gets: only what it needs to run, never the caller's secrets or mesh.
export function sandboxEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: join(home, '..', 'user'),
    TZ: process.env.TZ ?? 'UTC',
    NOVA_HOME: home,
    NOVA_PORT: '0',
    NOVA_SANDBOX: '1',
    NOVA_VAULT_KEY: 'file',
    NOVA_AGENT_CMD: 'false',
    NOVA_AGENT_EGRESS: 'none',
    // A closed port: a sandbox never reaches the person's model runtime.
    NOVA_OLLAMA_URL: 'http://127.0.0.1:9',
    ...extra,
    // Loopback only, whatever else is passed: a sandbox is never reachable from another machine.
    NOVA_HOST: '127.0.0.1',
  };
}

// Starts `node <root>/src/server.js` on `home` and waits until it says it is ready (or gives up).
export async function startSandbox(o: { root?: string; home: string; env?: Record<string, string>; timeoutMs?: number; execArgv?: string[] }): Promise<Sandbox> {
  const root = o.root ?? CODE_ROOT;
  const out: string[] = [];
  const proc = spawn(process.execPath, [...(o.execArgv ?? []), join(root, 'src', 'server.js')], { cwd: root, env: sandboxEnv(o.home, o.env), stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout!.on('data', (d) => out.push(String(d)));
  proc.stderr!.on('data', (d) => out.push(String(d)));
  const said = () => out.join('');
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.kill('SIGTERM');
    for (let i = 0; i < 200 && proc.exitCode === null && proc.signalCode === null; i++) await sleep(25);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  };
  const until = Date.now() + (o.timeoutMs ?? 30_000);
  while (Date.now() < until && !/Nova is ready at/.test(said()) && proc.exitCode === null && proc.signalCode === null) await sleep(25);
  const port = Number(/Nova is ready at http:\/\/[^:]+:(\d+)/.exec(said())?.[1]);
  if (!(port > 0)) {
    await stop();
    const tail = said().trim().split('\n').slice(-12).join('\n');
    throw new Error(proc.exitCode !== null ? `The sandbox Nova stopped as it started (exit ${proc.exitCode}):\n${tail}` : `The sandbox Nova didn’t start in time:\n${tail}`);
  }
  return { proc, port, base: `http://127.0.0.1:${port}`, output: said, stop };
}

// A copy of a live home to run something on: a consistent snapshot of its database (taken while
// Nova runs; WAL lets this read beside it) and the files a backup would carry. Secrets stay
// behind, as in a backup: the vault's key and this node's private keys.
export function copyHome(from: string, to: string): void {
  if (existsSync(to) && readdirSync(to).length) throw new Error(`${to} isn’t empty.`);
  mkdirSync(to, { recursive: true });
  for (const rel of backupFiles(from)) {
    const dst = join(to, rel);
    mkdirSync(join(dst, '..'), { recursive: true });
    try { copyFileSync(join(from, rel), dst); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  const live = join(from, 'nova.db');
  if (existsSync(live)) {
    const db = new DatabaseSync(live);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(`VACUUM INTO '${join(to, 'nova.db').replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    inert(join(to, 'nova.db'));
  }
}

// What a smoke probe asks a running Nova, in order, and what each answer must show.
export interface ProbeResult { name: string; ok: boolean; said: string }

// `ignore`: health checks that are expected to fail here and say nothing about the code or the
// data (a restored copy's vault has no key, by design; a check that was already failing on the
// live home before a deploy).
export async function smoke(base: string, expect: { memories?: number; ignore?: string[] } = {}): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [];
  const get = async (path: string) => {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const probe = async (name: string, fn: () => Promise<{ ok: boolean; said: string }>) => {
    try { out.push({ name, ...(await fn()) }); } catch (e) { out.push({ name, ok: false, said: `No answer: ${(e as Error).message}` }); }
  };
  await probe('health', async () => {
    const r = await get('/api/v1/health');
    const failing = r.body?.checks ? Object.entries(r.body.checks as Record<string, { ok: boolean; detail?: string }>).filter(([, c]) => !c.ok) : [];
    const bad = failing.filter(([k]) => !expect.ignore?.includes(k)).map(([k, c]) => `${k}: ${c.detail ?? 'not ok'}`);
    const ok = r.status === 200 && !!r.body?.checks && !bad.length;
    const set = failing.filter(([k]) => expect.ignore?.includes(k)).map(([k]) => k);
    return { ok, said: ok ? `Healthy (${r.body.checks?.database?.detail ?? 'database answers'})${set.length ? `; set aside as expected here: ${set.join(', ')}` : ''}.` : `Not healthy (${r.status}): ${bad.join('; ') || 'no answer'}` };
  });
  await probe('setup', async () => {
    const r = await get('/api/v1/setup');
    return { ok: r.status === 200 && typeof r.body?.done === 'boolean', said: r.status === 200 ? `Setup ${r.body.done ? 'done' : 'not done yet'}.` : `Setup didn’t answer (${r.status}).` };
  });
  await probe('ledger', async () => {
    const r = await get('/api/v1/tasks?limit=5');
    return { ok: r.status === 200 && Array.isArray(r.body), said: r.status === 200 ? 'The Work Ledger answers.' : `The Work Ledger didn’t answer (${r.status}).` };
  });
  await probe('memory', async () => {
    const r = await get('/api/v1/memory');
    if (r.status !== 200 || !Array.isArray(r.body)) return { ok: false, said: `Memory didn’t answer (${r.status}).` };
    if (expect.memories !== undefined && r.body.length !== expect.memories) return { ok: false, said: `Memory has ${r.body.length} records; the database has ${expect.memories}.` };
    return { ok: true, said: `Memory answers with ${r.body.length} record${r.body.length === 1 ? '' : 's'}.` };
  });
  await probe('problems', async () => {
    const r = await get('/api/v1/problems?open=1');
    return { ok: r.status === 200 && Array.isArray(r.body), said: r.status === 200 ? 'Problems are listed.' : `Problems didn’t answer (${r.status}).` };
  });
  return out;
}
