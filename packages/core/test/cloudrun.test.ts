// The Hub side of the cloud runner (FR-108, FR-071, FR-116; contracts/rest-api.md §5; ADR-095):
// the runner client's error mapping and event parsing; registering a runner (the token only in
// the vault, never turned on when its test fails); cloud environments through EnvironmentService;
// commands through the cloud sandbox with live output and reattach; leases with metering, a cap
// reached on the runner recorded and announced through its event stream, and caps raised again;
// snapshots and restore; artifacts copied into the thread; the environment transport (bytes in
// and out); Work runs bound to a cloud environment; removal and reconcile. The runner is the real
// service on 127.0.0.1, sandboxed with bubblewrap where it works, else with a host test double.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, RUNNER_TOKEN_REF, resolveSetting, type SettingKey } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { Logger } from '@nova/telemetry';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  buildRunnerServer,
  newRunnerToken,
  silentLog,
  tokenHash,
  tokenRecord,
  type RunnerServer,
} from '@nova/runner-service';
import { PolicyGate, PolicyStore } from '../src/approvals/index.ts';
import {
  ArtifactService,
  CloudRunService,
  CloudSandbox,
  EnvironmentService,
  ExecSessions,
  HUB_FILE_TOOLS,
  MemoryEventSink,
  RunnerClient,
  parseSse,
  readCapped,
  threadSandboxRouter,
  UnavailableSandbox,
  execTools,
  toNovaError,
  transportWorkspace,
  type AuditRecord,
  type CloudWorkRuns,
  type HookFreeGit,
  type SandboxClient,
} from '../src/index.ts';
import { HostSubstrate } from '../../../services/runner/test/host-substrate.ts';
import { bwrapReason, makeRepo } from '../../../services/runner/test/env.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000c1';
// NOVA_TEST_RUNNER_HOST=1 runs these with the host double even where bubblewrap works.
const realReason = process.env.NOVA_TEST_RUNNER_HOST
  ? 'NOVA_TEST_RUNNER_HOST is set'
  : await bwrapReason();
const MODE = realReason ? 'host test double' : 'bubblewrap';
if (realReason) console.warn(`cloud runner tests use the host double: ${realReason}`);

let dir: string;
let db: NovaDatabase;
let runner: RunnerServer;
let url: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-cloudrun-'));
  mkdirSync(join(dir, 'repos'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  token = newRunnerToken();
  runner = await buildRunnerServer({
    dataDir: join(dir, 'runner'),
    tokens: [tokenRecord(tokenHash(token), 'hub')],
    localRepoRoots: [join(dir, 'repos')],
    log: silentLog,
    limits: { meterIntervalMs: 50, diskIntervalMs: 100 },
    ...(realReason ? { substrate: new HostSubstrate() } : {}),
  });
  url = await runner.app.listen({ host: '127.0.0.1', port: 0 });
});

