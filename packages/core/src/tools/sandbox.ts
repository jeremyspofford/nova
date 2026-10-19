// Command sandboxes for `exec.*` (FR-184, FR-190, FR-107; docs/12 §7, docs/11 §2-§3). Three
// substrates behind one client: a container driven through the `docker` or `podman` CLI,
// bubblewrap with seccomp on Linux (sandbox-bwrap.ts), and the flagged micro-VM
// (sandbox-microvm.ts). An unavailable client makes exec tools fail closed; nothing ever runs
// outside a sandbox.
//
// Containers run the turn's roots mounted at their own paths (read-only unless the profile
// grants writing), as a non-root user, with every capability dropped, no new privileges, and
// pid, memory and CPU limits. A command that is still running when its yield time ends becomes
// a session the model can poll or write to; every session of a turn is killed when the turn is
// cancelled or ends.
//
// Network (M6, docs/11 §2.2 and §7): a container always gets `--network none`, its own network
// namespace with only loopback. When the profile allows network and the egress proxy is wired
// in, the session's proxy socket is bind-mounted at /run/nova/egress and a forwarder inside
// relays 127.0.0.1:3128 to it: the proxy is the only route out, for Docker and Podman alike,
// rootful or rootless. Without the proxy, `allowedNetwork: 'open'` keeps the M3 behavior (the
// engine's default network, unfiltered) and anything else fails closed (no network).
//
// Dev servers (FR-097): a request with `publish: {port}` gets the dev-server bridge (sandbox-
// publish.ts): its folder is bind-mounted at /run/nova/publish, a forwarder inside listens on a
// socket there and relays to the port, and the Hub serves it on a free port of its 127.0.0.1.
// Both substrates do it the same way; the command's network is unchanged.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { NovaError } from '@nova/shared';
import { BwrapSandbox } from './sandbox-bwrap.ts';
import {
  EGRESS_MOUNT,
  PERL_FORWARDER,
  forwarderPrelude,
  openEgress,
  proxyEnv,
  type SandboxEgress,
  type SandboxEgressSession,
} from './sandbox-egress.ts';
import { MicroVmSandbox, type MicroVmRunner } from './sandbox-microvm.ts';
import { sandboxMounts } from './sandbox-protect.ts';
import {
  PERL_PUBLISH_FORWARDER,
  PUBLISH_MOUNT,
  openPublish,
  publishBase,
  publishPrelude,
  type PublishBridge,
} from './sandbox-publish.ts';
import {
  ProcessSandbox,
  type LaunchPlan,
  type ProcessSandboxOptions,
  type SandboxExecRequest,
} from './sandbox-process.ts';
import type { ExecRequest, ExecResult, SandboxClient } from './types.ts';

export {
  MAX_SESSIONS_PER_TURN,
  ProcessSandbox,
  type ExecRequestExtras,
  type LaunchPlan,
  type ProcessSandboxOptions,
  type RunOnceResult,
  type SandboxExecRequest,
} from './sandbox-process.ts';
export {
  EGRESS_MOUNT,
  FORWARDER_NODE,
  FORWARDER_PORT,
  NODE_FORWARDER,
  PERL_FORWARDER,
  egressContext,
  forwarderPrelude,
  openEgress,
  proxyEnv,
  type SandboxEgress,
  type SandboxEgressContext,
  type SandboxEgressSession,
} from './sandbox-egress.ts';
export {
  BwrapSandbox,
  buildSeccompFilter,
  seccompArch,
  type BwrapSandboxOptions,
  type SeccompArch,
} from './sandbox-bwrap.ts';
export {
  NODE_PUBLISH_FORWARDER,
  PERL_PUBLISH_FORWARDER,
  PUBLISH_MOUNT,
  PUBLISH_SOCKET,
  checkPublishPort,
  openPublish,
  publishBase,
  publishPrelude,
  type PublishBridge,
  type PublishOptions,
} from './sandbox-publish.ts';
export {
  threadSandboxRouter,
  type ThreadSandboxPick,
  type ThreadSandboxRouter,
} from './sandbox-router.ts';
export {
  GIT_CONTROL_FILES,
  sandboxMounts,
  type SandboxMount,
  type SandboxMountInput,
} from './sandbox-protect.ts';
export {
  MicroVmSandbox,
  type MicroVmRunner,
  type MicroVmSandboxOptions,
} from './sandbox-microvm.ts';

