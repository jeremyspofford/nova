// The Linux OS sandbox (FR-107, docs/11 §2.5, docs/12 §7.3): bubblewrap with new user, PID,
// IPC, UTS, cgroup and network namespaces, no new privileges, every capability dropped, nested
// user namespaces disabled, a cleared environment, and a seccomp filter that denies io_uring,
// kernel-module loading, kexec, bpf, perf events and userfaultfd and, with network `off`, every
// socket family but AF_UNIX. The host's system folders are mounted read-only; the turn's roots
// at their own paths, read-only unless the profile grants writing; credential locations inside
// them are masked (docs/12 §7.2). The network namespace has only loopback; with `allowlist` or
// `limited` its only route is the egress proxy's socket, bridged in by a forwarder (sandbox-
// egress.ts). Limits: memory (RLIMIT_DATA) and CPU time (RLIMIT_CPU) inside, wall clock from the
// broker. A missing bubblewrap, an unsupported CPU or a failed self-test fails closed.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { NovaError } from '@nova/shared';
import {
  EGRESS_MOUNT,
  FORWARDER_NODE,
  NODE_FORWARDER,
  forwarderPrelude,
  openEgress,
  proxyEnv,
  type SandboxEgress,
  type SandboxEgressSession,
} from './sandbox-egress.ts';
import { sandboxMounts } from './sandbox-protect.ts';
import {
  ProcessSandbox,
  type LaunchPlan,
  type ProcessSandboxOptions,
  type SandboxExecRequest,
} from './sandbox-process.ts';
import type { ExecRequest } from './types.ts';

// ---- seccomp ----------------------------------------------------------------------------------

export type SeccompArch = 'x86_64' | 'aarch64';

const AUDIT_ARCH: Record<SeccompArch, number> = { x86_64: 0xc000003e, aarch64: 0xc00000b7 };

/** Syscalls denied in every sandbox, and the socket syscall, per architecture. */
const SYSCALLS: Record<SeccompArch, { denied: Record<string, number>; socket: number }> = {
  x86_64: {
    socket: 41,
    denied: {
      io_uring_setup: 425,
      io_uring_enter: 426,
      io_uring_register: 427,
      kexec_load: 246,
      kexec_file_load: 320,
      init_module: 175,
      finit_module: 313,
      delete_module: 176,
      bpf: 321,
      perf_event_open: 298,
      userfaultfd: 323,
    },
  },
  aarch64: {
    socket: 198,
    denied: {
      io_uring_setup: 425,
      io_uring_enter: 426,
      io_uring_register: 427,
      kexec_load: 104,
      kexec_file_load: 294,
      init_module: 105,
      finit_module: 273,
      delete_module: 106,
      bpf: 280,
      perf_event_open: 241,
      userfaultfd: 282,
    },
  },
};

const BPF = {
  LD_W_ABS: 0x20,
  JEQ_K: 0x15,
  JGE_K: 0x35,
  RET_K: 0x06,
};
const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const EPERM = 1;
const EAFNOSUPPORT = 97;
const AF_UNIX = 1;

type Ins = { label: string } | { code: number; k: number; jt?: string; jf?: string };

/** Assemble classic BPF with forward jumps to labels (each jump fits in 8 bits). */
function assemble(prog: Ins[]): Buffer {
  const labels = new Map<string, number>();
  const code: Exclude<Ins, { label: string }>[] = [];
  for (const i of prog) {
    if ('label' in i) labels.set(i.label, code.length);
    else code.push(i);
  }
  const out = Buffer.alloc(code.length * 8);
  code.forEach((ins, idx) => {
    const off = (l: string | undefined) => {
      if (l === undefined) return 0;
      const to = labels.get(l);
      if (to === undefined || to <= idx || to - idx - 1 > 255)
        throw new Error(`bad seccomp jump to ${l}`);
      return to - idx - 1;
    };
    out.writeUInt16LE(ins.code, idx * 8);
    out.writeUInt8(off(ins.jt), idx * 8 + 2);
    out.writeUInt8(off(ins.jf), idx * 8 + 3);
    out.writeUInt32LE(ins.k >>> 0, idx * 8 + 4);
  });
  return out;
}

/** The architecture of this process, or null when no filter exists for it. */
export function seccompArch(arch: string = process.arch): SeccompArch | null {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'arm64') return 'aarch64';
  return null;
}