const services: CloudRunService[] = [];
afterEach(async () => {
  for (const svc of services.splice(0)) await svc.close();
  await runner.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Env {
  svc: CloudRunService;
  envs: EnvironmentService;
  events: MemoryEventSink;
  secrets: MemorySecretStore;
  audit: AuditRecord[];
  values: Record<string, unknown>;
  managed: Record<string, unknown>;
}

function env(opts: { watch?: boolean; now?: () => Date; fetch?: typeof fetch } = {}): Env {
  const events = new MemoryEventSink();
  const secrets = new MemorySecretStore();
  const audit: AuditRecord[] = [];
  const values: Record<string, unknown> = {};
  const managed: Record<string, unknown> = {};
  const setting = <K extends SettingKey>(key: K) =>
    Promise.resolve(resolveSetting(key, { global: values, project: {}, managed }).value);
  const svc = new CloudRunService({
    db,
    events,
    secrets,
    setting,
    writeSetting: (_a, key, value) => {
      if (key in managed) return Promise.reject(new NovaError('policy_denied', 'managed'));
      values[key] = value;
      return Promise.resolve();
    },
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    artifacts: new ArtifactService({ db, events, dataDir: join(dir, 'hub') }),
    watch: opts.watch ?? true,
    watchBackoffMs: 50,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  services.push(svc);
  const envs = new EnvironmentService({
    db,
    events,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    secrets,
    git: { version: () => Promise.resolve('git version 2') } as unknown as HookFreeGit,
  });
  envs.useCloud(svc.provider);
  return { svc, envs, events, secrets, audit, values, managed };
}

async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function readyCloud(e: Env, connection: Record<string, unknown> = {}) {
  makeRepo(join(dir, 'repos'), 'app', { 'README.md': 'hello\n', 'src/a.txt': 'a\n' });
  await e.svc.configure(ACCOUNT, { url, token, enabled: true });
  const created = await e.envs.create(ACCOUNT, {
    kind: 'cloud',
    label: 'app in the cloud',
    connection: { repoUrls: [`file://${join(dir, 'repos', 'app')}`], ...connection },
  });
  await until(
    () => e.envs.check(ACCOUNT, created.id),
    (v) => v.status !== 'degraded',
  );
  return e.envs.get(ACCOUNT, created.id);
}

function exec(
  sandbox: SandboxClient,
  cmd: string,
  threadId: string | null,
  extra: Record<string, unknown> = {},
) {
  return sandbox.exec({
    cmd,
    cwd: '/workspace/app',
    roots: [{ path: '/workspace/app', access: 'write', label: 'app' }],
    network: 'off',
    yieldMs: 10_000,
    signal: AbortSignal.timeout(30_000),
    turnId: 'turn-1',
    ...(threadId ? { owner: { accountId: ACCOUNT, threadId } } : {}),
    ...extra,
  });
}

/** A runner client stand-in for the sandbox's own paths (drops, cancel, caps). */
function fakeClient(script: { reads: (() => Promise<unknown>)[] }) {
  const calls: string[] = [];
  const client = {
    environment: () =>
      Promise.resolve({ status: 'provisioning', detail: 'cloning', substrate: null }),
    exec: (_run: string, body: { cmd: string }) => {
      calls.push(`exec:${body.cmd}`);
      if (body.cmd === 'over')
        return Promise.reject(
          new NovaError('budget_exhausted', 'cap', {
            details: { reason: 'cap_reached', resource: 'cpu' },
          }),
        );
      return Promise.resolve({ id: `p-${calls.length}` });
    },
    read: () => {
      const next = script.reads.shift();
      return next
        ? next()
        : Promise.resolve({ data: '', offset: 0, dropped: 0, running: true, exitCode: null });
    },
    input: (_run: string, id: string, body: { signal?: string }) => {
      calls.push(`input:${id}:${body.signal ?? 'text'}`);
      return Promise.resolve();
    },
    kill: (_run: string, tag: string) => {
      calls.push(`kill:${tag}`);
      return Promise.resolve(1);
    },
  };
  return { client: client as unknown as RunnerClient, calls };
}

describe('cloud sandbox', () => {
  const req = (cmd: string, extra: Record<string, unknown> = {}) => ({
    cmd,
    cwd: '/workspace',
    roots: [{ path: '/workspace', access: 'read' as const, label: 'w' }],
    network: 'allowlist' as const,
    yieldMs: 300,
    signal: AbortSignal.timeout(5_000),
    turnId: 'turn-9',
    ...extra,
  });
  const unreachable = () =>
    Promise.reject(new NovaError('node_unavailable', 'down', { retryable: true }));

  it('reattaches after the runner drops, and says so when it stays away', async () => {
    const f = fakeClient({
      reads: [
        unreachable,
        () => Promise.resolve({ data: 'a', offset: 1, dropped: 3, running: true, exitCode: null }),
        () => Promise.resolve({ data: 'b', offset: 2, dropped: 0, running: false, exitCode: 2 }),
      ],
    });
    const caps: string[] = [];
    const s = new CloudSandbox({
      environmentId: 'e',
      runnerEnvironmentId: 're',
      client: () => Promise.resolve(f.client),
      lease: () => Promise.resolve({ id: 'l', runnerRunId: 'r' }),
      onCap: (_l, err) => Promise.resolve(void caps.push(err.code)),
    });
    expect(await s.available()).toEqual({
      ok: false,
      detail: 'the cloud environment is provisioning: cloning',
    });
    const r = await s.exec(req('make', { yieldMs: 5_000 }));
    expect(r).toEqual({
      status: 'exited',
      exitCode: 2,
      output: '\n[3 bytes of output were dropped]\nab',
    });
    const away = new CloudSandbox({
      environmentId: 'e',
      runnerEnvironmentId: 're',
      client: () =>
        Promise.resolve(
          fakeClient({ reads: [unreachable, unreachable, unreachable, unreachable] }).client,
        ),
      lease: () => Promise.resolve({ id: 'l', runnerRunId: 'r' }),
    });
    const later = await away.exec(req('sleep'));
    expect(later.status).toBe('running');
    expect(later.output).toMatch(/cannot be reached/);
    await expect(s.exec(req('over'))).rejects.toMatchObject({ code: 'budget_exhausted' });
    expect(caps).toEqual(['budget_exhausted']);
    await expect(s.poll('nope', 10, AbortSignal.timeout(100))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(s.write('nope', { text: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('terminates on cancel, takes input and kills a turn there', async () => {
    const f = fakeClient({ reads: [] });
    const s = new CloudSandbox({
      environmentId: 'e',
      runnerEnvironmentId: 're',
      client: () => Promise.resolve(f.client),
      lease: () => Promise.resolve({ id: 'l', runnerRunId: 'r' }),
    });
    const running = await s.exec(req('serve', { yieldMs: 50 }));
    expect(running.status).toBe('running');
    const id = running.status === 'running' ? running.sessionId : '';
    await s.write(id, { text: 'q\n' });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(s.poll(id, 1_000, ctrl.signal)).rejects.toMatchObject({ code: 'cancelled' });
    const other = await s.exec(req('watch', { yieldMs: 50 }));
    expect(other.status).toBe('running');
    await s.killTurn('turn-9');
    await s.killTurn('turn-unknown');
    expect(f.calls).toEqual(
      expect.arrayContaining([`input:${id}:text`, `input:${id}:terminate`, 'kill:turn-9']),
    );
  });
});

describe('runner client', () => {
  it('maps the runner errors to Nova errors', () => {
    expect(toNovaError(401, null)).toMatchObject({
      code: 'auth_missing',
      details: { reason: 'runner_token' },
    });
    expect(
      toNovaError(409, {
        error: { code: 'quota_exceeded', message: 'cap', details: { resource: 'cpu' } },
      }),
    ).toMatchObject({
      code: 'budget_exhausted',
      details: { reason: 'cap_reached', resource: 'cpu' },
    });
    expect(
      toNovaError(503, { error: { code: 'sandbox_unavailable', message: 'none' } }),
    ).toMatchObject({
      code: 'sandbox_unavailable',
      retryable: true,
    });
    expect(toNovaError(502, 'x')).toMatchObject({ code: 'server_error', retryable: true });
    expect(toNovaError(404, { error: { code: 'not_found', message: 'gone' } }).code).toBe(
      'not_found',
    );
    expect(toNovaError(429, { error: { code: 'rate_limited', message: 'slow' } }).retryable).toBe(
      true,
    );
  });

  it('parses server-sent events and skips keepalives', () => {
    expect(parseSse('id: 4\nevent: usage\ndata: {"a":1}')).toEqual({
      id: 4,
      event: 'usage',
      data: { a: 1 },
    });
    expect(parseSse(': ping')).toBeNull();
    expect(parseSse('event: x\ndata: not json')).toBeNull();
  });

  it('reports an unreachable runner as retryable and never shows the token', async () => {
    const c = new RunnerClient({ url: 'http://127.0.0.1:1', token, timeoutMs: 2_000 });
    const err = await c.health().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'node_unavailable', retryable: true });
    expect(String((err as Error).message)).not.toContain(token);
  });
});

describe(`cloud runner on the Hub (${MODE})`, { timeout: 30_000 }, () => {
  it('registers a runner: tested first, the token only in the vault', async () => {
    const e = env();
    expect((await e.svc.view()).state).toBe('unconfigured');
    await expect(e.svc.client()).rejects.toMatchObject({
      details: { reason: 'runner_unconfigured' },
    });
    const wrong = await e.svc
      .configure(ACCOUNT, { url, token: newRunnerToken(), enabled: true })
      .catch((err: unknown) => err);
    expect(wrong).toMatchObject({ code: 'validation', details: { reason: 'runner_test_failed' } });
    expect(e.values['cloud.runner.enabled']).toBeUndefined();
    const v = await e.svc.configure(ACCOUNT, { url, token, enabled: true });
    expect(v).toMatchObject({ enabled: true, url, hasToken: true, state: 'ok' });
    expect(JSON.stringify(v)).not.toContain(token);
    expect(e.values['cloud.runner.token']).toBe(RUNNER_TOKEN_REF);
    expect(await e.secrets.get(RUNNER_TOKEN_REF)).toBe(token);
    expect(JSON.stringify(e.audit)).not.toContain(token);
    expect(JSON.stringify(e.events.events)).not.toContain(token);
    expect(e.audit.map((a) => a.action)).toContain('cloud.runner.change');
    expect((await e.svc.test()).ok).toBe(true);
    await e.svc.setEnabled(ACCOUNT, false);
    await expect(e.svc.client()).rejects.toMatchObject({ details: { reason: 'runner_disabled' } });
    await e.svc.setEnabled(ACCOUNT, true);
    await e.svc.forget(ACCOUNT);
    expect(await e.secrets.get(RUNNER_TOKEN_REF)).toBeNull();
    expect((await e.svc.view()).state).toBe('unconfigured');
    await expect(e.svc.setEnabled(ACCOUNT, true)).rejects.toMatchObject({
      details: { reason: 'runner_unconfigured' },
    });
    await e.svc.close();
  });

  it('runs a command in a cloud environment with live output, and reattaches', async () => {
    const e = env();
    const saved = await readyCloud(e);
    // Not isolated for the mode checks: Bypass is never offered on the runner (docs/10 §12).
    expect(saved).toMatchObject({ kind: 'cloud', status: 'ok', isolated: false });
    expect(saved.connection).toMatchObject({ kind: 'cloud', folder: '/workspace' });
    expect(e.envs.describe(ACCOUNT, saved.id)).toMatch(/cloud runner/);
    const cloud = await e.svc.environment(ACCOUNT, saved.id);
    expect(cloud.runner).toMatchObject({
      status: 'ready',
      repos: [{ name: 'app', path: '/workspace/app' }],
    });
    expect(await e.envs.checkRemoteFolder(ACCOUNT, saved.id, '/workspace/app')).toBe(
      '/workspace/app',
    );
    await expect(
      e.envs.checkRemoteFolder(ACCOUNT, saved.id, '/workspace/none'),
    ).rejects.toMatchObject({
      details: { reason: 'missing' },
    });
    const sandbox = e.envs.sandboxFor(ACCOUNT, saved.id)!;
    expect(sandbox.substrate).toBe('cloud');
    expect((await sandbox.available()).ok).toBe(true);
    const chunks: string[] = [];
    const r = await exec(sandbox, 'cat README.md; echo two', 'thread-1', {
      onOutput: (c: string) => chunks.push(c),
    });
    expect(r).toEqual({ status: 'exited', exitCode: 0, output: 'hello\ntwo\n' });
    expect(chunks.join('')).toBe('hello\ntwo\n');
    // A long command becomes a session that is polled later (reattach by offset).
    const long = await exec(sandbox, 'echo start; sleep 0.5; echo end', 'thread-1', {
      yieldMs: 100,
    });
    expect(long.status).toBe('running');
    const id = long.status === 'running' ? long.sessionId : '';
    const done = await sandbox.poll(id, 10_000, AbortSignal.timeout(20_000));
    expect(done).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(`${long.output}${done.output}`).toBe('start\nend\n');
    const runs = await e.svc.runs(ACCOUNT, { threadId: 'thread-1' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'work', status: 'active', threadId: 'thread-1' });
    const fresh = await until(
      () => e.svc.run(ACCOUNT, runs[0]!.id),
      (x) => x.usage.commands === 2,
    );
    expect(fresh.usage.wallSeconds).toBeGreaterThan(0);
    // The M6 environment routes see the runner's processes (FR-078).
    const processes = await e.envs.processes(ACCOUNT, saved.id);
    expect(processes.map((p) => p.cmd)).toContain('cat README.md; echo two');
    const out = await e.envs.output(ACCOUNT, saved.id, processes[0]!.id, 0);
    expect(out.running).toBe(false);
    expect(e.events.events.map((x) => x.name)).toContain('cloud.run.started');
    await e.svc.close();
  });

  it('stops at a cap the runner enforces, records it, and goes on after the caps are raised', async () => {
    const e = env();
    const saved = await readyCloud(e);
    const sandbox = e.envs.sandboxFor(ACCOUNT, saved.id)!;
    await exec(sandbox, 'true', 'thread-cap');
    const lease = (await e.svc.runs(ACCOUNT, { threadId: 'thread-cap' }))[0]!;
    const row = db.raw
      .prepare('SELECT runner_run_id AS r FROM cloud_run WHERE id = ?')
      .get(lease.id) as { r: string };
    // Shrink the lease's wall time on the runner itself (the Hub's settings allow at least 60 s).
    await new RunnerClient({ url, token }).updateRun(row.r, { wallSeconds: 1 });
    const r = await exec(sandbox, 'sleep 5', 'thread-cap');
    expect(r.status).toBe('exited');
    const capped = await until(
      () => e.svc.run(ACCOUNT, lease.id),
      (x) => x.status === 'capped',
    );
    expect(capped.reason).toBe('wall');
    await until(
      () => e.events.events.map((x) => x.name),
      (n) => n.includes('cloud.run.capped'),
    );
    expect(e.audit.map((a) => a.action)).toContain('cloud.run.capped');
    await expect(exec(sandbox, 'true', 'thread-cap')).rejects.toMatchObject({
      code: 'budget_exhausted',
      details: { reason: 'cap_reached' },
    });
    const raised = await e.svc.setCaps(ACCOUNT, lease.id, { wallSeconds: 600 });
    expect(raised).toMatchObject({ status: 'active', caps: { wallSeconds: 600 } });
    expect((await exec(sandbox, 'echo again', 'thread-cap')).output).toBe('again\n');
    const cancelled = await e.svc.cancel(ACCOUNT, lease.id);
    expect(cancelled.status).toBe('cancelled');
    await e.svc.close();
  });

  it('snapshots and restores, imports an artifact, and runs Git through the transport', async () => {
    const e = env({ watch: false });
    const saved = await readyCloud(e);
    const sandbox = e.envs.sandboxFor(ACCOUNT, saved.id)!;
    const snap = await e.svc.snapshot(ACCOUNT, saved.id, 'clean', 'manual');
    expect(snap).toMatchObject({ label: 'clean', reason: 'manual' });
    await exec(sandbox, 'echo changed > README.md', 'thread-s');
    await e.svc.restore(ACCOUNT, snap.id, true);
    expect((await exec(sandbox, 'cat README.md', 'thread-s')).output).toBe('hello\n');
    const snaps = e.svc.snapshots(ACCOUNT, saved.id);
    expect(snaps.map((s) => s.reason).sort()).toEqual(['before_restore', 'manual']);
    await e.svc.deleteSnapshot(ACCOUNT, snap.id);
    expect(e.svc.snapshots(ACCOUNT, saved.id)).toHaveLength(1);
    // Artifacts land in the thread's artifacts.
    const iso = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES ('thread-s', ?, 'work', 'idle', ?, ?)",
      )
      .run(ACCOUNT, iso, iso);
    await exec(sandbox, 'printf "report\\n" > report.txt', 'thread-s');
    const lease = (await e.svc.runs(ACCOUNT, { threadId: 'thread-s' }))[0]!;
    const art = await e.svc.collectArtifact(ACCOUNT, lease.id, {
      path: '/workspace/app/report.txt',
    });
    expect(art).toMatchObject({ kind: 'file', title: 'report.txt', threadId: 'thread-s' });
    // The transport: bytes in and out, Git, Nova's state folder.
    const t = await e.svc.transportFor(ACCOUNT, saved.id);
    const ws = transportWorkspace(t!);
    expect(await ws.stateDir()).toBe('/nova');
    const bin = Buffer.from([0, 255, 1, 10]);
    await ws.fs.writeFile('/nova/x.bin', bin);
    expect(await ws.fs.readFile('/nova/x.bin')).toEqual(bin);
    const status = await ws.git.run(['status', '--porcelain'], { cwd: '/workspace/app' });
    expect(status.stdout.toString()).toContain('report.txt');
    expect(await e.svc.transportFor(ACCOUNT, 'nope')).toBeNull();
    // The transport's calls count against the environment's own lease.
    expect(
      (await e.svc.runs(ACCOUNT, { environmentId: saved.id })).some((r) => r.kind === 'system'),
    ).toBe(true);
    await e.svc.close();
  });

  it('starts a Work run bound to the cloud environment, snapshot first', async () => {
    const e = env({ watch: false });
    const saved = await readyCloud(e, { folder: '/workspace/app' });
    const calls: string[] = [];
    const runs: CloudWorkRuns = {
      create: (input) => {
        calls.push(`create:${input.objective}`);
        return Promise.resolve({ id: 'run-1', threadId: 'work-thread' });
      },
      start: (_a, id) => {
        calls.push(`start:${id}`);
        // The binding exists before the first turn.
        expect(e.svc.bindingFor(ACCOUNT, 'work-thread')).toMatchObject({ environmentId: saved.id });
        return Promise.resolve(null);
      },
    };
    e.svc.useRuns(runs);
    const started = await e.svc.startWork(ACCOUNT, {
      environmentId: saved.id,
      objective: 'build it',
      caps: { cpuSeconds: 120 },
    });
    expect(calls).toEqual(['create:build it', 'start:run-1']);
    expect(started).toMatchObject({
      runId: 'run-1',
      threadId: 'work-thread',
      cloudRun: { kind: 'work', workRunId: 'run-1', sessionId: null, caps: { cpuSeconds: 120 } },
    });
    expect(started.snapshot).toMatchObject({ reason: 'run_start' });
    const sandbox = e.svc.sandboxForThread(ACCOUNT, 'work-thread')!;
    expect((await exec(sandbox, 'pwd', 'work-thread')).output).toMatch(/app\n$/);
    expect(e.svc.sandboxForThread(ACCOUNT, 'other')).toBeNull();
    const policy = await e.svc
      .workPolicy({ forThread: () => Promise.resolve(null) })
      .forThread(ACCOUNT, 'work-thread');
    expect(policy?.roots).toEqual([{ path: '/workspace/app', access: 'write', label: 'app' }]);
    const ext = await e.svc.extension.forTurn({
      accountId: ACCOUNT,
      threadId: 'work-thread',
      turnId: 't',
      mode: 'work',
      trigger: 'user',
      projectId: null,
    });
    expect(ext?.context?.[0]?.text).toMatch(/Working folder: \/workspace\/app/);
    expect(await e.svc.finishThread(ACCOUNT, 'work-thread')).toBe(1);
    await expect(
      e.svc.startWork(ACCOUNT, { environmentId: 'missing', objective: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await e.svc.close();
  });

  it('removes a cloud environment from the runner and reconciles leftovers', async () => {
    // Leftovers younger than the grace period are kept (a creation another call may be making).
    const e = env({ watch: false, now: () => new Date(Date.now() + 11 * 60_000) });
    const saved = await readyCloud(e);
    await exec(e.envs.sandboxFor(ACCOUNT, saved.id)!, 'true', 'thread-r');
    const client = new RunnerClient({ url, token });
    const orphan = await client.createEnvironment({ repoUrls: [] });
    await e.envs.remove(ACCOUNT, saved.id);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM cloud_run').get()).toEqual({ n: 0 });
    expect(e.audit.map((a) => a.action)).toContain('cloud.environment.remove');
    expect((await client.environments()).map((x) => x.id)).toEqual([orphan.id]);
    expect(await e.svc.reconcile()).toBe(1);
    expect(await client.environments()).toEqual([]);
    // Without the runner wired, a cloud environment fails closed.
    const bare = new EnvironmentService({
      db,
      events: e.events,
      audit: { append: () => Promise.resolve() },
      secrets: e.secrets,
      git: { version: () => Promise.resolve(null) } as unknown as HookFreeGit,
    });
    await expect(
      bare.create(ACCOUNT, { kind: 'cloud', label: 'x', connection: { repoUrls: [] } }),
    ).rejects.toMatchObject({ details: { reason: 'no_cloud_runner' } });
    await e.svc.close();
  });

  it('refuses a disk cap above the configured one and a bad connection', async () => {
    const e = env({ watch: false });
    await e.svc.configure(ACCOUNT, { url, token, enabled: true });
    await expect(
      e.envs.create(ACCOUNT, { kind: 'cloud', label: 'x', connection: { diskMb: 10 ** 6 } }),
    ).rejects.toMatchObject({ details: { reason: 'over_cap' } });
    await expect(
      e.envs.create(ACCOUNT, {
        kind: 'cloud',
        label: 'x',
        connection: { repoUrls: ['ssh://h/x'] },
      }),
    ).rejects.toThrow();
    await e.svc.close();
  });
});

// ---- security review fixes (M7 review: findings 1, 4, 5, 15 and the Hub hardening notes) ------

describe(`cloud runner security (${MODE})`, { timeout: 30_000 }, () => {
  const sent = (network: 'off' | 'allowlist' | 'limited', allowed: boolean) => {
    const bodies: { network?: string }[] = [];
    const client = {
      exec: (_r: string, body: { network?: string }) => {
        bodies.push(body);
        return Promise.resolve({ id: 'p1' });
      },
      read: () => Promise.resolve({ data: '', offset: 0, dropped: 0, running: false, exitCode: 0 }),
    };
    const s = new CloudSandbox({
      environmentId: 'e',
      runnerEnvironmentId: 're',
      client: () => Promise.resolve(client as unknown as RunnerClient),
      lease: () => Promise.resolve({ id: 'l', runnerRunId: 'r' }),
      network: () => Promise.resolve(allowed),
    });
    return s
      .exec({
        cmd: 'curl https://attacker.example',
        cwd: '/workspace',
        roots: [{ path: '/workspace', access: 'write', label: 'w' }],
        network,
        yieldMs: 1_000,
        signal: AbortSignal.timeout(5_000),
      })
      .then(() => bodies[0]?.network);
  };

  it('finding 1: never gives cloud commands network unless the owner turned it on', async () => {
    // Probe cloud-sandbox-probe: allowlist and limited used to become `on`.
    expect([
      await sent('off', false),
      await sent('allowlist', false),
      await sent('limited', false),
    ]).toEqual(['off', 'off', 'off']);
    expect([await sent('off', true), await sent('allowlist', true)]).toEqual(['off', 'on']);
    // A cloud environment with network is refused without the setting.
    const e = env({ watch: false });
    await e.svc.configure(ACCOUNT, { url, token, enabled: true });
    await expect(
      e.envs.create(ACCOUNT, { kind: 'cloud', label: 'x', connection: { network: 'on' } }),
    ).rejects.toMatchObject({ details: { reason: 'cloud_network_off' } });
    e.values['cloud.runner.unrestrictedNetwork'] = true;
    const ok = await e.envs.create(ACCOUNT, {
      kind: 'cloud',
      label: 'y',
      connection: { network: 'setup' },
    });
    expect(ok.kind).toBe('cloud');
  });

  // The host double isolates nothing, so this needs the real sandbox.
  it.skipIf(realReason)(
    'finding 1 end to end: a loopback service of the runner host stays out of reach',
    async () => {
      // Probe egress-e2e: an environment that allows network (made before the fix, or with the
      // setting on earlier) and a Hub turn on `allowlist`.
      const http = await import('node:http');
      const server = http.createServer((_q, r) => r.end('INTERNAL-SECRET-PAGE'));
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      try {
        const e = env({ watch: false });
        e.values['cloud.runner.unrestrictedNetwork'] = true;
        const saved = await readyCloud(e, { network: 'on' });
        // The owner turns it off again: commands lose the network at once.
        e.values['cloud.runner.unrestrictedNetwork'] = false;
        const sandbox = e.envs.sandboxFor(ACCOUNT, saved.id)!;
        const fetchCmd = `perl -MIO::Socket::INET -e 'my $s = IO::Socket::INET->new("127.0.0.1:${port}") or do { print "blocked\\n"; exit 0 }; print $s "GET / HTTP/1.0\\r\\n\\r\\n"; print while <$s>'`;
        const r = await exec(sandbox, fetchCmd, 'thread-net', { network: 'allowlist' });
        expect(r.status === 'exited' && r.output).not.toContain('INTERNAL-SECRET-PAGE');
      } finally {
        server.close();
      }
    },
  );

  it('finding 4: takes only folders under /workspace from the runner, and hides the Hub file tools', async () => {
    // Probe hub-trust-probe: a runner answering a Hub path as the repository folder.
    const victim: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const u = new URL(input instanceof Request ? input.url : input.toString());
      if (
        /^\/v1\/runner\/environments\/[^/]+$/.test(u.pathname) &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        const body = (await res.json()) as { connection: { repos: { path: string }[] } };
        body.connection.repos = [{ ...body.connection.repos[0]!, path: '/home/victim' }];
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return res;
    };
    const e = env({ watch: false, fetch: victim });
    const saved = await readyCloud(e);
    e.svc.useRuns({
      create: () => Promise.resolve({ id: 'run-1', threadId: 'work-thread' }),
      start: () => Promise.resolve(null),
    });
    await expect(
      e.svc.startWork(ACCOUNT, { environmentId: saved.id, objective: 'x', snapshot: false }),
    ).rejects.toMatchObject({ details: { reason: 'runner_path' } });
    expect(e.svc.bindingFor(ACCOUNT, 'work-thread')).toBeNull();
    await expect(e.envs.checkRemoteFolder(ACCOUNT, saved.id, '/home/victim')).rejects.toMatchObject(
      {
        details: { reason: 'outside_workspace' },
      },
    );
    await expect(
      e.envs.create(ACCOUNT, {
        kind: 'cloud',
        label: 'x',
        connection: { folder: '/workspace/../etc' },
      }),
    ).rejects.toThrow();
    // The Hub's file tools are denied (hidden) in cloud threads, by the gate itself.
    const iso = new Date().toISOString();
    for (const id of ['cloud-code-thread', 'plain-thread'])
      db.raw
        .prepare(
          "INSERT INTO thread (id, account_id, mode, state, created_at, updated_at) VALUES (?, ?, 'code', 'idle', ?, ?)",
        )
        .run(id, ACCOUNT, iso, iso);
    db.raw
      .prepare(
        `INSERT INTO code_session (id, account_id, thread_id, environment_id, folder_path, created_at, updated_at)
         VALUES ('s-cloud', ?, 'cloud-code-thread', ?, '/workspace/app', ?, ?)`,
      )
      .run(ACCOUNT, saved.id, iso, iso);
    const gate = new PolicyGate({
      store: new PolicyStore({ db }),
      events: e.events,
      audit: { append: () => Promise.resolve() },
      notifier: { notify: () => Promise.resolve() },
      setting: (key) =>
        Promise.resolve(
          resolveSetting(key, { global: {}, project: {}, managed: {} }).value as never,
        ),
      dataDir: join(dir, 'gate-data'),
      home: join(dir, 'gate-home'),
      approvalTimeoutMs: () => 60_000,
    });
    gate.useAgentPolicy(e.svc.toolRules(null));
    const decide = (threadId: string, name: string) =>
      gate.preview({
        accountId: ACCOUNT,
        threadId,
        projectId: null,
        mode: 'code',
        tool: {
          name,
          title: name,
          description: '',
          source: 'builtin',
          inputSchema: { type: 'object' },
          annotations: { readOnly: name === 'fs.read' },
        },
        args: {},
        provenance: { userInstruction: { messageId: 'm', accountId: ACCOUNT }, taint: [] },
        profile: { id: 'workspace', hash: 'h' },
      });
    for (const name of HUB_FILE_TOOLS)
      expect((await decide('cloud-code-thread', name)).effect, name).toBe('deny');
    expect((await decide('plain-thread', 'fs.read')).effect).not.toBe('deny');
    expect(e.svc.isCloudThread(ACCOUNT, 'cloud-code-thread')).toBe(true);
    expect(e.svc.isCloudThread(ACCOUNT, 'plain-thread')).toBe(false);
    // A Code session's run names its session (M7); a thread without one names none.
    const lease = await e.svc.lease(ACCOUNT, saved.id, 'cloud-code-thread');
    expect(await e.svc.run(ACCOUNT, lease.id)).toMatchObject({
      kind: 'code',
      sessionId: 's-cloud',
    });
    expect((await e.svc.runs(ACCOUNT, { threadId: 'cloud-code-thread' }))[0]).toMatchObject({
      sessionId: 's-cloud',
    });
    const plain = await e.svc.lease(ACCOUNT, saved.id, 'plain-thread');
    expect(await e.svc.run(ACCOUNT, plain.id)).toMatchObject({ kind: 'work', sessionId: null });
    await gate.close();
  });

  it('finding 5: refuses credentials in repository URLs before the runner sees them', async () => {
    let posted = 0;
    const counting: typeof fetch = (input, init) => {
      if (
        init?.method === 'POST' &&
        (input instanceof Request ? input.url : input.toString()).endsWith(
          '/v1/runner/environments',
        )
      )
        posted++;
      return fetch(input, init);
    };
    const e = env({ watch: false, fetch: counting });
    await e.svc.configure(ACCOUNT, { url, token, enabled: true });
    for (const repo of [
      'https://user:ghp_secret@git.example/x.git',
      'https://ghp_secret@git.example/x.git',
    ])
      await expect(
        e.envs.create(ACCOUNT, { kind: 'cloud', label: 'x', connection: { repoUrls: [repo] } }),
      ).rejects.toThrow();
    expect(posted).toBe(0);
    expect(
      JSON.stringify(db.raw.prepare('SELECT config_json FROM environment').all()),
    ).not.toContain('ghp_secret');
  });

  it('finding 15: caps what it reads from the runner', async () => {
    const big = new Response('x'.repeat(2_000), { headers: { 'content-length': '2000' } });
    await expect(readCapped(big, 100)).rejects.toMatchObject({
      details: { reason: 'runner_answer_too_large' },
    });
    const streamed = new Response(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array(64 * 1024));
        },
      }),
    );
    await expect(readCapped(streamed, 256 * 1024)).rejects.toMatchObject({
      details: { reason: 'runner_answer_too_large' },
    });
    // An event stream that never ends an event.
    const endless: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new TextEncoder().encode('data: '.padEnd(64 * 1024, 'a')));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    const c = new RunnerClient({ url, token, fetch: endless });
    const it = c.stream('r', 0, AbortSignal.timeout(10_000));
    await expect(it.next()).rejects.toMatchObject({
      details: { reason: 'runner_event_too_large' },
    });
    // An artifact larger than a thread holds is refused before its bytes are hashed.
    const huge: typeof fetch = () =>
      Promise.resolve(new Response('a'.repeat(1_000), { headers: { 'content-length': '1000' } }));
    await expect(
      new RunnerClient({ url, token, fetch: huge }).artifact('r', 'a', 100),
    ).rejects.toMatchObject({
      details: { reason: 'runner_answer_too_large' },
    });
  });

  it('hardening: the router reports the routed substrate; reconcile spares a creation in flight', async () => {
    const e = env({ watch: false });
    const saved = await readyCloud(e);
    const base: SandboxClient = {
      substrate: 'container',
      available: () => Promise.resolve({ ok: true, detail: 'hub' }),
      exec: () => Promise.reject(new Error('no')),
      poll: () => Promise.reject(new Error('no')),
      write: () => Promise.resolve(),
      killTurn: () => Promise.resolve(),
    };
    const router = threadSandboxRouter(base, (_a, t) =>
      t === 'cloud-t' ? e.envs.sandboxFor(ACCOUNT, saved.id) : null,
    );
    expect(router.substrate).toBe('container');
    expect(router.substrateFor(ACCOUNT, 'cloud-t')).toBe('cloud');
    expect(router.substrateFor(ACCOUNT, 'other')).toBe('container');
    expect(router.substrateFor(null, null)).toBe('container');
    expect((await router.availableFor(ACCOUNT, 'cloud-t')).ok).toBe(true);
    // A test of the runner while an environment is being created must not delete it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const slow: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (
        init?.method === 'POST' &&
        (input instanceof Request ? input.url : input.toString()).endsWith(
          '/v1/runner/environments',
        )
      )
        await held;
      return res;
    };
    const late = env({ watch: false, fetch: slow, now: () => new Date(Date.now() + 60 * 60_000) });
    await late.svc.configure(ACCOUNT, { url, token, enabled: true });
    const creating = late.envs.create(ACCOUNT, { kind: 'cloud', label: 'slow', connection: {} });
    const client = new RunnerClient({ url, token });
    await until(
      () => client.environments(),
      (l) => l.length === 2,
    );
    expect(await late.svc.reconcile()).toBe(0);
    release();
    const made = await creating;
    expect(await late.svc.reconcile()).toBe(0);
    expect((await client.environments()).length).toBe(2);
    await late.envs.remove(ACCOUNT, made.id);
  });
});

// ---- J9 end to end: bug 3 ---------------------------------------------------------------------

describe(
  `exec in a cloud session on a Hub without its own sandbox (${MODE})`,
  { timeout: 30_000 },
  () => {
    it('runs the command on the runner, while a local thread on the same Hub is refused', async () => {
      const e = env({ watch: false });
      const saved = await readyCloud(e);
      // The Hub has no Docker, Podman or bubblewrap of its own.
      const hub = new UnavailableSandbox('No sandbox is available on this Hub');
      const router = threadSandboxRouter(hub, (_a, threadId) =>
        threadId === 'cloud-thread' ? e.envs.sandboxFor(ACCOUNT, saved.id) : null,
      );
      const sessions = new ExecSessions(router);
      expect((await sessions.available()).ok).toBe(false);
      expect((await sessions.availableFor(ACCOUNT, 'cloud-thread')).ok).toBe(true);
      const [run] = execTools();
      const call = (threadId: string, root: string) =>
        run!.handler(
          { cmd: 'cat README.md' },
          {
            accountId: ACCOUNT,
            threadId,
            turnId: 'turn-1',
            callId: 'c1',
            projectId: null,
            origin: 'model',
            profile: { id: 'workspace', hash: 'h' },
            roots: [{ path: root, access: 'write', label: 'app' }],
            sandbox: sessions,
            signal: AbortSignal.timeout(20_000),
            log: new Logger({ module: 'test', sinks: [] }),
          },
        );
      const cloud = await call('cloud-thread', '/workspace/app');
      expect(cloud).toMatchObject({ ok: true });
      expect(
        cloud.ok && cloud.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
      ).toContain('hello');
      const local = await call('local-thread', dir);
      expect(local).toMatchObject({ ok: false, error: { code: 'sandbox_unavailable' } });
    });
  },
);
