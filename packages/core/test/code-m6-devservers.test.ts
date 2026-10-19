// Dev servers (FR-097, FR-067; docs/10 §7): detection of common frameworks and
// `.nova/launch.json`, start in the session sandbox as an exec session, the port published through
// the sandbox's bridge, the URL handed to the browser pane through the egress proxy's dev-server
// grant and opened once the server answers, stop, stop-all and exits noticed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isNovaError } from '@nova/shared';
import {
  DevServerManager,
  MAX_DEV_SERVERS,
  detectDevServers,
  type AuditRecord,
  type ExecRequest,
  type ExecRequestExtras,
  type ExecResult,
  type SandboxClient,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { SessionSandbox, makeCodeM6Env, until, type CodeM6Env } from './code-m6-env.ts';

/**
 * A sandbox with its own network, like the real substrates: a published port is reachable only
 * through the bridge it reports (here a plain TCP relay on another Hub port), closed with the
 * command.
 */
class BridgedSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly inner = new SessionSandbox();
  readonly bridges = new Map<string, { server: Server; hostPort: number; turnId: string | null }>();

  available() {
    return this.inner.available();
  }
  async exec(req: ExecRequest & ExecRequestExtras): Promise<ExecResult> {
    const r = await this.inner.exec(req);
    if (r.status !== 'running' || !req.publish) return r;
    const port = req.publish.port;
    const server = createServer((c) => {
      const u = connect(port, '127.0.0.1');
      c.on('error', () => u.destroy());
      u.on('error', () => c.destroy());
      c.pipe(u);
      u.pipe(c);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const a = server.address();
    const hostPort = typeof a === 'object' && a ? a.port : 0;
    this.bridges.set(r.sessionId, { server, hostPort, turnId: req.turnId ?? null });
    return { ...r, published: { port, hostPort } };
  }
  async poll(sessionId: string, yieldMs: number): Promise<ExecResult> {
    const r = await this.inner.poll(sessionId, yieldMs);
    if (r.status === 'exited') this.#close(sessionId);
    return r;
  }
  async write(sessionId: string, input: { signal?: 'interrupt' | 'terminate' }): Promise<void> {
    await this.inner.write(sessionId, input);
    if (input.signal === 'terminate') this.#close(sessionId);
  }
  async killTurn(turnId: string): Promise<void> {
    await this.inner.killTurn(turnId);
    for (const [id, b] of this.bridges) if (b.turnId === turnId) this.#close(id);
  }
  stop(): void {
    this.inner.stop();
    for (const id of [...this.bridges.keys()]) this.#close(id);
  }
  #close(sessionId: string): void {
    const b = this.bridges.get(sessionId);
    if (!b) return;
    this.bridges.delete(sessionId);
    b.server.close();
  }
}

let e: CodeM6Env | null = null;
let box: SessionSandbox | BridgedSandbox | null = null;
afterEach(async () => {
  box?.stop();
  await e?.close();
  e = null;
  box = null;
});

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err)) return String((err.details as { reason?: string } | undefined)?.reason);
    throw err;
  }
  throw new Error('expected a failure');
}

/** A tiny HTTP server the launch configuration starts (node is on the test host). */
const SERVER = `node -e "require('http').createServer((q,s)=>s.end('hello from dev')).listen(+process.env.PORT,'127.0.0.1')"`;

