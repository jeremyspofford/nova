// The bubblewrap substrate (FR-107, docs/11 §2.5): argument building, the seccomp program (run
// through a small classic-BPF interpreter here, so it is checked on any machine), and, where
// bubblewrap works, real sandboxes: isolation, network off, the egress proxy as the only route,
// credentials injected by the proxy and invisible inside, and the wall-clock limit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BwrapSandbox,
  EGRESS_MOUNT,
  FORWARDER_NODE,
  buildSeccompFilter,
  detectSandbox,
  findOnPath,
  seccompArch,
  type SandboxEgress,
} from '../src/tools/sandbox.ts';
import type { ExecRequest } from '../src/tools/types.ts';
import { EgressProxyService, classifyAddress } from '../src/computers/index.ts';

const SECRET = 'sk-bwrap-test-9876543210'; // secret-scan: fake

/** Runs a classic BPF seccomp program over one syscall (x86_64 or aarch64 data layout). */
function runFilter(prog: Buffer, data: { arch: number; nr: number; arg0?: number }): number {
  const mem = Buffer.alloc(64);
  mem.writeInt32LE(data.nr, 0);
  mem.writeUInt32LE(data.arch, 4);
  mem.writeUInt32LE(data.arg0 ?? 0, 16);
  let a = 0;
  for (let pc = 0; pc < prog.length / 8;) {
    const code = prog.readUInt16LE(pc * 8);
    const jt = prog.readUInt8(pc * 8 + 2);
    const jf = prog.readUInt8(pc * 8 + 3);
    const k = prog.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) {
      a = mem.readUInt32LE(k);
      pc++;
    } else if (code === 0x15) pc += 1 + (a === k ? jt : jf);
    else if (code === 0x35) pc += 1 + (a >= k ? jt : jf);
    else if (code === 0x06) return k;
    else throw new Error(`unknown BPF op ${code}`);
  }
  throw new Error('fell off the program');
}

const X86 = 0xc000003e;
const ARM = 0xc00000b7;
const ALLOW = 0x7fff0000;

describe('seccomp filter', () => {
  it('denies io_uring, modules, kexec and bpf, and kills a foreign architecture', () => {
    const p = buildSeccompFilter('x86_64', 'proxy');
    expect(runFilter(p, { arch: X86, nr: 0 })).toBe(ALLOW); // read
    expect(runFilter(p, { arch: X86, nr: 41, arg0: 2 })).toBe(ALLOW); // socket(AF_INET)
    for (const nr of [425, 426, 427, 246, 320, 175, 313, 176, 321])
      expect(runFilter(p, { arch: X86, nr }), String(nr)).toBe(0x00050001);
    expect(runFilter(p, { arch: 0x40000003, nr: 0 })).toBe(0x80000000); // i386
    expect(runFilter(p, { arch: X86, nr: 0x40000000 })).toBe(0x80000000); // x32
  });

  it('allows only AF_UNIX sockets with network off', () => {
    for (const [arch, a, socket] of [
      ['x86_64', X86, 41],
      ['aarch64', ARM, 198],
    ] as const) {
      const p = buildSeccompFilter(arch, 'off');
      expect(runFilter(p, { arch: a, nr: socket, arg0: 1 })).toBe(ALLOW);
      expect(runFilter(p, { arch: a, nr: socket, arg0: 2 })).toBe(0x00050000 | 97);
      expect(runFilter(p, { arch: a, nr: socket, arg0: 10 })).toBe(0x00050000 | 97);
      expect(runFilter(p, { arch: a, nr: 425 })).toBe(0x00050001);
    }
    expect(seccompArch('x64')).toBe('x86_64');
    expect(seccompArch('arm64')).toBe('aarch64');
    expect(seccompArch('ia32')).toBeNull();
  });
});

