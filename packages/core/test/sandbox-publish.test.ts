// The dev-server bridge (FR-097, FR-067; docs/11 §2.2 and §7): the Hub side (a 127.0.0.1 port
// piped to the socket the forwarder inside listens on, moved out of the sandbox's reach first,
// never a link), the forwarders on their own, the substrates' arguments (run everywhere), and,
// where bubblewrap or a container engine works, a real round trip from the Hub to a server bound
// to 127.0.0.1 inside a sandbox whose network is off.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BwrapSandbox,
  ContainerSandbox,
  DEFAULT_SANDBOX_IMAGE,
  EGRESS_MOUNT,
  FORWARDER_NODE,
  NODE_PUBLISH_FORWARDER,
  PERL_PUBLISH_FORWARDER,
  PUBLISH_MOUNT,
  PUBLISH_SOCKET,
  checkPublishPort,
  findOnPath,
  openPublish,
  publishBase,
  publishPrelude,
  seccompArch,
  type PublishBridge,
} from '../src/tools/sandbox.ts';
import type { ExecRequest, ExecResult } from '../src/tools/types.ts';

let dir: string;
beforeAll(() => {
  // Short: Unix socket paths are limited to about 100 bytes.
  dir = mkdtempSync(join(tmpdir(), 'nova-pub-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The body of one HTTP GET, or the error's code. */
async function get(port: number, path = '/'): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return await res.text();
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return `error ${cause?.code ?? String(err)}`;
  }
}

/** Raw bytes back from one connection (empty when the Hub closes it without data). */
function exchange(port: number, send = 'ping\n', ms = 3_000): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    let got = '';
    const timer = setTimeout(() => s.destroy(), ms);
    s.on('connect', () => s.write(send));
    s.on('data', (b: Buffer) => (got += b.toString('utf8')));
    s.on('error', () => undefined);
    s.on('close', () => {
      clearTimeout(timer);
      resolve(got);
    });
  });
}

/** Whether nothing listens on the Hub port any more. */
function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.on('connect', () => {
      s.destroy();
      resolve(false);
    });
    s.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED'));
  });
}

function listenUnix(path: string, answer: string): Promise<{ server: Server; hits: number[] }> {
  const hits: number[] = [];
  const server = createServer((c) => {
    hits.push(Date.now());
    c.on('error', () => undefined);
    c.resume();
    c.end(answer);
  });
  return new Promise((resolve) => server.listen(path, () => resolve({ server, hits })));
}

const closeServer = (s: Server | HttpServer) => new Promise<void>((r) => s.close(() => r()));

