// The runner's isolated sandboxes (FR-108; the isolation rules of the Hub's sandboxes, docs/12 §7,
// written for this Apache-2.0 package, ADR-023). Every command and every file operation of an
// environment runs inside one, never on the runner host:
//
// - bubblewrap (preferred): new user, PID, IPC, UTS, cgroup and network namespaces, no new
//   privileges, every capability dropped, nested user namespaces disabled, a cleared environment
//   and the seccomp program of seccomp.ts. The host's system folders are mounted read-only; the
//   environment's workdir is mounted at /workspace and its caches at /cache/<name>, and nothing
//   else of the host. The network namespace has only loopback unless the environment allows
//   network, which then shares the runner host's network.
// - a container runtime CLI (docker or podman): the environment's base image (or the default one)
//   as a non-root user with every capability dropped, no new privileges, pid, memory and CPU
//   limits, `--network none` unless the environment allows network, and the same two mounts.
// - neither: the runner refuses environments and says why (fail closed).
//
// Limits inside: memory (RLIMIT_DATA), CPU time (RLIMIT_CPU, the run's remaining CPU seconds) and
// file size (RLIMIT_FSIZE, the environment's remaining disk). A command's CPU time is measured by
// the runner (meter.ts) and reported by the sandbox's own shell on a private file descriptor.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream, lstatSync, readlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { filterArch, seccompProgram, type FilterArch } from './seccomp.ts';

export type SubstrateKind = 'bwrap' | 'container';

export interface SandboxMount {
  /** A folder of the environment on the runner host. */
  host: string;
  /** Where it appears inside (/workspace, /cache/<name>). */
  target: string;
  writable: boolean;
}

export interface SandboxLimits {
  /** RLIMIT_CPU for each process inside (seconds, at least 1). */
  cpuSeconds: number;
  /** RLIMIT_FSIZE for each process inside (bytes). */
  fileBytes: number;
  /** RLIMIT_DATA for each process inside (MB). */
  memoryMb: number;
  /**
   * Processes the whole sandbox may have at once: RLIMIT_NPROC, which the kernel counts per
   * user namespace, so per bubblewrap sandbox; and the cgroup's (or the container's) pids limit.
   */
  processes: number;
  /** Memory of the whole sandbox (MB): the cgroup's or the container's limit. */
  sandboxMemoryMb: number;
  /**
   * Set RLIMIT_NPROC in the scripts too: only where it counts per sandbox (a user namespace of
   * its own). Elsewhere it would count the runner user's processes and threads host-wide.
   */
  processRlimit?: boolean;
}

export interface SandboxSpec {
  /** The program inside, e.g. ['/bin/sh', '-c', script]. */
  argv: string[];
  mounts: SandboxMount[];
  cwd: string;
  env: Record<string, string>;
  network: boolean;
  limits: SandboxLimits;
  /** The container image (container substrate only; the default when null). */
  image: string | null;
  /** Unique per launch (the container's name). */
  name: string;
}

export interface SandboxProcess {
  child: ChildProcess;
  /** The host pid whose process tree holds every process inside (bubblewrap), else null. */
  treePid: number | null;
  /** The sandbox shell's own report of CPU times (`times`), when the substrate gives one. */
  meter: Readable | null;
  kill(): Promise<void>;
  interrupt(): Promise<void>;
}

export interface Substrate {
  readonly kind: SubstrateKind;
  /** How the sandbox's shell reports CPU times (commandScript). */
  readonly meter: 'fd' | 'stderr';
  /** RLIMIT_NPROC counts per sandbox here (each sandbox has its own user namespace). */
  readonly processRlimit: boolean;
  /** Whether environments may ask for their own base image. */
  readonly supportsImage: boolean;
  available(): Promise<{ ok: boolean; detail: string }>;
  spawn(spec: SandboxSpec): SandboxProcess;
}