describe('bubblewrap arguments', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-bwrap-args-'));
    mkdirSync(join(dir, 'proj', '.ssh'), { recursive: true });
    writeFileSync(join(dir, 'proj', '.netrc'), 'machine x');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
    cmd: 'echo hi',
    cwd: join(dir, 'proj'),
    roots: [
      { path: join(dir, 'proj'), access: 'write', label: 'p' },
      { path: '/etc', access: 'read', label: 'etc' },
      { path: '/', access: 'read', label: 'all' },
    ],
    network: 'off',
    yieldMs: 1000,
    signal: new AbortController().signal,
    ...over,
  });

  it('isolates namespaces, clears the environment, mounts roots and masks credentials', () => {
    const sb = new BwrapSandbox({ bin: '/usr/bin/bwrap', memoryMb: 512, cpuSeconds: 60 });
    const args = sb.bwrapArgs(req({ env: { FOO: 'bar', 'BAD-NAME': 'x' } }));
    expect(args.slice(0, 6)).toEqual([
      '--unshare-all',
      '--unshare-user',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
    ]);
    expect(args).toContain('--clearenv');
    const pairs = (flag: string) =>
      args.flatMap((a, i) => (a === flag ? [`${args[i + 1]}=${args[i + 2]}`] : []));
    expect(pairs('--bind')).toContain(`${join(dir, 'proj')}=${join(dir, 'proj')}`);
    expect(pairs('--ro-bind')).toContain('/usr=/usr');
    // The host root is never mounted as a root.
    expect(pairs('--ro-bind')).not.toContain('/=/');
    expect(pairs('--setenv')).toContain('FOO=bar');
    expect(pairs('--setenv').some((p) => p.startsWith('BAD-NAME'))).toBe(false);
    expect(args.join(' ')).not.toContain('HTTP_PROXY');
    // Credential locations inside a root are masked.
    expect(args).toContain(join(dir, 'proj', '.ssh'));
    expect(pairs('--ro-bind')).toContain(`/dev/null=${join(dir, 'proj', '.netrc')}`);
    const i = args.indexOf('--seccomp');
    expect(args[i + 1]).toBe('3');
    const script = args.at(-3)!;
    expect(script).toContain('ulimit -d 524288');
    expect(script).toContain('ulimit -t 60');
    expect(args.at(-1)).toBe('echo hi');
    expect(args).toContain('--chdir');
  });

  it('bridges the proxy socket in and sets only proxy and CA variables for network', () => {
    const sb = new BwrapSandbox({ bin: '/usr/bin/bwrap', nodeBin: process.execPath });
    const args = sb.bwrapArgs(req({ network: 'allowlist' }), {
      dir: join(dir, 'sess'),
      socketName: 'proxy.sock',
      caBundleName: 'ca-bundle.pem',
      close: () => Promise.resolve(),
    });
    const pairs = (flag: string) =>
      args.flatMap((a, i) => (a === flag ? [`${args[i + 1]}=${args[i + 2]}`] : []));
    expect(pairs('--bind')).toContain(`${join(dir, 'sess')}=${EGRESS_MOUNT}`);
    expect(pairs('--ro-bind').some((p) => p.endsWith(`=${FORWARDER_NODE}`))).toBe(true);
    expect(pairs('--setenv')).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
    expect(pairs('--setenv')).toContain(`SSL_CERT_FILE=${EGRESS_MOUNT}/ca-bundle.pem`);
    expect(args.at(-3)).toContain(`${FORWARDER_NODE} -e "$NOVA_EGRESS_FORWARDER"`);
  });

  it('is chosen by detectSandbox when asked, and fails closed without bwrap', async () => {
    const none = detectSandbox({ mode: 'bwrap', env: { PATH: '/nonexistent' } });
    expect(none.substrate).toBeNull();
    expect((await none.available()).detail).toContain('Bubblewrap is not installed');
    await expect(
      new BwrapSandbox({ bin: join(dir, 'missing-bwrap') }).exec(req()),
    ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    expect((await new BwrapSandbox({ bin: join(dir, 'missing-bwrap') }).available()).ok).toBe(
      false,
    );
  });
});

// Real sandboxes, only where bubblewrap can create one.
const BWRAP = findOnPath('bwrap');
let works = false;
if (BWRAP && process.platform === 'linux' && seccompArch()) {
  try {
    execFileSync(BWRAP, ['--unshare-all', '--ro-bind', '/', '/', 'true'], { timeout: 5000 });
    works = true;
  } catch {
    works = false;
  }
}
const CURL = findOnPath('curl');