describe('the Hub side of the bridge', () => {
  let bridge: PublishBridge | null = null;
  afterEach(async () => {
    await bridge?.close();
    bridge = null;
  });

  it('pipes a 127.0.0.1 port to the forwarder socket, moved out of the shared folder first', async () => {
    bridge = await openPublish({ port: 5173, base: join(dir, 'b1') });
    expect(bridge.port).toBe(5173);
    expect(bridge.hostPort).toBeGreaterThan(0);
    // Only the Hub's user can enter either folder.
    expect(statSync(bridge.dir).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(bridge.dir)).mode & 0o777).toBe(0o700);
    expect(readdirSync(bridge.dir)).toEqual([]);
    // What the forwarder inside does: listen on the socket in the shared folder.
    const http = createHttpServer((q, res) => res.end(`dev ${q.url}`));
    await new Promise<void>((r) => http.listen(join(bridge!.dir, PUBLISH_SOCKET), () => r()));
    try {
      expect(await get(bridge.hostPort, '/a')).toBe('dev /a');
      // The socket now lives where the sandbox cannot see it, and keeps working there.
      expect(existsSync(join(bridge.dir, PUBLISH_SOCKET))).toBe(false);
      expect(lstatSync(join(dirname(bridge.dir), PUBLISH_SOCKET)).isSocket()).toBe(true);
      expect(await get(bridge.hostPort, '/b')).toBe('dev /b');
      // A socket the sandbox offers later is never used.
      const late = await listenUnix(join(bridge.dir, PUBLISH_SOCKET), 'late');
      expect(await get(bridge.hostPort, '/c')).toBe('dev /c');
      expect(late.hits).toHaveLength(0);
      await closeServer(late.server);
    } finally {
      await closeServer(http);
    }
    const root = dirname(bridge.dir);
    const hostPort = bridge.hostPort;
    await bridge.close();
    bridge = null;
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(dir, 'b1'))).toBe(false);
    expect(await refused(hostPort)).toBe(true);
  });

  it('waits briefly for a forwarder that is not listening yet, then gives up', async () => {
    bridge = await openPublish({ port: 3000, base: join(dir, 'b2'), socketWaitMs: 1_500 });
    const early = exchange(bridge.hostPort, 'hello');
    await new Promise((r) => setTimeout(r, 200));
    const up = await listenUnix(join(bridge.dir, PUBLISH_SOCKET), 'answer');
    expect(await early).toBe('answer');
    await closeServer(up.server);
    await bridge.close();
    // No forwarder at all: the connection is closed without data.
    bridge = await openPublish({ port: 3000, base: join(dir, 'b2'), socketWaitMs: 200 });
    expect(await exchange(bridge.hostPort)).toBe('');
  });

  it('never follows a link the sandbox puts in place of its socket', async () => {
    const outside = await listenUnix(join(dir, 'host.sock'), 'host secret');
    try {
      bridge = await openPublish({ port: 3000, base: join(dir, 'b3'), socketWaitMs: 300 });
      symlinkSync(join(dir, 'host.sock'), join(bridge.dir, PUBLISH_SOCKET));
      expect(await exchange(bridge.hostPort)).toBe('');
      expect(outside.hits).toHaveLength(0);
      // A regular file is refused too.
      rmSync(join(bridge.dir, PUBLISH_SOCKET));
      writeFileSync(join(bridge.dir, PUBLISH_SOCKET), 'x');
      expect(await exchange(bridge.hostPort)).toBe('');
    } finally {
      await closeServer(outside.server);
    }
  });

  it('checks the port and the socket path length', async () => {
    for (const p of [0, 65_536, 1.5, Number.NaN, '80'])
      expect(() => checkPublishPort(p)).toThrow(/1-65535/);
    expect(checkPublishPort(8080)).toBe(8080);
    await expect(openPublish({ port: 0, base: join(dir, 'b4') })).rejects.toMatchObject({
      code: 'validation',
    });
    await expect(openPublish({ port: 80, base: join(dir, 'x'.repeat(120)) })).rejects.toThrow(
      /too long/,
    );
    expect(() => publishPrelude('perl', 70_000)).toThrow(/1-65535/);
    expect(publishBase()).toBe(publishBase());
  });
});