describe('dev server detection', () => {
  it('finds package.json scripts, Django, Rails, Go and launch configurations', async () => {
    e = await makeCodeM6Env();
    const dir = join(e.dir, 'proj');
    mkdirSync(join(dir, '.nova'), { recursive: true });
    mkdirSync(join(dir, 'web'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { dev: 'vite', start: 'next start', build: 'tsc' },
        devDependencies: { vite: '7.0.0' },
      }),
    );
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'manage.py'), '');
    writeFileSync(join(dir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 8.0'\n");
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    writeFileSync(join(dir, 'main.go'), 'package main\n');
    writeFileSync(
      join(dir, '.nova', 'launch.json'),
      JSON.stringify({
        configurations: [
          { name: 'web', command: 'npm run serve', cwd: 'web', port: 4000 },
          { name: 'escape', command: 'x', cwd: '../elsewhere' },
          { name: 'git', command: 'x', cwd: '.git' },
          { name: 'multi', command: 'a\nb' },
          { command: 'nameless' },
        ],
      }),
    );
    const found = await detectDevServers(dir);
    expect(found.map((c) => c.id)).toEqual([
      'launch:web',
      'pnpm:dev',
      'pnpm:start',
      'django',
      'rails',
      'go',
    ]);
    expect(found[0]).toMatchObject({ cwd: 'web', port: 4000, source: 'launch.json' });
    expect(found[1]).toMatchObject({ framework: 'Vite', command: 'pnpm dev', port: 5173 });
    expect(found[2]).toMatchObject({ framework: 'Next.js', port: 3000 });
    expect(await detectDevServers(join(e.dir, 'nothing-here'))).toEqual([]);
  });
});

/** The lowest port the kernel hands out on its own (Linux), else 32768 (below macOS's 49152 too). */
function ephemeralLow(): number {
  try {
    const low = Number(
      readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0],
    );
    return low > 20_000 ? low : 32_768;
  } catch {
    return 32_768;
  }
}

function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/**
 * A loopback port free now that the kernel never hands out by itself: below its ephemeral range.
 * A fixed port, or one from `listen(0)` closed again, is inside that range (41890-45985 on WSL),
 * so under load the kernel gives it to another socket before the dev server binds it: the server
 * exits with EADDRINUSE while whatever took the port answers the readiness check.
 */
async function freePort(): Promise<number> {
  const top = Math.min(ephemeralLow(), 32_768);
  for (let i = 0; i < 100; i++) {
    const port = 20_000 + Math.floor(Math.random() * (top - 20_000));
    if (await bindable(port)) return port;
  }
  throw new Error('no free port below the ephemeral range');
}

