// The sandbox (M7 plan §1, stage 1): an isolated copy of the person's Nova that a change is tried
// on, never the live home. A scratch home is built from a consistent `VACUUM INTO` snapshot of the
// database plus the files the change needs, and a Nova process of its own starts on it, bound to
// loopback on a port it picks (resilience's `startSandbox`, with this sandbox's env on top). The
// copy is made inert first: nothing that was queued runs, the person's own rules are paused,
// providers and connectors are off, and no device addresses are kept, so a sandbox never reaches
// anyone. It keeps no secrets: the vault isn't copied.
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import { inert, startSandbox, type Sandbox as Started } from '../resilience/sandbox.ts';

const STANDING = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md'];
const READY_MS = 30_000;

export interface SandboxInfo { home: string; port: number; pid: number; snapshot_bytes: number; started_ms: number; copied: string[] }

// Only what a Nova process needs to start, and the egress tripwire's settings when one is loaded
// (tests): nothing else from this process's environment reaches the sandbox (no secrets, no mesh).
// Each is passed only when set here (TZ too: not the UTC that `sandboxEnv` would otherwise give).
const PASS_ENV = ['PATH', 'TZ', 'LANG', 'NOVA_EGRESS_LOG', 'NOVA_EGRESS_ALLOW', 'SYSTEMROOT'];

// What this sandbox adds to `startSandbox`'s own env, and the Node flags it keeps.
export function changesLaunch(timezone?: string, env: NodeJS.ProcessEnv = process.env, execArgv: string[] = process.execArgv): { env: Record<string, string | undefined>; execArgv: string[] } {
  const extra: Record<string, string | undefined> = {};
  for (const k of PASS_ENV) extra[k] = env[k];
  Object.assign(extra, {
    NOVA_TEST_CLOCK: '1',
    // The sandbox's chat model is declared remote and never runs: it is what the privacy probe
    // must refuse a local-only task to. Its Ollama address is a closed port (`sandboxEnv`).
    NOVA_AGENT_EGRESS: 'remote',
    ...(timezone ? { NOVA_TZ: timezone } : {}),
  });
  // The same Node and preloads as this process (the egress tripwire in tests), never its other flags.
  const preload: string[] = [];
  execArgv.forEach((a, i) => {
    if (a === '--import' || a === '--require') { const v = execArgv[i + 1]; if (v) preload.push(a, v); }
    else if (a.startsWith('--import=') || a.startsWith('--require=')) preload.push(a);
  });
  return { env: extra, execArgv: preload };
}

export class Sandbox {
  readonly dir: string;
  readonly home: string;
  #sb: Started | null = null;
  #said: () => string = () => '';
  port = 0;
  info: SandboxInfo | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.home = join(dir, 'home');
  }

  // Builds the scratch home and starts Nova on it. `files`: home-relative paths to copy as well.
  async start(o: { db: Db; liveHome: string; files?: string[]; timezone?: string; signal?: AbortSignal }): Promise<SandboxInfo> {
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
    // Its HOME (`sandboxEnv`: beside the scratch home), made here.
    mkdirSync(join(this.dir, 'user'), { recursive: true });
    const launch = changesLaunch(o.timezone);
    try {
      this.#sb = await startSandbox({ home: this.home, env: launch.env, execArgv: launch.execArgv, timeoutMs: READY_MS, ...(o.signal ? { signal: o.signal } : {}) });
    } catch (e) {
      const f = e as Error & { output?: string; exitCode?: number | null };
      const said = f.output ?? '';
      this.#said = () => said;
      if (f.message === 'stopped') throw f;
      throw new Error(f.exitCode != null ? `the sandbox Nova stopped as it started: ${said.slice(-400)}` : `the sandbox Nova didn’t start within ${READY_MS / 1000} s.`);
    }
    this.#said = this.#sb.output;
    this.port = this.#sb.port;
    this.info = { home: this.home, port: this.port, pid: this.#sb.proc.pid!, snapshot_bytes: statSync(dbFile).size, started_ms: Math.round(performance.now() - began), copied };
    return this.info;
  }

  output(): string {
    return this.#said();
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
    const sb = this.#sb;
    this.#sb = null;
    await sb?.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