/** The limits every program inside starts under (RLIMIT_DATA, RLIMIT_CPU, RLIMIT_FSIZE). */
export function limitsPrelude(limits: SandboxLimits): string {
  const blocks = Math.max(1, Math.floor(limits.fileBytes / 512));
  const cpu = Math.max(1, Math.ceil(limits.cpuSeconds));
  return [
    `ulimit -d ${Math.max(16, Math.floor(limits.memoryMb)) * 1024} 2>/dev/null`,
    // SIGXCPU at the soft limit (exit 152), SIGKILL a second later if it is caught.
    `ulimit -S -t ${cpu} 2>/dev/null`,
    `ulimit -H -t ${cpu + 1} 2>/dev/null`,
    `ulimit -f ${blocks} 2>/dev/null`,
    ...(limits.processRlimit ? [processLimit(limits.processes)] : []),
  ].join('; ');
}

/** RLIMIT_NPROC (`-p` in dash, `-u` in bash). */
function processLimit(n: number): string {
  const p = Math.max(8, Math.floor(n));
  return `{ ulimit -p ${p} 2>/dev/null || ulimit -u ${p} 2>/dev/null; }`;
}

/**
 * The script every command runs under: limits, the command, then the shell's `times` (the CPU the
 * command and everything it waited for used): on fd 4, which the command never sees (`fd`), or as
 * the last line of stderr after the marker in $NOVA_METER (`stderr`, containers).
 */
export function commandScript(limits: SandboxLimits, meter: 'fd' | 'stderr'): string {
  const lim = limitsPrelude(limits);
  // The command never sees fd 4 (or the marker), so only this shell reports.
  return meter === 'fd'
    ? `${lim}; /bin/sh -c "$1" 4>&-; s=$?; times >&4 2>/dev/null; exit $s`
    : `${lim}; m=$NOVA_METER; NOVA_METER= /bin/sh -c "$1"; s=$?; printf '\\n%s %s\\n' "$m" "$(times | tr '\\n' ' ')" >&2; exit $s`;
}

/** The script a program (an argv, no shell between its words) runs under, like commandScript. */
export function programScript(limits: SandboxLimits, meter: 'fd' | 'stderr'): string {
  const lim = limitsPrelude(limits);
  return meter === 'fd'
    ? `${lim}; "$@" 4>&-; s=$?; times >&4 2>/dev/null; exit $s`
    : `${lim}; m=$NOVA_METER; NOVA_METER= "$@"; s=$?; printf '\\n%s %s\\n' "$m" "$(times | tr '\\n' ' ')" >&2; exit $s`;
}

const SYSTEM_DIRS = ['/bin', '/sbin', '/lib', '/lib64', '/lib32', '/libx32', '/etc', '/opt'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** What systemd-run needs to reach the user's service manager, and nothing else. */
function scopeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? BASE_PATH };
  for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'])
    if (process.env[k]) env[k] = process.env[k];
  return env;
}

