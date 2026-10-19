// The native-shell journey's world (docs/16 §3.3): a real Hub over HTTPS with its local CA (set up
// through its own API, then restarted, as an owner would), and the shell launched with Playwright's
// Electron support into a fresh data folder.
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { request as httpsRequest } from 'node:https';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from '@playwright/test';

const DESKTOP = resolve(fileURLToPath(new URL('..', import.meta.url)));
// The checkout whose Hub the journey runs: this one, or another (NOVA_SHELL_E2E_HUB_ROOT) when the
// shell is tested against a known-good Hub build.
const ROOT = resolve(process.env.NOVA_SHELL_E2E_HUB_ROOT ?? resolve(DESKTOP, '../..'));

export async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  url: string,
  init: { method?: string; body?: unknown; token?: string; ca?: string },
): Promise<Raw> {
  const u = new URL(url);
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const data = init.body === undefined ? undefined : JSON.stringify(init.body);
  return new Promise((resolveCall, reject) => {
    const r = req(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(data ? { 'content-type': 'application/json' } : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        },
        ...(init.ca ? { ca: init.ca } : {}),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () =>
          resolveCall({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

export interface TestHub {
  /** https://127.0.0.1:<port> */
  url: string;
  /** The Hub identity's fingerprint, what devices pin. */
  fingerprint: string;
  /** An owner API call (bearer session); fails on a non-2xx answer. */
  api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T>;
  stop(): Promise<void>;
}

function spawnHub(
  port: number,
  dataDir: string,
): Promise<{ child: ChildProcess; out: () => string }> {
  const child = spawn(process.execPath, ['apps/hub/src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NOVA_DATA_DIR: dataDir,
      NOVA_PORT: String(port),
      NOVA_PORT_FALLBACKS: '0',
      NOVA_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  return Promise.resolve({ child, out: () => out });
}

async function waitHealthy(url: string, child: ChildProcess, ca?: string): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`hub exited early (${child.exitCode})`);
    try {
      const res = await call(`${url}/api/v1/health`, { ...(ca ? { ca } : {}) });
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > 30_000) throw new Error('hub did not start within 30 s');
    await new Promise((r) => setTimeout(r, 100));
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (child.exitCode !== null) return r();
    child.once('exit', () => r());
    child.kill('SIGTERM');
  });
}

/**
 * A fresh Hub, set up by its owner (the one-time setup code), switched to the local CA and
 * restarted so it serves HTTPS on 127.0.0.1.
 */
export async function startTlsHub(): Promise<TestHub> {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'nova-shell-hub-'));
  const http = `http://127.0.0.1:${port}`;
  let run = await spawnHub(port, dataDir);
  await waitHealthy(http, run.child);
  for (let i = 0; i < 40 && !run.out().includes('#setup='); i++)
    await new Promise((r) => setTimeout(r, 50));
  const code = /#setup=([A-Za-z0-9_-]+)/.exec(run.out())?.[1];
  if (!code) throw new Error('the Hub printed no setup code');
  const setup = await call(`${http}/api/v1/auth/setup`, {
    method: 'POST',
    body: { code, displayName: 'Shell tester' },
  });
  if (setup.status !== 200) throw new Error(`setup failed: ${setup.status} ${setup.body}`);
  const cookie = String(setup.headers['set-cookie'] ?? '');
  const token = /nova_session=([^;]+)/.exec(cookie)?.[1];
  if (!token) throw new Error('setup gave no session');
  const trust = await call(`${http}/api/v1/trust`, {
    method: 'PATCH',
    body: { mode: 'local-ca' },
    token,
  });
  if (trust.status !== 200) throw new Error(`trust mode failed: ${trust.status} ${trust.body}`);
  const hello = JSON.parse((await call(`${http}/api/v1/hello`, {})).body) as {
    hubFingerprint: string;
  };
  const ca = (await call(`${http}/api/v1/trust/ca.pem`, {})).body;
  await stopChild(run.child);
  run = await spawnHub(port, dataDir);
  const url = `https://127.0.0.1:${port}`;
  await waitHealthy(url, run.child, ca);
  const child = run.child;
  return {
    url,
    fingerprint: hello.hubFingerprint,
    async api<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await call(`${url}${path}`, { method, body, token, ca });
      if (res.status < 200 || res.status >= 300)
        throw new Error(`${method} ${path} → ${res.status} ${res.body}`);
      return JSON.parse(res.body) as T;
    },
    stop: () => stopChild(child),
  };
}

/** A fingerprint of some other key: what a wrong Hub would carry. */
export function otherFingerprint(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return createHash('sha256').update(raw).digest('base64url');
}

/**
 * Inside a container Chromium's OS sandbox cannot start (no user namespaces, no setuid helper),
 * so the shell runs there with `--no-sandbox`; everywhere else it keeps the sandbox. The renderers
 * run with `sandbox: true` (no Node, context isolation) either way.
 */
export function inContainer(
  exists: (p: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NOVA_SHELL_IN_CONTAINER === '1') return true;
  return exists('/.dockerenv') || exists('/run/.containerenv');
}
const SANDBOX_ARGS = inContainer() ? ['--no-sandbox'] : [];
const dataDirs = new WeakMap<ElectronApplication, string>();

/** The shell's data folder. */
export function dataDirOf(app: ElectronApplication): string {
  const dir = dataDirs.get(app);
  if (!dir) throw new Error('not a shell this test launched');
  return dir;
}

/** The shell, into a data folder of its own (or `dataDir`, to start it again). */
export async function launchShell(
  args: string[] = [],
  dataDir = mkdtempSync(join(tmpdir(), 'nova-shell-data-')),
): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [...SANDBOX_ARGS, DESKTOP, ...args],
    cwd: DESKTOP,
    env: { ...process.env, NOVA_SHELL_DATA_DIR: dataDir },
  });
  dataDirs.set(app, dataDir);
  app.process().stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    if (text.includes('[nova-shell]')) process.stderr.write(text);
  });
  return app;
}

/**
 * Open a `nova://` link the way the OS does on Linux and Windows: a second launch with the link,
 * which hands it to the running shell and exits.
 */
export function sendDeepLink(dataDir: string, link: string): Promise<number | null> {
  const bin = createRequire(import.meta.url)('electron') as unknown as string;
  const child = spawn(bin, [...SANDBOX_ARGS, DESKTOP, link], {
    cwd: DESKTOP,
    env: { ...process.env, NOVA_SHELL_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  return new Promise((r) => child.once('exit', (code) => r(code)));
}

export interface FakeNovad {
  socket: string;
  /** `ok`, or a refusal the way novad words it. */
  mode: 'ok' | 'scope_missing';
  stop(): Promise<void>;
}

/**
 * A stand-in for this computer's novad local runtime (services/novad/src/local_runtime.rs) on a
 * Unix socket: one model, a streamed answer, and the Hub's grant that can be taken away.
 */
export async function startFakeNovad(): Promise<FakeNovad> {
  const socket = join(mkdtempSync(join(tmpdir(), 'nova-shell-novad-')), 'runtime.sock');
  const fake: FakeNovad = { socket, mode: 'ok', stop: () => Promise.resolve() };
  const server = createHttpServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (fake.mode === 'scope_missing') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'policy_denied',
              message: 'the Hub has not granted this device the local runtime',
              details: { reason: 'scope_missing', scope: 'local-runtime' },
            },
          }),
        );
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:8b' }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      setTimeout(
        () => res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n'),
        50,
      );
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  fake.stop = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}