describe('the forwarders', () => {
  let tcp: Server;
  let tcpPort: number;
  beforeAll(async () => {
    tcp = createServer((c) => {
      c.on('error', () => undefined);
      c.on('data', (b: Buffer) => c.end(`inside got ${b.toString('utf8')}`));
    });
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    const a = tcp.address();
    tcpPort = typeof a === 'object' && a ? a.port : 0;
  });
  afterAll(() => closeServer(tcp));

  const viaUnix = (path: string, send: string) =>
    new Promise<string>((resolve) => {
      const s = connect(path);
      let got = '';
      s.on('connect', () => s.end(send));
      s.on('data', (b: Buffer) => (got += b.toString('utf8')));
      s.on('error', (err) => resolve(`error ${String(err)}`));
      s.on('close', () => resolve(got));
    });

  it('Node: listens on the socket (owner only) and relays to the port inside', async () => {
    const sock = join(dir, 'node-fwd.sock');
    // The detached copy the prelude starts, run in the foreground here so the test can stop it.
    const child: ChildProcess = spawn(
      process.execPath,
      ['-e', NODE_PUBLISH_FORWARDER, sock, String(tcpPort)],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, NOVA_FORWARDER_CHILD: '1' },
      },
    );
    try {
      await new Promise<void>((r) => child.stdout!.once('data', () => r()));
      expect(statSync(sock).mode & 0o777).toBe(0o600);
      // A half-closed request still gets its answer.
      expect(await viaUnix(sock, 'one')).toBe('inside got one');
      expect(await viaUnix(sock, 'two')).toBe('inside got two');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('the prelude fails the command when the forwarder cannot start', () => {
    // A runtime that is not there: the command does not run and says why.
    const script = `${publishPrelude('perl', 5173)} echo ran`;
    let out = '';
    let code = 0;
    try {
      execFileSync('/bin/sh', ['-c', script], {
        env: { PATH: join(dir, 'empty-path'), NOVA_PUBLISH_FORWARDER: PERL_PUBLISH_FORWARDER },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status: number; stderr: Buffer; stdout: Buffer };
      code = e.status;
      out = `${e.stdout.toString()}${e.stderr.toString()}`;
    }
    expect(code).toBe(125);
    expect(out).toContain('the image needs perl');
    expect(out).not.toContain('ran');
  });

  it.runIf(!!findOnPath('perl') && process.platform === 'linux')(
    'Perl: listens on the socket (owner only) and relays to the port inside',
    async () => {
      const sock = join(dir, 'perl-fwd.sock');
      execFileSync('perl', ['-e', PERL_PUBLISH_FORWARDER, sock, String(tcpPort)], {
        timeout: 10_000,
      });
      try {
        expect(statSync(sock).mode & 0o777).toBe(0o600);
        expect(await viaUnix(sock, 'three')).toBe('inside got three');
      } finally {
        // The forwarder left running in the background (its own session): stop it.
        for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
          try {
            if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(sock))
              process.kill(Number(pid), 'SIGKILL');
          } catch {
            // Gone already.
          }
        }
      }
    },
  );
});