export const DEFAULT_SANDBOX_IMAGE = 'debian:stable-slim';

/** A sandbox that never runs anything: exec tools fail closed with `sandbox_unavailable`. */
export class UnavailableSandbox implements SandboxClient {
  readonly substrate = null;
  readonly #detail: string;
  constructor(
    detail = 'No sandbox is available on this Hub: install Docker or Podman to let Nova run commands.',
  ) {
    this.#detail = detail;
  }
  available(): Promise<{ ok: boolean; detail: string }> {
    return Promise.resolve({ ok: false, detail: this.#detail });
  }
  exec(): Promise<ExecResult> {
    return Promise.reject(new NovaError('sandbox_unavailable', this.#detail));
  }
  poll(): Promise<ExecResult> {
    return Promise.reject(new NovaError('sandbox_unavailable', this.#detail));
  }
  write(): Promise<void> {
    return Promise.reject(new NovaError('sandbox_unavailable', this.#detail));
  }
  killTurn(): Promise<void> {
    return Promise.resolve();
  }
}

export interface ContainerSandboxOptions extends ProcessSandboxOptions {
  /** `docker`, `podman` or a path to either. */
  bin: string;
  image?: string;
  /** `uid:gid` inside the container; defaults to the Hub's user, or nobody when that is root. */
  user?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /**
   * What a profile that allows network gets without the egress proxy: the default `none` fails
   * closed; `open` gives the container the engine's default network, unfiltered (M3).
   */
  allowedNetwork?: 'none' | 'open';
  /** The egress proxy (M6): when set, network goes only through it (docs/12 §8). */
  egress?: SandboxEgress;
}

export class ContainerSandbox extends ProcessSandbox {
  readonly substrate = 'container' as const;
  readonly #bin: string;
  readonly #image: string;
  readonly #user: string;
  readonly #memory: string;
  readonly #cpus: string;
  readonly #pids: number;
  readonly #openNetwork: boolean;
  readonly #egress: SandboxEgress | undefined;
  #probe: { at: number; value: { ok: boolean; detail: string } } | null = null;

  constructor(opts: ContainerSandboxOptions) {
    super(opts);
    this.#bin = opts.bin;
    this.#image = opts.image ?? DEFAULT_SANDBOX_IMAGE;
    const uid = process.getuid?.() ?? 65534;
    const gid = process.getgid?.() ?? 65534;
    this.#user = opts.user ?? (uid === 0 ? '65534:65534' : `${uid}:${gid}`);
    this.#memory = opts.memory ?? '2g';
    this.#cpus = opts.cpus ?? '2';
    this.#pids = opts.pidsLimit ?? 512;
    this.#openNetwork = opts.allowedNetwork === 'open';
    this.#egress = opts.egress;
  }

  get image(): string {
    return this.#image;
  }

  /** The engine CLI (computers name their containers through it). */
  get bin(): string {
    return this.#bin;
  }

  /** Whether network goes through the egress proxy. */
  get proxied(): boolean {
    return !!this.#egress;
  }

  /** Whether the container engine answers; cached for 30 s. */
  async available(): Promise<{ ok: boolean; detail: string }> {
    if (this.#probe && Date.now() - this.#probe.at < 30_000) return this.#probe.value;
    const value = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      execFile(
        this.#bin,
        ['version', '--format', '{{.Server.Version}}'],
        { timeout: 5_000 },
        (err, stdout) => {
          const version = String(stdout).trim();
          if (err || !version)
            resolve({
              ok: false,
              detail: `${this.#bin} is installed but its engine is not running`,
            });
          else resolve({ ok: true, detail: `${this.#bin} ${version}, image ${this.#image}` });
        },
      );
    });
    this.#probe = { at: Date.now(), value };
    return value;
  }

  /** The container's user as numbers, when `--user` is numeric. */
  get sandboxUser(): { uid: number; gid: number } | null {
    const m = /^(\d+):(\d+)$/.exec(this.#user);
    return m ? { uid: Number(m[1]), gid: Number(m[2]) } : null;
  }

  /**
   * Arguments for `<bin> run`, exposed for tests. `egress` is the command's proxy session: with
   * one, the container's only route out is the mounted proxy socket. `publish` is the command's
   * dev-server bridge (its folder and the port inside).
   */
  runArgs(
    req: ExecRequest,
    name: string,
    egress: SandboxEgressSession | null = null,
    publish: Pick<PublishBridge, 'dir' | 'port'> | null = null,
  ): string[] {
    const args = [
      'run',
      '--rm',
      '-i',
      '--name',
      name,
      '--user',
      this.#user,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--pids-limit',
      String(this.#pids),
      '--memory',
      this.#memory,
      '--cpus',
      this.#cpus,
      '--workdir',
      req.cwd,
      '-e',
      'HOME=/tmp',
    ];
    // No network unless the profile allows it: through the proxy when it is wired in; without
    // it, only when the Hub opted into unfiltered access; otherwise fail closed.
    const unfiltered = req.network !== 'off' && !this.#egress && this.#openNetwork;
    if (!unfiltered) args.push('--network', 'none');
    // The host's filesystem root is never mounted: a profile's "whole filesystem" is the
    // container's own (docs/12 §7.1). Then the protected paths in the roots (§7.2); the engine
    // mounts parents before children. Dev-server bridges are hidden like the data folder.
    const mounts = sandboxMounts({
      roots: req.roots.filter((r) => r.path !== '/' && !/^[A-Za-z]:[\\/]?$/.test(r.path)),
      cwd: req.cwd,
      gitWrite: req.gitWrite === true,
      deniedPaths: [...this.deniedPaths, publishBase()],
    });
    for (const m of mounts) {
      if (m.path.includes(',') || m.path.includes('\n'))
        throw new NovaError('validation', `a folder path cannot contain commas: ${m.path}`);
      if (m.kind === 'root')
        args.push(
          '--mount',
          `type=bind,source=${m.path},target=${m.path}${m.writable ? '' : ',readonly'}`,
        );
      else if (m.kind === 'read_only')
        args.push('--mount', `type=bind,source=${m.path},target=${m.path},readonly`);
      else if (m.kind === 'hide_dir') args.push('--mount', `type=tmpfs,destination=${m.path}`);
      else args.push('--mount', `type=bind,source=/dev/null,target=${m.path},readonly`);
    }
    const env: Record<string, string> = { ...(req.env ?? {}) };
    if (egress) {
      if (egress.dir.includes(',') || egress.dir.includes('\n'))
        throw new NovaError('server_error', `the proxy folder path cannot contain commas`);
      args.push('--mount', `type=bind,source=${egress.dir},target=${EGRESS_MOUNT}`);
      // Proxy variables win over anything the caller set: the proxy is the only route.
      Object.assign(env, proxyEnv(egress), { NOVA_EGRESS_FORWARDER: PERL_FORWARDER });
    }
    let prelude = egress ? forwarderPrelude('perl', egress.socketName) : '';
    if (publish) {
      if (publish.dir.includes(',') || publish.dir.includes('\n'))
        throw new NovaError('server_error', `the dev-server bridge path cannot contain commas`);
      args.push('--mount', `type=bind,source=${publish.dir},target=${PUBLISH_MOUNT}`);
      env.NOVA_PUBLISH_FORWARDER = PERL_PUBLISH_FORWARDER;
      prelude = `${prelude}${prelude ? ' ' : ''}${publishPrelude('perl', publish.port)}`;
    }
    for (const [k, v] of Object.entries(env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) args.push('-e', `${k}=${v}`);
    }
    if (prelude)
      args.push(this.#image, 'sh', '-c', `${prelude} exec sh -c "$1"`, 'nova-sandbox', req.cmd);
    else args.push(this.#image, 'sh', '-c', req.cmd);
    return args;
  }

  protected async plan(req: SandboxExecRequest, name: string): Promise<LaunchPlan> {
    const { session, note } = await openEgress(this.#egress, req);
    let publish: PublishBridge | null = null;
    let args: string[];
    try {
      if (req.publish)
        publish = await openPublish({ port: req.publish.port, sandboxUser: this.sandboxUser });
      args = this.runArgs(req, name, session, publish);
    } catch (err) {
      await session?.close().catch(() => undefined);
      await publish?.close().catch(() => undefined);
      throw err;
    }
    const plan: LaunchPlan = {
      bin: this.#bin,
      args,
      kill: () => this.#cli(['kill', name]),
      interrupt: () => this.#cli(['kill', '--signal', 'INT', name]),
    };
    if (session || publish)
      plan.cleanup = async () => {
        await session?.close().catch(() => undefined);
        await publish?.close().catch(() => undefined);
      };
    if (publish) plan.published = { port: publish.port, hostPort: publish.hostPort };
    if (note) plan.note = note;
    return plan;
  }

  #cli(args: string[]): Promise<void> {
    return new Promise((resolve) => {
      execFile(this.#bin, args, { timeout: 10_000 }, () => resolve());
    });
  }
}

/** Find an executable on PATH. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface DetectSandboxOptions {
  /**
   * `off` disables commands; `docker`, `podman`, `bwrap` or `microvm` forces one; `auto`
   * (default) picks a container engine, else bubblewrap on Linux.
   */
  mode?: string;
  image?: string;
  allowedNetwork?: 'none' | 'open';
  env?: NodeJS.ProcessEnv;
  /** The egress proxy: network goes only through it (M6). */
  egress?: SandboxEgress;
  /** Limits for every command (docs/11 §8). */
  limits?: { cpus?: number; memoryMb?: number; wallClockMs?: number };
  /** The flagged micro-VM substrate (FR-195). */
  microVm?: { enabled: boolean; runner?: MicroVmRunner | null };
  /** Folders hidden from every command wherever a root contains them: the Nova data directory. */
  deniedPaths?: string[];
}

/** The sandbox for this host, or the unavailable client (FR-107: fail closed). */
export function detectSandbox(opts: DetectSandboxOptions = {}): SandboxClient {
  const mode = (opts.mode ?? 'auto').toLowerCase();
  if (mode === 'off') return new UnavailableSandbox('Running commands is turned off on this Hub.');
  if (mode === 'microvm' || mode === 'micro_vm')
    return new MicroVmSandbox({
      enabled: opts.microVm?.enabled ?? false,
      runner: opts.microVm?.runner ?? null,
    });
  const limits = opts.limits ?? {};
  const bwrap = () => {
    const bin = findOnPath('bwrap', opts.env);
    if (!bin || process.platform !== 'linux') return null;
    return new BwrapSandbox({
      bin,
      ...(opts.deniedPaths ? { deniedPaths: opts.deniedPaths } : {}),
      ...(opts.egress ? { egress: opts.egress } : {}),
      ...(limits.memoryMb ? { memoryMb: limits.memoryMb } : {}),
      ...(limits.wallClockMs ? { wallClockMs: limits.wallClockMs } : {}),
    });
  };
  if (mode === 'bwrap') {
    return (
      bwrap() ??
      new UnavailableSandbox(
        'Bubblewrap is not installed on this Hub (or the Hub is not on Linux), so commands cannot run.',
      )
    );
  }
  const names = mode === 'docker' || mode === 'podman' ? [mode] : ['docker', 'podman'];
  for (const n of names) {
    const bin = findOnPath(n, opts.env);
    if (bin)
      return new ContainerSandbox({
        bin,
        ...(opts.deniedPaths ? { deniedPaths: opts.deniedPaths } : {}),
        ...(opts.image ? { image: opts.image } : {}),
        ...(opts.allowedNetwork ? { allowedNetwork: opts.allowedNetwork } : {}),
        ...(opts.egress ? { egress: opts.egress } : {}),
        ...(limits.memoryMb ? { memory: `${limits.memoryMb}m` } : {}),
        ...(limits.cpus ? { cpus: String(limits.cpus) } : {}),
        ...(limits.wallClockMs ? { wallClockMs: limits.wallClockMs } : {}),
      });
  }
  if (mode === 'auto') return bwrap() ?? new UnavailableSandbox();
  return new UnavailableSandbox();
}
