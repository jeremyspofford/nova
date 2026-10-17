// Saved environments for Code sessions (FR-062, FR-078; docs/10 §2). Each environment is created
// once, saved, health-checked and selectable per session; the built-in `local` one (this Hub) stays
// the default. Kinds:
// - `container`: an image (and a setup script run once per session in its folder) on the Hub's
//   sandbox substrate; commands run in that image instead of the default one.
// - `ssh`: a host where Nova reaches the `novad` helper (installed under `~/.nova/remote/`, started
//   over the SSH connection, signature-checked; docs/10 §2). The key or password lives in the
//   keychain. The helper runs the session's commands and keeps their output buffered while the Hub
//   is away, so a session keeps running while the app is disconnected and reattaching shows the
//   buffered output (FR-078).
// - `wsl`: a distro on a Windows device, reached through that device's helper; not available
//   anywhere else.
// - `device`: a registered device running `novad`, under that device's own grants (docs/23).
// The SSH helper transport and the device provider are injected (the devices area builds `novad`
// and its connections); without one those environments are `down` and say why. Connection details
// are stored in `environment.config_json` without any secret value.
import { isolatedSubstrate } from '@nova/policy';
import {
  NovaError,
  containerConnectionSchema,
  createEnvironmentSchema,
  deviceConnectionSchema,
  sshConnectionSchema,
  sshCredentialSchema,
  uuidv7,
  wslConnectionSchema,
  type EnvironmentConnectionView,
  type EnvironmentOutputView,
  type EnvironmentProcessView,
  type EnvironmentView,
  type SavedEnvironmentView,
  type WslDistroView,
  type updateEnvironmentSchema,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { z } from 'zod';
import type { EventSink } from '../events.ts';
import type { AuditSink, ExecRequest, ExecResult, SandboxClient } from '../tools/types.ts';
import type { HookFreeGit } from './git.ts';

// ---- the helper protocol (novad operations a Code environment uses) ----------------------------

export interface EnvHelperHello {
  version: string;
  /** `linux`, `darwin` or `win32`. */
  platform: string;
  arch: string | null;
  /** The helper build's signature was verified before it started (docs/10 §14). */
  verified: boolean;
  home: string | null;
}

export interface EnvHelperSpawn {
  cmd: string;
  cwd: string;
  env?: Record<string, string>;
  /** Who started it (`<sessionId>:<turnId>`), so a reattached Hub can tell its processes. */
  tag?: string;
}

export interface EnvHelperRead {
  /** Output from the requested offset (stdout and stderr interleaved). */
  data: string;
  offset: number;
  /** Bytes the helper dropped before the requested offset (it keeps the newest). */
  dropped: number;
  running: boolean;
  exitCode: number | null;
}

export interface EnvHelperProcess {
  id: string;
  cmd: string;
  cwd: string;
  tag: string | null;
  running: boolean;
  exitCode: number | null;
  outputBytes: number;
  startedAt: string;
}

/**
 * One connection to a `novad` helper. Processes belong to the helper, not to the connection: they
 * keep running and buffering output when the connection drops, and a new connection reads them
 * from any offset (FR-078).
 */
export interface EnvHelperConnection {
  readonly closed: boolean;
  hello(): Promise<EnvHelperHello>;
  stat(path: string): Promise<{ kind: 'file' | 'dir' | 'other' } | null>;
  spawn(spec: EnvHelperSpawn): Promise<{ id: string }>;
  /** Output from `offset`, waiting up to `waitMs` for more while the process runs. */
  read(id: string, offset: number, waitMs: number): Promise<EnvHelperRead>;
  write(
    id: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void>;
  processes(): Promise<EnvHelperProcess[]>;
  /** WSL distros (Windows helpers only; others answer `capability_missing`). */
  wslDistros(): Promise<WslDistroView[]>;
  /** A connection into a WSL distro through this (Windows) helper. */
  wsl(distro: string): Promise<EnvHelperConnection>;
  close(): Promise<void>;
}

export interface EnvSshTarget {
  host: string;
  port: number;
  user: string;
  hostKey: string | null;
  credential: { privateKey?: string; passphrase?: string; password?: string };
}

/**
 * Reaches `novad` over SSH: installs or upgrades the helper after a signature check, starts it and
 * forwards its 0600 socket (with its token) over the connection (docs/10 §2, FR-192).
 */
export interface EnvSshTransport {
  connect(target: EnvSshTarget, signal: AbortSignal): Promise<EnvHelperConnection>;
}

/** The devices area's connections to registered devices running `novad` (late-bound). */
export interface EnvDeviceProvider {
  /** Null while the device is offline or not enrolled; the device's grants still apply. */
  connect(
    accountId: string,
    deviceId: string,
    signal: AbortSignal,
  ): Promise<EnvHelperConnection | null>;
}

// ---- rows ----------------------------------------------------------------------------------------

interface EnvRow {
  id: string;
  accountId: string;
  kind: EnvironmentView['kind'];
  label: string;
  deviceId: string | null;
  configJson: string | null;
  status: EnvironmentView['status'];
  statusDetail: string | null;
  lastCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ENV_COLUMNS = `id, account_id AS accountId, kind, label, device_id AS deviceId,
  config_json AS configJson, status, status_detail AS statusDetail, last_check_at AS lastCheckAt,
  created_at AS createdAt, updated_at AS updatedAt`;

type ContainerConfig = z.infer<typeof containerConnectionSchema>;
type SshConfig = z.infer<typeof sshConnectionSchema>;
type WslConfig = z.infer<typeof wslConnectionSchema>;
type DeviceConfig = z.infer<typeof deviceConnectionSchema>;
export type CreateEnvironmentRequest = z.input<typeof createEnvironmentSchema>;
export type UpdateEnvironmentRequest = z.input<typeof updateEnvironmentSchema>;

/** Where an environment's credential lives (the keychain; docs/12 §5). */
export function environmentSecretRef(id: string): string {
  return `secret://code/environment/${id}/credential`;
}

/** How long a health check or a connection attempt may take. */
const CHECK_TIMEOUT_MS = 20_000;
/** Bytes of output a process read returns at most. */
const MAX_READ_CHARS = 256 * 1024;

export interface EnvironmentServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  audit: AuditSink;
  secrets: SecretStore;
  git: HookFreeGit;
  /** The Hub's tool sandbox (the local environment's health). */
  sandbox?: () => SandboxClient | null;
  /** A sandbox running a container environment's image on the Hub's substrate. */
  containerSandbox?: (image: string) => SandboxClient | null;
  sshTransport?: EnvSshTransport | null;
  now?: () => Date;
  log?: Logger;
}

export class EnvironmentService {
  readonly #o: EnvironmentServiceOptions;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #connections = new Map<string, Promise<EnvHelperConnection>>();
  readonly #containers = new Map<string, SandboxClient>();
  readonly #remotes = new Map<string, EnvHelperSandbox>();
  #devices: EnvDeviceProvider | null = null;
  #ssh: EnvSshTransport | null;
  #gitVersion: Promise<string | null> | null = null;

  constructor(opts: EnvironmentServiceOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.env', sinks: [] });
    this.#ssh = opts.sshTransport ?? null;
  }

  /** The devices area's helper connections (device and WSL environments). */
  useDevices(provider: EnvDeviceProvider): void {
    this.#devices = provider;
  }

  /** The SSH helper transport (`novad` over SSH). */
  useSsh(transport: EnvSshTransport): void {
    this.#ssh = transport;
  }

  // ---- saved environments --------------------------------------------------------------------

  /** Every saved environment of the account, the local one first (its health checked now). */
  async list(accountId: string): Promise<SavedEnvironmentView[]> {
    const local = await this.local(accountId);
    await this.#checkLocal(local);
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${ENV_COLUMNS} FROM environment WHERE account_id = ?
         ORDER BY kind = 'local' DESC, created_at, id`,
      )
      .all(accountId) as unknown as EnvRow[];
    return rows.map((r) => this.#view(r));
  }

  /** M5's view of the environments (`GET /environments` keeps its shape). */
  async views(accountId: string): Promise<EnvironmentView[]> {
    return (await this.list(accountId)).map((v) => ({
      id: v.id,
      kind: v.kind,
      label: v.label,
      ...(v.isolated !== undefined ? { isolated: v.isolated } : {}),
      status: v.status,
      detail: v.detail,
      checkedAt: v.checkedAt,
    }));
  }

  async get(accountId: string, id: string): Promise<SavedEnvironmentView> {
    const r = this.#row(accountId, id);
    if (r.kind === 'local') await this.#checkLocal(r);
    return this.#view(this.#row(accountId, id));
  }

  /** The built-in local environment ("This Hub"), created on first use. */
  async local(accountId: string): Promise<EnvRow> {
    const select = () =>
      this.#o.db.raw
        .prepare(`SELECT ${ENV_COLUMNS} FROM environment WHERE account_id = ? AND kind = 'local'`)
        .get(accountId) as EnvRow | undefined;
    const found = select();
    if (found) return found;
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT OR IGNORE INTO environment (id, account_id, kind, label, status, created_at,
             updated_at) VALUES (?, ?, 'local', 'This Hub', 'unknown', ?, ?)`,
        )
        .run(uuidv7(), accountId, now, now);
    });
    return select()!;
  }

  /** The environment a session binds to: the given one, else the local default. */
  async resolve(accountId: string, id: string | undefined | null): Promise<EnvRow> {
    if (!id) return this.local(accountId);
    return this.#row(accountId, id);
  }

  async create(accountId: string, input: unknown): Promise<SavedEnvironmentView> {
    const req = createEnvironmentSchema.parse(input);
    const id = uuidv7();
    const now = this.#iso();
    let deviceId: string | null = null;
    let config: Record<string, unknown>;
    switch (req.kind) {
      case 'container':
        config = { ...req.connection, setupScript: req.connection.setupScript ?? null };
        break;
      case 'ssh': {
        assertCredential(req.connection.auth, req.credential);
        config = { ...req.connection, hostKey: req.connection.hostKey ?? null };
        await this.#o.secrets.put(environmentSecretRef(id), JSON.stringify(req.credential));
        break;
      }
      case 'wsl':
        deviceId = this.#knownDevice(accountId, req.connection.deviceId);
        config = { ...req.connection };
        break;
      case 'device':
        deviceId = this.#knownDevice(accountId, req.connection.deviceId);
        config = { ...req.connection, root: req.connection.root ?? null };
        break;
    }
    try {
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            `INSERT INTO environment (id, account_id, kind, device_id, label, config_json,
               setup_script, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
          )
          .run(
            id,
            accountId,
            req.kind,
            deviceId,
            req.label,
            JSON.stringify(config),
            req.kind === 'container' ? (req.connection.setupScript ?? null) : null,
            now,
            now,
          );
      });
    } catch (err) {
      await this.#o.secrets.delete(environmentSecretRef(id)).catch(() => false);
      throw err;
    }
    await this.#audit(accountId, 'environment.created', id, { kind: req.kind });
    await this.#emit(accountId, 'environment.updated', { environmentId: id, change: 'created' });
    return this.#view(this.#row(accountId, id));
  }

  async update(accountId: string, id: string, req: UpdateEnvironmentRequest) {
    const r = this.#row(accountId, id);
    if (r.kind === 'local')
      throw new NovaError('validation', 'the built-in environment cannot be changed', {
        details: { reason: 'built_in' },
      });
    let config = parseConfig(r);
    if (req.connection) config = parseConnection(r.kind, { ...config, ...req.connection });
    if (req.credential) {
      if (r.kind !== 'ssh')
        throw new NovaError('validation', 'only SSH environments take a credential');
      assertCredential((config as SshConfig).auth, sshCredentialSchema.parse(req.credential));
      await this.#o.secrets.put(environmentSecretRef(id), JSON.stringify(req.credential));
    } else if (req.connection && r.kind === 'ssh') {
      const before = parseConfig(r) as SshConfig;
      const after = config as SshConfig;
      // A new host or user must not silently reuse the old host's credential.
      if (before.host !== after.host || before.user !== after.user || before.auth !== after.auth)
        throw new NovaError(
          'validation',
          'a new host, user or sign-in method needs the credential',
          {
            details: { reason: 'credential_required' },
          },
        );
    }
    const now = this.#iso();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE environment SET label = ?, config_json = ?, setup_script = ?, device_id = ?,
             status = 'unknown', status_detail = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(
          req.label ?? r.label,
          JSON.stringify(config),
          r.kind === 'container' ? ((config as ContainerConfig).setupScript ?? null) : null,
          r.kind === 'wsl' || r.kind === 'device'
            ? this.#knownDevice(accountId, (config as WslConfig | DeviceConfig).deviceId)
            : null,
          now,
          id,
        );
    });
    await this.#drop(id);
    await this.#audit(accountId, 'environment.updated', id, {
      kind: r.kind,
      credential: req.credential ? 'replaced' : 'kept',
    });
    await this.#emit(accountId, 'environment.updated', { environmentId: id, change: 'updated' });
    return this.#view(this.#row(accountId, id));
  }

  /** Remove a saved environment and its credential; refused while active sessions use it. */
  async remove(accountId: string, id: string): Promise<void> {
    const r = this.#row(accountId, id);
    if (r.kind === 'local')
      throw new NovaError('validation', 'the built-in environment cannot be removed', {
        details: { reason: 'built_in' },
      });
    const inUse = this.#sessionCount(id);
    if (inUse)
      throw new NovaError('conflict', `${inUse} active Code session(s) use this environment`, {
        details: { reason: 'in_use', sessions: inUse },
      });
    await this.#o.db.transaction(() => {
      // Archived sessions keep their history; the binding goes.
      this.#o.db.raw
        .prepare('UPDATE code_session SET environment_id = NULL WHERE environment_id = ?')
        .run(id);
      this.#o.db.raw.prepare('DELETE FROM environment WHERE id = ?').run(id);
    });
    await this.#o.secrets.delete(environmentSecretRef(id)).catch(() => false);
    await this.#drop(id);
    await this.#audit(accountId, 'environment.removed', id, { kind: r.kind });
    await this.#emit(accountId, 'environment.updated', { environmentId: id, change: 'removed' });
  }

  // ---- health (FR-062) -----------------------------------------------------------------------

  /** Check an environment now and store the result. */
  async check(accountId: string, id: string): Promise<SavedEnvironmentView> {
    const r = this.#row(accountId, id);
    if (r.kind === 'local') await this.#checkLocal(r);
    else {
      let status: EnvironmentView['status'];
      let detail: string;
      try {
        ({ status, detail } = await this.#checkRemote(r));
      } catch (err) {
        status = 'down';
        detail = errText(err);
      }
      await this.#setHealth(r, status, detail);
    }
    return this.#view(this.#row(accountId, id));
  }

  /** Check every environment an active session uses (the Hub's periodic sweep). */
  async checkInUse(): Promise<number> {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT DISTINCT e.id, e.account_id AS accountId FROM environment e
         JOIN code_session s ON s.environment_id = e.id
         WHERE s.status = 'active' AND e.kind != 'local'`,
      )
      .all() as { id: string; accountId: string }[];
    for (const r of rows) await this.check(r.accountId, r.id).catch(() => undefined);
    return rows.length;
  }

  async #checkLocal(env: EnvRow): Promise<void> {
    this.#gitVersion ??= this.#o.git.version();
    const version = await this.#gitVersion;
    const sandbox = this.#o.sandbox?.() ?? null;
    const probe = await probeSandbox(sandbox);
    const status: EnvironmentView['status'] = version && probe.ok ? 'ok' : 'degraded';
    const detail = [
      version
        ? version.replace(/^git version /, 'Git ')
        : 'Git is not installed: changes cannot be captured',
      probe.ok ? probe.detail : `commands cannot run (${probe.detail})`,
    ].join('; ');
    await this.#setHealth(env, status, detail);
  }

  async #checkRemote(r: EnvRow): Promise<{ status: EnvironmentView['status']; detail: string }> {
    switch (r.kind) {
      case 'container': {
        const cfg = parseConfig(r) as ContainerConfig;
        const sandbox = this.#container(cfg.image);
        if (!sandbox) return { status: 'down', detail: 'no container engine on this Hub' };
        const a = await sandbox.available();
        if (!a.ok) return { status: 'down', detail: a.detail };
        const res = await sandbox.exec({
          cmd: 'true',
          cwd: '/',
          roots: [],
          network: 'off',
          yieldMs: CHECK_TIMEOUT_MS * 3,
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS * 4),
          turnId: `env-check:${r.id}`,
        });
        if (res.status !== 'exited' || res.exitCode !== 0)
          return {
            status: 'down',
            detail: `the image ${cfg.image} did not run: ${firstLine(res.output) || 'no output'}`,
          };
        return { status: 'ok', detail: `image ${cfg.image}; ${a.detail}` };
      }
      case 'ssh':
      case 'wsl':
      case 'device': {
        await this.#drop(r.id);
        const conn = await this.connection(r.accountId, r.id);
        const hello = await withTimeout(
          conn.hello(),
          CHECK_TIMEOUT_MS,
          'the helper did not answer',
        );
        if (!hello.verified)
          return {
            status: 'down',
            detail: "the helper's signature could not be verified; it will not run",
          };
        const where =
          r.kind === 'wsl'
            ? `WSL ${(parseConfig(r) as WslConfig).distro}`
            : `${hello.platform}${hello.arch ? ` (${hello.arch})` : ''}`;
        const root = r.kind === 'ssh' ? (parseConfig(r) as SshConfig).root : null;
        if (root) {
          const st = await conn.stat(root);
          if (st?.kind !== 'dir')
            return {
              status: 'degraded',
              detail: `novad ${hello.version} on ${where}; ${root} is missing`,
            };
        }
        return { status: 'ok', detail: `novad ${hello.version} on ${where}` };
      }
      case 'local':
      case 'cloud':
      case 'vm':
        return { status: 'unknown', detail: `${r.kind} environments are not available yet` };
    }
  }

  async #setHealth(r: EnvRow, status: EnvironmentView['status'], detail: string) {
    const now = this.#iso();
    const clean = defaultRedactor.redactString(detail).slice(0, 1000);
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE environment SET status = ?, status_detail = ?, last_check_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          status,
          clean,
          now,
          status !== r.status || clean !== r.statusDetail ? now : r.updatedAt,
          r.id,
        );
    });
    if (status !== r.status && r.kind !== 'local')
      await this.#emit(r.accountId, 'environment.health.changed', {
        environmentId: r.id,
        status,
        detail: clean,
      });
  }

  // ---- connections and commands ----------------------------------------------------------------

  /** The helper connection of an ssh, wsl or device environment (reconnects when it dropped). */
  async connection(accountId: string, id: string): Promise<EnvHelperConnection> {
    const r = this.#row(accountId, id);
    const cached = this.#connections.get(id);
    if (cached) {
      try {
        const c = await cached;
        if (!c.closed) return c;
      } catch {
        // A failed attempt is retried below.
      }
      this.#connections.delete(id);
    }
    const p = this.#connect(r);
    this.#connections.set(id, p);
    try {
      return await p;
    } catch (err) {
      this.#connections.delete(id);
      throw err;
    }
  }

  async #connect(r: EnvRow): Promise<EnvHelperConnection> {
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    switch (r.kind) {
      case 'ssh': {
        if (!this.#ssh)
          throw new NovaError(
            'capability_missing',
            'SSH environments are not available on this Hub',
            {
              details: { reason: 'no_ssh_transport' },
            },
          );
        const cfg = parseConfig(r) as SshConfig;
        const raw = await this.#o.secrets.get(environmentSecretRef(r.id));
        if (!raw)
          throw new NovaError('validation', 'the SSH credential is missing from the keychain', {
            details: { reason: 'credential_missing' },
          });
        const credential = sshCredentialSchema.parse(JSON.parse(raw));
        return this.#ssh.connect(
          {
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            hostKey: cfg.hostKey ?? null,
            credential,
          },
          signal,
        );
      }
      case 'device':
      case 'wsl': {
        const cfg = parseConfig(r) as DeviceConfig | WslConfig;
        if (!this.#devices)
          throw new NovaError('capability_missing', 'device connections are not available yet', {
            details: { reason: 'no_device_provider' },
          });
        const conn = await this.#devices.connect(r.accountId, cfg.deviceId, signal);
        if (!conn)
          throw new NovaError('capability_missing', 'the device is offline', {
            details: { reason: 'device_offline' },
          });
        if (r.kind === 'device') return conn;
        const hello = await conn.hello();
        if (hello.platform !== 'win32')
          throw new NovaError('capability_missing', 'WSL runs only on a Windows device', {
            details: { reason: 'not_windows' },
          });
        return conn.wsl((cfg as WslConfig).distro);
      }
      case 'local':
      case 'container':
      case 'cloud':
      case 'vm':
        throw new NovaError('validation', `a ${r.kind} environment has no helper connection`);
    }
  }

  /** Distros on a Windows device (FR-062): `capability_missing` on any other platform. */
  async wslDistros(accountId: string, deviceId: string): Promise<WslDistroView[]> {
    this.#knownDevice(accountId, deviceId);
    if (!this.#devices)
      throw new NovaError('capability_missing', 'device connections are not available yet', {
        details: { reason: 'no_device_provider' },
      });
    const conn = await this.#devices.connect(
      accountId,
      deviceId,
      AbortSignal.timeout(CHECK_TIMEOUT_MS),
    );
    if (!conn)
      throw new NovaError('capability_missing', 'the device is offline', {
        details: { reason: 'device_offline' },
      });
    const hello = await conn.hello();
    if (hello.platform !== 'win32')
      throw new NovaError('capability_missing', 'WSL is available only on Windows devices', {
        details: { reason: 'not_windows' },
      });
    return conn.wslDistros();
  }

  /**
   * The sandbox a session's commands use in this environment: null for the local one (the Hub's
   * own sandbox), a sandbox with the environment's image for a container, and the helper's
   * process runner for ssh, wsl and device environments.
   */
  sandboxFor(accountId: string, id: string): SandboxClient | null {
    const r = this.#row(accountId, id);
    switch (r.kind) {
      case 'local':
      case 'cloud':
      case 'vm':
        return null;
      case 'container':
        return this.#container((parseConfig(r) as ContainerConfig).image);
      case 'ssh':
      case 'wsl':
      case 'device': {
        let remote = this.#remotes.get(id);
        if (!remote) {
          remote = new EnvHelperSandbox(() => this.connection(accountId, id));
          this.#remotes.set(id, remote);
        }
        return remote;
      }
    }
  }

  /** Whether sessions in this environment work on the Hub's files (local and container). */
  isHubLocal(kind: EnvironmentView['kind']): boolean {
    return kind === 'local' || kind === 'container';
  }

  /** The folder check for a remote environment: an absolute path that is a folder there. */
  async checkRemoteFolder(accountId: string, id: string, folder: string): Promise<string> {
    const p = folder.trim().replace(/\/+$/, '') || '/';
    if (!p.startsWith('/') || p.split('/').includes('..'))
      throw new NovaError('validation', 'use the full path of a folder in the environment');
    if (p === '/')
      throw new NovaError('policy_denied', 'the whole filesystem cannot be a session folder', {
        details: { reason: 'protected_folder' },
      });
    const conn = await this.connection(accountId, id);
    const st = await conn.stat(p);
    if (!st)
      throw new NovaError('validation', `no folder at ${p}`, { details: { reason: 'missing' } });
    if (st.kind !== 'dir')
      throw new NovaError('validation', `${p} is not a folder`, {
        details: { reason: 'not_a_folder' },
      });
    return p;
  }

  /** Processes the environment's helper runs, with buffered output sizes (FR-078). */
  async processes(accountId: string, id: string): Promise<EnvironmentProcessView[]> {
    const r = this.#row(accountId, id);
    const conn = await this.connection(accountId, id);
    return (await conn.processes()).map((p) => ({
      id: p.id,
      environmentId: r.id,
      sessionId: p.tag ? (p.tag.split(':')[0] ?? null) : null,
      cmd: defaultRedactor.redactString(p.cmd),
      cwd: p.cwd,
      running: p.running,
      exitCode: p.exitCode,
      outputBytes: p.outputBytes,
      startedAt: p.startedAt,
    }));
  }

  /** Buffered output of a helper process from `offset`: reattaching shows what was missed. */
  async output(
    accountId: string,
    id: string,
    processId: string,
    offset: number,
  ): Promise<EnvironmentOutputView> {
    const conn = await this.connection(accountId, id);
    const r = await conn.read(processId, offset, 0);
    return {
      processId,
      data: defaultRedactor.redactString(r.data.slice(0, MAX_READ_CHARS)),
      offset: r.data.length > MAX_READ_CHARS ? offset + MAX_READ_CHARS : r.offset,
      dropped: r.dropped,
      running: r.running,
      exitCode: r.exitCode,
    };
  }

  /** Describe where a session runs, for its Environment block. */
  describe(accountId: string, id: string | null): string {
    if (!id) return 'this Hub (local environment); commands run in its sandbox';
    let r: EnvRow;
    try {
      r = this.#row(accountId, id);
    } catch {
      return 'an environment that was removed';
    }
    const state =
      r.status === 'ok'
        ? ''
        : ` (status: ${r.status}${r.statusDetail ? `, ${r.statusDetail}` : ''})`;
    switch (r.kind) {
      case 'local':
        return 'this Hub (local environment); commands run in its sandbox';
      case 'container':
        return `the container environment "${r.label}" (image ${(parseConfig(r) as ContainerConfig).image}); commands run in that image on the Hub's sandbox${state}`;
      case 'ssh': {
        const c = parseConfig(r) as SshConfig;
        return `the SSH environment "${r.label}" (${c.user}@${c.host}); commands run on that host through Nova's helper, not on the Hub${state}`;
      }
      case 'wsl':
        return `the WSL distro ${(parseConfig(r) as WslConfig).distro} ("${r.label}"); commands run there through Nova's helper${state}`;
      case 'device':
        return `the device environment "${r.label}"; commands run on that device through novad under its grants${state}`;
      case 'cloud':
      case 'vm':
        return `the ${r.kind} environment "${r.label}"${state}`;
    }
  }

  /** The kind of an environment (null when unknown or removed). */
  kindOf(accountId: string, id: string | null): EnvironmentView['kind'] | null {
    if (!id) return null;
    try {
      return this.#row(accountId, id).kind;
    } catch {
      return null;
    }
  }

  /** The container environment's setup script (null for others or none). */
  setupScript(accountId: string, id: string | null): string | null {
    if (!id) return null;
    const r = this.#row(accountId, id);
    if (r.kind !== 'container') return null;
    return (parseConfig(r) as ContainerConfig).setupScript ?? null;
  }

  async close(): Promise<void> {
    for (const id of [...this.#connections.keys()]) await this.#drop(id);
  }

  // ---- internals -------------------------------------------------------------------------------

  #container(image: string): SandboxClient | null {
    let s = this.#containers.get(image);
    if (!s) {
      const made = this.#o.containerSandbox?.(image) ?? null;
      if (!made) return null;
      s = made;
      this.#containers.set(image, s);
    }
    return s;
  }

  async #drop(id: string): Promise<void> {
    const p = this.#connections.get(id);
    this.#connections.delete(id);
    this.#remotes.delete(id);
    if (!p) return;
    try {
      await (await p).close();
    } catch {
      // Already gone.
    }
  }

  #row(accountId: string, id: string): EnvRow {
    const r = this.#o.db.raw
      .prepare(`SELECT ${ENV_COLUMNS} FROM environment WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as EnvRow | undefined;
    if (!r) throw new NovaError('not_found', 'environment not found');
    return r;
  }

  #knownDevice(accountId: string, deviceId: string): string {
    const d = this.#o.db.raw
      .prepare("SELECT id FROM device WHERE id = ? AND account_id = ? AND status != 'revoked'")
      .get(deviceId, accountId);
    if (!d)
      throw new NovaError('not_found', 'device not found', {
        details: { reason: 'unknown_device' },
      });
    return deviceId;
  }

  #sessionCount(id: string): number {
    const r = this.#o.db.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM code_session s JOIN thread t ON t.id = s.thread_id
         WHERE s.environment_id = ? AND s.status = 'active' AND t.deleted_at IS NULL`,
      )
      .get(id) as { n: number };
    return r.n;
  }

  #view(r: EnvRow): SavedEnvironmentView {
    const sandbox = r.kind === 'local' ? (this.#o.sandbox?.() ?? null) : null;
    const isolated =
      r.kind === 'local'
        ? r.status === 'ok' && isolatedSubstrate(sandbox?.substrate)
        : r.kind === 'container';
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      isolated,
      status: r.status,
      detail: r.statusDetail,
      checkedAt: r.lastCheckAt,
      builtIn: r.kind === 'local',
      connection: this.#connectionView(r),
      sessions: this.#sessionCount(r.id),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  #connectionView(r: EnvRow): EnvironmentConnectionView {
    const cfg = parseConfig(r);
    switch (r.kind) {
      case 'container': {
        const c = cfg as ContainerConfig;
        return { kind: 'container', image: c.image, setupScript: c.setupScript ?? null };
      }
      case 'ssh': {
        const c = cfg as SshConfig;
        return {
          kind: 'ssh',
          host: c.host,
          port: c.port,
          user: c.user,
          auth: c.auth,
          hostKey: c.hostKey ?? null,
          root: c.root ?? null,
          // Only the reference is checked here; the value is never read for a view.
          hasCredential: true,
        };
      }
      case 'wsl': {
        const c = cfg as WslConfig;
        return { kind: 'wsl', deviceId: c.deviceId, distro: c.distro };
      }
      case 'device': {
        const c = cfg as DeviceConfig;
        return { kind: 'device', deviceId: c.deviceId, root: c.root ?? null };
      }
      case 'local':
      case 'cloud':
      case 'vm':
        return { kind: 'local' };
    }
  }

  async #audit(accountId: string, action: string, id: string, detail: Record<string, unknown>) {
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'code',
      action,
      resource: id,
      result: 'ok',
      detail: { environmentId: id, ...detail },
    });
  }

  async #emit(accountId: string, name: string, payload: Record<string, unknown>) {
    try {
      await this.#o.events.emit({ name, actor: 'system', accountId, payload });
    } catch (err) {
      this.#log.warn('could not announce an environment event', { err, name });
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

// ---- the helper's processes as a sandbox (ssh, wsl, device) ------------------------------------

interface HelperProc {
  id: string;
  turnId: string | null;
  offset: number;
}

/**
 * Runs exec requests through a helper connection. The helper owns the processes, so a dropped
 * connection loses nothing: the next call reconnects and reads on from the stored offset, which
 * shows the output buffered meanwhile (FR-078). Commands run on the remote machine under its user
 * (or the device's grants), not in a container: `substrate` is null and Bypass is never offered.
 */
export class EnvHelperSandbox implements SandboxClient {
  readonly substrate = null;
  readonly #connect: () => Promise<EnvHelperConnection>;
  readonly #procs = new Map<string, HelperProc>();

  constructor(connect: () => Promise<EnvHelperConnection>) {
    this.#connect = connect;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    try {
      const h = await (await this.#connect()).hello();
      if (!h.verified) return { ok: false, detail: "the helper's signature is not verified" };
      return { ok: true, detail: `novad ${h.version} on ${h.platform}` };
    } catch (err) {
      return { ok: false, detail: errText(err) };
    }
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const conn = await this.#connect();
    const { id } = await conn.spawn({
      cmd: req.cmd,
      cwd: req.cwd,
      ...(req.env ? { env: req.env } : {}),
      tag: req.turnId ?? 'exec',
    });
    const proc: HelperProc = { id, turnId: req.turnId ?? null, offset: 0 };
    this.#procs.set(id, proc);
    return this.#collect(proc, req.yieldMs, req.signal);
  }

  async poll(sessionId: string, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    const proc = this.#procs.get(sessionId);
    if (!proc) throw new NovaError('not_found', 'no such exec session');
    return this.#collect(proc, yieldMs, signal);
  }

  async write(
    sessionId: string,
    input: { text?: string; closeStdin?: boolean; signal?: 'interrupt' | 'terminate' },
  ): Promise<void> {
    if (!this.#procs.has(sessionId)) throw new NovaError('not_found', 'no such exec session');
    await this.#retry((c) => c.write(sessionId, input));
  }

  async killTurn(turnId: string): Promise<void> {
    for (const p of [...this.#procs.values()]) {
      if (p.turnId !== turnId) continue;
      await this.#retry((c) => c.write(p.id, { signal: 'terminate' })).catch(() => undefined);
      this.#procs.delete(p.id);
    }
  }

  /** Read until the process exits or `yieldMs` passes; output accumulates across reconnects. */
  async #collect(proc: HelperProc, yieldMs: number, signal: AbortSignal): Promise<ExecResult> {
    const end = Date.now() + Math.max(0, yieldMs);
    let out = '';
    for (;;) {
      if (signal.aborted) {
        await this.#retry((c) => c.write(proc.id, { signal: 'terminate' })).catch(() => undefined);
        throw new NovaError('cancelled', 'the command was cancelled');
      }
      const wait = Math.max(0, Math.min(1_000, end - Date.now()));
      const r = await this.#retry((c) => c.read(proc.id, proc.offset, wait));
      if (r.dropped) out += `\n[${r.dropped} bytes of output were dropped]\n`;
      out += r.data;
      proc.offset = r.offset;
      if (!r.running) {
        this.#procs.delete(proc.id);
        return { status: 'exited', exitCode: r.exitCode ?? -1, output: out };
      }
      if (Date.now() >= end) return { status: 'running', sessionId: proc.id, output: out };
    }
  }

  /** One call; when the connection dropped, reconnect once and try again (reattach). */
  async #retry<T>(fn: (c: EnvHelperConnection) => Promise<T>): Promise<T> {
    const conn = await this.#connect();
    try {
      return await fn(conn);
    } catch (err) {
      if (!conn.closed) throw err;
      return fn(await this.#connect());
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function parseConfig(r: EnvRow): Record<string, unknown> {
  if (!r.configJson) return {};
  try {
    return JSON.parse(r.configJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseConnection(kind: EnvironmentView['kind'], value: unknown): Record<string, unknown> {
  switch (kind) {
    case 'container':
      return containerConnectionSchema.parse(value);
    case 'ssh':
      return sshConnectionSchema.parse(value);
    case 'wsl':
      return wslConnectionSchema.parse(value);
    case 'device':
      return deviceConnectionSchema.parse(value);
    case 'local':
    case 'cloud':
    case 'vm':
      throw new NovaError('validation', `${kind} environments have no connection to change`);
  }
}

function assertCredential(
  auth: 'key' | 'password',
  c: { privateKey?: string | undefined; password?: string | undefined },
): void {
  if (auth === 'key' && !c.privateKey)
    throw new NovaError('validation', 'key sign-in needs a private key', {
      details: { reason: 'credential_required' },
    });
  if (auth === 'password' && !c.password)
    throw new NovaError('validation', 'password sign-in needs a password', {
      details: { reason: 'credential_required' },
    });
}

async function probeSandbox(
  sandbox: SandboxClient | null,
): Promise<{ ok: boolean; detail: string }> {
  if (!sandbox) return { ok: false, detail: 'no sandbox' };
  try {
    const a = await sandbox.available();
    return { ok: a.ok, detail: a.ok ? `${sandbox.substrate ?? 'sandbox'} sandbox` : a.detail };
  } catch (err) {
    return { ok: false, detail: errText(err) };
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NovaError('server_error', message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(s: string): string {
  return (
    s
      .split('\n')
      .find((l) => l.trim())
      ?.trim()
      .slice(0, 300) ?? ''
  );
}
