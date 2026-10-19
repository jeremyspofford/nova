// The runner's core (FR-108, FR-071; docs/13 §3; ADR-095 decision 4): environments (repositories
// cloned side by side, a setup script run once, caches kept), runs (a Hub session's lease on an
// environment with CPU and wall-time caps), commands and file operations inside the sandbox
// (sandbox.ts), output kept for reattaching, live events, snapshots and restore, artifacts, and
// metering with a hard stop at each cap. The Hub keeps the agent loop, the model calls and the
// policy gate; nothing here decides what may run, only where and how much.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:os';
import { join, posix } from 'node:path';
import { RunnerError } from './errors.ts';
import { silentLog, type RunnerLog } from './log.ts';
import { diskUsage, parseTimes, scanProcesses, signalTree, treeCpuSeconds } from './meter.ts';
import { OutputRing } from './output.ts';
import { redact, redactUrl } from './redact.ts';
import {
  commandScript,
  limitsPrelude,
  programScript,
  runOnce,
  type SandboxLimits,
  type SandboxMount,
  type SandboxProcess,
  type SandboxSpec,
  type Substrate,
} from './sandbox.ts';
import type {
  ArtifactRecord,
  EnvironmentRecord,
  EnvironmentSpec,
  EnvironmentView,
  FileEntry,
  FileEntryKind,
  NetworkMode,
  ProcessView,
  ReadResult,
  RepoRecord,
  RunCaps,
  RunEvent,
  RunEventType,
  RunRecord,
  RunView,
  SnapshotRecord,
  SnapshotView,
} from './types.ts';

export const WORKDIR = '/workspace';
export const CACHE_ROOT = '/cache';
/** Where Nova's own state of an environment appears in the sandbox (transport stateDir). */
export const STATE_DIR = '/nova';

export interface RunnerLimits {
  maxEnvironmentsPerOwner: number;
  maxActiveRunsPerEnvironment: number;
  maxProcessesPerRun: number;
  maxProcesses: number;
  /** Commands one token (Hub) may run at once, its share of `maxProcesses`. */
  maxProcessesPerOwner: number;
  /** Processes one sandbox may have at once (RLIMIT_NPROC per sandbox; cgroup pids). */
  processesPerSandbox: number;
  /** Memory of one sandbox (cgroup or container limit; MB). */
  sandboxMemoryMb: number;
  /** Entries the disk count walks at most; past it the environment counts as over its cap. */
  diskMaxEntries: number;
  defaultDiskMb: number;
  maxDiskMb: number;
  defaultCpuSeconds: number;
  maxCpuSeconds: number;
  defaultWallSeconds: number;
  maxWallSeconds: number;
  /** RLIMIT_DATA of each process inside (MB). */
  memoryMb: number;
  /** Output kept per process (newest bytes). */
  outputBytes: number;
  setupTimeoutMs: number;
  /** CPU the setup script may use (seconds). */
  setupCpuSeconds: number;
  cloneTimeoutMs: number;
  maxArtifactBytes: number;
  /** Largest file a file operation reads or writes. */
  maxFileBytes: number;
  meterIntervalMs: number;
  diskIntervalMs: number;
  /** Share of a cap at which a warning is sent (FR-116). */
  warnAt: number;
  /** How long an ended process stays readable. */
  processRetentionMs: number;
  /** Events kept per run for resuming streams. */
  eventBuffer: number;
}

export const DEFAULT_RUNNER_LIMITS: RunnerLimits = {
  maxEnvironmentsPerOwner: 20,
  maxActiveRunsPerEnvironment: 50,
  maxProcessesPerRun: 8,
  maxProcesses: 64,
  maxProcessesPerOwner: 16,
  processesPerSandbox: 256,
  sandboxMemoryMb: 4_096,
  diskMaxEntries: 500_000,
  defaultDiskMb: 10_240,
  maxDiskMb: 51_200,
  defaultCpuSeconds: 3_600,
  maxCpuSeconds: 7 * 86_400,
  defaultWallSeconds: 4 * 3_600,
  maxWallSeconds: 7 * 86_400,
  memoryMb: 2_048,
  outputBytes: 1024 * 1024,
  setupTimeoutMs: 30 * 60_000,
  setupCpuSeconds: 3_600,
  cloneTimeoutMs: 10 * 60_000,
  maxArtifactBytes: 50 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  meterIntervalMs: 500,
  diskIntervalMs: 5_000,
  warnAt: 0.8,
  processRetentionMs: 60 * 60_000,
  eventBuffer: 2_000,
};

/** Environment variables pointing tools at a known cache name (FR-071: caches kept). */
const CACHE_ENV: Record<string, Record<string, string>> = {
  npm: { npm_config_cache: '/cache/npm' },
  yarn: { YARN_CACHE_FOLDER: '/cache/yarn' },
  pnpm: { PNPM_STORE_DIR: '/cache/pnpm' },
  pip: { PIP_CACHE_DIR: '/cache/pip' },
  cargo: { CARGO_HOME: '/cache/cargo' },
  go: { GOMODCACHE: '/cache/go/mod', GOCACHE: '/cache/go/build' },
  gradle: { GRADLE_USER_HOME: '/cache/gradle' },
  maven: { MAVEN_OPTS: '-Dmaven.repo.local=/cache/maven' },
  xdg: { XDG_CACHE_HOME: '/cache/xdg' },
};

export interface CreateEnvironmentInput {
  name?: string | undefined;
  repoUrls: string[];
  setupScript?: string | null | undefined;
  baseImage?: string | null | undefined;
  caches?: string[] | undefined;
  network?: NetworkMode | undefined;
  diskMb?: number | undefined;
  /** Answer an existing environment of the same owner with the same spec. */
  reuse?: boolean | undefined;
}

export interface ExecInput {
  cmd: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  tag?: string | undefined;
  /** Network for this command; it gets some only when the environment allows it too. */
  network?: 'off' | 'on' | undefined;
  /** Mount the workdir read-only (a Plan-mode turn). */
  readOnly?: boolean | undefined;
  timeoutMs?: number | undefined;
  /** Keep stdin open for later input. */
  stdin?: boolean | undefined;
}

export interface ProgramInput {
  argv: string[];
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  stdin?: Buffer | null | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}

export interface ProgramResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** A program's working folder: any absolute path inside the sandbox (only its mounts exist). */
export function programPath(input: string | undefined): string {
  const raw = (input ?? WORKDIR).trim() || WORKDIR;
  if (raw.includes('\0') || raw.length > 4096 || !raw.startsWith('/'))
    throw new RunnerError('validation', 'use a full path', { reason: 'relative' });
  return posix.normalize(raw);
}

export interface RunnerOptions {
  dataDir: string;
  substrate: Substrate | null;
  /** Why there is no substrate (shown when environments are refused). */
  substrateDetail?: string;
  limits?: Partial<RunnerLimits>;
  /** Host folders `file://` repositories may come from (tests and local mirrors); none by default. */
  localRepoRoots?: string[];
  log?: RunnerLog;
  now?: () => number;
}

interface Proc {
  id: string;
  runId: string;
  envId: string;
  cmd: string;
  cwd: string;
  tag: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  stopped: string | null;
  sandbox: SandboxProcess;
  ring: OutputRing;
  cpuSampled: number;
  cpuFinal: number | null;
  stdinOpen: boolean;
  waiters: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** The container substrate's CPU report trails stderr: held back until the process ends. */
  stderrTail: Buffer | null;
  meterMark: string | null;
  exited: Promise<void>;
}

interface RunState {
  rec: RunRecord;
  cpuClosed: number;
  wallClosed: number;
  activeSince: number | null;
  events: RunEvent[];
  nextEvent: number;
  listeners: Set<(e: RunEvent) => void>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  lastUsageEvent: number;
}

interface EnvState {
  rec: EnvironmentRecord;
  /** The last disk count stopped at `diskMaxEntries` (counted as over the cap). */
  diskPartial?: boolean;
  /** A provisioning, rebuild, snapshot or restore in progress. */
  busy: string | null;
  diskCheckedAt: number;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function iso(t: number): string {
  return new Date(t).toISOString();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** A path inside the sandbox, normalised; it must be /workspace or under it. */
export function workspacePath(input: string | undefined): string {
  const raw = (input ?? WORKDIR).trim() || WORKDIR;
  if (raw.includes('\0') || raw.length > 4096)
    throw new RunnerError('validation', 'not a valid path');
  if (!raw.startsWith('/'))
    throw new RunnerError('validation', `use a full path under ${WORKDIR}`, { reason: 'relative' });
  const p = posix.normalize(raw).replace(/\/+$/, '') || '/';
  if (p !== WORKDIR && !p.startsWith(`${WORKDIR}/`))
    throw new RunnerError('validation', `paths must be under ${WORKDIR}`, {
      reason: 'outside_workspace',
    });
  return p;
}

/** The folder name a repository is cloned into. */
export function repoName(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // scp-like or plain: use as is
  }
  const base =
    path
      .replace(/\/+$/, '')
      .split('/')
      .pop()
      ?.replace(/\.git$/, '') ?? '';
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return clean.slice(0, 100) || 'repo';
}

/** `url#ref` into its parts; the ref must be a plain branch or tag name. */
export function splitRef(input: string): { url: string; ref: string | null } {
  const i = input.lastIndexOf('#');
  if (i < 0) return { url: input, ref: null };
  const ref = input.slice(i + 1);
  if (!/^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$/.test(ref) || ref.includes('..'))
    throw new RunnerError('validation', `not a branch or tag name: ${ref}`, { reason: 'bad_ref' });
  return { url: input.slice(0, i), ref };
}

export class Runner {
  readonly limits: RunnerLimits;
  readonly #o: RunnerOptions;
  readonly #log: RunnerLog;
  readonly #now: () => number;
  readonly #envs = new Map<string, EnvState>();
  readonly #runs = new Map<string, RunState>();
  readonly #procs = new Map<string, Proc>();
  readonly #snapshots = new Map<string, SnapshotRecord>();
  #meterTimer: ReturnType<typeof setInterval> | null = null;
  #metering = false;
  #closed = false;

