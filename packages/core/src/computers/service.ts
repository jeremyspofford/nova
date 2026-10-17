// Computers (FR-080, docs/11 §1-§2, docs/06 `computer`): the ComputerProvider the agents,
// browser and screen areas ask by id. Each agent has one persistent computer of its own,
// created on first use (`forAgent`): a sandbox on the Hub (`local_container`, the default) or a
// cloud computer from the cloud runner (the mock runner in M6), per `computers.agentComputer`.
// A `local_host` computer is a connected device served by the devices area (late-bound).
// Browser and screen controllers come from their areas through late-bound factories.
//
// The agent's computer is also the sandbox of its turns: `sandboxRouter` wraps the Hub's
// sandbox so exec tools in an agent's threads run on the agent's computer (its home folder as
// the root and HOME, network under the agent's egress scope), and `threadPolicy` gives those
// threads the computer's folder as their root, so file tools work on the same files. No new
// tool names: exec.* and fs.* pass the policy gate as always (docs/12 §2).
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NovaError, uuidv7, type ComputerSnapshotView, type ComputerView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { ThreadPolicySource } from '../runtime/types.ts';
import type {
  AuditSink,
  ExecRequest,
  ExecResult,
  SandboxClient,
  ToolRoot,
} from '../tools/types.ts';
import type { SandboxExecRequest } from '../tools/sandbox-process.ts';
import { MockCloudRunner, type CloudRunner } from './cloud.ts';
import { DirComputer, type ComputerHost } from './computer.ts';
import type {
  BrowserController,
  Computer,
  ComputerKind,
  ComputerProvider,
  ComputerStatus,
  ScreenController,
} from './types.ts';

/** Connected devices' computers (`novad`, the devices area). */
export interface LocalHostComputers {
  /** The device's computer, or null while it is not connected. */
  open(input: {
    accountId: string;
    computerId: string;
    deviceId: string;
  }): Promise<Computer | null>;
}

export type BrowserFactory = (
  computer: Computer & {
    readonly browserProfileDir?: string;
  },
) => Promise<BrowserController | null>;
export type ScreenFactory = (computer: Computer) => Promise<ScreenController | null>;

export interface ComputerServiceOptions {
  db: NovaDatabase;
  dataDir: string;
  /** The local sandbox substrate (with the egress proxy wired in). */
  sandbox: () => SandboxClient;
  events?: EventSink;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  /** `computers.agentComputer`. */
  agentComputer?: () => Promise<'local_container' | 'cloud'>;
  /** `computers.limits`. */
  limits?: () => Promise<{ wallClockSeconds: number }>;
  /** The cloud runner; the mock runner over <dataDir>/cloud-mock by default. */
  cloud?: CloudRunner;
}

interface Row {
  id: string;
  account_id: string;
  kind: ComputerKind;
  agent_id: string | null;
  provider: string | null;
  base_image: string | null;
  state: ComputerStatus['state'];
  device_id: string | null;
  snapshot_blob_path: string | null;
  spec_json: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function providerOf(sb: SandboxClient): string {
  switch (sb.substrate) {
    case 'os_sandbox':
      return 'bwrap';
    case 'micro_vm':
      return 'micro_vm';
    case 'container':
      return 'container';
    default:
      return 'none';
  }
}

export class ComputerService implements ComputerProvider {
  readonly #o: ComputerServiceOptions;
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #cloud: CloudRunner;
  readonly #open = new Map<string, Computer>();
  readonly #creating = new Map<string, Promise<Computer>>();
  /** Exec sessions the turn router started, per computer. */
  readonly #sessions = new Map<string, Set<string>>();
  #router: SandboxClient | null = null;
  #browser: BrowserFactory | null = null;
  #screen: ScreenFactory | null = null;
  #localHost: LocalHostComputers | null = null;
  #agentOf: ((accountId: string, threadId: string) => Promise<string | null>) | null = null;
  readonly #host: ComputerHost;