describe('dev servers', () => {
  it('starts a server in the session sandbox, exposes its URL through the grant, and stops it', async () => {
    box = new SessionSandbox();
    e = await makeCodeM6Env({ sandbox: box });
    // A port free right now (not a fixed one, which another suite running at once may hold).
    const port = await freePort();
    mkdirSync(join(e.repo, '.nova'));
    writeFileSync(
      join(e.repo, '.nova', 'launch.json'),
      JSON.stringify({ configurations: [{ name: 'api', command: SERVER, port }] }),
    );
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    const grants: { host: string; port: number }[] = [];
    let revoked = 0;
    e.devServers.useGrant((input) => {
      grants.push({ host: input.host, port: input.port });
      return Promise.resolve({
        url: `http://127.0.0.1:${input.port}/`,
        revoke: () => {
          revoked++;
          return Promise.resolve();
        },
      });
    });
    const opened: string[] = [];
    e.devServers.useOpener((input) => {
      opened.push(input.url);
      return Promise.resolve();
    });
    const v = await e.devServers.start(ACCOUNT, s.id, {}, 'user');
    expect(v).toMatchObject({ status: 'running', candidateId: 'launch:api', port });
    expect(v.url).toBe(`http://127.0.0.1:${port}/`);
    expect(grants).toEqual([{ host: '127.0.0.1', port }]);
    expect(opened).toEqual([v.url]);
    expect(box.reqs.at(-1)).toMatchObject({
      network: 'off',
      env: { PORT: String(port) },
      turnId: `devserver:${v.id}`,
    });
    await until(async () => {
      try {
        return (await (await fetch(v.url!)).text()) === 'hello from dev';
      } catch {
        return false;
      }
    });
    // Starting the same one again returns it.
    expect(
      (await e.devServers.start(ACCOUNT, s.id, { candidateId: 'launch:api' }, 'agent')).id,
    ).toBe(v.id);
    expect(e.events.events.find((x) => x.name === 'code.devserver.started')?.payload).toMatchObject(
      {
        serverId: v.id,
        url: v.url,
      },
    );
    const stopped = await e.devServers.stop(ACCOUNT, s.id, v.id, 'user');
    expect(stopped.status).toBe('stopped');
    expect(revoked).toBe(1);
    expect(e.events.events.some((x) => x.name === 'code.devserver.stopped')).toBe(true);
    expect(e.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['code.devserver.start', 'code.devserver.stop']),
    );
  });

  it('stops all servers of a session and notices one that exits by itself', async () => {
    box = new SessionSandbox();
    e = await makeCodeM6Env({ sandbox: box });
    mkdirSync(join(e.repo, '.nova'));
    writeFileSync(
      join(e.repo, '.nova', 'launch.json'),
      JSON.stringify({
        configurations: [
          { name: 'a', command: 'sleep 30', port: 41_001 },
          { name: 'b', command: 'sleep 30', port: 41_002 },
          { name: 'short', command: 'sleep 4; exit 2', port: 41_003 },
        ],
      }),
    );
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    await e.devServers.start(ACCOUNT, s.id, { candidateId: 'launch:a' }, 'user');
    await e.devServers.start(ACCOUNT, s.id, { candidateId: 'launch:b' }, 'user');
    const short = await e.devServers.start(ACCOUNT, s.id, { candidateId: 'launch:short' }, 'user');
    await until(async () => {
      const list = await e!.devServers.list(ACCOUNT, s.id);
      return list.find((x) => x.id === short.id)?.status === 'failed';
    }, 8_000);
    expect((await e.devServers.list(ACCOUNT, s.id)).find((x) => x.id === short.id)?.exitCode).toBe(
      2,
    );
    const all = await e.devServers.stopAll(ACCOUNT, s.id, 'user');
    expect(all.filter((x) => x.status === 'stopped')).toHaveLength(2);
  }, 15_000);

  it('refuses a server that exits at once, unknown candidates, a remote folder and too many', async () => {
    box = new SessionSandbox();
    e = await makeCodeM6Env({ sandbox: box });
    const s0 = await e.svc.create(ACCOUNT, { folder: e.repo });
    await expect(reason(e.devServers.start(ACCOUNT, s0.id, {}, 'agent'))).resolves.toBe(
      'no_dev_server',
    );
    mkdirSync(join(e.repo, '.nova'));
    writeFileSync(
      join(e.repo, '.nova', 'launch.json'),
      JSON.stringify({
        configurations: [
          { name: 'broken', command: 'echo nope; exit 1' },
          ...[1, 2, 3, 4, 5].map((i) => ({ name: `s${i}`, command: 'sleep 30', port: 42_000 + i })),
        ],
      }),
    );
    await expect(
      reason(e.devServers.start(ACCOUNT, s0.id, { candidateId: 'launch:broken' }, 'agent')),
    ).resolves.toBe('dev_server_exited');
    await expect(
      reason(e.devServers.start(ACCOUNT, s0.id, { candidateId: 'launch:none' }, 'agent')),
    ).resolves.toBe('no_dev_server');
    for (let i = 1; i <= MAX_DEV_SERVERS; i++)
      await e.devServers.start(ACCOUNT, s0.id, { candidateId: `launch:s${i}` }, 'agent');
    await expect(
      reason(e.devServers.start(ACCOUNT, s0.id, { candidateId: 'launch:s5' }, 'agent')),
    ).resolves.toBe('too_many_dev_servers');
    // Servers of sessions that are no longer active are stopped by the sweep.
    expect(await e.devServers.stopInactive(() => false)).toBe(MAX_DEV_SERVERS);
    // A session on another machine has no Hub-side dev servers yet.
    const v = await e.svc.envs.create(ACCOUNT, {
      kind: 'ssh',
      label: 'r',
      connection: { host: 'h.example', port: 22, user: 'u', auth: 'key' },
      credential: { privateKey: 'PRIVATE KEY' },
    });
    const remoteDir = join(e.dir, 'remote');
    mkdirSync(remoteDir);
    const remote = await e.svc.create(ACCOUNT, { folder: remoteDir, environmentId: v.id });
    expect(await e.devServers.detect(ACCOUNT, remote.id)).toEqual([]);
    await expect(reason(e.devServers.start(ACCOUNT, remote.id, {}, 'agent'))).resolves.toBe(
      'remote_environment',
    );
  });

  it("publishes the server's port through the sandbox's bridge and opens it once it answers", async () => {
    const bridged = new BridgedSandbox();
    box = bridged;
    e = await makeCodeM6Env({ sandbox: bridged });
    const port = await freePort();
    mkdirSync(join(e.repo, '.nova'));
    writeFileSync(
      join(e.repo, '.nova', 'launch.json'),
      JSON.stringify({
        configurations: [
          // Listens a second after it starts: the browser pane opens it once it answers.
          { name: 'slow', command: `sleep 1; ${SERVER}`, port },
          { name: 'never', command: 'sleep 30', port: await freePort() },
        ],
      }),
    );
    const audit: AuditRecord[] = [];
    const dm = new DevServerManager({
      code: e.svc,
      audit: { append: (r) => Promise.resolve(void audit.push(r)) },
      startYieldMs: 300,
      readyWaitMs: 100,
      readyTimeoutMs: 10_000,
    });
    const grants: { host: string; port: number }[] = [];
    let revoked = 0;
    dm.useGrant((input) => {
      grants.push({ host: input.host, port: input.port });
      return Promise.resolve({
        url: null,
        revoke: () => {
          revoked++;
          return Promise.resolve();
        },
      });
    });
    const opened: string[] = [];
    dm.useOpener((input) => {
      opened.push(input.url);
      return Promise.resolve();
    });
    try {
      const s = await e.svc.create(ACCOUNT, { folder: e.repo });
      const v = await dm.start(ACCOUNT, s.id, { candidateId: 'launch:slow' }, 'user');
      expect(bridged.inner.reqs.at(-1)).toMatchObject({
        network: 'off',
        env: { PORT: String(port) },
        publish: { port },
      });
      const hostPort = bridged.bridges.get(v.execSessionId!)!.hostPort;
      expect(hostPort).not.toBe(port);
      // The URL is the bridge's port on the Hub; the view keeps the server's own port.
      expect(v).toMatchObject({ status: 'running', port });
      expect(v.url).toBe(`http://127.0.0.1:${hostPort}/`);
      expect(grants).toEqual([{ host: '127.0.0.1', port: hostPort }]);
      // Not answering yet: the pane opens it in the background once it does.
      expect(opened).toEqual([]);
      await until(() => opened.length === 1, 10_000);
      expect(opened).toEqual([v.url]);
      expect(await (await fetch(v.url!)).text()).toBe('hello from dev');
      await dm.stop(ACCOUNT, s.id, v.id, 'user');
      expect(revoked).toBe(1);
      expect(bridged.bridges.size).toBe(0);
      // A server stopped before it ever answered is never opened.
      const never = await dm.start(ACCOUNT, s.id, { candidateId: 'launch:never' }, 'agent');
      await dm.stop(ACCOUNT, s.id, never.id, 'agent');
      await new Promise((r) => setTimeout(r, 600));
      expect(opened).toHaveLength(1);
      expect(revoked).toBe(2);
    } finally {
      await dm.close();
    }
  }, 20_000);

  it('needs a sandbox', async () => {
    e = await makeCodeM6Env({ sandbox: null });
    writeFileSync(join(e.repo, 'manage.py'), '');
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    await expect(e.devServers.start(ACCOUNT, s.id, {}, 'user')).rejects.toThrow(/no sandbox/);
  });
});
