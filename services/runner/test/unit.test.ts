// Runner units: tokens (hashed at rest, plaintext refused), the seccomp program (run through a
// small classic-BPF interpreter), the output ring (offsets, drops, UTF-8 boundaries), metering
// parsers, redaction, sandbox paths and the substrates' arguments (no host paths but the
// environment's own folders; network only when allowed).
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BwrapSubstrate,
  ContainerSubstrate,
  OutputRing,
  addToken,
  commandScript,
  detectSubstrate,
  diskUsage,
  findToken,
  newRunnerToken,
  parseProcStat,
  parseTimes,
  parseTokenFile,
  readTokenFile,
  redact,
  redactUrl,
  repoName,
  seccompProgram,
  splitRef,
  tokenHash,
  tokenRecord,
  treeCpuSeconds,
  workspacePath,
  type SandboxSpec,
} from '../src/index.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nova-runner-unit-'));
  dirs.push(d);
  return d;
}

describe('tokens', () => {
  it('keeps only hashes, refuses plaintext and finds a presented token', () => {
    const dir = tmp();
    const file = join(dir, 'tokens');
    const { token, record } = addToken(file, 'my hub');
    expect(token).toMatch(/^nvrun_[A-Za-z0-9_-]{43}$/);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain(`sha256:${tokenHash(token)} my-hub`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const list = readTokenFile(file);
    expect(list).toEqual([record]);
    const map = new Map(list.map((t) => [t.hash, t]));
    expect(findToken(map, token)?.label).toBe('my-hub');
    expect(findToken(map, newRunnerToken())).toBeNull();
    expect(findToken(map, 'not-a-token')).toBeNull();
  });

  it('refuses a token file with a plaintext token or a malformed line', () => {
    const t = newRunnerToken();
    expect(() => parseTokenFile(`# ok\n${t}\n`)).toThrow(/plaintext token/);
    expect(() => parseTokenFile('sha256:abc\n')).toThrow(/line 1/);
    expect(parseTokenFile(`\n# c\nsha256:${'a'.repeat(64)}\n`)).toEqual([
      tokenRecord('a'.repeat(64), 'hub'),
    ]);
  });
});

/** Classic BPF over struct seccomp_data, enough for the runner's program. */
function bpf(prog: Buffer, data: { nr: number; arch: number; arg0?: number }): number {
  const word = (k: number) =>
    k === 0 ? data.nr : k === 4 ? data.arch : k === 16 ? (data.arg0 ?? 0) : 0;
  let a = 0;
  for (let pc = 0; pc < prog.length / 8; pc++) {
    const code = prog.readUInt16LE(pc * 8);
    const jt = prog.readUInt8(pc * 8 + 2);
    const jf = prog.readUInt8(pc * 8 + 3);
    const k = prog.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) a = word(k);
    else if (code === 0x15) pc += a === k ? jt : jf;
    else if (code === 0x35) pc += a >= k ? jt : jf;
    else if (code === 0x06) return k;
    else throw new Error(`unknown opcode ${code}`);
  }
  throw new Error('fell off the program');
}

describe('seccomp program', () => {
  const X86 = 0xc000003e;
  const ALLOW = 0x7fff0000;
  it('kills other architectures and the x32 ABI, denies the listed syscalls', () => {
    const p = seccompProgram('x86_64', false);
    expect(bpf(p, { nr: 0, arch: 0xc00000b7 })).toBe(0x80000000);
    expect(bpf(p, { nr: 0x40000000 + 1, arch: X86 })).toBe(0x80000000);
    expect(bpf(p, { nr: 321, arch: X86 })).toBe(0x00050000 | 1); // bpf
    expect(bpf(p, { nr: 425, arch: X86 })).toBe(0x00050000 | 1); // io_uring_setup
    expect(bpf(p, { nr: 0, arch: X86 })).toBe(ALLOW); // read
  });

  it('allows only AF_UNIX sockets without network, every socket with it', () => {
    const off = seccompProgram('x86_64', false);
    expect(bpf(off, { nr: 41, arch: X86, arg0: 2 })).toBe(0x00050000 | 97);
    expect(bpf(off, { nr: 41, arch: X86, arg0: 1 })).toBe(ALLOW);
    const on = seccompProgram('x86_64', true);
    expect(bpf(on, { nr: 41, arch: X86, arg0: 2 })).toBe(ALLOW);
    const arm = seccompProgram('aarch64', false);
    expect(bpf(arm, { nr: 198, arch: 0xc00000b7, arg0: 10 })).toBe(0x00050000 | 97);
    expect(bpf(arm, { nr: 280, arch: 0xc00000b7 })).toBe(0x00050000 | 1);
  });
});