/**
 * The seccomp program bubblewrap installs (`--seccomp 3`): `struct sock_filter[]` in the host's
 * byte order (little-endian on both supported architectures). Another architecture's syscalls
 * (and the x32 ABI) kill the process; denied syscalls fail with EPERM; with network `off`, a
 * socket that is not AF_UNIX fails with EAFNOSUPPORT.
 */
export function buildSeccompFilter(arch: SeccompArch, network: 'off' | 'proxy'): Buffer {
  const t = SYSCALLS[arch];
  const prog: Ins[] = [
    { code: BPF.LD_W_ABS, k: 4 },
    { code: BPF.JEQ_K, k: AUDIT_ARCH[arch], jf: 'kill' },
    { code: BPF.LD_W_ABS, k: 0 },
  ];
  if (arch === 'x86_64') prog.push({ code: BPF.JGE_K, k: 0x40000000, jt: 'kill' });
  for (const nr of Object.values(t.denied)) prog.push({ code: BPF.JEQ_K, k: nr, jt: 'eperm' });
  if (network === 'off') prog.push({ code: BPF.JEQ_K, k: t.socket, jt: 'socket' });
  prog.push(
    { code: BPF.RET_K, k: RET_ALLOW },
    { label: 'eperm' },
    { code: BPF.RET_K, k: RET_ERRNO | EPERM },
    { label: 'kill' },
    { code: BPF.RET_K, k: RET_KILL_PROCESS },
  );
  if (network === 'off')
    prog.push(
      { label: 'socket' },
      // args[0] (the address family), low 32 bits.
      { code: BPF.LD_W_ABS, k: 16 },
      { code: BPF.JEQ_K, k: AF_UNIX, jt: 'allow_unix' },
      { code: BPF.RET_K, k: RET_ERRNO | EAFNOSUPPORT },
      { label: 'allow_unix' },
      { code: BPF.RET_K, k: RET_ALLOW },
    );
  return assemble(prog);
}

// ---- bubblewrap -------------------------------------------------------------------------------

export interface BwrapSandboxOptions extends ProcessSandboxOptions {
  /** Absolute path of `bwrap`, found outside the project and every writable root. */
  bin: string;
  egress?: SandboxEgress;
  /** RLIMIT_DATA for every process inside (default 2048 MB). */
  memoryMb?: number;
  /** RLIMIT_CPU in seconds (default: the wall clock times 2 CPUs, or 1 hour). */
  cpuSeconds?: number;
  /** The forwarder runtime (default: this Node binary). */
  nodeBin?: string;
  /** Extra host folders mounted read-only (toolchains outside /usr). */
  readOnly?: string[];
}

const SYSTEM_DIRS = ['/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32', '/etc', '/opt'];

export class BwrapSandbox extends ProcessSandbox {
  readonly substrate = 'os_sandbox' as const;
  readonly #bin: string;
  readonly #egress: SandboxEgress | undefined;
  readonly #memoryMb: number;
  readonly #cpuSeconds: number;
  readonly #nodeBin: string;
  readonly #readOnly: string[];
  readonly #arch: SeccompArch | null;
  #disableUserns = true;
  #probe: { at: number; value: { ok: boolean; detail: string } } | null = null;

  constructor(opts: BwrapSandboxOptions) {
    super(opts);
    this.#bin = opts.bin;
    this.#egress = opts.egress;
    this.#memoryMb = opts.memoryMb ?? 2048;
    this.#cpuSeconds =
      opts.cpuSeconds ?? (opts.wallClockMs ? Math.ceil(opts.wallClockMs / 1000) * 2 : 3600);
    let node = opts.nodeBin ?? process.execPath;
    try {
      node = realpathSync(node);
    } catch {
      // Keep the given path; the forwarder then fails visibly.
    }
    this.#nodeBin = node;
    this.#readOnly = opts.readOnly ?? [];
    this.#arch = seccompArch();
  }