  constructor(opts: ComputerServiceOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
    this.#cloud =
      opts.cloud ??
      new MockCloudRunner({ dir: join(opts.dataDir, 'cloud-mock'), sandbox: opts.sandbox });
    this.#host = {
      setState: (id, to) => this.#setState(id, to),
      state: (id) => this.#row(id)?.state ?? 'stopped',
      touch: (id) => {
        void this.#db
          .transaction(() => {
            this.#db.raw
              .prepare('UPDATE computer SET last_used_at = ? WHERE id = ?')
              .run(this.#now().toISOString(), id);
          })
          .catch(() => undefined);
      },
      recordSnapshot: (s) => this.#recordSnapshot(s),
      snapshotPath: (computerId, snapshotId) => {
        const r = this.#db.raw
          .prepare('SELECT blob_path FROM computer_snapshot WHERE id = ? AND computer_id = ?')
          .get(snapshotId, computerId) as { blob_path: string } | undefined;
        return r?.blob_path ?? null;
      },
      browser: (c) => (this.#browser ? this.#browser(c) : Promise.resolve(null)),
      screen: (c) => (this.#screen ? this.#screen(c) : Promise.resolve(null)),
      stopSessions: (computerId) => this.#stopSessions(computerId),
      limits: async () => ({
        wallClockMs: ((await this.#o.limits?.())?.wallClockSeconds ?? 300) * 1000,
      }),
      now: () => this.#now(),
    };
    if (opts.audit) this.#host.audit = opts.audit;
  }

  /** After a restart nothing is running: every computer starts stopped. */
  async recover(): Promise<number> {
    return this.#db.transaction(() =>
      Number(
        this.#db.raw
          .prepare("UPDATE computer SET state = 'stopped' WHERE state IN ('running', 'starting')")
          .run().changes,
      ),
    );
  }

  /** Remove the files of computers whose rows are gone (an agent was deleted). */
  sweep(): number {
    let n = 0;
    const known = new Set(
      (this.#db.raw.prepare('SELECT id FROM computer').all() as { id: string }[]).map((r) => r.id),
    );
    for (const dir of [
      join(this.#o.dataDir, 'computers'),
      join(this.#o.dataDir, 'cloud-mock'),
      join(this.#o.dataDir, 'blobs', 'snapshots'),
    ]) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!UUID.test(name) || known.has(name)) continue;
        rmSync(join(dir, name), { recursive: true, force: true });
        n++;
      }
    }
    return n;
  }

  useBrowser(factory: BrowserFactory | null): void {
    this.#browser = factory;
  }

  useScreen(factory: ScreenFactory | null): void {
    this.#screen = factory;
  }

  useLocalHost(provider: LocalHostComputers | null): void {
    this.#localHost = provider;
  }

  /** Which agent a thread belongs to; by default read from `agent_thread` (the agents area). */
  useAgentOf(fn: ((accountId: string, threadId: string) => Promise<string | null>) | null): void {
    this.#agentOf = fn;
  }

  async agentOfThread(accountId: string, threadId: string): Promise<string | null> {
    if (this.#agentOf) return this.#agentOf(accountId, threadId);
    try {
      const r = this.#db.raw
        .prepare('SELECT agent_id FROM agent_thread WHERE thread_id = ? AND account_id = ?')
        .get(threadId, accountId) as { agent_id: string } | undefined;
      return r?.agent_id ?? null;
    } catch {
      return null;
    }
  }

  #row(id: string): Row | undefined {
    return this.#db.raw.prepare('SELECT * FROM computer WHERE id = ?').get(id) as Row | undefined;
  }

  #owned(accountId: string, id: string): Row {
    const row = this.#db.raw
      .prepare('SELECT * FROM computer WHERE id = ? AND account_id = ?')
      .get(id, accountId) as Row | undefined;
    if (!row) throw new NovaError('not_found', 'no such computer');
    return row;
  }

  async #setState(id: string, to: ComputerStatus['state']): Promise<void> {
    const row = this.#row(id);
    if (!row || row.state === to) return;
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare('UPDATE computer SET state = ?, updated_at = ? WHERE id = ?')
        .run(to, this.#now().toISOString(), id);
    });
    await this.#emit(row.account_id, 'computer.state.changed', {
      computerId: id,
      from: row.state,
      to,
    });
  }