describe('output ring', () => {
  it('keeps the newest bytes and reports what was dropped', () => {
    const r = new OutputRing(8);
    r.append(Buffer.from('abcdef'));
    r.append(Buffer.from('ghijkl'));
    expect(r.end).toBe(12);
    expect(r.read(0, 100, true)).toEqual({ data: 'efghijkl', offset: 12, dropped: 4 });
    expect(r.read(10, 100, true)).toEqual({ data: 'kl', offset: 12, dropped: 0 });
    expect(r.read(12, 100, true)).toEqual({ data: '', offset: 12, dropped: 0 });
  });

  it('never splits a UTF-8 sequence while the process runs', () => {
    const r = new OutputRing();
    const euro = Buffer.from('€'); // 3 bytes
    r.append(Buffer.concat([Buffer.from('a'), euro.subarray(0, 2)]));
    expect(r.read(0)).toEqual({ data: 'a', offset: 1, dropped: 0 });
    r.append(euro.subarray(2));
    expect(r.read(1)).toEqual({ data: '€', offset: 4, dropped: 0 });
    // A start the ring cut into skips the orphaned continuation bytes.
    const small = new OutputRing(4);
    small.append(Buffer.from('x€y'));
    expect(small.read(0, 100, true).data).toBe('€y');
  });
});

describe('metering parsers', () => {
  it('reads /proc stat lines and sums a tree', () => {
    const line = (pid: number, ppid: number, ut: number) =>
      `${pid} (sh (x)) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${ut} 5 2 3 20 0 1 0 1 1 1`;
    expect(parseProcStat(line(10, 1, 40))).toEqual({ ppid: 1, ticks: 50 });
    expect(parseProcStat('garbage')).toBeNull();
    const procs = new Map([
      [10, parseProcStat(line(10, 1, 90))!],
      [11, parseProcStat(line(11, 10, 90))!],
      [12, parseProcStat(line(12, 11, 90))!],
      [13, parseProcStat(line(13, 1, 90))!],
    ]);
    expect(treeCpuSeconds(procs, 10)).toBeCloseTo(3, 5);
    expect(treeCpuSeconds(procs, 99)).toBe(0);
  });

  it('reads a shell times report', () => {
    expect(parseTimes('0m0.200000s 0m0.100000s\n1m2.5s 0m0.4s\n')).toBeCloseTo(63.2, 5);
    expect(parseTimes('nothing')).toBeNull();
  });

  it('measures disk use without following links', async () => {
    const d = tmp();
    const u = await diskUsage([d, join(d, 'missing')]);
    expect(u.partial).toBe(false);
    expect(u.bytes).toBeGreaterThanOrEqual(0);
  });
});