function run(
  bin: string,
  args: string[],
  timeoutMs = 5_000,
  env?: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, ...(env ? { env } : {}) }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${String(stdout)}${String(stderr)}`.trim() }),
    );
  });
}

function checkMount(m: SandboxMount): void {
  if (!m.host.startsWith('/') || !m.target.startsWith('/'))
    throw new Error('sandbox mounts need absolute paths');
  if (/[,\n\0]/.test(m.host) || /[,\n\0]/.test(m.target))
    throw new Error('sandbox mount paths cannot contain commas or newlines');
}

// ---- bubblewrap ---------------------------------------------------------------------------------

export interface BwrapOptions {
  bin: string;
  /** Extra host folders mounted read-only (toolchains outside /usr). */
  readOnly?: string[];
  /**
   * Put each sandbox in its own cgroup with pids and memory limits through a transient systemd
   * user scope (`auto`: when `systemd-run --user --scope` works here). Without one, the process
   * count is still limited per sandbox (RLIMIT_NPROC) and memory per process (RLIMIT_DATA).
   */
  cgroup?: 'auto' | 'off';
  /** The systemd-run binary (tests). */
  systemdRun?: string;
}

export class BwrapSubstrate implements Substrate {
  readonly kind = 'bwrap' as const;
  readonly meter = 'fd' as const;
  readonly processRlimit = true;
  readonly supportsImage = false;
  readonly #bin: string;
  readonly #readOnly: string[];
  readonly #arch: FilterArch | null = filterArch();
  readonly #cgroupMode: 'auto' | 'off';
  readonly #systemdRun: string;
  #disableUserns = true;
  /** systemd-run, when each sandbox gets its own cgroup scope. */
  #scope: string | null = null;
  #probe: { at: number; value: { ok: boolean; detail: string } } | null = null;

  constructor(opts: BwrapOptions) {
    this.#bin = opts.bin;
    this.#readOnly = opts.readOnly ?? [];
    this.#cgroupMode = opts.cgroup ?? 'auto';
    this.#systemdRun = opts.systemdRun ?? 'systemd-run';
  }

  /** Whether sandboxes get their own cgroup (pids and memory limits). */
  get cgroups(): boolean {
    return this.#scope !== null;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    if (this.#probe && Date.now() - this.#probe.at < 30_000) return this.#probe.value;
    const value = await this.#check();
    this.#probe = { at: Date.now(), value };
    return value;
  }

  async #check(): Promise<{ ok: boolean; detail: string }> {
    if (process.platform !== 'linux') return { ok: false, detail: 'bubblewrap needs Linux' };
    // As root, the sandbox's own user would be root on the host's files too (bind mounts).
    if (process.getuid?.() === 0)
      return {
        ok: false,
        detail:
          'the runner runs as root: run it as an unprivileged user (or use the container substrate)',
      };
    if (!this.#arch)
      return { ok: false, detail: `no seccomp program exists for this CPU (${process.arch})` };
    const version = await run(this.#bin, ['--version']);
    if (!version.ok) return { ok: false, detail: `${this.#bin} does not run: ${version.out}` };
    const m = /(\d+)\.(\d+)/.exec(version.out);
    // --disable-userns arrived in bubblewrap 0.8.
    this.#disableUserns = !!m && (Number(m[1]) > 0 || Number(m[2]) >= 8);
    const self = await run(this.#bin, [...this.#base(false), '--', '/bin/sh', '-c', 'true']);
    if (!self.ok)
      return {
        ok: false,
        detail: `bubblewrap cannot create a sandbox here (user namespaces may be disabled): ${self.out.slice(0, 300)}`,
      };
    this.#scope = null;
    if (this.#cgroupMode === 'auto') {
      const scope = await run(
        this.#systemdRun,
        [...scopeArgs({ processes: 16, sandboxMemoryMb: 64 }), '--', '/bin/sh', '-c', 'true'],
        5_000,
        scopeEnv(),
      );
      if (scope.ok) this.#scope = this.#systemdRun;
    }
    return {
      ok: true,
      detail: `bubblewrap ${version.out.replace(/^bubblewrap\s*/, '')}, seccomp ${this.#arch}, ${
        this.#scope
          ? 'a cgroup per sandbox (pids, memory)'
          : 'a process limit per sandbox, memory per process (no cgroup)'
      }`,
    };
  }

  #base(network: boolean): string[] {
    const args = ['--unshare-all'];
    if (network) args.push('--share-net');
    args.push(
      '--unshare-user',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--hostname',
      'nova-runner',
    );
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
    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
    return args;
  }

  /** The bwrap arguments for one launch (exposed for tests). */
  args(spec: SandboxSpec): string[] {
    const args = [...this.#base(spec.network), '--clearenv'];
    for (const m of spec.mounts) {
      checkMount(m);
      args.push(m.writable ? '--bind' : '--ro-bind', m.host, m.target);
    }
    const env: Record<string, string> = {
      PATH: BASE_PATH,
      HOME: '/tmp',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      ...spec.env,
    };
    for (const [k, v] of Object.entries(env)) if (ENV_NAME.test(k)) args.push('--setenv', k, v);
    // Every program starts under the sandbox-wide process limit and the memory limit per process.
    const guard = `ulimit -d ${Math.max(16, Math.floor(spec.limits.memoryMb)) * 1024} 2>/dev/null; ${processLimit(spec.limits.processes)}; exec "$@"`;
    args.push(
      '--chdir',
      spec.cwd,
      '--seccomp',
      '3',
      '--',
      '/bin/sh',
      '-c',
      guard,
      'nova-sandbox',
      ...spec.argv,
    );
    return args;
  }

  /** The program and arguments spawned for one launch: in a cgroup scope when there is one. */
  launch(spec: SandboxSpec): { bin: string; args: string[] } {
    const args = this.args(spec);
    if (!this.#scope) return { bin: this.#bin, args };
    return { bin: this.#scope, args: [...scopeArgs(spec.limits), '--', this.#bin, ...args] };
  }

  spawn(spec: SandboxSpec): SandboxProcess {
    if (!this.#arch) throw new Error('no seccomp program for this CPU');
    const { bin, args } = this.launch(spec);
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      // Its own process group: a kill reaches bwrap, whose death ends the namespace.
      detached: true,
      // bwrap clears the environment inside (--clearenv); systemd-run needs the user bus.
      env: this.#scope ? scopeEnv() : {},
    });
    // A killed sandbox resets its pipes: that is not an error of the runner.
    for (const st of child.stdio) st?.on('error', () => undefined);
    const fd3 = child.stdio[3] as NodeJS.WritableStream | null;
    fd3?.end(seccompProgram(this.#arch, spec.network));
    const meter = (child.stdio[4] as Readable | null) ?? null;
    const signal = (sig: NodeJS.Signals) => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // Already gone.
        }
      }
    };
    return {
      child,
      treePid: child.pid ?? null,
      meter,
      kill: () => {
        signal('SIGKILL');
        return Promise.resolve();
      },
      interrupt: () => {
        // SIGINT to bwrap reaches only bwrap; the tree walk in meter.ts signals the processes
        // inside (they are in their own session).
        signal('SIGINT');
        return Promise.resolve();
      },
    };
  }
}