  async #recordSnapshot(s: {
    computerId: string;
    id: string;
    label: string | null;
    path: string;
    sizeBytes: number;
    createdAt: string;
  }): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO computer_snapshot (id, computer_id, label, blob_path, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(s.id, s.computerId, s.label, s.path, s.sizeBytes, s.createdAt);
      this.#db.raw
        .prepare('UPDATE computer SET snapshot_blob_path = ?, updated_at = ? WHERE id = ?')
        .run(s.path, s.createdAt, s.computerId);
    });
    const row = this.#row(s.computerId);
    if (row)
      await this.#emit(row.account_id, 'computer.snapshot.created', {
        computerId: s.computerId,
        snapshotId: s.id,
        label: s.label,
      });
  }

  async #emit(accountId: string, name: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.#o.events?.emit({ name, accountId, payload });
    } catch (err) {
      this.#o.log?.warn('computer event failed', { err, name });
    }
  }

  async #audit(
    accountId: string,
    action: string,
    computerId: string,
    actor: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#o.audit?.append({
        accountId,
        actor,
        kind: 'computer',
        action,
        resource: `computer:${computerId}`,
        decision: null,
        result: 'ok',
        detail,
      });
    } catch {
      // The sink reports its own failures.
    }
  }

  #paths(id: string) {
    return {
      root: join(this.#o.dataDir, 'computers', id),
      snapshots: join(this.#o.dataDir, 'blobs', 'snapshots', id),
    };
  }

  async #instance(row: Row): Promise<Computer | null> {
    const hit = this.#open.get(row.id);
    if (hit) return hit;
    let c: Computer | null = null;
    const { root, snapshots } = this.#paths(row.id);
    if (row.kind === 'local_container') {
      mkdirSync(join(this.#o.dataDir, 'computers'), { recursive: true, mode: 0o700 });
      c = new DirComputer({
        id: row.id,
        accountId: row.account_id,
        kind: 'local_container',
        agentId: row.agent_id,
        root,
        snapshotsDir: snapshots,
        sandbox: this.#o.sandbox,
        host: this.#host,
      });
    } else if (row.kind === 'cloud') {
      c = await this.#cloud.open({
        accountId: row.account_id,
        computerId: row.id,
        agentId: row.agent_id,
        snapshotsDir: snapshots,
        host: this.#host,
      });
    } else if (row.device_id && this.#localHost) {
      // A device's computer is served by the devices area, and only while it is connected.
      return this.#localHost.open({
        accountId: row.account_id,
        computerId: row.id,
        deviceId: row.device_id,
      });
    }
    if (c) this.#open.set(row.id, c);
    return c;
  }

  async get(accountId: string, computerId: string): Promise<Computer | null> {
    const row = this.#db.raw
      .prepare('SELECT * FROM computer WHERE id = ? AND account_id = ?')
      .get(computerId, accountId) as Row | undefined;
    return row ? this.#instance(row) : null;
  }

  async forAgent(accountId: string, agentId: string): Promise<Computer> {
    const key = `${accountId}|${agentId}`;
    const pending = this.#creating.get(key);
    if (pending) return pending;
    const p = this.#forAgent(accountId, agentId).finally(() => this.#creating.delete(key));
    this.#creating.set(key, p);
    return p;
  }

  async #forAgent(accountId: string, agentId: string): Promise<Computer> {
    let row = this.#db.raw
      .prepare(
        "SELECT * FROM computer WHERE account_id = ? AND agent_id = ? AND kind <> 'local_host'",
      )
      .get(accountId, agentId) as Row | undefined;
    if (!row) {
      const agent = this.#db.raw
        .prepare('SELECT id FROM agent WHERE id = ? AND account_id = ?')
        .get(agentId, accountId);
      if (!agent) throw new NovaError('not_found', 'no such agent');
      const kind = (await this.#o.agentComputer?.()) ?? 'local_container';
      const sb = this.#o.sandbox();
      const id = uuidv7();
      const now = this.#now().toISOString();
      const provider = kind === 'cloud' ? this.#cloud.name : providerOf(sb);
      const image = (sb as { image?: unknown }).image;
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            `INSERT INTO computer (id, account_id, kind, agent_id, provider, base_image, state,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?)`,
          )
          .run(
            id,
            accountId,
            kind,
            agentId,
            provider,
            typeof image === 'string' ? image : null,
            now,
            now,
          );
        // The agent's row names its computer (docs/06 `agent.computer_id`).
        this.#db.raw
          .prepare(
            'UPDATE agent SET computer_id = ? WHERE id = ? AND account_id = ? AND computer_id IS NULL',
          )
          .run(id, agentId, accountId);
      });
      await this.#audit(accountId, 'computer.create', id, 'system', { kind, agentId, provider });
      row = this.#row(id);
      if (!row) throw new NovaError('server_error', 'the computer was not created');
    }
    const c = await this.#instance(row);
    if (!c) throw new NovaError('server_error', 'the computer could not be opened');
    return c;
  }

  /** Register a connected device's computer (the devices area calls this, FR-081). */
  async ensureLocalHost(
    accountId: string,
    input: { deviceId: string; agentId?: string | null },
  ): Promise<ComputerView> {
    const existing = this.#db.raw
      .prepare(
        "SELECT * FROM computer WHERE account_id = ? AND device_id = ? AND kind = 'local_host'",
      )
      .get(accountId, input.deviceId) as Row | undefined;
    if (existing) return this.view(accountId, existing.id);
    const id = uuidv7();
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO computer (id, account_id, kind, agent_id, provider, device_id, state,
             created_at, updated_at)
           VALUES (?, ?, 'local_host', ?, 'novad', ?, 'stopped', ?, ?)`,
        )
        .run(id, accountId, input.agentId ?? null, input.deviceId, now, now);
    });
    await this.#audit(accountId, 'computer.create', id, 'user', {
      kind: 'local_host',
      deviceId: input.deviceId,
    });
    return this.view(accountId, id);
  }

  async view(accountId: string, id: string): Promise<ComputerView> {
    const row = this.#owned(accountId, id);
    const c = await this.#instance(row);
    let status: ComputerStatus;
    if (c) {
      try {
        status = await c.status();
      } catch (err) {
        status = {
          state: 'error',
          substrate: null,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    } else
      status = {
        state: 'stopped',
        substrate: row.kind === 'local_host' ? 'host' : null,
        detail: row.kind === 'local_host' ? 'The device is not connected.' : null,
      };
    const count = this.#db.raw
      .prepare('SELECT COUNT(*) AS n FROM computer_snapshot WHERE computer_id = ?')
      .get(id) as { n: number };
    return {
      id: row.id,
      kind: row.kind,
      agentId: row.agent_id,
      deviceId: row.device_id,
      provider: row.provider,
      state: status.state,
      substrate: status.substrate,
      detail: status.detail,
      baseImage: row.base_image,
      snapshotCount: count.n,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUsedAt: row.last_used_at,
    };
  }

  async list(accountId: string): Promise<ComputerView[]> {
    const rows = this.#db.raw
      .prepare('SELECT id FROM computer WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as { id: string }[];
    const out: ComputerView[] = [];
    for (const r of rows) out.push(await this.view(accountId, r.id));
    return out;
  }

  snapshots(accountId: string, id: string): ComputerSnapshotView[] {
    this.#owned(accountId, id);
    const rows = this.#db.raw
      .prepare(
        'SELECT id, computer_id, label, size_bytes, created_at FROM computer_snapshot WHERE computer_id = ? ORDER BY created_at DESC, id DESC',
      )
      .all(id) as {
      id: string;
      computer_id: string;
      label: string | null;
      size_bytes: number | null;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      computerId: r.computer_id,
      label: r.label,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
    }));
  }

  async #dir(accountId: string, id: string): Promise<DirComputer> {
    const row = this.#owned(accountId, id);
    const c = await this.#instance(row);
    if (!(c instanceof DirComputer))
      throw new NovaError(
        'capability_missing',
        row.kind === 'local_host'
          ? "a connected device's computer is managed on the device"
          : 'this computer cannot do that',
      );
    return c;
  }

  async snapshot(
    accountId: string,
    id: string,
    label: string | null,
    actor = 'user',
  ): Promise<ComputerSnapshotView> {
    const c = await this.#dir(accountId, id);
    const ref = await c.snapshot(label ?? undefined, actor);
    const v = this.snapshots(accountId, id).find((s) => s.id === ref.id);
    if (!v) throw new NovaError('server_error', 'the snapshot was not recorded');
    return v;
  }

  async restore(
    accountId: string,
    id: string,
    snapshotId: string,
    actor = 'user',
  ): Promise<ComputerView> {
    const c = await this.#dir(accountId, id);
    const s = this.snapshots(accountId, id).find((x) => x.id === snapshotId);
    if (!s) throw new NovaError('not_found', 'no such snapshot');
    await this.#stopSessions(id);
    await c.restore({ id: s.id, label: s.label, createdAt: s.createdAt }, actor);
    await this.#emit(accountId, 'computer.restored', { computerId: id, snapshotId });
    return this.view(accountId, id);
  }

  async deleteSnapshot(accountId: string, id: string, snapshotId: string): Promise<boolean> {
    this.#owned(accountId, id);
    const r = this.#db.raw
      .prepare('SELECT blob_path FROM computer_snapshot WHERE id = ? AND computer_id = ?')
      .get(snapshotId, id) as { blob_path: string } | undefined;
    if (!r) return false;
    await this.#db.transaction(() => {
      this.#db.raw.prepare('DELETE FROM computer_snapshot WHERE id = ?').run(snapshotId);
      this.#db.raw
        .prepare(
          'UPDATE computer SET snapshot_blob_path = (SELECT blob_path FROM computer_snapshot WHERE computer_id = ? ORDER BY created_at DESC LIMIT 1) WHERE id = ?',
        )
        .run(id, id);
    });
    rmSync(r.blob_path, { recursive: true, force: true });
    await this.#audit(accountId, 'computer.snapshot.delete', id, 'user', { snapshotId });
    return true;
  }

  async stop(accountId: string, id: string, actor = 'user'): Promise<ComputerView> {
    const row = this.#owned(accountId, id);
    const c = await this.#instance(row);
    if (c instanceof DirComputer) await c.stop(actor);
    else if (c) await c.stop();
    else await this.#setState(id, 'stopped');
    return this.view(accountId, id);
  }

  /** Remove an agent's computer, its files and snapshots (the agent is being deleted). */
  async purgeAgent(accountId: string, agentId: string): Promise<number> {
    const rows = this.#db.raw
      .prepare(
        "SELECT * FROM computer WHERE account_id = ? AND agent_id = ? AND kind <> 'local_host'",
      )
      .all(accountId, agentId) as unknown as Row[];
    for (const row of rows) {
      const c = this.#open.get(row.id);
      if (c) await c.stop().catch(() => undefined);
      await this.#stopSessions(row.id);
      this.#open.delete(row.id);
      const { root, snapshots } = this.#paths(row.id);
      rmSync(root, { recursive: true, force: true });
      rmSync(snapshots, { recursive: true, force: true });
      if (row.kind === 'cloud') await this.#cloud.purge?.(row.id);
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare('UPDATE agent SET computer_id = NULL WHERE computer_id = ?')
          .run(row.id);
        this.#db.raw.prepare('DELETE FROM computer WHERE id = ?').run(row.id);
      });
      await this.#audit(accountId, 'computer.delete', row.id, 'user', { agentId });
    }
    return rows.length;
  }

  /** The roots of an agent's computer (for its threads' policy). */
  async rootsFor(accountId: string, agentId: string): Promise<ToolRoot[]> {
    const c = await this.forAgent(accountId, agentId);
    if (!(c instanceof DirComputer)) return [];
    return c.roots().map((r) => ({ ...r, path: realpathSync(r.path) }));
  }

  /**
   * A ThreadPolicySource for agent threads: the agent computer's folder is their only root, so
   * file tools and commands work on the same files. Other threads are left to other sources.
   */
  threadPolicy(): ThreadPolicySource {
    return {
      forThread: async (accountId, threadId) => {
        const agentId = await this.agentOfThread(accountId, threadId);
        if (!agentId) return null;
        return {
          approvalPolicy: null,
          profileId: null,
          roots: await this.rootsFor(accountId, agentId),
          permissionMode: null,
          autoAcceptEdits: false,
        };
      },
    };
  }

  /**
   * Wrap the Hub's sandbox so exec tools in an agent's threads run on the agent's computer: its
   * home folder is mounted and is HOME, and its network goes through the agent's egress scope.
   * Every other command passes through unchanged.
   */
  sandboxRouter(base: SandboxClient): SandboxClient {
    const router: SandboxClient & { killAll?: () => Promise<void> } = {
      get substrate() {
        return base.substrate;
      },
      available: () => base.available(),
      exec: (req) => this.#routedExec(base, req),
      poll: (sessionId, yieldMs, signal) => base.poll(sessionId, yieldMs, signal),
      write: async (sessionId, input) => {
        await base.write(sessionId, input);
        if (input.signal === 'terminate')
          for (const s of this.#sessions.values()) s.delete(sessionId);
      },
      killTurn: (turnId) => base.killTurn(turnId),
    };
    const killAll = (base as { killAll?: () => Promise<void> }).killAll;
    if (killAll) router.killAll = () => killAll.call(base);
    this.#router = router;
    return router;
  }

  async #routedExec(base: SandboxClient, req: ExecRequest): Promise<ExecResult> {
    const owner = (req as { owner?: { accountId?: unknown; threadId?: unknown } }).owner;
    const accountId = typeof owner?.accountId === 'string' ? owner.accountId : null;
    const threadId = typeof owner?.threadId === 'string' ? owner.threadId : null;
    const agentId = accountId && threadId ? await this.agentOfThread(accountId, threadId) : null;
    if (!accountId || !agentId) return base.exec(req);
    const c = await this.forAgent(accountId, agentId);
    if (!(c instanceof DirComputer)) return base.exec(req);
    const home = realpathSync(c.home);
    const roots = [...req.roots];
    if (!roots.some((r) => r.path === home))
      roots.unshift({ path: home, access: 'write', label: 'computer' });
    const routed: SandboxExecRequest = {
      ...req,
      roots,
      env: { ...(req.env ?? {}), HOME: home },
      egress: { accountId, threadId, scope: c.egressScope },
    };
    await this.#host.setState(c.id, 'running');
    this.#host.touch(c.id);
    const r = await base.exec(routed);
    if (r.status === 'running') {
      const set = this.#sessions.get(c.id) ?? new Set<string>();
      set.add(r.sessionId);
      this.#sessions.set(c.id, set);
    }
    return r;
  }

  async #stopSessions(computerId: string): Promise<void> {
    const set = this.#sessions.get(computerId);
    if (!set || !this.#router) return;
    this.#sessions.delete(computerId);
    for (const id of set)
      await this.#router.write(id, { signal: 'terminate' }).catch(() => undefined);
  }

  /** Close open computers' sessions (Hub shutdown). */
  async close(): Promise<void> {
    for (const id of [...this.#sessions.keys()]) await this.#stopSessions(id);
    this.#open.clear();
  }
}