describe('redaction and paths', () => {
  it('redacts credentials in text and URLs', () => {
    expect(redactUrl('https://bob:pw@git.example/x.git')).toBe('https://git.example/x.git');
    expect(redactUrl('not a url ghp_abcdefghijklmnopqrstuvwxyz0123')).toContain('[redacted');
    const t = redact(
      'Authorization: Bearer abcdefghijklmnop token=s3cr3t https://u:p@h/ sk-abcdefghijklmnopqrstuvwxyz',
    );
    expect(t).not.toMatch(/abcdefghijklmnop|s3cr3t|u:p@|sk-abc/);
  });

  it('keeps paths inside /workspace', () => {
    expect(workspacePath(undefined)).toBe('/workspace');
    expect(workspacePath('/workspace/app/../lib/')).toBe('/workspace/lib');
    expect(() => workspacePath('/workspace/../etc')).toThrow(/under \/workspace/);
    expect(() => workspacePath('relative')).toThrow(/full path/);
    expect(() => workspacePath('/workspacefoo')).toThrow(/under/);
  });

  it('names repositories and reads refs', () => {
    expect(repoName('https://git.example/org/app.git')).toBe('app');
    expect(repoName('file:///srv/repos/my%20lib/')).toBe('my-20lib');
    expect(repoName('https://git.example/')).toBe('repo');
    expect(splitRef('https://g/x.git#release/1.2')).toEqual({
      url: 'https://g/x.git',
      ref: 'release/1.2',
    });
    expect(() => splitRef('https://g/x.git#-rf')).toThrow(/branch or tag/);
    expect(() => splitRef('https://g/x.git#a..b')).toThrow(/branch or tag/);
  });
});