/** A transient systemd user scope (systemd-run execs the sandbox in place, keeping its fds). */
function scopeArgs(limits: Pick<SandboxLimits, 'processes' | 'sandboxMemoryMb'>): string[] {
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    // Arguments reach the sandbox as they are (systemd-run would expand $VARIABLES in them; an
    // older systemd without this option fails the probe, so no scope is used there).
    '--expand-environment=no',
    '-p',
    `TasksMax=${Math.max(8, Math.floor(limits.processes)) + 4}`,
    '-p',
    `MemoryMax=${Math.max(64, Math.floor(limits.sandboxMemoryMb))}M`,
    '-p',
    'MemorySwapMax=0',
  ];
}

// ---- container runtime CLI -------------------------------------------------------------------

export const DEFAULT_IMAGE = 'debian:stable-slim';

export interface ContainerOptions {
  /** `docker`, `podman` or a path to either. */
  bin: string;
  image?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
}

export class ContainerSubstrate implements Substrate {
  readonly kind = 'container' as const;
  readonly meter = 'stderr' as const;
  // A container shares the runner user's uid without a user namespace: its pids limit does it.
  readonly processRlimit = false;
  readonly supportsImage = true;
  readonly #bin: string;
  readonly #image: string;
  readonly #user: string;
  readonly #cpus: number;
  readonly #pids: number;
  #probe: { at: number; value: { ok: boolean; detail: string } } | null = null;

