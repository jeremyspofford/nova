// The container substrate's network (FR-107, FR-193, docs/11 §2.2): `--network none` always, and
// with the egress proxy wired in the session's socket bind-mounted at /run/nova/egress with a
// forwarder inside, so the proxy is the only route. Only proxy and CA variables are passed. With
// Docker or Podman present the route is exercised for real (a Perl HTTP client in the default
// image); without one those tests are skipped and say why.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContainerSandbox,
  DEFAULT_SANDBOX_IMAGE,
  EGRESS_MOUNT,
  MicroVmSandbox,
  detectSandbox,
  egressContext,
  findOnPath,
  openEgress,
  type SandboxEgress,
  type SandboxEgressSession,
} from '../src/tools/sandbox.ts';
import type { ExecRequest } from '../src/tools/types.ts';
import { EgressProxyService, classifyAddress } from '../src/computers/index.ts';

const SECRET = 'sk-container-test-5555555555'; // secret-scan: fake

const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
  cmd: 'echo hi',
  cwd: '/work',
  roots: [{ path: '/work', access: 'write', label: 'w' }],
  network: 'off',
  yieldMs: 1000,
  signal: new AbortController().signal,
  ...over,
});

const session: SandboxEgressSession = {
  dir: '/tmp/nova-egress-x/abc',
  socketName: 'proxy.sock',
  caBundleName: 'ca-bundle.pem',
  close: () => Promise.resolve(),
};

describe('container network arguments', () => {
  it('routes network only through the mounted proxy socket', () => {
    const sb = new ContainerSandbox({
      bin: 'docker',
      egress: { open: () => Promise.resolve(null) },
    });
    const args = sb.runArgs(
      req({ network: 'allowlist', env: { HTTP_PROXY: 'http://evil:1' } }),
      'n',
      session,
    );
    expect(args).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(args).toContain(`type=bind,source=${session.dir},target=${EGRESS_MOUNT}`);
    // The proxy variables win over what the caller set.
    expect(args).toContain('HTTP_PROXY=http://127.0.0.1:3128');
    expect(args).not.toContain('HTTP_PROXY=http://evil:1');
    expect(args).toContain(`SSL_CERT_FILE=${EGRESS_MOUNT}/ca-bundle.pem`);
    expect(args.some((a) => a.startsWith('NOVA_EGRESS_FORWARDER=use strict'))).toBe(true);
    const i = args.indexOf(DEFAULT_SANDBOX_IMAGE);
    expect(args.slice(i + 1, i + 3)).toEqual(['sh', '-c']);
    expect(args[i + 3]).toContain(
      `perl -e "$NOVA_EGRESS_FORWARDER" ${EGRESS_MOUNT}/proxy.sock 3128`,
    );
    expect(args.slice(i + 4)).toEqual(['nova-sandbox', 'echo hi']);
  });

  it('never opens the engine network once the proxy is wired in', () => {
    const sb = new ContainerSandbox({
      bin: 'docker',
      allowedNetwork: 'open',
      egress: { open: () => Promise.resolve(null) },
    });
    expect(sb.proxied).toBe(true);
    // The policy is off (no session): no network at all.
    expect(sb.runArgs(req({ network: 'allowlist' }), 'n')).toEqual(
      expect.arrayContaining(['--network', 'none']),
    );
  });

  it('opens a session per command with the owner, and fails closed with a note', async () => {
    expect(egressContext(req())).toBeNull();
    const owned = { ...req({ network: 'limited' }), owner: { accountId: 'a1', threadId: 't1' } };
    expect(egressContext(owned)).toEqual({
      accountId: 'a1',
      threadId: 't1',
      network: 'limited',
      scope: null,
    });
    const viaComputer = {
      ...req({ network: 'allowlist' }),
      egress: { accountId: 'a2', scope: { kind: 'agent' as const, id: 'ag' } },
    };
    expect(egressContext(viaComputer)?.scope).toEqual({ kind: 'agent', id: 'ag' });
    const broken: SandboxEgress = { open: () => Promise.reject(new Error('proxy is down')) };
    const r = await openEgress(broken, owned);
    expect(r.session).toBeNull();
    expect(r.note).toContain('no network: proxy is down');
    expect(await openEgress(undefined, owned)).toEqual({ session: null });
  });

  it('offers the micro-VM only behind its flag and a KVM runner (FR-195)', async () => {
    const off = detectSandbox({ mode: 'microvm' });
    expect(off.substrate).toBe('micro_vm');
    expect((await off.available()).detail).toContain('turned off');
    await expect(off.exec(req())).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    const noRunner = new MicroVmSandbox({ enabled: true, kvmPath: process.execPath });
    expect((await noRunner.available()).detail).toContain('no KVM runner is configured');
    const noKvm = new MicroVmSandbox({ enabled: true, kvmPath: '/nonexistent/kvm' });
    expect((await noKvm.available()).detail).toContain('not available on this host');
    const calls: string[] = [];
    const runner = {
      available: () => Promise.resolve({ ok: true, detail: 'fake vm' }),
      exec: () => Promise.resolve({ status: 'exited' as const, exitCode: 0, output: 'vm' }),
      poll: () => Promise.resolve({ status: 'exited' as const, exitCode: 0, output: '' }),
      write: () => Promise.resolve(),
      killTurn: (t: string) => Promise.resolve(void calls.push(t)),
    };
    const on = new MicroVmSandbox({ enabled: true, runner, kvmPath: process.execPath });
    expect(await on.exec(req())).toMatchObject({ output: 'vm' });
    await on.killTurn('T');
    expect(calls).toEqual(['T']);
  });
});