  /** Whether bubblewrap runs here: a supported CPU, a working binary and user namespaces. */
  async available(): Promise<{ ok: boolean; detail: string }> {
    if (this.#probe && Date.now() - this.#probe.at < 30_000) return this.#probe.value;
    const value = await this.#check();
    this.#probe = { at: Date.now(), value };
    return value;
  }

  async #check(): Promise<{ ok: boolean; detail: string }> {
    if (process.platform !== 'linux')
      return { ok: false, detail: 'Bubblewrap sandboxes need Linux.' };
    if (!this.#arch)
      return {
        ok: false,
        detail: `No seccomp filter exists for this CPU (${process.arch}), so commands cannot run sandboxed.`,
      };
    const run = (args: string[]) =>
      new Promise<{ ok: boolean; out: string }>((resolve) => {
        execFile(this.#bin, args, { timeout: 5_000 }, (err, stdout, stderr) =>
          resolve({ ok: !err, out: `${String(stdout)}${String(stderr)}`.trim() }),
        );
      });
    const version = await run(['--version']);
    if (!version.ok) return { ok: false, detail: `${this.#bin} does not run: ${version.out}` };
    const m = /(\d+)\.(\d+)/.exec(version.out);
    // --disable-userns arrived in 0.8.
    this.#disableUserns = !!m && (Number(m[1]) > 0 || Number(m[2]) >= 8);
    const self = await run([...this.#baseArgs(), '--', '/bin/sh', '-c', 'true']);
    if (!self.ok)
      return {
        ok: false,
        detail: `Bubblewrap cannot create a sandbox here (user namespaces may be disabled; WSL1 is not supported): ${self.out.slice(0, 300)}`,
      };
    return {
      ok: true,
      detail: `bubblewrap ${version.out.replace(/^bubblewrap\s*/, '')}, seccomp ${this.#arch}`,
    };
  }

  #baseArgs(): string[] {
    const args = [
      '--unshare-all',
      '--unshare-user',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
    ];
    if (this.#disableUserns) args.push('--disable-userns');
    args.push('--ro-bind', '/usr', '/usr');
    for (const d of [...SYSTEM_DIRS, ...this.#readOnly]) {
      let st;
      try {
        st = lstatSync(d);
      } catch {
        continue;
      }
      // Merged-/usr systems link /bin and friends into /usr: keep them links.
      if (st.isSymbolicLink()) args.push('--symlink', readlinkSync(d), d);
      else args.push('--ro-bind', d, d);
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/run/nova');
    return args;
  }

  /** The `bwrap` arguments for one command, exposed for tests. */
  bwrapArgs(req: ExecRequest, egress: SandboxEgressSession | null = null): string[] {
    const args = [...this.#baseArgs(), '--clearenv'];
    const env: Record<string, string> = {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/tmp',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      ...(req.env ?? {}),
    };
    // Roots, then the protected paths in them (docs/12 §7.2), parents before children.
    const mounts = sandboxMounts({
      roots: req.roots.filter((r) => r.path !== '/' && r.path.startsWith('/')),
      cwd: req.cwd,
      gitWrite: req.gitWrite === true,
      deniedPaths: this.deniedPaths,
    });
    for (const m of mounts) {
      if (m.kind === 'root') args.push(m.writable ? '--bind' : '--ro-bind', m.path, m.path);
      else if (m.kind === 'read_only') args.push('--ro-bind', m.path, m.path);
      else if (m.kind === 'hide_dir') args.push('--tmpfs', m.path);
      else args.push('--ro-bind', '/dev/null', m.path);
    }
    let prelude = '';
    if (egress) {
      args.push('--bind', egress.dir, EGRESS_MOUNT, '--ro-bind', this.#nodeBin, FORWARDER_NODE);
      Object.assign(env, proxyEnv(egress), { NOVA_EGRESS_FORWARDER: NODE_FORWARDER });
      prelude = forwarderPrelude('node', egress.socketName);
    }
    for (const [k, v] of Object.entries(env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) args.push('--setenv', k, v);
    }
    const limits = `ulimit -d ${this.#memoryMb * 1024} 2>/dev/null; ulimit -t ${this.#cpuSeconds} 2>/dev/null;`;
    args.push(
      '--chdir',
      req.cwd,
      '--seccomp',
      '3',
      '--',
      '/bin/sh',
      '-c',
      `${limits} ${prelude} exec /bin/sh -c "$1"`,
      'nova-sandbox',
      req.cmd,
    );
    return args;
  }

  protected async plan(req: SandboxExecRequest): Promise<LaunchPlan> {
    const a = await this.available();
    if (!a.ok || !this.#arch) throw new NovaError('sandbox_unavailable', a.detail);
    if (!existsSync(req.cwd))
      throw new NovaError('validation', `the folder ${req.cwd} does not exist`);
    // Only a proxy route needs the network; `off` gets the stricter socket filter.
    const { session, note } = await openEgress(this.#egress, req);
    const args = this.bwrapArgs(req, session);
    const plan: LaunchPlan = {
      bin: this.#bin,
      args,
      fd3: buildSeccompFilter(this.#arch, session ? 'proxy' : 'off'),
    };
    if (session) plan.cleanup = () => session.close();
    if (note) plan.note = note;
    return plan;
  }
}