  constructor(opts: ContainerOptions) {
    this.#bin = opts.bin;
    this.#image = opts.image ?? DEFAULT_IMAGE;
    const uid = process.getuid?.() ?? 65534;
    const gid = process.getgid?.() ?? 65534;
    this.#user = uid === 0 ? '65534:65534' : `${uid}:${gid}`;
    this.#cpus = opts.cpus ?? 2;
    this.#pids = opts.pidsLimit ?? 512;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    if (this.#probe && Date.now() - this.#probe.at < 30_000) return this.#probe.value;
    const r = await run(this.#bin, ['version', '--format', '{{.Server.Version}}']);
    const value =
      r.ok && r.out
        ? { ok: true, detail: `${this.#bin} ${r.out}, default image ${this.#image}` }
        : { ok: false, detail: `${this.#bin} is installed but its engine is not running` };
    this.#probe = { at: Date.now(), value };
    return value;
  }

  /** The `<bin> run` arguments for one launch (exposed for tests). */
  args(spec: SandboxSpec): string[] {
    const cpu = Math.max(1, Math.ceil(spec.limits.cpuSeconds));
    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      spec.name,
      '--user',
      this.#user,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(Math.min(this.#pids, Math.max(8, Math.floor(spec.limits.processes)))),
      '--memory',
      `${Math.max(64, Math.floor(spec.limits.sandboxMemoryMb))}m`,
      '--memory-swap',
      `${Math.max(64, Math.floor(spec.limits.sandboxMemoryMb))}m`,
      '--cpus',
      String(this.#cpus),
      '--ulimit',
      `cpu=${cpu}:${cpu}`,
      '--network',
      spec.network ? 'bridge' : 'none',
      '--hostname',
      'nova-runner',
      '--workdir',
      spec.cwd,
    ];
    for (const m of spec.mounts) {
      checkMount(m);
      args.push(
        '--mount',
        `type=bind,source=${m.host},target=${m.target}${m.writable ? '' : ',readonly'}`,
      );
    }
    const env: Record<string, string> = {
      HOME: '/tmp',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      ...spec.env,
    };
    for (const [k, v] of Object.entries(env)) if (ENV_NAME.test(k)) args.push('-e', `${k}=${v}`);
    // The image's own ENTRYPOINT never runs: the program is the entrypoint, so the limits and
    // the CPU report always wrap the command.
    const [entry, ...rest] = spec.argv;
    if (!entry) throw new Error('nothing to run');
    args.push('--entrypoint', entry, spec.image ?? this.#image, ...rest);
    return args;
  }

  spawn(spec: SandboxSpec): SandboxProcess {
    const child = spawn(this.#bin, this.args(spec), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? BASE_PATH, HOME: process.env.HOME ?? '/tmp' },
    });
    for (const st of child.stdio) st?.on('error', () => undefined);
    const cli = (args: string[]) =>
      new Promise<void>((resolve) => {
        execFile(this.#bin, args, { timeout: 10_000 }, () => resolve());
      });
    return {
      child,
      treePid: null,
      meter: null,
      // The CLI's death does not stop the container; the engine does.
      kill: () => cli(['kill', spec.name]),
      interrupt: () => cli(['kill', '--signal', 'INT', spec.name]),
    };
  }
}

// ---- detection ----------------------------------------------------------------------------------

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface DetectOptions {
  /** `auto` (default: bubblewrap, else docker, else podman), `bwrap`, `docker`, `podman`, `none`. */
  mode?: string;
  image?: string;
  env?: NodeJS.ProcessEnv;
}

/** The substrate of this host, or null with the reason (environments are then refused). */
export async function detectSubstrate(
  opts: DetectOptions = {},
): Promise<{ substrate: Substrate | null; detail: string }> {
  const mode = (opts.mode ?? 'auto').toLowerCase();
  if (mode === 'none')
    return { substrate: null, detail: 'sandboxes are turned off on this runner' };
  const tried: string[] = [];
  if (mode === 'auto' || mode === 'bwrap') {
    const bin = findOnPath('bwrap', opts.env);
    if (bin) {
      const s = new BwrapSubstrate({ bin });
      const a = await s.available();
      if (a.ok) return { substrate: s, detail: a.detail };
      tried.push(a.detail);
    } else tried.push('bubblewrap is not installed');
  }
  const names =
    mode === 'docker' || mode === 'podman' ? [mode] : mode === 'auto' ? ['docker', 'podman'] : [];
  for (const n of names) {
    const bin = findOnPath(n, opts.env);
    if (!bin) {
      tried.push(`${n} is not installed`);
      continue;
    }
    const s = new ContainerSubstrate({ bin, ...(opts.image ? { image: opts.image } : {}) });
    const a = await s.available();
    if (a.ok) return { substrate: s, detail: a.detail };
    tried.push(a.detail);
  }
  return {
    substrate: null,
    detail: `no sandbox can run here (${tried.join('; ') || `unknown mode ${mode}`}): install bubblewrap or a container runtime`,
  };
}

// ---- one-shot runs (file operations, snapshots) ----------------------------------------------

export interface RunOnceOptions {
  spec: SandboxSpec;
  stdin?: Buffer | { file: string } | null;
  /** Stream stdout into this file instead of memory. */
  stdoutFile?: string | null;
  /** Bytes of stdout kept in memory (more marks the result truncated). */
  maxStdout?: number;
  /** Bytes written to `stdoutFile` at most (more fails the run). */
  maxFileBytes?: number;
  timeoutMs: number;
}

export interface RunOnceResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** Bytes written to `stdoutFile`. */
  written: number;
  /** What the sandbox shell reported on its private descriptor (programScript, commandScript). */
  meter: string;
}

/** Run one program in the sandbox to completion (no metering; the runner's own operations). */
export function runOnce(substrate: Substrate, opts: RunOnceOptions): Promise<RunOnceResult> {
  const p = substrate.spawn(opts.spec);
  const max = opts.maxStdout ?? 8 * 1024 * 1024;
  const maxFile = opts.maxFileBytes ?? Number.MAX_SAFE_INTEGER;
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let written = 0;
  let stderr = '';
  let timedOut = false;
  let tooBig = false;
  let meter = '';
  p.meter?.on('data', (b: Buffer) => {
    if (meter.length < 4096) meter += b.toString('utf8');
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      void p.kill();
    }, opts.timeoutMs);
    const out = opts.stdoutFile ? createWriteStream(opts.stdoutFile, { mode: 0o600 }) : null;
    p.child.stdout?.on('data', (b: Buffer) => {
      if (out) {
        written += b.length;
        if (written > maxFile && !tooBig) {
          tooBig = true;
          void p.kill();
          return;
        }
        out.write(b);
        return;
      }
      if (size >= max) {
        truncated = true;
        return;
      }
      const take = b.subarray(0, max - size);
      chunks.push(take);
      size += take.length;
      if (take.length < b.length) truncated = true;
    });
    // The head of stderr, and its last kilobyte (a container's CPU report comes last).
    let tail = '';
    let cut = false;
    p.child.stderr?.on('data', (b: Buffer) => {
      const text = b.toString('utf8');
      if (!cut && stderr.length + text.length <= 63 * 1024) stderr += text;
      else {
        cut = true;
        tail = (tail + text).slice(-1024);
      }
    });
    p.child.on('error', (err) => {
      stderr += err.message;
    });
    p.child.on('close', (code) => {
      clearTimeout(timer);
      const done = () =>
        resolve({
          exitCode: tooBig ? null : code,
          stdout: Buffer.concat(chunks),
          stderr: `${stderr}${cut ? `\n[…]\n${tail}` : ''}${tooBig ? `\noutput larger than ${maxFile} bytes` : ''}`,
          truncated,
          timedOut,
          written,
          meter,
        });
      if (out) out.end(done);
      else done();
    });
    const stdin = p.child.stdin;
    if (!stdin) return;
    stdin.on('error', () => undefined);
    if (!opts.stdin) stdin.end();
    else if (Buffer.isBuffer(opts.stdin)) stdin.end(opts.stdin);
    else createReadStream(opts.stdin.file).pipe(stdin);
  });
}