  constructor(opts: RunnerOptions) {
    this.#o = opts;
    this.limits = { ...DEFAULT_RUNNER_LIMITS, ...opts.limits };
    this.#log = opts.log ?? silentLog;
    this.#now = opts.now ?? (() => Date.now());
  }

  get substrate(): Substrate | null {
    return this.#o.substrate;
  }

  /** Whether scripts set RLIMIT_NPROC (where it counts per sandbox). */
  get #nproc(): boolean {
    return this.#o.substrate?.processRlimit === true;
  }

  #envsDir(): string {
    return join(this.#o.dataDir, 'envs');
  }
  #envDir(id: string): string {
    return join(this.#envsDir(), id);
  }
  #workDir(id: string): string {
    return join(this.#envDir(id), 'work');
  }
  #cacheDir(id: string, name: string): string {
    return join(this.#envDir(id), 'caches', name);
  }

  /** Load what a previous start left (environments, runs, snapshots) and start metering. */
  async start(): Promise<void> {
    await mkdir(this.#envsDir(), { recursive: true, mode: 0o700 });
    for (const id of await readdir(this.#envsDir())) {
      if (!ID.test(id)) continue;
      const rec = await readJson<EnvironmentRecord>(join(this.#envDir(id), 'env.json'));
      if (!rec || rec.id !== id) continue;
      if (rec.status === 'deleting') {
        await rm(this.#envDir(id), { recursive: true, force: true });
        continue;
      }
      if (rec.status === 'provisioning') {
        rec.status = 'failed';
        rec.detail = 'the runner restarted while preparing this environment; rebuild it';
        if (rec.setup.status === 'running') rec.setup.status = 'failed';
        await writeJson(join(this.#envDir(id), 'env.json'), rec);
      }
      this.#envs.set(id, { rec, busy: null, diskCheckedAt: 0 });
      for (const f of await readdir(join(this.#envDir(id), 'runs')).catch(() => [])) {
        const r = await readJson<RunRecord>(join(this.#envDir(id), 'runs', f));
        if (r?.id && f === `${r.id}.json`) this.#runs.set(r.id, this.#runState(r));
      }
      for (const f of await readdir(join(this.#envDir(id), 'snapshots')).catch(() => [])) {
        if (!f.endsWith('.json')) continue;
        const s = await readJson<SnapshotRecord>(join(this.#envDir(id), 'snapshots', f));
        if (s?.id) this.#snapshots.set(s.id, s);
      }
    }
    this.#meterTimer = setInterval(() => {
      void this.#meter();
    }, this.limits.meterIntervalMs);
    this.#meterTimer.unref();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#meterTimer) clearInterval(this.#meterTimer);
    const running = [...this.#procs.values()].filter((p) => p.endedAt === null);
    for (const p of running) await this.#stop(p, 'killed');
    await Promise.all(running.map((p) => p.exited));
    for (const r of this.#runs.values()) await this.#saveRun(r, true);
  }

  // ---- environments (FR-071) -----------------------------------------------------------------

  async createEnvironment(
    owner: string,
    input: CreateEnvironmentInput,
  ): Promise<{ view: EnvironmentView; reused: boolean }> {
    if (!this.#o.substrate)
      throw new RunnerError(
        'sandbox_unavailable',
        this.#o.substrateDetail ?? 'no sandbox can run on this runner',
        { reason: 'no_substrate' },
      );
    const spec: EnvironmentSpec = {
      repoUrls: input.repoUrls.map((u) => this.#checkRepoUrl(u)),
      setupScript: input.setupScript ?? null,
      baseImage: input.baseImage ?? null,
      caches: [...new Set(input.caches ?? [])],
      network: input.network ?? 'off',
      diskMb: input.diskMb ?? this.limits.defaultDiskMb,
    };
    if (spec.diskMb > this.limits.maxDiskMb)
      throw new RunnerError('validation', `at most ${this.limits.maxDiskMb} MB of disk`, {
        reason: 'disk_cap',
        max: this.limits.maxDiskMb,
      });
    if (spec.baseImage && !this.#o.substrate.supportsImage)
      throw new RunnerError(
        'validation',
        'this runner sandboxes with bubblewrap, which runs its own system, not a base image',
        { reason: 'base_image_unsupported', substrate: this.#o.substrate.kind },
      );
    for (const u of spec.repoUrls) await this.#checkLocalRepo(u);
    const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    if (input.reuse) {
      const same = [...this.#envs.values()].find(
        (e) => e.rec.owner === owner && e.rec.specHash === specHash && e.rec.status !== 'deleting',
      );
      if (same) return { view: this.#envView(same), reused: true };
    }
    const mine = [...this.#envs.values()].filter((e) => e.rec.owner === owner).length;
    if (mine >= this.limits.maxEnvironmentsPerOwner)
      throw new RunnerError(
        'quota_exceeded',
        `at most ${this.limits.maxEnvironmentsPerOwner} environments per Hub`,
        { resource: 'environments', limit: this.limits.maxEnvironmentsPerOwner },
      );
    const id = randomUUID();
    const now = iso(this.#now());
    const rec: EnvironmentRecord = {
      id,
      owner,
      name: input.name?.trim() || repoName(spec.repoUrls[0] ?? 'environment'),
      spec,
      specHash,
      status: 'provisioning',
      detail: 'preparing',
      substrate: this.#o.substrate.kind,
      repos: [],
      setup: { status: 'none', exitCode: null, log: '', startedAt: null, endedAt: null },
      diskBytes: 0,
      createdAt: now,
      updatedAt: now,
      readyAt: null,
    };
    await mkdir(join(this.#envDir(id), 'runs'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.#envDir(id), 'snapshots'), { recursive: true, mode: 0o700 });
    await mkdir(this.#workDir(id), { recursive: true, mode: 0o700 });
    for (const c of spec.caches)
      await mkdir(this.#cacheDir(id, c), { recursive: true, mode: 0o700 });
    const env: EnvState = { rec, busy: 'provisioning', diskCheckedAt: 0 };
    this.#envs.set(id, env);
    await this.#saveEnv(env);
    void this.#provision(env, false);
    return { view: this.#envView(env), reused: false };
  }

  listEnvironments(owner: string): EnvironmentView[] {
    return [...this.#envs.values()]
      .filter((e) => e.rec.owner === owner && e.rec.status !== 'deleting')
      .sort((a, b) => a.rec.createdAt.localeCompare(b.rec.createdAt))
      .map((e) => this.#envView(e));
  }

  getEnvironment(owner: string, id: string): EnvironmentView {
    return this.#envView(this.#env(owner, id));
  }

  /** Clone again and run the setup script again (an explicit rebuild, docs/10 §2). */
  async rebuildEnvironment(owner: string, id: string): Promise<EnvironmentView> {
    const env = this.#env(owner, id);
    if (env.busy)
      throw new RunnerError('conflict', `the environment is ${env.busy}`, { reason: 'busy' });
    if (this.#running(id).length)
      throw new RunnerError('conflict', 'commands are running in this environment', {
        reason: 'busy',
      });
    env.busy = 'provisioning';
    env.rec.status = 'provisioning';
    env.rec.detail = 'rebuilding';
    await this.#saveEnv(env);
    void this.#provision(env, true);
    return this.#envView(env);
  }

  async deleteEnvironment(owner: string, id: string): Promise<void> {
    const env = this.#env(owner, id);
    env.rec.status = 'deleting';
    await this.#saveEnv(env);
    const running = this.#running(id);
    for (const p of running) await this.#stop(p, 'killed');
    await Promise.all(running.map((p) => p.exited));
    for (const r of this.#runs.values()) {
      if (r.rec.environmentId !== id) continue;
      if (r.rec.status === 'active' || r.rec.status === 'capped')
        await this.#endRun(r, 'cancelled', 'environment_deleted');
      this.#runs.delete(r.rec.id);
    }
    for (const s of [...this.#snapshots.values()])
      if (s.environmentId === id) this.#snapshots.delete(s.id);
    for (const p of [...this.#procs.values()]) if (p.envId === id) this.#procs.delete(p.id);
    this.#envs.delete(id);
    await rm(this.#envDir(id), { recursive: true, force: true });
    this.#log.info('environment deleted', { environmentId: id });
  }

  #checkRepoUrl(input: string): string {
    const { url } = splitRef(input);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new RunnerError('validation', `not a repository URL: ${redactUrl(url)}`, {
        reason: 'bad_url',
      });
    }
    // Credentials in a URL would end up in the clone's .git/config, env.json and snapshots.
    if (u.username || u.password)
      throw new RunnerError('validation', 'repository URLs may not carry credentials', {
        reason: 'credentials_in_url',
      });
    if (u.protocol === 'https:') {
      if (privateHost(u.hostname))
        throw new RunnerError(
          'validation',
          'repositories on private or local addresses are refused',
          {
            reason: 'private_host',
          },
        );
      return input;
    }
    if (u.protocol === 'file:') {
      if (!this.#o.localRepoRoots?.length)
        throw new RunnerError('validation', 'this runner does not clone from its own disk', {
          reason: 'local_repo_refused',
        });
      return input;
    }
    throw new RunnerError('validation', 'repositories must be https:// URLs', {
      reason: 'bad_scheme',
    });
  }

  /** A `file://` repository must lie inside one of the configured local roots (no host paths). */
  async #checkLocalRepo(input: string): Promise<void> {
    const { url } = splitRef(input);
    const u = new URL(url);
    if (u.protocol !== 'file:') return;
    let real: string;
    try {
      real = await realpath(decodeURIComponent(u.pathname));
    } catch {
      throw new RunnerError('validation', 'no repository at that path', { reason: 'missing' });
    }
    for (const root of this.#o.localRepoRoots ?? []) {
      const r = await realpath(root).catch(() => null);
      if (r && (real === r || real.startsWith(`${r}/`))) return;
    }
    throw new RunnerError('validation', 'that folder is not one this runner clones from', {
      reason: 'local_repo_refused',
    });
  }

  async #provision(env: EnvState, rebuild: boolean): Promise<void> {
    const id = env.rec.id;
    const spec = env.rec.spec;
    const fresh = join(this.#envDir(id), `work.new-${randomUUID()}`);
    try {
      await mkdir(fresh, { recursive: true, mode: 0o700 });
      const repos: RepoRecord[] = [];
      const used = new Set<string>();
      for (const input of spec.repoUrls) {
        const { url, ref } = splitRef(input);
        let name = repoName(url);
        for (let i = 2; used.has(name); i++) name = `${repoName(url)}-${i}`;
        used.add(name);
        env.rec.detail = `cloning ${redactUrl(url)}`;
        await this.#saveEnv(env);
        const head = await this.#clone(env, fresh, url, ref, name);
        repos.push({ name, url: redactUrl(url), ref, head });
      }
      const size = await diskUsage([fresh]);
      if (size.bytes > spec.diskMb * 1024 * 1024)
        throw new RunnerError('quota_exceeded', 'the repositories exceed the disk cap', {
          resource: 'disk',
        });
      if (rebuild) {
        const old = join(this.#envDir(id), `work.old-${randomUUID()}`);
        await rename(this.#workDir(id), old).catch(() => undefined);
        await rename(fresh, this.#workDir(id));
        void rm(old, { recursive: true, force: true });
      } else {
        await rm(this.#workDir(id), { recursive: true, force: true });
        await rename(fresh, this.#workDir(id));
      }
      env.rec.repos = repos;
      if (spec.setupScript) await this.#setup(env);
      await this.#measureDisk(env);
      if (env.rec.setup.status === 'failed') {
        env.rec.status = 'failed';
        env.rec.detail = `the setup script failed${env.rec.setup.exitCode !== null ? ` (exit ${env.rec.setup.exitCode})` : ''}`;
      } else {
        env.rec.status = 'ready';
        env.rec.detail = null;
        env.rec.readyAt = iso(this.#now());
      }
    } catch (err) {
      await rm(fresh, { recursive: true, force: true }).catch(() => undefined);
      env.rec.status = 'failed';
      env.rec.detail = redact(err instanceof Error ? err.message : String(err)).slice(0, 1000);
      this.#log.warn('environment failed', { environmentId: id, err: env.rec.detail });
    } finally {
      env.busy = null;
      if (this.#envs.get(id) === env && env.rec.status !== 'deleting') await this.#saveEnv(env);
    }
  }

  /**
   * Clone one repository inside the sandbox, into `fresh` (the next workdir, mounted at
   * /workspace): the Git client never runs on the runner host, so a hostile server reaches only
   * the sandbox. Hardened: no system or global config, no prompts, no hooks, only https (and a
   * `file://` repository from the configured roots, mounted read-only at /source), objects
   * checked, no submodules. Network only for https. Returns the checked-out commit.
   */
  async #clone(
    env: EnvState,
    fresh: string,
    url: string,
    ref: string | null,
    name: string,
  ): Promise<string | null> {
    const substrate = this.#o.substrate;
    if (!substrate)
      throw new RunnerError('sandbox_unavailable', 'no sandbox', { reason: 'no_substrate' });
    const u = new URL(url);
    const local = u.protocol === 'file:';
    const source = local ? 'file:///source' : url;
    const limits: SandboxLimits = {
      cpuSeconds: 3_600,
      fileBytes: env.rec.spec.diskMb * 1024 * 1024,
      memoryMb: this.limits.memoryMb,
      processes: this.limits.processesPerSandbox,
      processRlimit: this.#nproc,
      sandboxMemoryMb: this.limits.sandboxMemoryMb,
    };
    const git =
      'git -c protocol.ext.allow=never -c core.hooksPath=/dev/null -c transfer.fsckObjects=true -c core.symlinks=true';
    const script = `${limitsPrelude(limits)}; ${git} clone --quiet --no-recurse-submodules ${ref ? '--branch "$3" ' : ''}-- "$1" "$2" && ${git} -C "$2" rev-parse HEAD`;
    const spec: SandboxSpec = {
      argv: ['/bin/sh', '-c', script, 'nova-clone', source, `${WORKDIR}/${name}`, ref ?? ''],
      mounts: [
        { host: fresh, target: WORKDIR, writable: true },
        ...(local
          ? [
              {
                host: await realpath(decodeURIComponent(u.pathname)),
                target: '/source',
                writable: false,
              },
            ]
          : []),
      ],
      cwd: WORKDIR,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ALLOW_PROTOCOL: local ? 'file' : 'https',
        GIT_ASKPASS: '/bin/false',
        SSH_ASKPASS: '/bin/false',
      },
      network: !local,
      limits,
      image: env.rec.spec.baseImage,
      name: `nova-runner-${randomUUID()}`,
    };
    const r = await runOnce(substrate, {
      spec,
      maxStdout: 4096,
      timeoutMs: this.limits.cloneTimeoutMs,
    });
    if (r.exitCode === 0) {
      const head = r.stdout.toString('utf8').trim();
      return /^[0-9a-f]{40,64}$/.test(head) ? head : null;
    }
    const why =
      r.exitCode === 127
        ? 'Git is not available in the sandbox (use a base image with git)'
        : r.timedOut
          ? 'it did not finish in time'
          : redact(r.stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 500);
    throw new RunnerError(
      'validation',
      `cloning ${redactUrl(url)} failed: ${why || `exit ${String(r.exitCode)}`}`,
      {
        reason: 'clone_failed',
      },
    );
  }

  async #setup(env: EnvState): Promise<void> {
    const substrate = this.#o.substrate!;
    const rec = env.rec;
    rec.setup = {
      status: 'running',
      exitCode: null,
      log: '',
      startedAt: iso(this.#now()),
      endedAt: null,
    };
    rec.detail = 'running the setup script';
    await this.#saveEnv(env);
    const limits: SandboxLimits = {
      cpuSeconds: this.limits.setupCpuSeconds,
      fileBytes: rec.spec.diskMb * 1024 * 1024,
      memoryMb: this.limits.memoryMb,
      processes: this.limits.processesPerSandbox,
      processRlimit: this.#nproc,
      sandboxMemoryMb: this.limits.sandboxMemoryMb,
    };
    const r = await runOnce(substrate, {
      spec: this.#spec(env, {
        argv: [
          '/bin/sh',
          '-c',
          `${limitsPrelude(limits)}; exec /bin/sh -c "$1" 2>&1`,
          'nova-setup',
          rec.spec.setupScript!,
        ],
        // In the first repository, as the environment dialog says; /workspace without one.
        cwd: rec.repos[0] ? `${WORKDIR}/${rec.repos[0].name}` : WORKDIR,
        network: rec.spec.network !== 'off',
        readOnly: false,
        limits,
        extraEnv: {},
      }),
      maxStdout: 256 * 1024,
      timeoutMs: this.limits.setupTimeoutMs,
    });
    const text = `${r.stdout.toString('utf8')}${r.stderr ? `\n${r.stderr}` : ''}`;
    rec.setup.log = redact(text.slice(-64 * 1024));
    rec.setup.exitCode = r.exitCode;
    rec.setup.endedAt = iso(this.#now());
    rec.setup.status = r.exitCode === 0 && !r.timedOut ? 'ok' : 'failed';
    if (r.timedOut) rec.setup.log += '\n[the setup script did not finish in time]';
  }

  // ---- runs ----------------------------------------------------------------------------------

  createRun(
    owner: string,
    input: {
      environmentId: string;
      label?: string | undefined;
      budget?: Partial<RunCaps> | undefined;
    },
  ): RunView {
    const env = this.#env(owner, input.environmentId);
    if (env.rec.status !== 'ready')
      throw new RunnerError('conflict', `the environment is ${env.rec.status}`, {
        reason: 'not_ready',
        status: env.rec.status,
      });
    const active = [...this.#runs.values()].filter(
      (r) => r.rec.environmentId === env.rec.id && r.rec.status === 'active',
    ).length;
    if (active >= this.limits.maxActiveRunsPerEnvironment)
      throw new RunnerError('quota_exceeded', 'too many active runs on this environment', {
        resource: 'runs',
        limit: this.limits.maxActiveRunsPerEnvironment,
      });
    const caps = this.#caps(input.budget, null);
    const now = iso(this.#now());
    const rec: RunRecord = {
      id: randomUUID(),
      owner,
      environmentId: env.rec.id,
      label: input.label?.trim() || null,
      status: 'active',
      reason: null,
      caps,
      usage: { cpuSeconds: 0, wallSeconds: 0, commands: 0 },
      warned: [],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    const state = this.#runState(rec);
    this.#runs.set(rec.id, state);
    void this.#saveRun(state, true);
    return this.#runView(state);
  }

  listRuns(owner: string, environmentId?: string): RunView[] {
    return [...this.#runs.values()]
      .filter(
        (r) => r.rec.owner === owner && (!environmentId || r.rec.environmentId === environmentId),
      )
      .sort((a, b) => b.rec.createdAt.localeCompare(a.rec.createdAt))
      .map((r) => this.#runView(r));
  }

  getRun(owner: string, id: string): RunView {
    return this.#runView(this.#run(owner, id));
  }

  /** Raise (or lower) a run's caps; a capped run whose new caps leave room is active again. */
  async updateRun(owner: string, id: string, budget: Partial<RunCaps>): Promise<RunView> {
    const r = this.#run(owner, id);
    if (r.rec.status !== 'active' && r.rec.status !== 'capped')
      throw new RunnerError('conflict', 'the run has ended', {
        reason: 'ended',
        status: r.rec.status,
      });
    r.rec.caps = this.#caps(budget, r.rec.caps);
    r.rec.warned = r.rec.warned.filter(
      (w) => this.#share(r, w as 'cpu' | 'wall') >= this.limits.warnAt,
    );
    if (r.rec.status === 'capped' && this.#share(r, 'cpu') < 1 && this.#share(r, 'wall') < 1) {
      r.rec.status = 'active';
      r.rec.reason = null;
      r.rec.endedAt = null;
    }
    r.rec.updatedAt = iso(this.#now());
    await this.#saveRun(r, true);
    this.#event(r, 'usage', { usage: r.rec.usage, caps: r.rec.caps, status: r.rec.status });
    return this.#runView(r);
  }

  async cancelRun(owner: string, id: string): Promise<RunView> {
    const r = this.#run(owner, id);
    if (r.rec.status === 'active' || r.rec.status === 'capped')
      await this.#endRun(r, 'cancelled', 'cancelled');
    return this.#runView(r);
  }

  /** The Hub is done with the run (the session was archived, the Work run ended). */
  async finishRun(owner: string, id: string): Promise<RunView> {
    const r = this.#run(owner, id);
    if (r.rec.status === 'active' || r.rec.status === 'capped')
      await this.#endRun(r, 'completed', 'finished');
    return this.#runView(r);
  }

  #caps(budget: Partial<RunCaps> | undefined, base: RunCaps | null): RunCaps {
    const cpu = budget?.cpuSeconds ?? base?.cpuSeconds ?? this.limits.defaultCpuSeconds;
    const wall = budget?.wallSeconds ?? base?.wallSeconds ?? this.limits.defaultWallSeconds;
    if (cpu > this.limits.maxCpuSeconds || wall > this.limits.maxWallSeconds)
      throw new RunnerError('validation', 'the budget is above what this runner allows', {
        reason: 'over_limit',
        maxCpuSeconds: this.limits.maxCpuSeconds,
        maxWallSeconds: this.limits.maxWallSeconds,
      });
    return { cpuSeconds: cpu, wallSeconds: wall };
  }

  // ---- commands ------------------------------------------------------------------------------

  exec(owner: string, runId: string, input: ExecInput): ProcessView {
    const r = this.#run(owner, runId);
    if (r.rec.status === 'capped')
      throw new RunnerError(
        'quota_exceeded',
        `the run reached its ${r.rec.reason ?? ''} cap`.replace('  ', ' '),
        {
          resource: r.rec.reason,
          usage: r.rec.usage,
          caps: r.rec.caps,
        },
      );
    if (r.rec.status !== 'active')
      throw new RunnerError('conflict', 'the run has ended', {
        reason: 'ended',
        status: r.rec.status,
      });
    const env = this.#env(owner, r.rec.environmentId);
    if (env.rec.status !== 'ready')
      throw new RunnerError('conflict', `the environment is ${env.rec.status}`, {
        reason: 'not_ready',
        status: env.rec.status,
      });
    if (env.busy)
      throw new RunnerError('conflict', `the environment is ${env.busy}`, { reason: 'busy' });
    const substrate = this.#o.substrate;
    if (!substrate)
      throw new RunnerError('sandbox_unavailable', this.#o.substrateDetail ?? 'no sandbox', {
        reason: 'no_substrate',
      });
    const diskCap = env.rec.spec.diskMb * 1024 * 1024;
    if (env.rec.diskBytes >= diskCap)
      throw new RunnerError('quota_exceeded', 'the environment is at its disk cap', {
        resource: 'disk',
        used: env.rec.diskBytes,
        limit: diskCap,
      });
    const cpuLeft = r.rec.caps.cpuSeconds - this.#cpuNow(r);
    const wallLeft = r.rec.caps.wallSeconds - this.#wallNow(r);
    if (cpuLeft <= 0 || wallLeft <= 0) {
      void this.#capRun(r, cpuLeft <= 0 ? 'cpu' : 'wall');
      throw new RunnerError('quota_exceeded', 'the run reached its cap', {
        resource: cpuLeft <= 0 ? 'cpu' : 'wall',
      });
    }
    const mine = this.#running(env.rec.id).filter((p) => p.runId === r.rec.id).length;
    if (mine >= this.limits.maxProcessesPerRun)
      throw new RunnerError(
        'rate_limited',
        `at most ${this.limits.maxProcessesPerRun} commands at once per run`,
        {
          reason: 'too_many_processes',
        },
      );
    const running = [...this.#procs.values()].filter((p) => p.endedAt === null);
    if (
      running.filter((p) => this.#runs.get(p.runId)?.rec.owner === owner).length >=
      this.limits.maxProcessesPerOwner
    )
      throw new RunnerError(
        'rate_limited',
        `at most ${this.limits.maxProcessesPerOwner} commands at once per Hub`,
        { reason: 'owner_busy' },
      );
    if (running.length >= this.limits.maxProcesses)
      throw new RunnerError('rate_limited', 'the runner is running as many commands as it can', {
        reason: 'runner_busy',
      });
    const cwd = workspacePath(input.cwd);
    const limits: SandboxLimits = {
      cpuSeconds: cpuLeft,
      fileBytes: Math.max(512, diskCap - env.rec.diskBytes),
      memoryMb: this.limits.memoryMb,
      processes: this.limits.processesPerSandbox,
      processRlimit: this.#nproc,
      sandboxMemoryMb: this.limits.sandboxMemoryMb,
    };
    const id = randomUUID();
    const mark = substrate.meter === 'stderr' ? `NOVA-METER-${randomUUID()}` : null;
    const spec = this.#spec(env, {
      argv: ['/bin/sh', '-c', commandScript(limits, substrate.meter), 'nova-runner', input.cmd],
      cwd,
      network: env.rec.spec.network === 'on' && input.network === 'on',
      readOnly: input.readOnly === true,
      limits,
      extraEnv: { ...(input.env ?? {}), ...(mark ? { NOVA_METER: mark } : {}) },
    });
    spec.name = `nova-runner-${id}`;
    const sandbox = substrate.spawn(spec);
    let resolveExit!: () => void;
    const proc: Proc = {
      id,
      runId: r.rec.id,
      envId: env.rec.id,
      cmd: input.cmd,
      cwd,
      tag: input.tag ?? null,
      startedAt: this.#now(),
      endedAt: null,
      exitCode: null,
      stopped: null,
      sandbox,
      ring: new OutputRing(this.limits.outputBytes),
      cpuSampled: 0,
      cpuFinal: null,
      stdinOpen: input.stdin === true,
      waiters: new Set(),
      timer: null,
      stderrTail: mark ? Buffer.alloc(0) : null,
      meterMark: mark,
      exited: new Promise<void>((resolve) => (resolveExit = resolve)),
    };
    this.#procs.set(id, proc);
    if (r.activeSince === null) r.activeSince = this.#now();
    r.rec.usage.commands++;
    // The command's own timeout, or the run's wall time left (then the run is capped).
    const own = input.timeoutMs ?? Infinity;
    const left = wallLeft * 1000;
    proc.timer = setTimeout(
      () => void (own <= left ? this.#stop(proc, 'timeout') : this.#capRun(r, 'wall')),
      Math.max(1, Math.min(own, left)),
    );
    let meterText = '';
    sandbox.meter?.on('data', (b: Buffer) => {
      if (meterText.length < 4096) meterText += b.toString('utf8');
    });
    const out = (b: Buffer) => {
      proc.ring.append(b);
      this.#event(r, 'output', { processId: id, data: b.toString('utf8').slice(0, 16_384) });
      this.#wake(proc);
    };
    sandbox.child.stdout?.on('data', out);
    sandbox.child.stderr?.on('data', (b: Buffer) => {
      if (!proc.stderrTail) return out(b);
      // Hold back enough to find the CPU report at the end.
      const all = Buffer.concat([proc.stderrTail, b]);
      const keep = 512;
      if (all.length > keep) out(all.subarray(0, all.length - keep));
      proc.stderrTail = all.subarray(Math.max(0, all.length - keep));
    });
    sandbox.child.stdin?.on('error', () => undefined);
    if (!proc.stdinOpen) sandbox.child.stdin?.end();
    sandbox.child.on('error', (err) => {
      proc.ring.append(Buffer.from(`\n[the sandbox did not start: ${err.message}]\n`));
    });
    sandbox.child.on('close', (code, signal) => {
      let reported: number | null = null;
      if (proc.stderrTail && proc.meterMark) {
        const tail = proc.stderrTail.toString('utf8');
        const at = tail.lastIndexOf(`\n${proc.meterMark} `);
        if (at >= 0) {
          reported = parseTimes(tail.slice(at));
          proc.ring.append(Buffer.from(tail.slice(0, at)));
        } else proc.ring.append(proc.stderrTail);
        proc.stderrTail = null;
      } else reported = parseTimes(meterText);
      proc.cpuFinal = Math.max(proc.cpuSampled, reported ?? 0);
      proc.exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 9) : -1);
      // The kernel's limits stopped it (SIGXCPU, SIGXFSZ through the sandbox shell): a cap.
      // The run's CPU with this command's final figure (RLIMIT_CPU is whole seconds, rounded up).
      const cpuAfter = this.#cpuNow(r) - proc.cpuSampled + proc.cpuFinal;
      if (
        proc.exitCode === 128 + constants.signals.SIGXCPU ||
        (proc.exitCode === 128 + constants.signals.SIGKILL &&
          proc.stopped === null &&
          cpuAfter >= r.rec.caps.cpuSeconds - 1.05)
      )
        proc.stopped ??= 'cap_cpu';
      if (proc.exitCode === 128 + constants.signals.SIGXFSZ) proc.stopped ??= 'cap_disk';
      void this.#exited(r, proc).finally(resolveExit);
    });
    this.#event(r, 'process.started', { processId: id, tag: proc.tag });
    return this.#procView(proc);
  }

  /** Output from `offset`, waiting up to `waitMs` for more while the command runs. */
  async read(
    owner: string,
    runId: string,
    processId: string,
    offset: number,
    waitMs: number,
  ): Promise<ReadResult> {
    const proc = this.#proc(owner, runId, processId);
    const wait = Math.min(Math.max(0, waitMs), 30_000);
    if (proc.endedAt === null && proc.ring.end <= offset && wait > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, wait);
        function done() {
          clearTimeout(timer);
          proc.waiters.delete(done);
          resolve();
        }
        proc.waiters.add(done);
      });
    }
    const r = proc.ring.read(offset, 256 * 1024, proc.endedAt !== null);
    const more = r.offset < proc.ring.end;
    return {
      data: r.data,
      offset: r.offset,
      dropped: r.dropped,
      // Still "running" while unread output remains, so a reader collects all of it.
      running: proc.endedAt === null || more,
      exitCode: proc.endedAt === null || more ? null : proc.exitCode,
    };
  }

  async input(
    owner: string,
    runId: string,
    processId: string,
    input: {
      text?: string | undefined;
      closeStdin?: boolean | undefined;
      signal?: 'interrupt' | 'terminate' | undefined;
    },
  ): Promise<void> {
    const proc = this.#proc(owner, runId, processId);
    if (proc.endedAt !== null)
      throw new RunnerError('conflict', 'the command has ended', { reason: 'ended' });
    const stdin = proc.sandbox.child.stdin;
    if (input.text !== undefined) {
      if (!proc.stdinOpen || !stdin || stdin.destroyed)
        throw new RunnerError('conflict', 'the command takes no input', { reason: 'stdin_closed' });
      stdin.write(input.text);
    }
    if (input.closeStdin && proc.stdinOpen) {
      proc.stdinOpen = false;
      stdin?.end();
    }
    if (input.signal === 'interrupt') {
      if (proc.sandbox.treePid !== null) await signalTree(proc.sandbox.treePid, 'SIGINT');
      else await proc.sandbox.interrupt();
    } else if (input.signal === 'terminate') await this.#stop(proc, 'killed');
  }

  /**
   * Run one program to its end with bytes in and out (the Hub's Git and file operations through
   * the environment transport, FR-213): no shell between the arguments, stdin from `stdin`,
   * stdout returned whole up to `maxBytes`. It runs in the sandbox under the run's caps and counts
   * against them like a command.
   */
  async runProgram(owner: string, runId: string, input: ProgramInput): Promise<ProgramResult> {
    const r = this.#run(owner, runId);
    if (r.rec.status === 'capped')
      throw new RunnerError('quota_exceeded', 'the run reached its cap', {
        resource: r.rec.reason,
        usage: r.rec.usage,
        caps: r.rec.caps,
      });
    if (r.rec.status !== 'active')
      throw new RunnerError('conflict', 'the run has ended', {
        reason: 'ended',
        status: r.rec.status,
      });
    const env = this.#env(owner, r.rec.environmentId);
    if (env.rec.status !== 'ready')
      throw new RunnerError('conflict', `the environment is ${env.rec.status}`, {
        reason: 'not_ready',
        status: env.rec.status,
      });
    const substrate = this.#o.substrate;
    if (!substrate)
      throw new RunnerError('sandbox_unavailable', this.#o.substrateDetail ?? 'no sandbox', {
        reason: 'no_substrate',
      });
    const cwd = programPath(input.cwd);
    const diskCap = env.rec.spec.diskMb * 1024 * 1024;
    const cpuLeft = r.rec.caps.cpuSeconds - this.#cpuNow(r);
    const wallLeft = r.rec.caps.wallSeconds - this.#wallNow(r);
    if (cpuLeft <= 0 || wallLeft <= 0) {
      await this.#capRun(r, cpuLeft <= 0 ? 'cpu' : 'wall');
      throw new RunnerError('quota_exceeded', 'the run reached its cap', {
        resource: cpuLeft <= 0 ? 'cpu' : 'wall',
      });
    }
    const limits: SandboxLimits = {
      cpuSeconds: cpuLeft,
      fileBytes: Math.max(512, diskCap - env.rec.diskBytes),
      memoryMb: this.limits.memoryMb,
      processes: this.limits.processesPerSandbox,
      processRlimit: this.#nproc,
      sandboxMemoryMb: this.limits.sandboxMemoryMb,
    };
    const mark = substrate.meter === 'stderr' ? `NOVA-METER-${randomUUID()}` : null;
    const spec = this.#spec(env, {
      argv: ['/bin/sh', '-c', programScript(limits, substrate.meter), 'nova-run', ...input.argv],
      cwd,
      network: false,
      readOnly: false,
      state: true,
      limits,
      extraEnv: { ...(input.env ?? {}), ...(mark ? { NOVA_METER: mark } : {}) },
    });
    const max = Math.min(input.maxBytes ?? 64 * 1024 * 1024, 64 * 1024 * 1024);
    const t0 = this.#now();
    r.rec.usage.commands++;
    const res = await runOnce(substrate, {
      spec,
      stdin: input.stdin ?? null,
      maxStdout: max,
      timeoutMs: Math.max(1, Math.min(input.timeoutMs ?? 120_000, wallLeft * 1000)),
    });
    let stderr = res.stderr;
    let cpu: number | null = null;
    if (mark) {
      const at = stderr.lastIndexOf(`\n${mark} `);
      if (at >= 0) {
        cpu = parseTimes(stderr.slice(at));
        stderr = stderr.slice(0, at);
      }
    } else cpu = parseTimes(res.meter);
    r.cpuClosed += cpu ?? 0;
    if (r.activeSince === null) r.wallClosed += (this.#now() - t0) / 1000;
    this.#usage(r);
    await this.#checkCaps(r);
    await this.#saveRun(r, false);
    if (res.truncated)
      throw new RunnerError('too_large', `the output is larger than ${max} bytes`, { limit: max });
    if (res.timedOut)
      throw new RunnerError('conflict', 'the program did not finish in time', {
        reason: 'timeout',
      });
    return {
      code: res.exitCode ?? -1,
      stdout: res.stdout,
      stderr: redact(stderr).slice(0, 64_000),
    };
  }

  /** Stop every running command of the run with this tag (a cancelled or ended turn). */
  async killTag(owner: string, runId: string, tag: string): Promise<number> {
    const r = this.#run(owner, runId);
    const hit = [...this.#procs.values()].filter(
      (p) => p.runId === r.rec.id && p.tag === tag && p.endedAt === null,
    );
    for (const p of hit) await this.#stop(p, 'killed');
    return hit.length;
  }

  processes(owner: string, runId: string): ProcessView[] {
    const r = this.#run(owner, runId);
    return [...this.#procs.values()]
      .filter((p) => p.runId === r.rec.id)
      .map((p) => this.#procView(p));
  }

  async #stop(proc: Proc, why: string): Promise<void> {
    if (proc.endedAt !== null) return;
    proc.stopped ??= why;
    await proc.sandbox.kill();
  }

  async #exited(r: RunState, proc: Proc): Promise<void> {
    if (proc.timer) clearTimeout(proc.timer);
    proc.endedAt = this.#now();
    r.cpuClosed += proc.cpuFinal ?? proc.cpuSampled;
    if (!this.#running(proc.envId).some((p) => p.runId === r.rec.id) && r.activeSince !== null) {
      r.wallClosed += (this.#now() - r.activeSince) / 1000;
      r.activeSince = null;
    }
    this.#usage(r);
    this.#event(r, 'process.exited', {
      processId: proc.id,
      exitCode: proc.exitCode,
      stopped: proc.stopped,
      cpuSeconds: round(proc.cpuFinal ?? proc.cpuSampled),
    });
    this.#wake(proc);
    if (proc.stopped === 'cap_cpu') await this.#capRun(r, 'cpu');
    else await this.#checkCaps(r);
    await this.#saveRun(r, true);
    const env = this.#envs.get(proc.envId);
    if (env) await this.#measureDisk(env).catch(() => undefined);
    setTimeout(() => {
      if (this.#procs.get(proc.id) === proc) this.#procs.delete(proc.id);
    }, this.limits.processRetentionMs).unref();
  }

  #wake(proc: Proc): void {
    for (const w of [...proc.waiters]) w();
  }

  // ---- metering and caps (FR-116) ------------------------------------------------------------

  #cpuNow(r: RunState): number {
    let cpu = r.cpuClosed;
    for (const p of this.#procs.values())
      if (p.runId === r.rec.id && p.endedAt === null) cpu += p.cpuSampled;
    return cpu;
  }

  #wallNow(r: RunState): number {
    return r.wallClosed + (r.activeSince !== null ? (this.#now() - r.activeSince) / 1000 : 0);
  }

  #usage(r: RunState): void {
    r.rec.usage.cpuSeconds = round(this.#cpuNow(r));
    r.rec.usage.wallSeconds = round(this.#wallNow(r));
    r.rec.updatedAt = iso(this.#now());
  }

  #share(r: RunState, resource: 'cpu' | 'wall'): number {
    return resource === 'cpu'
      ? r.rec.usage.cpuSeconds / Math.max(1e-9, r.rec.caps.cpuSeconds)
      : r.rec.usage.wallSeconds / Math.max(1e-9, r.rec.caps.wallSeconds);
  }

  async #checkCaps(r: RunState): Promise<void> {
    if (r.rec.status !== 'active') return;
    for (const resource of ['cpu', 'wall'] as const) {
      const share = this.#share(r, resource);
      if (share >= 1) {
        await this.#capRun(r, resource);
        return;
      }
      if (share >= this.limits.warnAt && !r.rec.warned.includes(resource)) {
        r.rec.warned.push(resource);
        this.#event(r, 'cap.warning', this.#capDetail(r, resource));
      }
    }
  }

  #capDetail(r: RunState, resource: 'cpu' | 'wall'): Record<string, unknown> {
    return resource === 'cpu'
      ? { resource, used: r.rec.usage.cpuSeconds, limit: r.rec.caps.cpuSeconds }
      : { resource, used: r.rec.usage.wallSeconds, limit: r.rec.caps.wallSeconds };
  }

  /** Hard stop at the cap: every command of the run ends now. */
  async #capRun(r: RunState, resource: 'cpu' | 'wall'): Promise<void> {
    if (r.rec.status !== 'active') return;
    r.rec.status = 'capped';
    r.rec.reason = resource;
    r.rec.updatedAt = iso(this.#now());
    for (const p of this.#procs.values())
      if (p.runId === r.rec.id && p.endedAt === null) await this.#stop(p, `cap_${resource}`);
    this.#event(r, 'cap.reached', this.#capDetail(r, resource));
    await this.#saveRun(r, true);
    this.#log.info('run capped', { runId: r.rec.id, resource });
  }

  async #endRun(
    r: RunState,
    status: 'completed' | 'cancelled' | 'failed',
    reason: string,
  ): Promise<void> {
    const running = [...this.#procs.values()].filter(
      (p) => p.runId === r.rec.id && p.endedAt === null,
    );
    for (const p of running) await this.#stop(p, status === 'cancelled' ? 'cancelled' : 'killed');
    await Promise.all(running.map((p) => p.exited));
    r.rec.status = status;
    r.rec.reason = reason;
    r.rec.endedAt = iso(this.#now());
    r.rec.updatedAt = r.rec.endedAt;
    this.#usage(r);
    this.#event(r, 'run.ended', { status, reason, usage: r.rec.usage });
    await this.#saveRun(r, true);
  }

  async #meter(): Promise<void> {
    if (this.#metering || this.#closed) return;
    this.#metering = true;
    try {
      const running = [...this.#procs.values()].filter((p) => p.endedAt === null);
      if (!running.length) return;
      if (running.some((p) => p.sandbox.treePid !== null)) {
        const procs = await scanProcesses();
        for (const p of running)
          if (p.sandbox.treePid !== null)
            p.cpuSampled = Math.max(p.cpuSampled, treeCpuSeconds(procs, p.sandbox.treePid));
      }
      const now = this.#now();
      for (const r of new Set(running.map((p) => this.#runs.get(p.runId)))) {
        if (!r) continue;
        this.#usage(r);
        if (now - r.lastUsageEvent >= 1000) {
          r.lastUsageEvent = now;
          this.#event(r, 'usage', { usage: r.rec.usage, caps: r.rec.caps, status: r.rec.status });
        }
        await this.#checkCaps(r);
        await this.#saveRun(r, false);
      }
      for (const envId of new Set(running.map((p) => p.envId))) {
        const env = this.#envs.get(envId);
        if (!env || now - env.diskCheckedAt < this.limits.diskIntervalMs) continue;
        await this.#measureDisk(env);
        const cap = env.rec.spec.diskMb * 1024 * 1024;
        if (env.rec.diskBytes <= cap) continue;
        for (const p of this.#running(envId)) {
          await this.#stop(p, 'cap_disk');
          const r = this.#runs.get(p.runId);
          if (r)
            this.#event(r, 'cap.reached', {
              resource: 'disk',
              used: env.rec.diskBytes,
              limit: cap,
            });
        }
      }
    } catch (err) {
      this.#log.warn('metering failed', { err });
    } finally {
      this.#metering = false;
    }
  }

  async #measureDisk(env: EnvState): Promise<void> {
    env.diskCheckedAt = this.#now();
    const id = env.rec.id;
    const dirs = [
      this.#workDir(id),
      join(this.#envDir(id), 'state'),
      join(this.#envDir(id), 'caches'),
      join(this.#envDir(id), 'snapshots'),
      join(this.#envDir(id), 'artifacts'),
    ];
    const usage = await diskUsage(dirs, this.limits.diskMaxEntries);
    // Too many entries to count is over the cap: the uncounted rest could hold anything.
    env.rec.diskBytes = usage.partial
      ? Math.max(usage.bytes, env.rec.spec.diskMb * 1024 * 1024 + 1)
      : usage.bytes;
    env.diskPartial = usage.partial;
  }

  /** Measure an environment's disk now (tests, and after file operations). */
  async measure(owner: string, id: string): Promise<number> {
    const env = this.#env(owner, id);
    await this.#measureDisk(env);
    return env.rec.diskBytes;
  }

  // ---- events (SSE) --------------------------------------------------------------------------

  #event(r: RunState, type: RunEventType, data: Record<string, unknown>): void {
    const e: RunEvent = { id: r.nextEvent++, type, ts: iso(this.#now()), data };
    r.events.push(e);
    if (r.events.length > this.limits.eventBuffer)
      r.events.splice(0, r.events.length - this.limits.eventBuffer);
    for (const l of [...r.listeners]) {
      try {
        l(e);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** Events after `since` and a subscription to the next ones. */
  subscribe(
    owner: string,
    runId: string,
    since: number,
    listener: (e: RunEvent) => void,
  ): { backlog: RunEvent[]; ended: boolean; unsubscribe: () => void } {
    const r = this.#run(owner, runId);
    r.listeners.add(listener);
    return {
      backlog: r.events.filter((e) => e.id > since),
      ended: r.rec.status !== 'active' && r.rec.status !== 'capped',
      unsubscribe: () => r.listeners.delete(listener),
    };
  }

  // ---- files (inside the sandbox) ------------------------------------------------------------

  async stat(
    owner: string,
    envId: string,
    path: string,
  ): Promise<{ kind: FileEntryKind; size: number } | null> {
    const env = this.#readyEnv(owner, envId);
    const p = workspacePath(path);
    const r = await this.#once(
      env,
      ['/bin/sh', '-c', 'exec find -H "$1" -maxdepth 0 -printf "%y\\t%s\\n"', 'nova-stat', p],
      { readOnly: true },
    );
    if (r.exitCode !== 0) return null;
    const [y, s] = r.stdout.toString('utf8').trim().split('\t');
    return { kind: kindOf(y), size: Number(s) || 0 };
  }

  async list(
    owner: string,
    envId: string,
    path: string,
  ): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const env = this.#readyEnv(owner, envId);
    const p = workspacePath(path);
    const r = await this.#once(
      env,
      [
        '/bin/sh',
        '-c',
        '[ -d "$1" ] || exit 3; exec find -H "$1" -mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%f\\0"',
        'nova-list',
        p,
      ],
      { readOnly: true, maxStdout: 1024 * 1024 },
    );
    if (r.exitCode === 3)
      throw new RunnerError('not_found', `no folder at ${p}`, { reason: 'not_a_folder' });
    if (r.exitCode !== 0) throw new RunnerError('server_error', 'listing failed');
    const entries: FileEntry[] = [];
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      if (!rec) continue;
      const [y, s, ...name] = rec.split('\t');
      entries.push({ name: name.join('\t'), kind: kindOf(y), size: Number(s) || 0 });
      if (entries.length >= 1000) break;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, truncated: r.truncated || entries.length >= 1000 };
  }

  async readFile(
    owner: string,
    envId: string,
    path: string,
  ): Promise<{ content: Buffer; truncated: boolean }> {
    const env = this.#readyEnv(owner, envId);
    const p = workspacePath(path);
    const r = await this.#once(
      env,
      ['/bin/sh', '-c', '[ -f "$1" ] || exit 3; exec cat -- "$1"', 'nova-read', p],
      {
        readOnly: true,
        maxStdout: this.limits.maxFileBytes,
      },
    );
    if (r.exitCode === 3)
      throw new RunnerError('not_found', `no file at ${p}`, { reason: 'not_a_file' });
    if (r.exitCode !== 0 && !r.truncated) throw new RunnerError('server_error', 'reading failed');
    return { content: r.stdout, truncated: r.truncated };
  }

  async writeFile(
    owner: string,
    envId: string,
    path: string,
    content: Buffer,
  ): Promise<{ size: number; sha256: string }> {
    const env = this.#readyEnv(owner, envId);
    const p = workspacePath(path);
    if (p === WORKDIR) throw new RunnerError('validation', 'that is the workspace folder');
    if (content.length > this.limits.maxFileBytes)
      throw new RunnerError(
        'too_large',
        `files above ${this.limits.maxFileBytes} bytes are refused`,
      );
    const cap = env.rec.spec.diskMb * 1024 * 1024;
    if (env.rec.diskBytes + content.length > cap)
      throw new RunnerError('quota_exceeded', 'the environment is at its disk cap', {
        resource: 'disk',
        used: env.rec.diskBytes,
        limit: cap,
      });
    const r = await this.#once(
      env,
      [
        '/bin/sh',
        '-c',
        '[ -d "$1" ] && exit 3; mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
        'nova-write',
        p,
      ],
      { readOnly: false, stdin: content },
    );
    if (r.exitCode === 3)
      throw new RunnerError('conflict', `${p} is a folder`, { reason: 'is_folder' });
    if (r.exitCode !== 0)
      throw new RunnerError(
        'server_error',
        `writing failed: ${redact(r.stderr.trim()).slice(0, 300)}`,
      );
    void this.#measureDisk(env).catch(() => undefined);
    return { size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
  }

  async deleteFile(owner: string, envId: string, path: string): Promise<void> {
    const env = this.#readyEnv(owner, envId);
    const p = workspacePath(path);
    if (p === WORKDIR)
      throw new RunnerError('validation', 'the workspace folder itself cannot be removed');
    const r = await this.#once(
      env,
      ['/bin/sh', '-c', '[ -e "$1" ] || [ -L "$1" ] || exit 3; exec rm -rf -- "$1"', 'nova-rm', p],
      { readOnly: false },
    );
    if (r.exitCode === 3) throw new RunnerError('not_found', `nothing at ${p}`);
    if (r.exitCode !== 0) throw new RunnerError('server_error', 'removing failed');
    void this.#measureDisk(env).catch(() => undefined);
  }

  #readyEnv(owner: string, envId: string): EnvState {
    const env = this.#env(owner, envId);
    if (env.rec.status !== 'ready' && env.rec.status !== 'failed')
      throw new RunnerError('conflict', `the environment is ${env.rec.status}`, {
        reason: 'not_ready',
        status: env.rec.status,
      });
    return env;
  }

  #once(
    env: EnvState,
    argv: string[],
    o: { readOnly: boolean; stdin?: Buffer; maxStdout?: number },
  ) {
    const substrate = this.#o.substrate;
    if (!substrate)
      throw new RunnerError('sandbox_unavailable', this.#o.substrateDetail ?? 'no sandbox', {
        reason: 'no_substrate',
      });
    const spec = this.#spec(env, {
      argv,
      cwd: WORKDIR,
      network: false,
      readOnly: o.readOnly,
      limits: {
        cpuSeconds: 60,
        fileBytes: this.limits.maxFileBytes,
        memoryMb: this.limits.memoryMb,
        processes: this.limits.processesPerSandbox,
        processRlimit: this.#nproc,
        sandboxMemoryMb: this.limits.sandboxMemoryMb,
      },
      extraEnv: {},
    });
    return runOnce(substrate, {
      spec,
      ...(o.stdin ? { stdin: o.stdin } : {}),
      ...(o.maxStdout ? { maxStdout: o.maxStdout } : {}),
      timeoutMs: 60_000,
    });
  }

  // ---- snapshots and artifacts ---------------------------------------------------------------

  async createSnapshot(owner: string, envId: string, label: string | null): Promise<SnapshotView> {
    const env = this.#env(owner, envId);
    if (env.rec.status !== 'ready')
      throw new RunnerError('conflict', `the environment is ${env.rec.status}`, {
        reason: 'not_ready',
      });
    if (env.busy)
      throw new RunnerError('conflict', `the environment is ${env.busy}`, { reason: 'busy' });
    const substrate = this.#o.substrate;
    if (!substrate)
      throw new RunnerError('sandbox_unavailable', 'no sandbox', { reason: 'no_substrate' });
    const cap = env.rec.spec.diskMb * 1024 * 1024;
    const room = cap - env.rec.diskBytes;
    if (room <= 0)
      throw new RunnerError('quota_exceeded', 'the environment is at its disk cap', {
        resource: 'disk',
      });
    const id = randomUUID();
    const file = join(this.#envDir(envId), 'snapshots', `${id}.tar`);
    env.busy = 'snapshotting';
    try {
      const r = await runOnce(substrate, {
        spec: this.#spec(env, {
          argv: ['tar', '-C', WORKDIR, '-cf', '-', '.'],
          cwd: WORKDIR,
          network: false,
          readOnly: true,
          limits: {
            cpuSeconds: 3_600,
            fileBytes: 1024,
            memoryMb: this.limits.memoryMb,
            processes: this.limits.processesPerSandbox,
            processRlimit: this.#nproc,
            sandboxMemoryMb: this.limits.sandboxMemoryMb,
          },
          extraEnv: {},
        }),
        stdoutFile: `${file}.part`,
        maxFileBytes: room,
        timeoutMs: 30 * 60_000,
      });
      // GNU tar answers 1 when a file changed while it was read: the snapshot is still usable.
      if (r.exitCode !== 0 && r.exitCode !== 1) {
        await rm(`${file}.part`, { force: true });
        throw new RunnerError(
          r.exitCode === null && r.written > room ? 'quota_exceeded' : 'server_error',
          `the snapshot failed: ${redact(r.stderr.trim()).slice(0, 300)}`,
          { resource: 'disk' },
        );
      }
      await rename(`${file}.part`, file);
      const rec: SnapshotRecord = {
        id,
        owner,
        environmentId: envId,
        label: label?.trim() || null,
        sizeBytes: (await stat(file)).size,
        createdAt: iso(this.#now()),
        restoredAt: null,
      };
      await writeJson(join(this.#envDir(envId), 'snapshots', `${id}.json`), rec);
      this.#snapshots.set(id, rec);
      await this.#measureDisk(env);
      return snapshotView(rec);
    } finally {
      env.busy = null;
    }
  }

  listSnapshots(owner: string, envId?: string): SnapshotView[] {
    return [...this.#snapshots.values()]
      .filter((s) => s.owner === owner && (!envId || s.environmentId === envId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(snapshotView);
  }

  getSnapshot(owner: string, id: string): SnapshotView {
    return snapshotView(this.#snapshot(owner, id));
  }

  /** Put the workdir back as it was at the snapshot (caches are kept). */
  async restoreSnapshot(owner: string, id: string): Promise<SnapshotView> {
    const snap = this.#snapshot(owner, id);
    const env = this.#env(owner, snap.environmentId);
    if (env.busy)
      throw new RunnerError('conflict', `the environment is ${env.busy}`, { reason: 'busy' });
    if (this.#running(env.rec.id).length)
      throw new RunnerError('conflict', 'commands are running in this environment', {
        reason: 'busy',
      });
    const substrate = this.#o.substrate;
    if (!substrate)
      throw new RunnerError('sandbox_unavailable', 'no sandbox', { reason: 'no_substrate' });
    const fresh = join(this.#envDir(env.rec.id), `work.restore-${randomUUID()}`);
    await mkdir(fresh, { mode: 0o700 });
    env.busy = 'restoring';
    try {
      const spec = this.#spec(env, {
        argv: ['tar', '-C', WORKDIR, '-xf', '-', '--no-same-owner'],
        cwd: WORKDIR,
        network: false,
        readOnly: false,
        limits: {
          cpuSeconds: 3_600,
          fileBytes: env.rec.spec.diskMb * 1024 * 1024,
          memoryMb: this.limits.memoryMb,
          processes: this.limits.processesPerSandbox,
          processRlimit: this.#nproc,
          sandboxMemoryMb: this.limits.sandboxMemoryMb,
        },
        extraEnv: {},
      });
      // The fresh folder stands in for the workdir.
      spec.mounts = spec.mounts.map((m) => (m.target === WORKDIR ? { ...m, host: fresh } : m));
      const r = await runOnce(substrate, {
        spec,
        stdin: { file: join(this.#envDir(env.rec.id), 'snapshots', `${id}.tar`) },
        timeoutMs: 30 * 60_000,
      });
      if (r.exitCode !== 0) {
        await rm(fresh, { recursive: true, force: true });
        throw new RunnerError(
          'server_error',
          `the restore failed: ${redact(r.stderr.trim()).slice(0, 300)}`,
        );
      }
      const old = join(this.#envDir(env.rec.id), `work.old-${randomUUID()}`);
      await rename(this.#workDir(env.rec.id), old);
      await rename(fresh, this.#workDir(env.rec.id));
      await rm(old, { recursive: true, force: true });
      snap.restoredAt = iso(this.#now());
      await writeJson(join(this.#envDir(env.rec.id), 'snapshots', `${id}.json`), snap);
      env.rec.updatedAt = snap.restoredAt;
      if (env.rec.status === 'failed') {
        env.rec.status = 'ready';
        env.rec.detail = null;
      }
      await this.#measureDisk(env);
      await this.#saveEnv(env);
      return snapshotView(snap);
    } finally {
      env.busy = null;
    }
  }

  async deleteSnapshot(owner: string, id: string): Promise<void> {
    const snap = this.#snapshot(owner, id);
    const dir = join(this.#envDir(snap.environmentId), 'snapshots');
    await rm(join(dir, `${id}.tar`), { force: true });
    await rm(join(dir, `${id}.json`), { force: true });
    this.#snapshots.delete(id);
  }

  /** Keep a file of the workdir as an artifact of the run (downloadable until the run is gone). */
  async collectArtifact(
    owner: string,
    runId: string,
    input: { path: string; name?: string | undefined },
  ): Promise<ArtifactRecord> {
    const r = this.#run(owner, runId);
    const env = this.#readyEnv(owner, r.rec.environmentId);
    const p = workspacePath(input.path);
    const substrate = this.#o.substrate;
    if (!substrate)
      throw new RunnerError('sandbox_unavailable', 'no sandbox', { reason: 'no_substrate' });
    const id = randomUUID();
    const dir = join(this.#envDir(env.rec.id), 'artifacts', r.rec.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, id);
    const res = await runOnce(substrate, {
      spec: this.#spec(env, {
        argv: ['/bin/sh', '-c', '[ -f "$1" ] || exit 3; exec cat -- "$1"', 'nova-artifact', p],
        cwd: WORKDIR,
        network: false,
        readOnly: true,
        limits: {
          cpuSeconds: 60,
          fileBytes: 1024,
          memoryMb: this.limits.memoryMb,
          processes: this.limits.processesPerSandbox,
          processRlimit: this.#nproc,
          sandboxMemoryMb: this.limits.sandboxMemoryMb,
        },
        extraEnv: {},
      }),
      stdoutFile: file,
      maxFileBytes: this.limits.maxArtifactBytes,
      timeoutMs: 120_000,
    });
    if (res.exitCode !== 0) {
      await rm(file, { force: true });
      if (res.exitCode === 3)
        throw new RunnerError('not_found', `no file at ${p}`, { reason: 'not_a_file' });
      if (res.written > this.limits.maxArtifactBytes)
        throw new RunnerError(
          'too_large',
          `artifacts above ${this.limits.maxArtifactBytes} bytes are refused`,
        );
      throw new RunnerError('server_error', 'collecting the artifact failed');
    }
    const sha = createHash('sha256');
    for await (const chunk of createReadStream(file)) sha.update(chunk as Buffer);
    const rec: ArtifactRecord = {
      id,
      path: p,
      name: (input.name?.trim() || posix.basename(p)).slice(0, 200),
      sizeBytes: (await stat(file)).size,
      sha256: sha.digest('hex'),
      createdAt: iso(this.#now()),
    };
    r.rec.artifacts.push(rec);
    this.#event(r, 'artifact', { artifact: rec });
    await this.#saveRun(r, true);
    return rec;
  }

  artifactFile(
    owner: string,
    runId: string,
    artifactId: string,
  ): { path: string; record: ArtifactRecord } {
    const r = this.#run(owner, runId);
    const rec = r.rec.artifacts.find((a) => a.id === artifactId);
    if (!rec) throw new RunnerError('not_found', 'artifact not found');
    return {
      path: join(this.#envDir(r.rec.environmentId), 'artifacts', r.rec.id, rec.id),
      record: rec,
    };
  }

  // ---- internals -----------------------------------------------------------------------------

  #spec(
    env: EnvState,
    o: {
      argv: string[];
      cwd: string;
      network: boolean;
      readOnly: boolean;
      limits: SandboxLimits;
      extraEnv: Record<string, string>;
      /** Mount Nova's own state folder: only the Hub's own programs (`/runs/:id/run`). */
      state?: boolean;
    },
  ): SandboxSpec {
    const id = env.rec.id;
    const mounts: SandboxMount[] = [
      { host: this.#workDir(id), target: WORKDIR, writable: !o.readOnly },
    ];
    // Nova's own state there (the Hub's shadow repositories, transport scratch), out of the
    // workspace and its snapshots, and out of reach of the model's commands: a command could
    // otherwise rewrite a session's shadow baseline and hide its edits from review.
    if (o.state) {
      const state = join(this.#envDir(id), 'state');
      mkdirSync(state, { recursive: true, mode: 0o700 });
      mounts.push({ host: state, target: STATE_DIR, writable: !o.readOnly });
    }
    const cacheEnv: Record<string, string> = {};
    for (const c of env.rec.spec.caches) {
      mounts.push({
        host: this.#cacheDir(id, c),
        target: `${CACHE_ROOT}/${c}`,
        writable: !o.readOnly,
      });
      Object.assign(cacheEnv, CACHE_ENV[c] ?? {});
    }
    return {
      argv: o.argv,
      mounts,
      cwd: o.cwd,
      env: { ...cacheEnv, ...o.extraEnv },
      network: o.network,
      limits: o.limits,
      image: env.rec.spec.baseImage,
      name: `nova-runner-${randomUUID()}`,
    };
  }

  #env(owner: string, id: string): EnvState {
    const e = this.#envs.get(id);
    if (!e || e.rec.owner !== owner || e.rec.status === 'deleting')
      throw new RunnerError('not_found', 'environment not found');
    return e;
  }

  #run(owner: string, id: string): RunState {
    const r = this.#runs.get(id);
    if (!r || r.rec.owner !== owner) throw new RunnerError('not_found', 'run not found');
    return r;
  }

  #proc(owner: string, runId: string, id: string): Proc {
    const r = this.#run(owner, runId);
    const p = this.#procs.get(id);
    if (!p || p.runId !== r.rec.id) throw new RunnerError('not_found', 'process not found');
    return p;
  }

  #snapshot(owner: string, id: string): SnapshotRecord {
    const s = this.#snapshots.get(id);
    if (!s || s.owner !== owner) throw new RunnerError('not_found', 'snapshot not found');
    return s;
  }

  #running(envId: string): Proc[] {
    return [...this.#procs.values()].filter((p) => p.envId === envId && p.endedAt === null);
  }

  #runState(rec: RunRecord): RunState {
    return {
      rec,
      cpuClosed: rec.usage.cpuSeconds,
      wallClosed: rec.usage.wallSeconds,
      activeSince: null,
      events: [],
      nextEvent: 1,
      listeners: new Set(),
      saveTimer: null,
      lastUsageEvent: 0,
    };
  }

  async #saveEnv(env: EnvState): Promise<void> {
    env.rec.updatedAt = iso(this.#now());
    await writeJson(join(this.#envDir(env.rec.id), 'env.json'), env.rec).catch((err: unknown) =>
      this.#log.error('could not save an environment', { err, environmentId: env.rec.id }),
    );
  }

  /** Save a run now (`now`) or within two seconds (metering ticks). */
  async #saveRun(r: RunState, now: boolean): Promise<void> {
    const write = async () => {
      if (!this.#envs.has(r.rec.environmentId)) return;
      await writeJson(
        join(this.#envDir(r.rec.environmentId), 'runs', `${r.rec.id}.json`),
        r.rec,
      ).catch((err: unknown) => this.#log.error('could not save a run', { err, runId: r.rec.id }));
    };
    if (now) {
      if (r.saveTimer) clearTimeout(r.saveTimer);
      r.saveTimer = null;
      await write();
      return;
    }
    if (r.saveTimer) return;
    r.saveTimer = setTimeout(() => {
      r.saveTimer = null;
      void write();
    }, 2_000);
    r.saveTimer.unref();
  }

  #envView(e: EnvState): EnvironmentView {
    const rec = e.rec;
    const runs = [...this.#runs.values()].filter(
      (r) => r.rec.environmentId === rec.id && r.rec.status === 'active',
    ).length;
    return {
      id: rec.id,
      name: rec.name,
      status: rec.status,
      detail: rec.detail,
      substrate: rec.substrate,
      repoUrls: rec.spec.repoUrls.map((u) => {
        const { url, ref } = splitRef(u);
        return `${redactUrl(url)}${ref ? `#${ref}` : ''}`;
      }),
      setupScript: rec.spec.setupScript,
      baseImage: rec.spec.baseImage,
      caches: rec.spec.caches,
      network: rec.spec.network,
      connection: {
        workdir: WORKDIR,
        repos: rec.repos.map((r) => ({
          name: r.name,
          path: `${WORKDIR}/${r.name}`,
          ref: r.ref,
          head: r.head,
        })),
        caches: rec.spec.caches.map((c) => ({ name: c, path: `${CACHE_ROOT}/${c}` })),
      },
      setup: rec.setup,
      usage: { diskBytes: rec.diskBytes },
      caps: { diskBytes: rec.spec.diskMb * 1024 * 1024 },
      runs: { active: runs },
      processes: { running: this.#running(rec.id).length },
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      readyAt: rec.readyAt,
    };
  }

  #runView(r: RunState): RunView {
    if (r.rec.status === 'active') this.#usage(r);
    const { owner: _owner, warned: _warned, ...rest } = r.rec;
    return {
      ...rest,
      usage: { ...rest.usage },
      caps: { ...rest.caps },
      artifacts: [...rest.artifacts],
      processes: [...this.#procs.values()]
        .filter((p) => p.runId === r.rec.id)
        .map((p) => this.#procView(p)),
    };
  }

  #procView(p: Proc): ProcessView {
    return {
      id: p.id,
      runId: p.runId,
      cmd: redact(p.cmd).slice(0, 500),
      cwd: p.cwd,
      tag: p.tag,
      running: p.endedAt === null,
      exitCode: p.endedAt === null ? null : p.exitCode,
      stopped: p.stopped,
      cpuSeconds: round(p.cpuFinal ?? p.cpuSampled),
      outputBytes: p.ring.end,
      startedAt: iso(p.startedAt),
      endedAt: p.endedAt === null ? null : iso(p.endedAt),
    };
  }
}

function snapshotView(s: SnapshotRecord): SnapshotView {
  const { owner: _owner, ...rest } = s;
  return { ...rest };
}

function kindOf(y: string | undefined): FileEntryKind {
  return y === 'f' ? 'file' : y === 'd' ? 'dir' : y === 'l' ? 'link' : 'other';
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * A host name that is this machine or a private network by its literal form (localhost, IPv4 and
 * IPv6 loopback, private, link-local and shared ranges). A name that resolves there is not caught
 * here; the clone runs in the sandbox either way.
 */
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::' || h === '::1')
    return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h.replace(/^::ffff:/, ''));
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(h) && h.includes(':');
}