describe.runIf(works)('bubblewrap sandboxes (integration)', () => {
  let dir: string;
  let up: Server;
  let port: number;
  const seen: IncomingHttpHeaders[] = [];
  let proxy: EgressProxyService;
  const egress = (allow: string[]): SandboxEgress => ({
    open: (ctx) =>
      proxy.open({
        accountId: ctx.accountId ?? 'acct',
        scope: { kind: 'sandbox', id: 'bwrap-test' },
        policy: {
          mode: 'allowlist',
          allow,
          deny: [],
          credentials: ['c1'],
          allowLocalBinding: false,
        },
      }),
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nova-bwrap-'));
    mkdirSync(join(dir, 'work'));
    up = createServer((req, res) => {
      seen.push(req.headers);
      res.end(`seen ${String(req.headers.authorization ?? 'none')}`);
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', () => r()));
    const a = up.address();
    port = typeof a === 'object' && a ? a.port : 0;
    proxy = new EgressProxyService({
      socketDir: join(dir, 's'),
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
    await proxy.close();
    await new Promise((r) => up.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const run = async (sb: BwrapSandbox, cmd: string, network: ExecRequest['network'] = 'off') => {
    const r = await sb.exec({
      cmd,
      cwd: join(dir, 'work'),
      roots: [{ path: join(dir, 'work'), access: 'write', label: 'w' }],
      network,
      yieldMs: 20_000,
      signal: new AbortController().signal,
    });
    if (r.status !== 'exited') throw new Error('still running');
    return r;
  };

  it('runs a command with the root writable and the rest of the host hidden', async () => {
    const sb = new BwrapSandbox({ bin: BWRAP! });
    expect((await sb.available()).ok).toBe(true);
    const r = await run(sb, `echo hi > out.txt && cat out.txt && ls ${tmpdir()} | wc -l && id -u`);
    expect(r.exitCode).toBe(0);
    expect(r.output.split('\n')[0]).toBe('hi');
    // /usr is read-only.
    const ro = await run(sb, 'touch /usr/nova-test 2>&1; echo $?');
    expect(ro.output.trim().split('\n').at(-1)).not.toBe('0');
    // No secrets in the environment: only what the sandbox set.
    const env = await run(sb, 'env | cut -d= -f1 | sort | tr "\\n" " "');
    expect(env.output).not.toContain('NOVA_');
    expect(env.output).not.toContain('SSH_AUTH_SOCK');
  });

  it('has only loopback and no IP sockets with network off', async () => {
    const sb = new BwrapSandbox({ bin: BWRAP! });
    const r = await run(sb, 'cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d " "');
    expect(r.output.trim()).toBe('lo');
    if (findOnPath('perl')) {
      const s = await run(
        sb,
        `perl -e 'socket(my $s, 2, 1, 0) or print "denied: $!"; socket(my $u, 1, 1, 0) and print " unix ok"'`,
      );
      expect(s.output).toContain('denied');
      expect(s.output).toContain('unix ok');
    }
  });

  it.runIf(!!CURL)(
    'reaches allowed hosts only through the proxy, with credentials it never sees',
    async () => {
      const sb = new BwrapSandbox({ bin: BWRAP!, egress: egress(['api.test', 'echo.test']) });
      const ok = await run(sb, `curl -s -m 10 http://api.test:${port}/data`, 'allowlist');
      expect(ok.exitCode).toBe(0);
      // The proxy added the credential and masked it in the response.
      expect(seen.at(-1)?.authorization).toBe(`Bearer ${SECRET}`);
      expect(ok.output).not.toContain(SECRET);
      // An echo server shows no credential; the environment and files hold none.
      await run(sb, `curl -s -m 10 http://echo.test:${port}/`, 'allowlist');
      expect(seen.at(-1)?.authorization).toBeUndefined();
      const inside = await run(
        sb,
        `env; ls -la ${EGRESS_MOUNT}; grep -rl "${SECRET}" ${EGRESS_MOUNT} /tmp 2>/dev/null; echo done`,
        'allowlist',
      );
      expect(inside.output).not.toContain(SECRET);
      expect(inside.output).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
      // An unlisted host gets the proxy's 403 with the cause header.
      const blocked = await run(sb, `curl -s -m 10 -i http://evil.test:${port}/`, 'allowlist');
      expect(blocked.output).toContain('403');
      expect(blocked.output.toLowerCase()).toContain('x-nova-block-cause: allowlist');
      // Going around the proxy finds no route.
      const direct = await run(
        sb,
        `curl -s -m 5 --noproxy '*' http://127.0.0.1:${port}/ || echo "no route $?"`,
        'allowlist',
      );
      expect(direct.output).toContain('no route');
    },
  );

  it('stops a command at the wall-clock limit', async () => {
    const sb = new BwrapSandbox({ bin: BWRAP!, wallClockMs: 500 });
    const r = await run(sb, 'sleep 30');
    expect(r.output).toContain('wall-clock limit');
    expect(r.exitCode).not.toBe(0);
  });
});