describe('substrate arguments', () => {
  const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
    argv: ['/bin/sh', '-c', 'true'],
    mounts: [
      { host: '/data/envs/e1/work', target: '/workspace', writable: true },
      { host: '/data/envs/e1/caches/npm', target: '/cache/npm', writable: true },
    ],
    cwd: '/workspace/app',
    env: { FOO: 'bar', 'bad name': 'x' },
    network: false,
    limits: {
      cpuSeconds: 10,
      fileBytes: 1024 * 1024,
      memoryMb: 512,
      processes: 64,
      sandboxMemoryMb: 1024,
    },
    image: null,
    name: 'nova-runner-x',
    ...over,
  });

  it('bubblewrap mounts only the environment folders and shares the network only when allowed', () => {
    const b = new BwrapSubstrate({ bin: '/usr/bin/bwrap' });
    const a = b.args(spec());
    expect(a).toContain('--unshare-all');
    expect(a).not.toContain('--share-net');
    expect(a).toContain('--clearenv');
    expect(a.join(' ')).toContain('--bind /data/envs/e1/work /workspace');
    expect(a.join(' ')).toContain('--bind /data/envs/e1/caches/npm /cache/npm');
    expect(a.join(' ')).toContain('--setenv FOO bar');
    expect(a.join(' ')).not.toContain('bad name');
    // No other writable host path.
    const binds = a.flatMap((v, i) => (v === '--bind' ? [a[i + 1]] : []));
    expect(binds).toEqual(['/data/envs/e1/work', '/data/envs/e1/caches/npm']);
    expect(b.args(spec({ network: true }))).toContain('--share-net');
    const ro = b.args(
      spec({ mounts: [{ host: '/data/envs/e1/work', target: '/workspace', writable: false }] }),
    );
    expect(ro.join(' ')).toContain('--ro-bind /data/envs/e1/work /workspace');
    expect(() =>
      b.args(spec({ mounts: [{ host: '/a,b', target: '/workspace', writable: true }] })),
    ).toThrow(/commas/);
    // Every program starts under the sandbox-wide process limit (finding 7).
    const tail = a.slice(a.indexOf('--seccomp'));
    expect(tail.slice(0, 5)).toEqual(['--seccomp', '3', '--', '/bin/sh', '-c']);
    expect(tail[5]).toMatch(/ulimit -d 524288 .*ulimit -p 64 .*ulimit -u 64.*exec "\$@"/);
    expect(tail.slice(6)).toEqual(['nova-sandbox', '/bin/sh', '-c', 'true']);
  });

  it('puts each sandbox in a cgroup scope with pids and memory limits when it can', async () => {
    const b = new BwrapSubstrate({ bin: '/usr/bin/bwrap', cgroup: 'off' });
    expect(b.launch(spec()).bin).toBe('/usr/bin/bwrap');
    const scoped = new BwrapSubstrate({ bin: '/usr/bin/bwrap', systemdRun: '/bin/true' });
    const a = await scoped.available();
    if (!a.ok) return; // no bubblewrap here; the arguments are what matters below
    expect(scoped.cgroups).toBe(true);
    const l = scoped.launch(spec());
    expect(l.bin).toBe('/bin/true');
    expect(l.args.slice(0, 5)).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--expand-environment=no',
    ]);
    expect(l.args).toEqual(expect.arrayContaining(['TasksMax=68', 'MemoryMax=1024M']));
    expect(l.args[l.args.indexOf('--') + 1]).toBe('/usr/bin/bwrap');
    const none = new BwrapSubstrate({ bin: '/usr/bin/bwrap', systemdRun: '/bin/false' });
    expect((await none.available()).detail).toMatch(/no cgroup/);
    expect(none.cgroups).toBe(false);
  });

  it('refuses to sandbox as root under bubblewrap', async () => {
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try {
      const a = await new BwrapSubstrate({ bin: '/usr/bin/bwrap' }).available();
      expect(a).toMatchObject({ ok: false });
      expect(a.detail).toMatch(/runs as root/);
    } finally {
      spy.mockRestore();
    }
  });

  it('containers run without network as a non-root user with limits', () => {
    const c = new ContainerSubstrate({ bin: 'docker' });
    const a = c.args(spec());
    expect(a.slice(0, 2)).toEqual(['run', '--rm']);
    expect(a.join(' ')).toContain('--network none');
    expect(a.join(' ')).toContain('--cap-drop ALL');
    expect(a.join(' ')).toContain('--security-opt no-new-privileges');
    expect(a.join(' ')).toContain('--ulimit cpu=10:10');
    expect(a.join(' ')).toContain('type=bind,source=/data/envs/e1/work,target=/workspace');
    expect(a).toContain('debian:stable-slim');
    expect(c.args(spec({ network: true, image: 'node:24' })).join(' ')).toMatch(
      /--network bridge.*node:24/,
    );
    const ro = c.args(spec({ mounts: [{ host: '/w', target: '/workspace', writable: false }] }));
    expect(ro.join(' ')).toContain('target=/workspace,readonly');
    // The image's ENTRYPOINT is replaced by the program, so the limits always wrap it.
    expect(a.slice(a.indexOf('--entrypoint'), a.indexOf('--entrypoint') + 5)).toEqual([
      '--entrypoint',
      '/bin/sh',
      'debian:stable-slim',
      '-c',
      'true',
    ]);
    expect(a.join(' ')).toContain('--pids-limit 64');
    expect(a.join(' ')).toContain('--memory 1024m --memory-swap 1024m');
  });

  it('wraps commands with limits and a private CPU report', () => {
    const lim = {
      fileBytes: 4096,
      memoryMb: 100,
      processes: 32,
      sandboxMemoryMb: 200,
      processRlimit: true,
    };
    const s = commandScript({ cpuSeconds: 2.2, ...lim }, 'fd');
    expect(s).toContain('ulimit -S -t 3');
    expect(s).toContain('ulimit -H -t 4');
    expect(s).toContain('ulimit -f 8');
    expect(s).toContain('4>&-');
    expect(s).toContain('ulimit -p 32');
    expect(commandScript({ cpuSeconds: 1, ...lim }, 'stderr')).toContain('NOVA_METER= /bin/sh');
  });

  it('refuses when sandboxes are turned off or missing', async () => {
    expect((await detectSubstrate({ mode: 'none' })).substrate).toBeNull();
    const d = await detectSubstrate({ mode: 'podman', env: { PATH: '/nonexistent' } });
    expect(d.substrate).toBeNull();
    expect(d.detail).toMatch(/podman is not installed/);
  });
});