describe('substrate arguments', () => {
  const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
    cmd: 'npm run dev',
    cwd: '/work',
    roots: [{ path: '/work', access: 'write', label: 'w' }],
    network: 'off',
    yieldMs: 1000,
    signal: new AbortController().signal,
    ...over,
  });
  const share = '/tmp/nova-publish-x/abc/share';
  const egress = {
    dir: '/tmp/nova-egress-x/abc',
    socketName: 'proxy.sock',
    caBundleName: null,
    close: () => Promise.resolve(),
  };

  it('container: mounts the bridge folder, keeps network none and starts the Perl forwarder', () => {
    const sb = new ContainerSandbox({ bin: 'docker', user: '1000:1000' });
    expect(sb.sandboxUser).toEqual({ uid: 1000, gid: 1000 });
    const args = sb.runArgs(req(), 'n1', null, { dir: share, port: 5173 });
    expect(args).toContain('--network');
    expect(args[args.indexOf('--network') + 1]).toBe('none');
    expect(args).toContain(`type=bind,source=${share},target=${PUBLISH_MOUNT}`);
    expect(args).toContain(`NOVA_PUBLISH_FORWARDER=${PERL_PUBLISH_FORWARDER}`);
    expect(args.join(' ')).not.toContain('HTTP_PROXY');
    const script = args.at(-3)!;
    expect(script).toContain(
      `perl -e "$NOVA_PUBLISH_FORWARDER" ${PUBLISH_MOUNT}/${PUBLISH_SOCKET} 5173`,
    );
    expect(script).toContain('exit 125');
    expect(script).toMatch(/ exec sh -c "\$1"$/);
    expect(args.at(-1)).toBe('npm run dev');
    // With the egress proxy too: both forwarders, the proxy's first.
    const both = sb.runArgs(req({ network: 'allowlist' }), 'n2', egress, {
      dir: share,
      port: 8000,
    });
    const s2 = both.at(-3)!;
    expect(s2.indexOf('NOVA_EGRESS_FORWARDER')).toBeLessThan(s2.indexOf('NOVA_PUBLISH_FORWARDER'));
    expect(both).toContain(`type=bind,source=${egress.dir},target=${EGRESS_MOUNT}`);
    expect(() => sb.runArgs(req(), 'n3', null, { dir: '/tmp/a,b', port: 1 })).toThrow(/commas/);
    // Without a bridge nothing changes.
    expect(sb.runArgs(req(), 'n4').join(' ')).not.toContain(PUBLISH_MOUNT);
    expect(new ContainerSandbox({ bin: 'docker', user: 'node' }).sandboxUser).toBeNull();
  });

  it('bubblewrap: binds the bridge folder and the Hub Node once and starts the Node forwarder', () => {
    const sb = new BwrapSandbox({ bin: '/usr/bin/bwrap', nodeBin: process.execPath });
    const args = sb.bwrapArgs(req({ cwd: dir, roots: [] }), null, { dir: share, port: 5173 });
    const pairs = (flag: string) =>
      args.flatMap((a, i) => (a === flag ? [`${args[i + 1]}=${args[i + 2]}`] : []));
    expect(pairs('--bind')).toContain(`${share}=${PUBLISH_MOUNT}`);
    expect(pairs('--ro-bind').filter((p) => p.endsWith(`=${FORWARDER_NODE}`))).toHaveLength(1);
    expect(pairs('--setenv')).toContain(`NOVA_PUBLISH_FORWARDER=${NODE_PUBLISH_FORWARDER}`);
    expect(args.join(' ')).not.toContain('HTTP_PROXY');
    expect(args.at(-3)).toContain(
      `${FORWARDER_NODE} -e "$NOVA_PUBLISH_FORWARDER" ${PUBLISH_MOUNT}/${PUBLISH_SOCKET} 5173`,
    );
    const both = sb.bwrapArgs(req({ cwd: dir, roots: [], network: 'allowlist' }), egress, {
      dir: share,
      port: 5173,
    });
    const p2 = both.flatMap((a, i) => (a === '--ro-bind' ? [both[i + 2]] : []));
    expect(p2.filter((p) => p === FORWARDER_NODE)).toHaveLength(1);
    expect(both.at(-3)).toContain('NOVA_EGRESS_FORWARDER');
    expect(both.at(-3)).toContain('NOVA_PUBLISH_FORWARDER');
  });

  it('hides bridge folders inside a root that contains them', () => {
    const base = publishBase();
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const sb = new BwrapSandbox({ bin: '/usr/bin/bwrap' });
    const parent = dirname(base);
    const args = sb.bwrapArgs(
      req({ cwd: parent, roots: [{ path: parent, access: 'write', label: 'tmp' }] }),
    );
    expect(args.flatMap((a, i) => (a === '--tmpfs' ? [args[i + 1]] : []))).toContain(base);
    const ctr = new ContainerSandbox({ bin: 'docker' }).runArgs(
      req({ cwd: parent, roots: [{ path: parent, access: 'write', label: 'tmp' }] }),
      'n',
    );
    expect(ctr).toContain(`type=tmpfs,destination=${base}`);
  });
});

// ---- real sandboxes ------------------------------------------------------------------------------

/** A tiny HTTP server inside the sandbox, bound to its own 127.0.0.1. */
const NODE_SERVER = `${FORWARDER_NODE} -e "require('http').createServer((q,s)=>s.end('inside '+q.url)).listen(+process.env.PORT,'127.0.0.1')"`;

async function startServer(
  sb: BwrapSandbox | ContainerSandbox,
  cmd: string,
  cwd: string,
  port: number,
): Promise<Extract<ExecResult, { status: 'running' }>> {
  const r = await sb.exec({
    cmd,
    cwd,
    roots: [{ path: cwd, access: 'write', label: 'w' }],
    network: 'off',
    env: { PORT: String(port) },
    yieldMs: 1_500,
    signal: new AbortController().signal,
    turnId: 'publish-test',
    publish: { port },
  });
  if (r.status !== 'running') throw new Error(`the server exited: ${r.output}`);
  return r;
}

