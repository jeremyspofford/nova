// Spawn a real Hub for an E2E journey: fresh data directory, chosen port, restartable.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunningHub {
  url: string;
  dataDir: string;
  /** The one-time setup link printed on first start, if any. */
  setupCode: string | null;
  /** Milliseconds from spawn until /api/v1/health answered. */
  startMs: number;
  stop(): Promise<void>;
}

export async function startHub(opts: {
  port: number;
  dataDir?: string;
  /** Node options before the entry point (for example `--import` of a test preload). */
  nodeArgs?: string[];
  /** Hub arguments after the entry point (for example `--allow-test-policy`). */
  args?: string[];
  /** Extra environment for the Hub process. */
  env?: Record<string, string>;
}): Promise<RunningHub> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), 'nova-e2e-'));
  const t0 = Date.now();
  const child: ChildProcess = spawn(
    process.execPath,
    [...(opts.nodeArgs ?? []), 'apps/hub/src/main.ts', ...(opts.args ?? [])],
    {
      env: {
        ...process.env,
        NOVA_DATA_DIR: dataDir,
        NOVA_PORT: String(opts.port),
        NOVA_PORT_FALLBACKS: '0',
        NOVA_LOG_LEVEL: 'warn',
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  const url = `http://127.0.0.1:${opts.port}`;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`hub exited early (${child.exitCode})`);
    try {
      const res = await fetch(`${url}/api/v1/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > 20_000) throw new Error('hub did not start within 20 s');
    await new Promise((r) => setTimeout(r, 50));
  }
  const startMs = Date.now() - t0;
  // The setup link is printed right after listening; give stdout a moment.
  for (let i = 0; i < 20 && !out.includes('#setup='); i++)
    await new Promise((r) => setTimeout(r, 25));
  const code = /#setup=([A-Za-z0-9_-]+)/.exec(out)?.[1] ?? null;
  return {
    url,
    dataDir,
    setupCode: code,
    startMs,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}