// Real containers, only with a running engine and the default image already present.
const ENGINE = findOnPath('docker') ?? findOnPath('podman');
let ready = false;
let why = 'no docker or podman on PATH';
if (ENGINE) {
  try {
    execFileSync(ENGINE, ['image', 'inspect', DEFAULT_SANDBOX_IMAGE], {
      timeout: 10_000,
      stdio: 'ignore',
    });
    ready = true;
  } catch {
    why = `the engine is not running or ${DEFAULT_SANDBOX_IMAGE} is not pulled`;
  }
}

describe('container sandboxes through the egress proxy (integration)', () => {
  it.skipIf(ready)(`skipped: ${why}`, () => undefined);

  let dir: string;
  let up: Server;
  let port: number;
  const seen: IncomingHttpHeaders[] = [];
  let proxy: EgressProxyService;

  beforeAll(async () => {
    if (!ready) return;
    dir = mkdtempSync(join(tmpdir(), 'nova-ctr-'));
    // A minimal HTTP client: the default image has Perl but no curl.
    writeFileSync(
      join(dir, 'get.pl'),
      `use IO::Socket::INET;
my ($url, $proxy) = @ARGV;
my ($host) = $url =~ m{^http://([^/]+)};
my $s = IO::Socket::INET->new(PeerAddr => $proxy // '127.0.0.1:3128', Timeout => 10) or do { print "no route: $!\\n"; exit 7 };
print $s "GET $url HTTP/1.1\\r\\nHost: $host\\r\\nConnection: close\\r\\n\\r\\n";
print while <$s>;
`,
    );
    up = createServer((r, res) => {
      seen.push(r.headers);
      res.end(`seen ${String(r.headers.authorization ?? 'none')}`);
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    const a = up.address();
    port = typeof a === 'object' && a ? a.port : 0;
    proxy = new EgressProxyService({
      socketDir: join(tmpdir(), `nova-ctr-s-${process.pid}`),
      resolve: (h) => Promise.resolve(h === 'api.test' || h === 'echo.test' ? ['127.0.0.1'] : []),
      classify: (x) => (x === '127.0.0.1' ? 'public' : classifyAddress(x)),
      credentials: () =>
        Promise.resolve([
          {
            id: 'c1',
            hosts: ['api.test'],
            scheme: 'bearer',
            header: null,
            username: null,
            value: () => Promise.resolve(SECRET),
          },
        ]),
    });
  });
  afterAll(async () => {
    if (!ready) return;
    await proxy.close();
    await new Promise((r) => up.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (cmd: string, network: ExecRequest['network']) => {
    const sb = new ContainerSandbox({
      bin: ENGINE!,
      egress: {
        open: (ctx) =>
          proxy.open({
            accountId: ctx.accountId ?? 'acct',
            scope: { kind: 'sandbox', id: 'ctr-test' },
            policy: {
              mode: 'allowlist',
              allow: ['api.test', 'echo.test'],
              deny: [],
              credentials: ['c1'],
              allowLocalBinding: false,
            },
          }),
      },
    });
    const r = await sb.exec({
      cmd,
      cwd: dir,
      roots: [{ path: dir, access: 'write', label: 'w' }],
      network,
      yieldMs: 60_000,
      signal: new AbortController().signal,
    });
    if (r.status !== 'exited') throw new Error('still running');
    return r;
  };

  it.runIf(ready)(
    'reaches allowed hosts only through the proxy; the credential never enters the container',
    async () => {
      const ok = await run(`perl ${dir}/get.pl http://api.test:${port}/x`, 'allowlist');
      expect(ok.output).toContain('200 OK');
      expect(seen.at(-1)?.authorization).toBe(`Bearer ${SECRET}`);
      expect(ok.output).not.toContain(SECRET);
      await run(`perl ${dir}/get.pl http://echo.test:${port}/`, 'allowlist');
      expect(seen.at(-1)?.authorization).toBeUndefined();
      const inside = await run(
        `env; ls -la ${EGRESS_MOUNT}; grep -rl "${SECRET}" / --exclude-dir=proc --exclude-dir=sys 2>/dev/null; echo done`,
        'allowlist',
      );
      expect(inside.output).not.toContain(SECRET);
      expect(inside.output).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
      const blocked = await run(`perl ${dir}/get.pl http://evil.test:${port}/`, 'allowlist');
      expect(blocked.output).toContain('403');
      expect(blocked.output.toLowerCase()).toContain('x-nova-block-cause: allowlist');
      // The container has no other route: the host is unreachable directly.
      const direct = await run(
        `perl ${dir}/get.pl http://api.test:${port}/ 172.17.0.1:${port}; perl ${dir}/get.pl http://api.test:${port}/ 8.8.8.8:53`,
        'allowlist',
      );
      expect(direct.output).toContain('no route');
      expect(direct.output).not.toContain('200 OK');
      // Network off: no forwarder, nothing listens on the proxy port.
      const off = await run(`perl ${dir}/get.pl http://api.test:${port}/`, 'off');
      expect(off.output).toContain('no route');
    },
    120_000,
  );
});