async function until(fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const BWRAP = findOnPath('bwrap');
let bwrapWorks = false;
if (BWRAP && process.platform === 'linux' && seccompArch()) {
  try {
    execFileSync(BWRAP, ['--unshare-all', '--ro-bind', '/', '/', 'true'], { timeout: 5000 });
    bwrapWorks = true;
  } catch {
    bwrapWorks = false;
  }
}

describe.runIf(bwrapWorks)('bubblewrap: a published dev server (integration)', () => {
  it('reaches a server bound to 127.0.0.1 inside from the Hub, until the command ends', async () => {
    const work = join(dir, 'bw');
    mkdirSync(work, { recursive: true });
    const sb = new BwrapSandbox({ bin: BWRAP! });
    const r = await startServer(sb, NODE_SERVER, work, 4321);
    expect(r.published).toMatchObject({ port: 4321 });
    const hostPort = r.published!.hostPort;
    expect(hostPort).toBeGreaterThan(0);
    await until(async () => (await get(hostPort, '/hello')) === 'inside /hello');
    // The command's network is still only its own loopback.
    const lo = await sb.exec({
      cmd: 'cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " "; ls /run/nova',
      cwd: work,
      roots: [{ path: work, access: 'write', label: 'w' }],
      network: 'off',
      yieldMs: 10_000,
      signal: new AbortController().signal,
      publish: { port: 4322 },
    });
    expect(lo.status === 'exited' && lo.output.trim().split('\n')).toEqual([
      'lo',
      'node',
      'publish',
    ]);
    // Killing the command closes the bridge.
    await sb.write(r.sessionId, { signal: 'terminate' });
    await until(() => refused(hostPort));
    // The last bridge takes the base folder with it.
    await until(() => Promise.resolve(!existsSync(publishBase())));
  }, 40_000);

  it('answers nothing (and leaves the Hub port closed after) when the server never listens', async () => {
    const work = join(dir, 'bw2');
    mkdirSync(work, { recursive: true });
    const sb = new BwrapSandbox({ bin: BWRAP! });
    const r = await startServer(sb, 'sleep 30', work, 4323);
    expect(await exchange(r.published!.hostPort, 'GET / HTTP/1.0\r\n\r\n')).toBe('');
    await sb.killTurn('publish-test');
    await until(() => refused(r.published!.hostPort));
  }, 30_000);
});

const ENGINE = findOnPath('docker') ?? findOnPath('podman');
let ctrReady = false;
let ctrWhy = 'no docker or podman on PATH';
if (ENGINE) {
  try {
    execFileSync(ENGINE, ['image', 'inspect', DEFAULT_SANDBOX_IMAGE], {
      timeout: 10_000,
      stdio: 'ignore',
    });
    ctrReady = true;
  } catch {
    ctrWhy = `the engine is not running or ${DEFAULT_SANDBOX_IMAGE} is not pulled`;
  }
}

describe('container: a published dev server (integration)', () => {
  it.skipIf(ctrReady)(`skipped: ${ctrWhy}`, () => undefined);

  it.runIf(ctrReady)(
    'reaches a server bound to 127.0.0.1 inside a container without network, until it is killed',
    async () => {
      const work = mkdtempSync(join(tmpdir(), 'nova-pub-ctr-'));
      try {
        // The default image has Perl but no Node or Python.
        writeFileSync(
          join(work, 'serve.pl'),
          `use IO::Socket::INET;
my $l = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => $ENV{PORT}, Listen => 5, ReuseAddr => 1) or die "listen: $!";
while (my $c = $l->accept) { my $r = <$c>; print $c "HTTP/1.0 200 OK\\r\\nContent-Type: text/plain\\r\\n\\r\\ninside the container"; close $c; }
`,
        );
        const sb = new ContainerSandbox({ bin: ENGINE! });
        const r = await startServer(sb, `perl ${work}/serve.pl`, work, 8000);
        const hostPort = r.published!.hostPort;
        await until(async () => (await get(hostPort)) === 'inside the container', 30_000);
        await sb.write(r.sessionId, { signal: 'terminate' });
        await until(() => refused(hostPort));
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
