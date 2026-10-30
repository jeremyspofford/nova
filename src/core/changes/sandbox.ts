// The sandbox (M7 plan §1, stage 1): an isolated copy of the person's Nova that a change is tried
// on, never the live home. A scratch home is built from a consistent `VACUUM INTO` snapshot of the
// database plus the files the change needs, and a Nova process of its own starts on it, bound to
// loopback on a port it picks. The copy is made inert first: nothing that was queued runs, the
// person's own rules are paused, providers and connectors are off, and no device addresses are
// kept, so a sandbox never reaches anyone. It keeps no secrets: the vault isn't copied.
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db.ts';

export const SERVER = fileURLToPath(new URL('../../server.js', import.meta.url));
const STANDING = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md'];
const READY_MS = 30_000;

export interface SandboxInfo { home: string; port: number; pid: number; snapshot_bytes: number; started_ms: number; copied: string[] }

// Only what a Nova process needs to start, and the egress tripwire's settings when one is loaded
// (tests): nothing else from this process's environment reaches the sandbox (no secrets, no mesh).
const PASS_ENV = ['PATH', 'TZ', 'LANG', 'NOVA_EGRESS_LOG', 'NOVA_EGRESS_ALLOW', 'SYSTEMROOT'];

export class Sandbox {
  readonly dir: string;
  readonly home: string;
  #proc: ChildProcess | null = null;
  #out: string[] = [];
  port = 0;
  info: SandboxInfo | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.home = join(dir, 'home');
  }

  // Builds the scratch home and starts Nova on it. `files`: home-relative paths to copy as well.
  async start(o: { db: Db; liveHome: string; files?: string[]; timezone?: string; server?: string; signal?: AbortSignal }): Promise<SandboxInfo> {
    const began = performance.now();
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const dbFile = join(this.home, 'nova.db');
    o.db.raw.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`);
    inert(dbFile);
    const copied: string[] = [];
    for (const rel of [...STANDING, ...(o.files ?? [])]) {
      const from = join(o.liveHome, rel);
      if (!existsSync(from)) continue;
      cpSync(from, join(this.home, rel), { recursive: true });
      copied.push(rel);
    }
    const env: Record<string, string> = {};
    for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k]!;
    Object.assign(env, {
      HOME: join(this.dir, 'user'), NOVA_HOME: this.home, NOVA_HOST: '127.0.0.1', NOVA_PORT: '0',
      NOVA_SANDBOX: '1', NOVA_TEST_CLOCK: '1', NOVA_VAULT_KEY: 'file',
      // The sandbox's chat model is declared remote and never runs: it is what the privacy probe
      // must refuse a local-only task to. Its Ollama address is a closed port.
      NOVA_AGENT_CMD: 'false', NOVA_AGENT_EGRESS: 'remote', NOVA_OLLAMA_URL: 'http://127.0.0.1:9',
      ...(o.timezone ? { NOVA_TZ: o.timezone } : {}),
    });
    mkdirSync(env.HOME!, { recursive: true });
    // The same Node and preloads as this process (the egress tripwire in tests), never its other flags.
    const preload: string[] = [];
    process.execArgv.forEach((a, i) => {
      if (a === '--import' || a === '--require') { const v = process.execArgv[i + 1]; if (v) preload.push(a, v); }
      else if (a.startsWith('--import=') || a.startsWith('--require=')) preload.push(a);
    });
    const proc = spawn(process.execPath, [...preload, o.server ?? SERVER], { cwd: join(SERVER, '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.#proc = proc;
    proc.stdout!.on('data', (d) => this.#out.push(String(d)));
    proc.stderr!.on('data', (d) => this.#out.push(String(d)));
    const end = Date.now() + READY_MS;
    while (!/Nova is ready at http:\/\/[^:]+:(\d+)/.test(this.#out.join(''))) {
      if (proc.exitCode !== null) throw new Error(`the sandbox Nova stopped as it started: ${this.output().slice(-400)}`);
      if (Date.now() > end) throw new Error(`the sandbox Nova didn’t start within ${READY_MS / 1000} s.`);
      if (o.signal?.aborted) throw new Error('stopped');
      await new Promise((r) => setTimeout(r, 25));
    }
    this.port = Number(/Nova is ready at http:\/\/[^:]+:(\d+)/.exec(this.#out.join(''))![1]);
    this.info = { home: this.home, port: this.port, pid: proc.pid!, snapshot_bytes: statSync(dbFile).size, started_ms: Math.round(performance.now() - began), copied };
    return this.info;
  }

  output(): string {
    return this.#out.join('');
  }

  // One call to the sandbox's API, as its own console would make it.
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`http://127.0.0.1:${this.port}/api/v1${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, signal: AbortSignal.timeout(60_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  // Stops the process this sandbox started (only that one) and deletes the scratch home, which held
  // a copy of the person's data.
  async stop(): Promise<void> {
    const p = this.#proc;
    this.#proc = null;
    if (p && p.exitCode === null && p.signalCode === null) {
      p.kill('SIGTERM');
      const end = Date.now() + 5000;
      while (p.exitCode === null && p.signalCode === null && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// The copy is a picture of the person's Nova, not a second one at work: what was waiting or
// running is cancelled there, their rules are paused (the change's own are what is tested),
// providers, automations and connectors are off, and devices have no addresses to reach.
function inert(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const at = new Date().toISOString();
    db.exec('UPDATE sync_state SET logging = 0 WHERE id = 1');
    db.prepare(`UPDATE task SET state = 'cancelled', reason = 'Not run in a sandbox copy.', completed_at = ?, updated_at = ? WHERE state NOT IN ('done', 'failed', 'cancelled')`).run(at, at);
    db.exec('UPDATE trigger_rule SET paused = 1');
    db.exec(`UPDATE extension SET state = 'disabled' WHERE kind IN ('agent-adapter', 'automation-adapter', 'connector')`);
    db.exec('UPDATE device SET address = NULL');
    db.exec('DELETE FROM device_session');
    db.exec('DELETE FROM sync_log');
  } finally {
    db.close();
  }
}
