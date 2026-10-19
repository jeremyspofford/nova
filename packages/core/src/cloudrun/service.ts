// The Hub side of the cloud runner (FR-108, FR-071, FR-116; docs/13 §3, docs/10 §12;
// contracts/rest-api.md §5; ADR-095 decision 4). The Hub keeps the agent loop, the model calls and
// the policy gate; a `cloud` environment's commands and files run on the runner:
//
// - The runner: a URL and a token (the token in the vault at `secret://cloud/runner/token`, the
//   `cloud.runner.*` settings hold the URL, the reference and the caps), tested before it is used
//   and off unless `cloud.runner.enabled`.
// - Environments: saved environments of kind `cloud` (EnvironmentService, through `provider`);
//   the runner clones the repositories side by side, runs the setup script once and keeps caches.
// - Runs: each Code session or Work run thread gets a lease (a runner run) with CPU and wall-time
//   caps; usage and caps follow the runner's event stream, so a cap reached while nobody watches
//   is recorded, announced and stops the commands there (a hard stop, FR-116).
// - Work runs on a cloud environment: their thread's commands, roots and Environment block point
//   at the environment (`sandboxForThread`, `workPolicy`, `extension`).
// - Snapshots before a Work run starts and on request; restore on failure. Artifacts are copied
//   from the runner into the thread's artifacts.
import { createHash } from 'node:crypto';
import {
  DEFAULT_CLOUD_CAPS,
  NovaError,
  RUNNER_TOKEN_REF,
  cloudConnectionSchema,
  isCloudFolder,
  isNovaError,
  isRunnerUrl,
  repoUrlHasCredentials,
  uuidv7,
  type ArtifactView,
  type CloudConnectionView,
  type CloudEnvironmentView,
  type CloudFileView,
  type CloudRunStatus,
  type CloudRunView,
  type CloudRunnerTestView,
  type CloudRunnerView,
  type CloudSnapshotView,
  type EnvironmentView,
  type PutRunnerRequest,
  type SettingKey,
  type SettingValue,
  type StartCloudWorkRequest,
} from '@nova/shared';
import type { PolicyRule } from '@nova/policy';
import type { SecretStore } from '@nova/secrets';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type {
  EnvCloudProvider,
  EnvHelperConnection,
  EnvHelperProcess,
} from '../code/environments.ts';
import type { EnvironmentTransport } from '../code/transport.ts';
import type { EventSink } from '../events.ts';
import type {
  AgentRuleSource,
  ThreadPolicy,
  ThreadPolicySource,
  TurnExtension,
} from '../runtime/types.ts';
import type { CreateArtifactInput } from '../tools/artifacts.ts';
import type { AuditSink, Notifier, SandboxClient } from '../tools/types.ts';
import { RunnerClient, type RunnerEnvironment, type RunnerStreamEvent } from './client.ts';
import { CloudSandbox, type CloudLease } from './sandbox.ts';
import { CloudTransport } from './transport.ts';

/** The setting keys the area writes (globally; managed values win). */
export type CloudRunnerSettingKey =
  'cloud.runner.enabled' | 'cloud.runner.url' | 'cloud.runner.token';

export interface CloudRunServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  secrets: SecretStore;
  setting: <K extends SettingKey>(key: K) => Promise<SettingValue<K>>;
  /** Store one global setting (the Hub area's writer: refused when managed). */
  writeSetting: (accountId: string, key: CloudRunnerSettingKey, value: unknown) => Promise<void>;
  audit?: AuditSink;
  notifier?: Notifier;
  /** Imported artifacts go to the thread's artifacts (the artifacts pane). */
  artifacts?: { save(input: CreateArtifactInput): Promise<ArtifactView> };
  fetch?: typeof fetch;
  now?: () => Date;
  log?: Logger;
  /** Follow active runs' event streams (default true). */
  watch?: boolean;
  /** First reconnect delay of an event stream (default 1 s; doubles up to a minute). */
  watchBackoffMs?: number;
}

/** The Work runs area's create and start (bound late; ADR-076: one loop). */
export interface CloudWorkRuns {
  create(input: {
    accountId: string;
    objective: string;
    title?: string;
    projectId: string | null;
    autonomy?: 'ask_first' | 'standard' | 'autonomous';
    budgets?: { timeSeconds?: number; tokens?: number; costUsd?: number | null };
    model?: string;
  }): Promise<{ id: string; threadId: string }>;
  start(accountId: string, runId: string): Promise<unknown>;
}

interface RunRow {
  id: string;
  accountId: string;
  environmentId: string;
  threadId: string | null;
  kind: 'code' | 'work' | 'system';
  workRunId: string | null;
  runnerRunId: string;
  status: CloudRunStatus;
  reason: string | null;
  cpuCapS: number;
  wallCapS: number;
  cpuUsedS: number;
  wallUsedS: number;
  commands: number;
  warningsJson: string;
  lastEventId: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

const RUN_COLUMNS = `id, account_id AS accountId, environment_id AS environmentId, thread_id AS threadId,
  kind, work_run_id AS workRunId, runner_run_id AS runnerRunId, status, reason, cpu_cap_s AS cpuCapS,
  wall_cap_s AS wallCapS, cpu_used_s AS cpuUsedS, wall_used_s AS wallUsedS, commands,
  warnings_json AS warningsJson, last_event_id AS lastEventId, created_at AS createdAt,
  updated_at AS updatedAt, ended_at AS endedAt`;

interface SnapshotRow {
  id: string;
  accountId: string;
  environmentId: string;
  runnerSnapshotId: string;
  label: string | null;
  reason: CloudSnapshotView['reason'];
  sizeBytes: number;
  createdAt: string;
  restoredAt: string | null;
}

const SNAPSHOT_COLUMNS = `id, account_id AS accountId, environment_id AS environmentId,
  runner_snapshot_id AS runnerSnapshotId, label, reason, size_bytes AS sizeBytes,
  created_at AS createdAt, restored_at AS restoredAt`;

interface EnvRow {
  id: string;
  accountId: string;
  kind: string;
  label: string;
  configJson: string | null;
  status: EnvironmentView['status'];
  statusDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a cloud environment's `config_json` holds (never a secret). */
export interface CloudConfig {
  runnerEnvironmentId: string;
  runnerUrl: string;
  repoUrls: string[];
  setupScript: string | null;
  baseImage: string | null;
  caches: string[];
  network: 'off' | 'setup' | 'on';
  diskMb: number;
  folder: string | null;
}

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** Tools that act on the Hub's own files (packages/core/src/tools/fs.ts). */
export const HUB_FILE_TOOLS = [
  'fs.read',
  'fs.list',
  'fs.search',
  'fs.write',
  'fs.edit',
  'fs.delete',
] as const;
/** Runner environments younger than this are never taken for leftovers. */
const RECONCILE_GRACE_MS = 10 * 60_000;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function asCloudConfig(raw: Record<string, unknown>): CloudConfig {
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    runnerEnvironmentId: str(raw.runnerEnvironmentId) ?? '',
    runnerUrl: str(raw.runnerUrl) ?? '',
    repoUrls: Array.isArray(raw.repoUrls)
      ? raw.repoUrls.filter((u): u is string => typeof u === 'string')
      : [],
    setupScript: str(raw.setupScript),
    baseImage: str(raw.baseImage),
    caches: Array.isArray(raw.caches)
      ? raw.caches.filter((u): u is string => typeof u === 'string')
      : [],
    network: raw.network === 'on' || raw.network === 'setup' ? raw.network : 'off',
    diskMb: typeof raw.diskMb === 'number' ? raw.diskMb : DEFAULT_CLOUD_CAPS.diskMb,
    folder: ((f) => (f && isCloudFolder(f) ? f : null))(str(raw.folder)),
  };
}

/** A repository URL without user information. */
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return defaultRedactor.redactString(url);
  }
}

export class CloudRunService {
  readonly #o: CloudRunServiceOptions;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #sandboxes = new Map<string, CloudSandbox>();
  readonly #leasing = new Map<string, Promise<RunRow>>();
  readonly #watchers = new Map<string, AbortController>();
  /** Which lease a runner process belongs to (process listings and reads, FR-078). */
  readonly #processes = new Map<string, string>();
  #client: { key: string; client: RunnerClient } | null = null;
  #status: {
    state: CloudRunnerView['state'];
    detail: string | null;
    version: string | null;
    substrate: CloudRunnerView['substrate'];
    checkedAt: string | null;
  } = {
    state: 'unknown',
    detail: null,
    version: null,
    substrate: null,
    checkedAt: null,
  };
  #runs: CloudWorkRuns | null = null;
  /** Saved environments being created (runner call in flight). */
  readonly #creating = new Set<string>();
  /** Runner environment id → saved environment id, until the row exists. */
  readonly #pendingRunner = new Map<string, string>();
  #closed = false;

  constructor(opts: CloudRunServiceOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.cloudrun', sinks: [] });
  }

  /** The runs area (Work runs on a cloud environment). */
  useRuns(runs: CloudWorkRuns): void {
    this.#runs = runs;
  }

  /** Follow the event streams of runs left active by a restart. */
  start(): void {
    for (const r of this.#rows("status IN ('active', 'capped')", [])) this.#watch(r);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const c of this.#watchers.values()) c.abort();
    this.#watchers.clear();
    return Promise.resolve();
  }

  // ---- the runner (register, test, turn on and off) ------------------------------------------

  async view(): Promise<CloudRunnerView> {
    const [enabled, url, ref, caps] = await Promise.all([
      this.#o.setting('cloud.runner.enabled'),
      this.#o.setting('cloud.runner.url'),
      this.#o.setting('cloud.runner.token'),
      this.#o.setting('cloud.runner.caps'),
    ]);
    const hasToken = !!ref && (await this.#o.secrets.get(ref)) !== null;
    const state: CloudRunnerView['state'] =
      !url || !hasToken ? 'unconfigured' : !enabled ? 'disabled' : this.#status.state;
    return {
      enabled,
      url,
      hasToken,
      state,
      detail:
        state === 'unconfigured'
          ? 'no runner is set up'
          : state === 'disabled'
            ? 'the cloud runner is turned off'
            : this.#status.detail,
      version: this.#status.version,
      substrate: this.#status.substrate,
      checkedAt: this.#status.checkedAt,
      caps,
    };
  }

  /** Register or change the runner. A runner that fails its test is never turned on. */
  async configure(accountId: string, req: PutRunnerRequest): Promise<CloudRunnerView> {
    if (!isRunnerUrl(req.url)) throw new NovaError('validation', 'not a runner URL');
    const before = await this.view();
    const stored = before.hasToken ? await this.#o.secrets.get(RUNNER_TOKEN_REF) : null;
    const token = req.token ?? stored;
    if (!token)
      throw new NovaError('validation', 'the runner token is required', {
        details: { reason: 'token_required' },
      });
    const enabled = req.enabled ?? before.enabled;
    const result = await this.#test(req.url, token);
    if (enabled && !result.ok)
      throw new NovaError('validation', `the runner did not pass its test: ${result.detail}`, {
        details: { reason: 'runner_test_failed', test: result },
      });
    if (req.token) await this.#o.secrets.put(RUNNER_TOKEN_REF, req.token);
    // The URL and token first, so turning it on never sees the old ones.
    await this.#o.writeSetting(accountId, 'cloud.runner.url', req.url);
    await this.#o.writeSetting(accountId, 'cloud.runner.token', RUNNER_TOKEN_REF);
    await this.#o.writeSetting(accountId, 'cloud.runner.enabled', enabled);
    this.#client = null;
    await this.#audit(accountId, 'settings', 'cloud.runner.change', 'cloud.runner', {
      url: req.url,
      urlChanged: req.url !== before.url,
      token: req.token ? 'replaced' : 'kept',
      enabled,
      test: result.ok ? 'ok' : 'failed',
    });
    await this.#emit(accountId, 'cloud.runner.updated', {
      enabled,
      url: req.url,
      state: result.ok ? 'ok' : 'error',
    });
    return this.view();
  }

  async setEnabled(accountId: string, enabled: boolean): Promise<CloudRunnerView> {
    const v = await this.view();
    if (enabled) {
      if (!v.url || !v.hasToken)
        throw new NovaError('validation', 'set up the runner first', {
          details: { reason: 'runner_unconfigured' },
        });
      const t = await this.test();
      if (!t.ok)
        throw new NovaError('validation', `the runner did not pass its test: ${t.detail}`, {
          details: { reason: 'runner_test_failed', test: t },
        });
    }
    await this.#o.writeSetting(accountId, 'cloud.runner.enabled', enabled);
    this.#client = null;
    if (!enabled) for (const c of this.#watchers.values()) c.abort();
    await this.#audit(accountId, 'settings', 'cloud.runner.change', 'cloud.runner', { enabled });
    await this.#emit(accountId, 'cloud.runner.updated', {
      enabled,
      url: v.url,
      state: enabled ? 'ok' : 'disabled',
    });
    if (enabled) this.start();
    return this.view();
  }

  /** Forget the runner: token out of the vault, settings cleared, turned off. */
  async forget(accountId: string): Promise<void> {
    await this.#o.writeSetting(accountId, 'cloud.runner.enabled', false);
    await this.#o.writeSetting(accountId, 'cloud.runner.token', '');
    await this.#o.writeSetting(accountId, 'cloud.runner.url', '');
    await this.#o.secrets.delete(RUNNER_TOKEN_REF).catch(() => false);
    this.#client = null;
    for (const c of this.#watchers.values()) c.abort();
    this.#status = {
      state: 'unknown',
      detail: null,
      version: null,
      substrate: null,
      checkedAt: null,
    };
    await this.#audit(accountId, 'settings', 'cloud.runner.remove', 'cloud.runner', {});
    await this.#emit(accountId, 'cloud.runner.updated', {
      enabled: false,
      url: '',
      state: 'unconfigured',
    });
  }

  /** Reach the runner with the stored URL and token now. */
  async test(): Promise<CloudRunnerTestView> {
    const url = await this.#o.setting('cloud.runner.url');
    const ref = await this.#o.setting('cloud.runner.token');
    const token = ref ? await this.#o.secrets.get(ref) : null;
    if (!url || !token)
      return {
        ok: false,
        latencyMs: null,
        version: null,
        substrate: null,
        detail: 'no runner is set up',
      };
    return this.#test(url, token);
  }

  async #test(url: string, token: string): Promise<CloudRunnerTestView> {
    const client = new RunnerClient({
      url,
      token,
      timeoutMs: 10_000,
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
    });
    const t0 = Date.now();
    let out: CloudRunnerTestView;
    try {
      const h = await client.health();
      out = {
        ok: h.substrate.ok,
        latencyMs: Date.now() - t0,
        version: h.version,
        substrate: h.substrate,
        detail: h.substrate.ok
          ? `runner ${h.version}; ${h.substrate.detail}`
          : `the runner has no sandbox: ${h.substrate.detail}`,
      };
    } catch (err) {
      out = { ok: false, latencyMs: null, version: null, substrate: null, detail: errText(err) };
    }
    this.#status = {
      state: out.ok ? 'ok' : 'error',
      detail: out.detail,
      version: out.version,
      substrate: out.substrate,
      checkedAt: this.#iso(),
    };
    return out;
  }

  /** The client of the configured runner; `capability_missing` while it is off or not set up. */
  async client(): Promise<RunnerClient> {
    const [enabled, url, ref] = await Promise.all([
      this.#o.setting('cloud.runner.enabled'),
      this.#o.setting('cloud.runner.url'),
      this.#o.setting('cloud.runner.token'),
    ]);
    if (!url || !ref)
      throw new NovaError('capability_missing', 'no cloud runner is set up', {
        details: { reason: 'runner_unconfigured' },
        action: 'Set up a cloud runner in Settings',
      });
    if (!enabled)
      throw new NovaError('capability_missing', 'the cloud runner is turned off', {
        details: { reason: 'runner_disabled' },
        action: 'Turn on the cloud runner in Settings',
      });
    const token = await this.#o.secrets.get(ref);
    if (!token)
      throw new NovaError('capability_missing', 'the runner token is missing from the vault', {
        details: { reason: 'runner_token_missing' },
      });
    const key = createHash('sha256').update(`${url}\0${token}`).digest('hex');
    if (this.#client?.key !== key)
      this.#client = {
        key,
        client: new RunnerClient({
          url,
          token,
          ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
        }),
      };
    return this.#client.client;
  }

  // ---- environments (the provider EnvironmentService uses for kind `cloud`) -------------------

  readonly provider: EnvCloudProvider = {
    create: async (accountId, envId, label, connection) => {
      const c = cloudConnectionSchema.parse(connection);
      // Network from the runner bypasses the Hub's egress proxy (docs/12 §8): only behind the
      // owner's explicit, off-by-default setting.
      if (c.network !== 'off' && !(await this.#o.setting('cloud.runner.unrestrictedNetwork')))
        throw new NovaError(
          'validation',
          "cloud environments get network only when cloud.runner.unrestrictedNetwork is on: their traffic would not go through the Hub's egress proxy",
          { details: { reason: 'cloud_network_off', field: 'network' } },
        );
      if (c.repoUrls.some(repoUrlHasCredentials))
        throw new NovaError('validation', 'repository URLs may not carry credentials', {
          details: { reason: 'credentials_in_url', field: 'repoUrls' },
        });
      const caps = await this.#o.setting('cloud.runner.caps');
      const diskMb = c.diskMb ?? caps.diskMb;
      if (diskMb > caps.diskMb)
        throw new NovaError(
          'validation',
          `at most ${caps.diskMb} MB of disk per cloud environment (cloud.runner.caps)`,
          {
            details: { reason: 'over_cap', field: 'diskMb' },
          },
        );
      const client = await this.client();
      // Until the row is saved, reconcile must not take it for a leftover.
      this.#creating.add(envId);
      let env: RunnerEnvironment;
      try {
        env = await client.createEnvironment({
          name: label,
          repoUrls: c.repoUrls,
          setupScript: c.setupScript ?? null,
          baseImage: c.baseImage ?? null,
          caches: c.caches ?? [],
          network: c.network,
          diskMb,
        });
        this.#pendingRunner.set(env.id, envId);
      } finally {
        this.#creating.delete(envId);
      }
      this.#log.info('cloud environment created', {
        environmentId: envId,
        runnerEnvironmentId: env.id,
      });
      const config: CloudConfig = {
        runnerEnvironmentId: env.id,
        runnerUrl: client.url,
        repoUrls: c.repoUrls.map(cleanUrl),
        setupScript: c.setupScript ?? null,
        baseImage: c.baseImage ?? null,
        caches: c.caches ?? [],
        network: c.network,
        diskMb,
        folder: c.folder ?? null,
      };
      void accountId;
      return config as unknown as Record<string, unknown>;
    },
    remove: async (accountId, envId, raw) => {
      const cfg = asCloudConfig(raw);
      for (const r of this.#rows("environment_id = ? AND status IN ('active', 'capped')", [
        envId,
      ])) {
        this.#watchers.get(r.id)?.abort();
        await this.#setStatus(r, 'cancelled', 'environment_removed');
      }
      this.#sandboxes.delete(envId);
      let runnerDeleted = true;
      try {
        await (await this.client()).deleteEnvironment(cfg.runnerEnvironmentId);
      } catch (err) {
        if (!(isNovaError(err) && err.code === 'not_found')) {
          // Removed from the runner the next time it is reachable (reconcile).
          runnerDeleted = false;
          this.#log.warn('the runner environment was not deleted', { err, environmentId: envId });
        }
      }
      await this.#o.db.transaction(() => {
        for (const t of ['cloud_snapshot', 'cloud_work_binding', 'cloud_run'])
          this.#o.db.raw.prepare(`DELETE FROM ${t} WHERE environment_id = ?`).run(envId);
      });
      await this.#audit(accountId, 'code', 'cloud.environment.remove', envId, { runnerDeleted });
    },
    check: async (_accountId, _envId, raw) => {
      const cfg = asCloudConfig(raw);
      let client: RunnerClient;
      try {
        client = await this.client();
      } catch (err) {
        return { status: 'down', detail: errText(err) };
      }
      try {
        const env = await client.environment(cfg.runnerEnvironmentId);
        return envHealth(env);
      } catch (err) {
        if (isNovaError(err) && err.code === 'not_found')
          return { status: 'down', detail: 'the runner no longer has this environment' };
        return { status: 'down', detail: errText(err) };
      }
    },
    connection: (accountId, envId, raw) =>
      Promise.resolve(this.#connection(accountId, envId, asCloudConfig(raw))),
    sandbox: (accountId, envId, raw) => this.#sandbox(accountId, envId, asCloudConfig(raw)),
    connectionView: (raw) => connectionView(asCloudConfig(raw)),
    describe: (label, raw) => {
      const c = asCloudConfig(raw);
      return `the cloud environment "${label}" (${c.repoUrls.length} repositor${c.repoUrls.length === 1 ? 'y' : 'ies'} under /workspace) on the cloud runner; commands run there in the runner's sandbox, not on the Hub, and keep running while the user's devices are offline. The file tools work on the Hub's files only: read and change files here with exec.run (cat, sed, tee, git apply)`;
    },
  };

  /** Every cloud environment of the account with what the runner says of it. */
  async environments(accountId: string): Promise<CloudEnvironmentView[]> {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT id, account_id AS accountId, kind, label, config_json AS configJson, status,
           status_detail AS statusDetail, created_at AS createdAt, updated_at AS updatedAt
         FROM environment WHERE account_id = ? AND kind = 'cloud' ORDER BY created_at, id`,
      )
      .all(accountId) as unknown as EnvRow[];
    const client = await this.client().catch(() => null);
    const remote = new Map<string, RunnerEnvironment>();
    if (client)
      try {
        for (const e of await client.environments()) remote.set(e.id, e);
      } catch (err) {
        this.#log.warn('listing runner environments failed', { err });
      }
    return rows.map((r) =>
      this.#envView(r, remote.get(asCloudConfig(parse(r.configJson)).runnerEnvironmentId) ?? null),
    );
  }

  async environment(accountId: string, id: string): Promise<CloudEnvironmentView> {
    const r = this.#envRow(accountId, id);
    const cfg = asCloudConfig(parse(r.configJson));
    let remote: RunnerEnvironment | null = null;
    try {
      remote = await (await this.client()).environment(cfg.runnerEnvironmentId);
    } catch (err) {
      if (!(
        isNovaError(err) &&
        (err.code === 'node_unavailable' ||
          err.code === 'capability_missing' ||
          err.code === 'not_found')
      ))
        throw err;
    }
    return this.#envView(r, remote);
  }

  /** Clone again and run the setup again (explicit, docs/10 §2). */
  async rebuild(accountId: string, id: string): Promise<CloudEnvironmentView> {
    const r = this.#envRow(accountId, id);
    const cfg = asCloudConfig(parse(r.configJson));
    const env = await (await this.client()).rebuild(cfg.runnerEnvironmentId);
    await this.#audit(accountId, 'code', 'cloud.environment.rebuild', id, {});
    await this.#emit(accountId, 'environment.updated', { environmentId: id, change: 'rebuilding' });
    return this.#envView(r, env);
  }

  /** A folder listing or a file of the environment (read in the runner's sandbox). */
  async file(accountId: string, id: string, path: string): Promise<CloudFileView> {
    const r = this.#envRow(accountId, id);
    const cfg = asCloudConfig(parse(r.configJson));
    const f = await (await this.client()).files(cfg.runnerEnvironmentId, path);
    if (f.kind === 'dir') return { kind: 'dir', path, entries: f.entries, truncated: f.truncated };
    const bytes = Buffer.from(f.content, 'base64');
    let text: string | null = null;
    if (!bytes.includes(0)) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    return {
      kind: 'file',
      path,
      size: f.size,
      text: text === null ? null : defaultRedactor.redactString(text),
      truncated: f.truncated,
    };
  }

  /** Remove runner environments no saved environment refers to (left by a removal while unreachable). */
  async reconcile(): Promise<number> {
    const client = await this.client();
    const known = new Set(
      (
        this.#o.db.raw
          .prepare("SELECT config_json AS c FROM environment WHERE kind = 'cloud'")
          .all() as { c: string | null }[]
      ).map((r) => asCloudConfig(parse(r.c)).runnerEnvironmentId),
    );
    // Not one being created right now (made on the runner, its row not saved yet), and not one
    // younger than the grace period (a creation this Hub process did not see start).
    for (const [runnerId, envId] of [...this.#pendingRunner]) {
      known.add(runnerId);
      if (this.#o.db.raw.prepare('SELECT 1 FROM environment WHERE id = ?').get(envId))
        this.#pendingRunner.delete(runnerId);
    }
    if (this.#creating.size) return 0;
    const cutoff = this.#now().getTime() - RECONCILE_GRACE_MS;
    let removed = 0;
    for (const e of await client.environments()) {
      if (known.has(e.id) || Date.parse(e.createdAt) > cutoff) continue;
      await client.deleteEnvironment(e.id).catch(() => undefined);
      removed++;
    }
    return removed;
  }

  // ---- leases (one runner run per thread) ----------------------------------------------------

  /** The thread's active lease on the environment, created on first use. */
  async lease(accountId: string, envId: string, threadId: string | null): Promise<RunRow> {
    const key = `${envId}\0${threadId ?? ''}`;
    const pending = this.#leasing.get(key);
    if (pending) return pending;
    const p = this.#lease(accountId, envId, threadId).finally(() => this.#leasing.delete(key));
    this.#leasing.set(key, p);
    return p;
  }

  async #lease(accountId: string, envId: string, threadId: string | null): Promise<RunRow> {
    const where = threadId === null ? 'thread_id IS NULL' : 'thread_id = ?';
    const args = threadId === null ? [envId] : [envId, threadId];
    const open = this.#rows(
      `environment_id = ? AND ${where} AND status IN ('active', 'capped') ORDER BY created_at DESC`,
      args,
    )[0];
    if (open?.status === 'capped')
      throw new NovaError(
        'budget_exhausted',
        `the cloud run reached its ${open.reason ?? ''} cap`.replace('  ', ' '),
        {
          details: { reason: 'cap_reached', resource: open.reason, cloudRunId: open.id },
          action: 'Raise the cloud run caps to continue',
        },
      );
    if (open) return open;
    const env = this.#envRow(accountId, envId);
    const cfg = asCloudConfig(parse(env.configJson));
    const binding = threadId ? this.#binding(accountId, threadId) : null;
    const kind: RunRow['kind'] = binding
      ? 'work'
      : threadId && this.#isCodeThread(threadId)
        ? 'code'
        : threadId
          ? 'work'
          : 'system';
    const caps = await this.#o.setting('cloud.runner.caps');
    const client = await this.client();
    const run = await client.createRun({
      environmentId: cfg.runnerEnvironmentId,
      label: kind,
      budget: { cpuSeconds: caps.cpuSeconds, wallSeconds: caps.wallSeconds },
    });
    const now = this.#iso();
    const id = uuidv7();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO cloud_run (id, account_id, environment_id, thread_id, kind, work_run_id,
             runner_run_id, status, cpu_cap_s, wall_cap_s, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(
          id,
          accountId,
          envId,
          threadId,
          kind,
          binding?.workRunId ?? null,
          run.id,
          run.caps.cpuSeconds,
          run.caps.wallSeconds,
          now,
          now,
        );
    });
    const row = this.#rowById(id)!;
    await this.#audit(accountId, 'run', 'cloud.run.start', id, {
      environmentId: envId,
      kind,
      threadId,
    });
    await this.#emit(
      accountId,
      'cloud.run.started',
      { cloudRunId: id, environmentId: envId, threadId, kind },
      threadId,
    );
    this.#watch(row);
    return row;
  }

  async runs(
    accountId: string,
    q: {
      environmentId?: string | undefined;
      threadId?: string | undefined;
      status?: 'active' | 'all';
    },
  ): Promise<CloudRunView[]> {
    const where = ['account_id = ?'];
    const args: string[] = [accountId];
    if (q.environmentId) {
      where.push('environment_id = ?');
      args.push(q.environmentId);
    }
    if (q.threadId) {
      where.push('thread_id = ?');
      args.push(q.threadId);
    }
    if (q.status === 'active') where.push("status IN ('active', 'capped')");
    return Promise.resolve(
      this.#rows(`${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, args).map((r) =>
        this.#view(r),
      ),
    );
  }

  /** A run, refreshed from the runner when it can be reached. */
  async run(accountId: string, id: string): Promise<CloudRunView> {
    const row = this.#own(accountId, id);
    if (row.status === 'active' || row.status === 'capped') {
      try {
        const r = await (await this.client()).run(row.runnerRunId);
        await this.#apply(row, {
          usage: r.usage,
          caps: r.caps,
          status: r.status,
          reason: r.reason,
        });
      } catch (err) {
        if (isNovaError(err) && err.code === 'not_found')
          await this.#setStatus(row, 'lost', 'unknown_to_runner');
      }
    }
    return this.#view(this.#rowById(id)!);
  }

  async cancel(accountId: string, id: string): Promise<CloudRunView> {
    const row = this.#own(accountId, id);
    if (row.status === 'active' || row.status === 'capped') {
      await (await this.client()).cancelRun(row.runnerRunId);
      await this.#setStatus(row, 'cancelled', 'cancelled');
      await this.#audit(accountId, 'run', 'cloud.run.cancel', id, {});
    }
    return this.#view(this.#rowById(id)!);
  }

  /** New caps for a run; one that was capped and now has room is active again (FR-116). */
  async setCaps(
    accountId: string,
    id: string,
    caps: { cpuSeconds?: number | undefined; wallSeconds?: number | undefined },
  ): Promise<CloudRunView> {
    const row = this.#own(accountId, id);
    if (row.status !== 'active' && row.status !== 'capped')
      throw new NovaError('conflict', 'the cloud run has ended', { details: { reason: 'ended' } });
    const r = await (
      await this.client()
    ).updateRun(row.runnerRunId, {
      ...(caps.cpuSeconds !== undefined ? { cpuSeconds: caps.cpuSeconds } : {}),
      ...(caps.wallSeconds !== undefined ? { wallSeconds: caps.wallSeconds } : {}),
    });
    await this.#apply(row, { usage: r.usage, caps: r.caps, status: r.status, reason: r.reason });
    const after = this.#rowById(id)!;
    if (after.status === 'active') {
      await this.#updateRow(after.id, { warnings_json: '[]' });
      this.#watch(after);
    }
    await this.#audit(accountId, 'run', 'cloud.run.caps', id, {
      cpuSeconds: r.caps.cpuSeconds,
      wallSeconds: r.caps.wallSeconds,
    });
    return this.#view(this.#rowById(id)!);
  }

  /** End a thread's leases (the session was archived, the Work run ended). */
  async finishThread(accountId: string, threadId: string): Promise<number> {
    const rows = this.#rows("account_id = ? AND thread_id = ? AND status IN ('active', 'capped')", [
      accountId,
      threadId,
    ]);
    for (const r of rows) {
      this.#watchers.get(r.id)?.abort();
      try {
        await (await this.client()).finishRun(r.runnerRunId);
      } catch (err) {
        this.#log.warn('finishing a cloud run failed', { err, cloudRunId: r.id });
      }
      await this.#setStatus(r, 'completed', 'finished');
    }
    return rows.length;
  }

  /** Active leases whose thread no longer needs them (archived session, ended Work run). */
  async sweep(): Promise<number> {
    const rows = this.#rows("status IN ('active', 'capped') AND thread_id IS NOT NULL", []);
    let n = 0;
    for (const r of rows) {
      const done =
        r.kind === 'code'
          ? (this.#o.db.raw
              .prepare("SELECT 1 FROM code_session WHERE thread_id = ? AND status = 'active'")
              .get(r.threadId) ?? null) === null
          : r.workRunId
            ? (this.#o.db.raw
                .prepare(
                  "SELECT 1 FROM run WHERE id = ? AND status NOT IN ('done', 'failed', 'cancelled', 'output_missing')",
                )
                .get(r.workRunId) ?? null) === null
            : false;
      if (done) n += await this.finishThread(r.accountId, r.threadId!);
    }
    return n;
  }

  // ---- event streams from the runner ---------------------------------------------------------

  #watch(row: RunRow): void {
    if (this.#o.watch === false || this.#closed || this.#watchers.has(row.id)) return;
    const ctrl = new AbortController();
    this.#watchers.set(row.id, ctrl);
    void this.#follow(row.id, ctrl).finally(() => {
      if (this.#watchers.get(row.id) === ctrl) this.#watchers.delete(row.id);
    });
  }

  async #follow(id: string, ctrl: AbortController): Promise<void> {
    let delay = this.#o.watchBackoffMs ?? 1_000;
    while (!ctrl.signal.aborted && !this.#closed) {
      const row = this.#rowById(id);
      if (!row || (row.status !== 'active' && row.status !== 'capped')) return;
      try {
        const client = await this.client();
        for await (const e of client.stream(row.runnerRunId, row.lastEventId, ctrl.signal)) {
          await this.#onEvent(id, e);
          delay = this.#o.watchBackoffMs ?? 1_000;
          if (e.event === 'run.ended') return;
        }
      } catch (err) {
        if (isNovaError(err) && err.code === 'not_found') {
          await this.#setStatus(this.#rowById(id)!, 'lost', 'unknown_to_runner');
          return;
        }
        if (isNovaError(err) && err.code === 'capability_missing') return;
        this.#log.warn('the runner event stream dropped', { err, cloudRunId: id });
      }
      if (ctrl.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        t.unref();
        ctrl.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
      delay = Math.min(60_000, delay * 2);
    }
  }

  async #onEvent(id: string, e: RunnerStreamEvent): Promise<void> {
    const row = this.#rowById(id);
    if (!row) return;
    const d = e.data;
    switch (e.event) {
      case 'usage':
      case 'process.exited': {
        const usage = d.usage as
          { cpuSeconds: number; wallSeconds: number; commands: number } | undefined;
        if (usage)
          await this.#apply(row, {
            usage,
            caps: d.caps as { cpuSeconds: number; wallSeconds: number } | undefined,
          });
        await this.#updateRow(id, { last_event_id: e.id });
        if (usage)
          this.#o.events.emitEphemeral({
            name: 'cloud.run.usage',
            actor: 'system',
            accountId: row.accountId,
            ...(row.threadId ? { correlation: { threadId: row.threadId } } : {}),
            payload: {
              cloudRunId: id,
              usage,
              caps: { cpuSeconds: row.cpuCapS, wallSeconds: row.wallCapS },
            },
          });
        break;
      }
      case 'cap.warning': {
        const warnings = new Set(JSON.parse(row.warningsJson) as string[]);
        const resource = typeof d.resource === 'string' ? d.resource : '';
        warnings.add(resource);
        await this.#updateRow(id, {
          warnings_json: JSON.stringify([...warnings]),
          last_event_id: e.id,
        });
        await this.#emit(
          row.accountId,
          'cloud.run.cap_warning',
          { cloudRunId: id, resource, used: d.used, limit: d.limit },
          row.threadId,
        );
        await this.#notify(
          row,
          'attention',
          `Cloud run near its ${resource} cap`,
          `${String(d.used)} of ${String(d.limit)}`,
        );
        break;
      }
      case 'cap.reached': {
        const resource = typeof d.resource === 'string' ? d.resource : '';
        if (resource === 'cpu' || resource === 'wall')
          await this.#setStatus(row, 'capped', resource);
        await this.#updateRow(id, { last_event_id: e.id });
        await this.#emit(
          row.accountId,
          'cloud.run.capped',
          { cloudRunId: id, resource, used: d.used, limit: d.limit },
          row.threadId,
        );
        await this.#audit(
          row.accountId,
          'run',
          'cloud.run.capped',
          id,
          { resource, used: d.used, limit: d.limit },
          'system',
        );
        await this.#notify(
          row,
          'attention',
          `Cloud run stopped at its ${resource} cap`,
          'Raise the caps to continue',
        );
        break;
      }
      case 'run.ended': {
        const status = d.status === 'cancelled' || d.status === 'failed' ? d.status : 'completed';
        await this.#updateRow(id, { last_event_id: e.id });
        await this.#setStatus(
          this.#rowById(id)!,
          status,
          typeof d.reason === 'string' ? d.reason : null,
        );
        break;
      }
      default:
        await this.#updateRow(id, { last_event_id: e.id });
    }
  }

  /** Called by the sandbox when the runner refused a command at a cap. */
  async capped(lease: CloudLease, err: NovaError): Promise<void> {
    const row = this.#rowById(lease.id);
    if (!row || row.status !== 'active') return;
    const resource = (err.details?.resource as string | undefined) ?? null;
    if (resource === 'cpu' || resource === 'wall') {
      await this.#setStatus(row, 'capped', resource);
      await this.#emit(
        row.accountId,
        'cloud.run.capped',
        { cloudRunId: row.id, resource },
        row.threadId,
      );
    }
  }

  async #apply(
    row: RunRow,
    r: {
      usage?: { cpuSeconds: number; wallSeconds: number; commands: number } | undefined;
      caps?: { cpuSeconds: number; wallSeconds: number } | undefined;
      status?: string;
      reason?: string | null;
    },
  ): Promise<void> {
    const set: Record<string, string | number | null> = {};
    if (r.usage) {
      set.cpu_used_s = r.usage.cpuSeconds;
      set.wall_used_s = r.usage.wallSeconds;
      set.commands = r.usage.commands;
    }
    if (r.caps) {
      set.cpu_cap_s = r.caps.cpuSeconds;
      set.wall_cap_s = r.caps.wallSeconds;
    }
    if (Object.keys(set).length) await this.#updateRow(row.id, set);
    if (r.status && r.status !== row.status) {
      const status = (['active', 'completed', 'cancelled', 'capped', 'failed'] as const).find(
        (s) => s === r.status,
      );
      if (status) await this.#setStatus(this.#rowById(row.id)!, status, r.reason ?? null);
    }
  }

  async #setStatus(row: RunRow, status: CloudRunStatus, reason: string | null): Promise<void> {
    if (row.status === status && row.reason === reason) return;
    const now = this.#iso();
    const ended = status !== 'active' && status !== 'capped';
    await this.#updateRow(row.id, {
      status,
      reason,
      ...(ended ? { ended_at: now } : { ended_at: null }),
    });
    if (ended) {
      this.#watchers.get(row.id)?.abort();
      await this.#emit(
        row.accountId,
        'cloud.run.ended',
        { cloudRunId: row.id, status, reason },
        row.threadId,
      );
    }
  }

  async #notify(row: RunRow, kind: 'attention', title: string, body: string): Promise<void> {
    try {
      await this.#o.notifier?.notify({
        accountId: row.accountId,
        kind,
        title,
        body,
        dedupeKey: `cloud-run:${row.id}:${title}`,
        ...(row.kind === 'code' && row.threadId
          ? { href: `/code/${this.#sessionOf(row.threadId) ?? ''}` }
          : {}),
        ...(row.kind === 'work' && row.workRunId ? { href: `/work/${row.workRunId}` } : {}),
      });
    } catch (err) {
      this.#log.warn('a cloud run notification failed', { err });
    }
  }

  // ---- snapshots and artifacts ---------------------------------------------------------------

  async snapshot(
    accountId: string,
    envId: string,
    label: string | null,
    reason: CloudSnapshotView['reason'] = 'manual',
  ): Promise<CloudSnapshotView> {
    const env = this.#envRow(accountId, envId);
    const cfg = asCloudConfig(parse(env.configJson));
    const s = await (await this.client()).snapshot(cfg.runnerEnvironmentId, label ?? undefined);
    const id = uuidv7();
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO cloud_snapshot (id, account_id, environment_id, runner_snapshot_id, label,
             reason, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, accountId, envId, s.id, label, reason, s.sizeBytes, this.#iso());
    });
    await this.#audit(accountId, 'code', 'cloud.snapshot.create', id, {
      environmentId: envId,
      reason,
    });
    await this.#emit(accountId, 'cloud.snapshot.created', {
      snapshotId: id,
      environmentId: envId,
      reason,
    });
    return snapshotView(this.#snapshotRow(accountId, id));
  }

  snapshots(accountId: string, envId: string): CloudSnapshotView[] {
    this.#envRow(accountId, envId);
    return (
      this.#o.db.raw
        .prepare(
          `SELECT ${SNAPSHOT_COLUMNS} FROM cloud_snapshot WHERE account_id = ? AND environment_id = ? ORDER BY created_at DESC`,
        )
        .all(accountId, envId) as unknown as SnapshotRow[]
    ).map(snapshotView);
  }

  /** Put the workdir back as it was (refused while commands run there). */
  async restore(accountId: string, id: string, keepCurrent = false): Promise<CloudSnapshotView> {
    const s = this.#snapshotRow(accountId, id);
    if (keepCurrent)
      await this.snapshot(accountId, s.environmentId, 'before restore', 'before_restore');
    await (await this.client()).restore(s.runnerSnapshotId);
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare('UPDATE cloud_snapshot SET restored_at = ? WHERE id = ?')
        .run(this.#iso(), id);
    });
    await this.#audit(accountId, 'code', 'cloud.snapshot.restore', id, {
      environmentId: s.environmentId,
      keepCurrent,
    });
    await this.#emit(accountId, 'cloud.snapshot.restored', {
      snapshotId: id,
      environmentId: s.environmentId,
    });
    return snapshotView(this.#snapshotRow(accountId, id));
  }

  async deleteSnapshot(accountId: string, id: string): Promise<void> {
    const s = this.#snapshotRow(accountId, id);
    try {
      await (await this.client()).deleteSnapshot(s.runnerSnapshotId);
    } catch (err) {
      if (!(isNovaError(err) && err.code === 'not_found')) throw err;
    }
    await this.#o.db.transaction(() => {
      this.#o.db.raw.prepare('DELETE FROM cloud_snapshot WHERE id = ?').run(id);
    });
    await this.#audit(accountId, 'code', 'cloud.snapshot.delete', id, {
      environmentId: s.environmentId,
    });
    await this.#emit(accountId, 'cloud.snapshot.deleted', {
      snapshotId: id,
      environmentId: s.environmentId,
    });
  }

  /** Copy a file of the run's workdir into the thread's artifacts (docs/13 §3: artifacts returned). */
  async collectArtifact(
    accountId: string,
    cloudRunId: string,
    input: { path: string; title?: string | undefined },
  ): Promise<ArtifactView> {
    const row = this.#own(accountId, cloudRunId);
    if (!this.#o.artifacts)
      throw new NovaError('capability_missing', 'artifacts are not available here');
    if (!row.threadId)
      throw new NovaError('validation', 'this cloud run has no thread to keep artifacts in');
    const client = await this.client();
    const a = await client.collectArtifact(row.runnerRunId, input.path);
    if (a.sizeBytes > MAX_IMPORT_BYTES)
      throw new NovaError(
        'validation',
        `the file is ${a.sizeBytes} bytes; artifacts in a thread hold at most ${MAX_IMPORT_BYTES}`,
        {
          details: { reason: 'too_large', size: a.sizeBytes, limit: MAX_IMPORT_BYTES },
        },
      );
    const bytes = await client.artifact(row.runnerRunId, a.id, MAX_IMPORT_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== a.sha256)
      throw new NovaError('server_error', 'the artifact changed on the way from the runner');
    const view = await this.#o.artifacts.save({
      accountId,
      threadId: row.threadId,
      messageId: null,
      kind: 'file',
      title: input.title ?? a.name,
      content: bytes.toString('base64'),
      encoding: 'base64',
    });
    await this.#audit(accountId, 'run', 'cloud.artifact.import', cloudRunId, {
      artifactId: view.id,
      size: a.sizeBytes,
      sha256: a.sha256,
    });
    return view;
  }

  // ---- Work runs on a cloud environment ------------------------------------------------------

  /**
   * Start a Work run whose commands and files go to a cloud environment: the run is created
   * waiting, bound, snapshotted (unless asked not to), then started, so its first command already
   * runs there.
   */
  async startWork(
    accountId: string,
    req: StartCloudWorkRequest,
  ): Promise<{
    runId: string;
    threadId: string;
    cloudRun: CloudRunView;
    snapshot: CloudSnapshotView | null;
  }> {
    if (!this.#runs) throw new NovaError('capability_missing', 'Work runs are not available here');
    const env = this.#envRow(accountId, req.environmentId);
    if (env.kind !== 'cloud')
      throw new NovaError('validation', 'that is not a cloud environment', {
        details: { reason: 'not_cloud' },
      });
    const cfg = asCloudConfig(parse(env.configJson));
    const client = await this.client();
    const remote = await client.environment(cfg.runnerEnvironmentId);
    if (remote.status !== 'ready')
      throw new NovaError('conflict', `the cloud environment is ${remote.status}`, {
        details: { reason: 'not_ready', status: remote.status },
      });
    // The runner says where the repository is; the Hub takes only a folder under /workspace.
    const folder = cfg.folder ?? remote.connection.repos[0]?.path ?? '/workspace';
    if (!isCloudFolder(folder))
      throw new NovaError('validation', 'the runner reported a folder outside /workspace', {
        details: { reason: 'runner_path' },
      });
    const snapshot =
      req.snapshot === false
        ? null
        : await this.snapshot(
            accountId,
            env.id,
            `before ${req.title ?? 'a Work run'}`,
            'run_start',
          );
    const run = await this.#runs.create({
      accountId,
      objective: req.objective,
      ...(req.title ? { title: req.title } : {}),
      projectId: req.projectId ?? null,
      ...(req.autonomy ? { autonomy: req.autonomy } : {}),
      ...(req.budgets ? { budgets: req.budgets } : {}),
      ...(req.model ? { model: req.model } : {}),
    });
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `INSERT INTO cloud_work_binding (thread_id, account_id, environment_id, work_run_id, folder, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(run.threadId, accountId, env.id, run.id, folder, this.#iso());
    });
    const lease = await this.lease(accountId, env.id, run.threadId);
    if (req.caps) await this.setCaps(accountId, lease.id, req.caps);
    await this.#audit(accountId, 'run', 'cloud.work.start', run.id, {
      environmentId: env.id,
      cloudRunId: lease.id,
    });
    await this.#runs.start(accountId, run.id);
    return {
      runId: run.id,
      threadId: run.threadId,
      cloudRun: this.#view(this.#rowById(lease.id)!),
      snapshot,
    };
  }

  /** The cloud environment a Work run's thread is bound to. */
  bindingFor(
    accountId: string,
    threadId: string,
  ): { environmentId: string; folder: string; workRunId: string } | null {
    return this.#binding(accountId, threadId);
  }

  /**
   * The Code area's transport for a cloud environment (`CodeService.useEnvironmentTransport`):
   * Hub-side change capture, review, commits and handoffs run their Git there (FR-213).
   */
  readonly transportFor = (
    accountId: string,
    envId: string,
  ): Promise<EnvironmentTransport | null> => {
    try {
      const env = this.#envRow(accountId, envId);
      return Promise.resolve(
        new CloudTransport({
          label: `the cloud environment "${env.label}"`,
          client: () => this.client(),
          lease: async () => {
            const r = await this.lease(accountId, envId, null);
            return { id: r.id, runnerRunId: r.runnerRunId };
          },
        }),
      );
    } catch {
      return Promise.resolve(null);
    }
  };

  /** The sandbox of a bound Work run's thread (null for every other thread). */
  sandboxForThread(accountId: string, threadId: string): SandboxClient | null {
    const b = this.#binding(accountId, threadId);
    if (!b) return null;
    try {
      const env = this.#envRow(accountId, b.environmentId);
      return this.#sandbox(accountId, env.id, asCloudConfig(parse(env.configJson)));
    } catch {
      return null;
    }
  }

  /** A Work run's policy with the cloud folder as its only root, for bound threads. */
  workPolicy(base: ThreadPolicySource): ThreadPolicySource {
    return {
      forThread: async (accountId, threadId) => {
        const p = await base.forThread(accountId, threadId);
        const b = this.#binding(accountId, threadId);
        if (!b) return p;
        const roots = [
          {
            path: b.folder,
            access: 'write' as const,
            label: b.folder.split('/').pop() || 'workspace',
          },
        ];
        const out: ThreadPolicy = p
          ? { ...p, roots }
          : {
              approvalPolicy: null,
              profileId: null,
              roots,
              permissionMode: null,
              autoAcceptEdits: false,
            };
        return out;
      },
    };
  }

  /**
   * The Hub's file tools act on the Hub's own disk, never on a cloud environment's: in a cloud
   * thread (a Code session in a cloud environment, a Work run bound to one) they are denied, so
   * the tool runtime hides them, and files are read and changed with commands there. Wraps the
   * agents area's rule source (the gate's `useAgentPolicy`).
   */
  toolRules(base: AgentRuleSource | null): AgentRuleSource {
    return {
      forThread: async (accountId, threadId) => {
        const own = base ? await base.forThread(accountId, threadId) : null;
        if (!this.isCloudThread(accountId, threadId)) return own;
        const rule: PolicyRule = {
          id: `cloud-hub-files:${threadId}`,
          label: "Cloud environment: the file tools would act on the Hub's disk",
          priority: 0,
          scope: { kind: 'session', ref: threadId },
          match: { tool: [...HUB_FILE_TOOLS] },
          effect: 'deny',
        };
        return { rules: [...(own?.rules ?? []), rule], commandRules: own?.commandRules ?? [] };
      },
    };
  }

  /** A Code session in a cloud environment, or a Work run bound to one. */
  isCloudThread(accountId: string, threadId: string): boolean {
    if (this.#binding(accountId, threadId)) return true;
    return !!this.#o.db.raw
      .prepare(
        `SELECT 1 FROM code_session s JOIN environment e ON e.id = s.environment_id
         WHERE s.thread_id = ? AND s.account_id = ? AND e.kind = 'cloud'`,
      )
      .get(threadId, accountId);
  }

  /** The Environment block of a bound Work run's turns. */
  readonly extension: TurnExtension = {
    forTurn: (input) => {
      if (input.mode !== 'work') return Promise.resolve(null);
      const b = this.#binding(input.accountId, input.threadId);
      if (!b) return Promise.resolve(null);
      let label = 'cloud';
      try {
        label = this.#envRow(input.accountId, b.environmentId).label;
      } catch {
        // removed meanwhile
      }
      return Promise.resolve({
        context: [
          {
            label: 'Environment',
            trusted: true,
            text: [
              `Working folder: ${b.folder}`,
              `Runs on: ${this.provider.describe(label, this.#configOf(input.accountId, b.environmentId))}`,
              'Approvals: every command still passes the policy gate on the Hub first.',
            ].join('\n'),
          },
        ],
      });
    },
  };

  // ---- internals -----------------------------------------------------------------------------

  #sandbox(accountId: string, envId: string, cfg: CloudConfig): CloudSandbox {
    let s = this.#sandboxes.get(envId);
    if (!s) {
      s = new CloudSandbox({
        environmentId: envId,
        runnerEnvironmentId: cfg.runnerEnvironmentId,
        client: () => this.client(),
        lease: async (threadId) => {
          const r = await this.lease(accountId, envId, threadId);
          return { id: r.id, runnerRunId: r.runnerRunId };
        },
        onCap: (lease, err) => this.capped(lease, err),
        network: () => this.#o.setting('cloud.runner.unrestrictedNetwork'),
        onProcess: (lease, processId) => {
          this.#processes.set(processId, lease.id);
          if (this.#processes.size > 5_000)
            this.#processes.delete(this.#processes.keys().next().value!);
        },
      });
      this.#sandboxes.set(envId, s);
    }
    return s;
  }

  /** novad-like operations over the runner, for the M6 environment routes (FR-078). */
  #connection(accountId: string, envId: string, cfg: CloudConfig): EnvHelperConnection {
    const runOf = async (processId: string): Promise<string> => {
      const leaseId = this.#processes.get(processId);
      const row = leaseId ? this.#rowById(leaseId) : null;
      if (row) return row.runnerRunId;
      // Not seen by this Hub process: look through the environment's runs.
      const client = await this.client();
      for (const r of this.#rows('environment_id = ? ORDER BY created_at DESC LIMIT 50', [envId])) {
        const ps = await client.processes(r.runnerRunId).catch(() => []);
        if (ps.some((p) => p.id === processId)) {
          this.#processes.set(processId, r.id);
          return r.runnerRunId;
        }
      }
      throw new NovaError('not_found', 'no such process');
    };
    const conn: EnvHelperConnection = {
      closed: false,
      hello: async () => {
        const h = await (await this.client()).health();
        return {
          version: h.version,
          platform: 'linux',
          arch: null,
          verified: true,
          home: '/workspace',
        };
      },
      stat: async (path) => {
        const st = await (await this.client()).stat(cfg.runnerEnvironmentId, path);
        if (!st) return null;
        return { kind: st.kind === 'file' || st.kind === 'dir' ? st.kind : 'other' };
      },
      spawn: async (spec) => {
        const lease = await this.lease(accountId, envId, null);
        const p = await (
          await this.client()
        ).exec(lease.runnerRunId, {
          cmd: spec.cmd,
          cwd: spec.cwd,
          ...(spec.env ? { env: spec.env } : {}),
          ...(spec.tag ? { tag: spec.tag } : {}),
        });
        this.#processes.set(p.id, lease.id);
        return { id: p.id };
      },
      read: async (id, offset, waitMs) =>
        (await this.client()).read(await runOf(id), id, offset, waitMs),
      write: async (id, input) => (await this.client()).input(await runOf(id), id, input),
      processes: async () => {
        const client = await this.client();
        const out: EnvHelperProcess[] = [];
        for (const r of this.#rows(
          "environment_id = ? AND status IN ('active', 'capped') ORDER BY created_at DESC LIMIT 50",
          [envId],
        )) {
          const session = r.threadId ? this.#sessionOf(r.threadId) : null;
          for (const p of await client.processes(r.runnerRunId).catch(() => [])) {
            this.#processes.set(p.id, r.id);
            out.push({
              id: p.id,
              cmd: p.cmd,
              cwd: p.cwd,
              tag: `${session ?? r.threadId ?? 'hub'}:${p.tag ?? ''}`,
              running: p.running,
              exitCode: p.exitCode,
              outputBytes: p.outputBytes,
              startedAt: p.startedAt,
            });
          }
        }
        return out;
      },
      wslDistros: () =>
        Promise.reject(
          new NovaError('capability_missing', 'cloud environments have no WSL', {
            details: { reason: 'not_windows' },
          }),
        ),
      wsl: () =>
        Promise.reject(
          new NovaError('capability_missing', 'cloud environments have no WSL', {
            details: { reason: 'not_windows' },
          }),
        ),
      close: () => Promise.resolve(),
    };
    return conn;
  }

  #configOf(accountId: string, envId: string): Record<string, unknown> {
    try {
      return parse(this.#envRow(accountId, envId).configJson);
    } catch {
      return {};
    }
  }

  #envRow(accountId: string, id: string): EnvRow {
    const r = this.#o.db.raw
      .prepare(
        `SELECT id, account_id AS accountId, kind, label, config_json AS configJson, status,
           status_detail AS statusDetail, created_at AS createdAt, updated_at AS updatedAt
         FROM environment WHERE id = ? AND account_id = ?`,
      )
      .get(id, accountId) as EnvRow | undefined;
    if (!r || r.kind !== 'cloud') throw new NovaError('not_found', 'cloud environment not found');
    return r;
  }

  #envView(r: EnvRow, remote: RunnerEnvironment | null): CloudEnvironmentView {
    const cfg = asCloudConfig(parse(r.configJson));
    const sessions = (
      this.#o.db.raw
        .prepare(
          "SELECT COUNT(*) AS n FROM code_session WHERE environment_id = ? AND status = 'active'",
        )
        .get(r.id) as { n: number }
    ).n;
    return {
      id: r.id,
      label: r.label,
      status: r.status,
      detail: r.statusDetail,
      connection: connectionView(cfg),
      runner: remote
        ? {
            status: remote.status,
            detail: remote.detail,
            substrate: remote.substrate,
            repos: remote.connection.repos,
            caches: remote.connection.caches,
            setup: { ...remote.setup, log: defaultRedactor.redactString(remote.setup.log) },
            usage: remote.usage,
            caps: remote.caps,
            runs: remote.runs,
            processes: remote.processes,
            readyAt: remote.readyAt,
          }
        : null,
      sessions,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  #binding(
    accountId: string,
    threadId: string,
  ): { environmentId: string; folder: string; workRunId: string } | null {
    return (
      (this.#o.db.raw
        .prepare(
          'SELECT environment_id AS environmentId, folder, work_run_id AS workRunId FROM cloud_work_binding WHERE thread_id = ? AND account_id = ?',
        )
        .get(threadId, accountId) as
        { environmentId: string; folder: string; workRunId: string } | undefined) ?? null
    );
  }

  #isCodeThread(threadId: string): boolean {
    return !!this.#o.db.raw.prepare('SELECT 1 FROM code_session WHERE thread_id = ?').get(threadId);
  }

  #sessionOf(threadId: string): string | null {
    return (
      (
        this.#o.db.raw.prepare('SELECT id FROM code_session WHERE thread_id = ?').get(threadId) as
          { id: string } | undefined
      )?.id ?? null
    );
  }

  #rows(where: string, args: (string | number | null)[]): RunRow[] {
    return this.#o.db.raw
      .prepare(`SELECT ${RUN_COLUMNS} FROM cloud_run WHERE ${where}`)
      .all(...args) as unknown as RunRow[];
  }

  #rowById(id: string): RunRow | null {
    return this.#rows('id = ?', [id])[0] ?? null;
  }

  /** A run's view, with the Code session its thread belongs to (M7: a run page finds its own). */
  #view(r: RunRow): CloudRunView {
    let sessionId: string | null = null;
    if (r.kind === 'code' && r.threadId) {
      const s = this.#o.db.raw
        .prepare('SELECT id FROM code_session WHERE thread_id = ? AND account_id = ?')
        .get(r.threadId, r.accountId) as { id: string } | undefined;
      sessionId = s?.id ?? null;
    }
    return runView(r, sessionId);
  }

  #own(accountId: string, id: string): RunRow {
    const r = this.#rowById(id);
    if (!r || r.accountId !== accountId) throw new NovaError('not_found', 'cloud run not found');
    return r;
  }

  #snapshotRow(accountId: string, id: string): SnapshotRow {
    const r = this.#o.db.raw
      .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM cloud_snapshot WHERE id = ? AND account_id = ?`)
      .get(id, accountId) as SnapshotRow | undefined;
    if (!r) throw new NovaError('not_found', 'snapshot not found');
    return r;
  }

  async #updateRow(id: string, set: Record<string, string | number | null>): Promise<void> {
    const cols = Object.keys(set);
    if (!cols.length) return;
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare(
          `UPDATE cloud_run SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        )
        .run(...cols.map((c) => set[c] ?? null), this.#iso(), id);
    });
  }

  async #audit(
    accountId: string,
    kind: 'settings' | 'code' | 'run',
    action: string,
    resource: string,
    detail: Record<string, unknown>,
    actor: 'user' | 'system' = 'user',
  ): Promise<void> {
    try {
      await this.#o.audit?.append({
        accountId,
        actor,
        kind,
        action,
        resource,
        result: 'ok',
        detail,
      });
    } catch (err) {
      this.#log.warn('cloud runner audit failed', { err, action });
    }
  }

  async #emit(
    accountId: string,
    name: string,
    payload: Record<string, unknown>,
    threadId?: string | null,
  ): Promise<void> {
    try {
      await this.#o.events.emit({
        name,
        actor: 'system',
        accountId,
        ...(threadId ? { correlation: { threadId } } : {}),
        payload,
      });
    } catch (err) {
      this.#log.warn('could not announce a cloud runner event', { err, name });
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

function parse(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function envHealth(env: RunnerEnvironment): { status: EnvironmentView['status']; detail: string } {
  switch (env.status) {
    case 'ready':
      return {
        status: 'ok',
        detail: `cloud runner (${env.substrate ?? 'sandbox'}); ${env.connection.repos.length} repositor${env.connection.repos.length === 1 ? 'y' : 'ies'} ready`,
      };
    case 'provisioning':
      return { status: 'degraded', detail: `preparing: ${env.detail ?? 'cloning'}` };
    case 'failed':
      return { status: 'down', detail: env.detail ?? 'the environment failed on the runner' };
    case 'deleting':
      return { status: 'down', detail: 'the environment is being deleted on the runner' };
  }
}

function connectionView(c: CloudConfig): CloudConnectionView {
  return {
    kind: 'cloud',
    runnerEnvironmentId: c.runnerEnvironmentId,
    repoUrls: c.repoUrls,
    setupScript: c.setupScript,
    baseImage: c.baseImage,
    caches: c.caches,
    network: c.network,
    diskMb: c.diskMb,
    folder: c.folder ?? '/workspace',
  };
}

function runView(r: RunRow, sessionId: string | null): CloudRunView {
  let warnings: string[];
  try {
    warnings = JSON.parse(r.warningsJson) as string[];
  } catch {
    warnings = [];
  }
  return {
    id: r.id,
    environmentId: r.environmentId,
    threadId: r.threadId,
    kind: r.kind,
    workRunId: r.workRunId,
    sessionId,
    status: r.status,
    reason: r.reason,
    caps: { cpuSeconds: r.cpuCapS, wallSeconds: r.wallCapS },
    usage: { cpuSeconds: r.cpuUsedS, wallSeconds: r.wallUsedS, commands: r.commands },
    warnings,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    endedAt: r.endedAt,
  };
}

function snapshotView(s: SnapshotRow): CloudSnapshotView {
  return {
    id: s.id,
    environmentId: s.environmentId,
    label: s.label,
    reason: s.reason,
    sizeBytes: s.sizeBytes,
    createdAt: s.createdAt,
    restoredAt: s.restoredAt,
  };
}
