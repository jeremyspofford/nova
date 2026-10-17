// The Network Setup assistant (FR-136, docs/22 §6) against fake CLIs: detection, plans, the
// off-by-default host-changes setting, one-time consent (exact description, remembered per kind
// and provider, revocable), exact argv per step, snapshots and undo, automatic rollback when the
// reachability test fails or the owner's own path is lost, the lock-out guard, whole-run and
// last-step rollback, the change log, and secrets kept out of argv, logs, events, audit and the
// database. Headscale + Tailscale, managed Tailscale, NetBird and plain WireGuard runs.
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, type NetworkSetupRunView } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, type LogRecord } from '@nova/telemetry';
import { MemoryEventSink } from '../src/events.ts';
import { wireguardPublicKey } from '../src/network/mesh/wireguard.ts';
import {
  lockoutRefusal,
  transportLost,
  type SetupReachabilityResult,
} from '../src/network/setup/seams.ts';
import {
  NetworkSetupService,
  type NetworkSetupServiceOptions,
} from '../src/network/setup/service.ts';
import type { AuditRecord } from '../src/tools/types.ts';
import { FakeMeshWorld, FlakyRunner, argvOf, argvStarts } from './fixtures/mesh/world.ts';
import { ProcessMeshRunner } from '../src/network/mesh/runner.ts';
import { wireguardRoutedTransports } from '../src/network/setup/planner.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000d1';
const HS = 'https://hs.example.com';

let db: NovaDatabase;
let world: FakeMeshWorld;
let secrets: MemorySecretStore;
let events: MemoryEventSink;
let audit: AuditRecord[];
let logs: LogRecord[];
let allow: boolean;
let dataDir: string;
let svc: NetworkSetupService;
let flaky: FlakyRunner;
let net: { lanOk: boolean; meshOk: boolean; lanFailsAfter?: string };
let relay: { enabled: boolean; url: string | null };
let certHosts: string[];
let changeLog: {
  records: { kind: string; summary: string; undo: Record<string, unknown> }[];
  handler: ((undo: Record<string, unknown>) => Promise<void>) | null;
};

function meshUp(): boolean {
  const s = world.state;
  return (
    s.tailscale.backendState === 'Running' || s.netbird.connected || s.wg.interfaces.length > 0
  );
}

function reachability(): Promise<SetupReachabilityResult[]> {
  const lanOk =
    net.lanOk &&
    !(net.lanFailsAfter && world.calls().some((c) => argvOf(c).startsWith(net.lanFailsAfter!)));
  const out: SetupReachabilityResult[] = [
    { transport: 'lan', url: 'http://192.168.1.10:7419', ok: lanOk, latencyMs: 2, detail: null },
  ];
  if (meshUp())
    out.push({
      transport: 'mesh',
      url: 'http://100.64.0.5:7419',
      ok: net.meshOk,
      latencyMs: 9,
      detail: net.meshOk ? null : 'timed out',
    });
  if (relay.enabled)
    out.push({ transport: 'relay', url: relay.url ?? '', ok: true, latencyMs: 40, detail: null });
  return Promise.resolve(out);
}

function build(over: Partial<NetworkSetupServiceOptions> = {}) {
  svc = new NetworkSetupService({
    db,
    secrets,
    events,
    log: new Logger({ module: 'test', sinks: [{ write: (r: LogRecord) => logs.push(r) }] }),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    dataDir,
    hubPort: () => 7419,
    allowSystemChanges: () => Promise.resolve(allow),
    runner: flaky,
    probe: {
      interfaces: () => ({
        eth0: [
          {
            address: '192.168.1.10',
            cidr: '192.168.1.10/24',
            family: 'IPv4',
            internal: false,
            netmask: '255.255.255.0',
            mac: '00:00:00:00:00:01',
          },
        ],
        ...(world.state.wg.interfaces.includes('wg-nova')
          ? {
              'wg-nova': [
                {
                  address: '10.77.0.1',
                  cidr: '10.77.0.1/24',
                  family: 'IPv4' as const,
                  internal: false,
                  netmask: '255.255.255.0',
                  mac: '00:00:00:00:00:00',
                },
              ],
            }
          : {}),
      }),
      readFile: (p) =>
        Promise.resolve(p === '/etc/resolv.conf' ? 'nameserver 192.168.1.1\nsearch lan\n' : null),
      exists: (p) => p === '/usr/bin/apt-get',
      platform: 'linux',
    },
    verifyRetries: 1,
    verifyDelayMs: 0,
    ...over,
  });
  svc.useReachability({ test: reachability });
  svc.useTrust({
    ensureLocalCa: () => Promise.resolve({ caFingerprint: 'AA:BB:CC' }),
    requestMeshCert: (host) => {
      certHosts.push(host);
      return Promise.resolve({ host, notAfter: '2027-01-01T00:00:00.000Z' });
    },
  });
  svc.useRelay({
    state: () => Promise.resolve({ ...relay, connected: relay.enabled }),
    set: (next) => {
      relay = { ...next };
      return Promise.resolve();
    },
  });
  svc.useChangeLog({
    record: (input) => {
      changeLog.records.push(input);
      return Promise.resolve({ id: `chg-${changeLog.records.length}` });
    },
    registerUndo: (_kind, handler) => {
      changeLog.handler = handler;
    },
  });
}

beforeEach(async () => {
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  world = new FakeMeshWorld();
  flaky = new FlakyRunner(world.runner);
  secrets = new MemorySecretStore();
  events = new MemoryEventSink();
  audit = [];
  logs = [];
  allow = true;
  dataDir = mkdtempSync(join(tmpdir(), 'nova-setup-'));
  net = { lanOk: true, meshOk: true };
  relay = { enabled: false, url: null };
  certHosts = [];
  changeLog = { records: [], handler: null };
  build();
});

afterEach(() => {
  world.close();
  rmSync(dataDir, { recursive: true, force: true });
  db.close();
});

async function err(p: Promise<unknown>): Promise<NovaError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(NovaError);
  return e as NovaError;
}

function stepOf(run: NetworkSetupRunView, kind: string) {
  const s = run.steps.find((x) => x.kind === kind);
  if (!s) throw new Error(`no ${kind} step`);
  return s;
}

/** Apply every pending step in order, confirming each one with its description. */
async function applyAll(
  runId: string,
  transport: Parameters<NetworkSetupService['apply']>[2] = 'local',
): Promise<NetworkSetupRunView> {
  for (let i = 0; i < 20; i++) {
    const run = await svc.getRun(ACCOUNT, runId);
    const next = run.steps.find((s) => s.status === 'pending');
    if (!next) return run;
    const { step } = await svc.apply(
      ACCOUNT,
      { runId, stepId: next.id, consent: { stepId: next.id, description: next.description } },
      transport,
    );
    if (step.status !== 'verified') return svc.getRun(ACCOUNT, runId);
  }
  throw new Error('too many steps');
}

function headscalePlan(over: Record<string, unknown> = {}) {
  return svc.plan(ACCOUNT, 'headscale', {
    controlUrl: HS,
    advertiseRoutes: ['192.168.1.0/24'],
    exitNode: true,
    ...over,
  });
}

function dump(): string {
  return [
    'network_setup_run',
    'network_setup_step',
    'network_setup_snapshot',
    'network_setup_consent',
  ]
    .map((t) => JSON.stringify(db.raw.prepare(`SELECT * FROM ${t}`).all()))
    .join('\n');
}

describe('detection', () => {
  it('finds interfaces, subnets, DNS, meshes, the firewall and the package manager', async () => {
    const d = await svc.detect();
    expect(d.interfaces.map((i) => [i.name, i.kind])).toEqual([['eth0', 'lan']]);
    expect(d.subnets).toEqual(['192.168.1.0/24']);
    expect(d.dns).toEqual({
      nameservers: ['192.168.1.1'],
      search: ['lan'],
      source: '/etc/resolv.conf',
    });
    expect(d.meshes.map((m) => [m.provider, m.installed, m.loggedIn])).toEqual([
      ['tailscale', true, false],
      ['headscale', true, true],
      ['netbird', false, false],
      ['wireguard', false, false],
    ]);
    expect(d.firewall).toEqual({ tool: 'ufw', active: true, detail: null });
    expect(d.packageManager).toBe('apt');
    expect(d.meshUrls).toEqual([]);
    expect(await svc.meshEndpoints()).toEqual([]);
    expect(world.changes()).toEqual([]);
    expect(await svc.aclSummary()).toMatchObject({ provider: 'headscale', source: 'none' });
  });

  it('classifies the transport a request came in on', async () => {
    await svc.detect();
    // Loopback proves nothing (an SSH tunnel or a proxy arrives from there too): review finding 9.
    expect(svc.transportOf('127.0.0.1')).toBe('unknown');
    expect(svc.transportOf('::ffff:127.0.0.1')).toBe('unknown');
    expect(svc.transportOf('::1')).toBe('unknown');
    expect(svc.transportOf('100.64.0.5')).toBe('mesh');
    expect(svc.transportOf('fd7a:115c:a1e0::5')).toBe('mesh');
    expect(svc.transportOf('192.168.1.10')).toBe('lan');
    expect(svc.transportOf('fe80::1')).toBe('lan');
    expect(svc.transportOf('fd00::1')).toBe('lan');
    expect(svc.transportOf('203.0.113.9')).toBe('direct');
    expect(svc.transportOf(undefined)).toBe('unknown');
    expect(svc.transportOf('nonsense')).toBe('unknown');
  });
});

describe('plans', () => {
  it('Headscale with the Tailscale client: every step, exact commands, no change made', async () => {
    const run = await headscalePlan();
    expect(run.status).toBe('planned');
    expect(run.steps.map((s) => [s.kind, s.provider, s.status])).toEqual([
      ['client.install', 'tailscale', 'skipped'],
      ['server.user', 'headscale', 'pending'],
      ['server.acl', 'headscale', 'pending'],
      ['server.authkey', 'headscale', 'pending'],
      ['mesh.up', 'tailscale', 'pending'],
      ['mesh.dns', 'tailscale', 'skipped'],
      ['mesh.routes', 'tailscale', 'pending'],
      ['mesh.exitnode', 'tailscale', 'pending'],
      ['trust.cert', 'hub', 'pending'],
      ['firewall.ports', 'ufw', 'pending'],
      ['reachability', 'hub', 'pending'],
    ]);
    expect(stepOf(run, 'mesh.up').commands).toEqual([
      [
        'tailscale',
        'up',
        `--login-server=${HS}`,
        '--auth-key=file:/dev/stdin',
        '--hostname=nova-hub',
        '--advertise-tags=tag:nova-hub',
        '--accept-dns=true',
        '<secret on stdin>',
      ],
    ]);
    expect(stepOf(run, 'mesh.up')).toMatchObject({
      affects: [],
      undoAffects: ['mesh'],
      systemChange: true,
      consent: { required: true, remembered: false },
    });
    expect(stepOf(run, 'server.acl').affects).toEqual(['mesh']);
    expect(stepOf(run, 'trust.cert').systemChange).toBe(false);
    expect(stepOf(run, 'mesh.dns').description).toContain('dns.magic_dns');
    expect(world.changes()).toEqual([]);
    expect((await svc.listRuns(ACCOUNT)).map((r) => r.id)).toEqual([run.id]);
  });

  it('refuses unusable choices and drops the secrets it stored', async () => {
    const reason = async (p: Promise<unknown>) => (await err(p)).details?.reason;
    expect(await reason(svc.plan(ACCOUNT, 'headscale', {}))).toBe('control_url_required');
    expect(await reason(svc.plan(ACCOUNT, 'tailscale', {}))).toBe('auth_key_required');
    expect(await reason(svc.plan(ACCOUNT, 'wireguard', {}))).toBe('wireguard_options_required');
    expect(await reason(headscalePlan({ certs: 'mesh', authKey: 'hskey-given-elsewhere' }))).toBe(
      'mesh_certs_unavailable',
    );
    expect(
      await reason(
        svc.plan(ACCOUNT, 'headscale', {
          controlUrl: HS,
          headscale: { cliAddress: 'hs.example.com:50443' },
        }),
      ),
    ).toBe('api_key_required');
    world.update((s) => {
      s.installed.headscale = false;
    });
    expect(await reason(svc.plan(ACCOUNT, 'headscale', { controlUrl: HS }))).toBe(
      'headscale_unavailable',
    );
    world.update((s) => {
      Object.assign(s.tailscale, {
        backendState: 'Running',
        loggedOut: false,
        controlUrl: 'https://other.example',
      });
    });
    const inUse = await err(svc.plan(ACCOUNT, 'tailscale', { authKey: 'tskey-auth-0123456789' }));
    expect(inUse.code).toBe('conflict');
    expect(inUse.details).toMatchObject({ reason: 'mesh_in_use' });
    expect(await secrets.list('secret://network/setup/')).toEqual([]);
    expect(await svc.listRuns(ACCOUNT)).toEqual([]);
  });
});

describe('applying', { timeout: 30_000 }, () => {
  it('refuses host changes while the setting is off, and runs nothing', async () => {
    allow = false;
    const run = await headscalePlan();
    const user = stepOf(run, 'server.user');
    const e = await err(
      svc.apply(
        ACCOUNT,
        { runId: run.id, consent: { stepId: user.id, description: user.description } },
        'local',
      ),
    );
    expect(e.code).toBe('policy_denied');
    expect(e.details).toMatchObject({ reason: 'system_changes_disabled' });
    expect(world.changes()).toEqual([]);
    expect(audit.at(-1)).toMatchObject({
      action: 'network.setup.apply',
      decision: 'denied',
      kind: 'network',
    });
    expect(svc.consents(ACCOUNT)).toEqual([]);
  });

  it('asks for consent with the exact description, remembers it per kind and provider, and can revoke it', async () => {
    const run = await headscalePlan();
    const user = stepOf(run, 'server.user');
    const ask = await err(svc.apply(ACCOUNT, { runId: run.id }, 'local'));
    expect(ask.code).toBe('policy_denied');
    expect(ask.details).toEqual({
      reason: 'consent_required',
      stepId: user.id,
      description: user.description,
    });
    const wrong = await err(
      svc.apply(
        ACCOUNT,
        { runId: run.id, consent: { stepId: user.id, description: 'yes' } },
        'local',
      ),
    );
    expect(wrong.details?.reason).toBe('consent_required');
    expect(world.changes()).toEqual([]);
    const { step } = await svc.apply(
      ACCOUNT,
      { runId: run.id, consent: { stepId: user.id, description: user.description } },
      'local',
    );
    expect(step.status).toBe('verified');
    expect(world.changes().map(argvOf)).toEqual(['headscale users create nova']);
    expect(svc.consents(ACCOUNT)).toMatchObject([{ kind: 'server.user', provider: 'headscale' }]);
    expect(audit.find((a) => a.action === 'network.setup.consent')).toMatchObject({
      decision: 'granted',
    });

    // Remembered: another run's step of the same kind and provider needs no confirmation.
    const again = await headscalePlan();
    expect(stepOf(again, 'server.user').consent).toEqual({ required: true, remembered: true });
    expect((await svc.apply(ACCOUNT, { runId: again.id }, 'local')).step.status).toBe('verified');

    // Revoked: asked again.
    const [c] = svc.consents(ACCOUNT);
    await svc.revokeConsent(ACCOUNT, c!.id);
    expect(svc.consents(ACCOUNT)).toEqual([]);
    expect(audit.at(-1)).toMatchObject({ action: 'network.setup.consent', decision: 'revoked' });
    const third = await headscalePlan();
    expect((await err(svc.apply(ACCOUNT, { runId: third.id }, 'local'))).details?.reason).toBe(
      'consent_required',
    );
    expect((await err(svc.revokeConsent(ACCOUNT, c!.id))).code).toBe('not_found');
  });

  it('runs a Headscale setup end to end with the exact argv, and keeps every secret out of sight', async () => {
    const run = await applyAll((await headscalePlan()).id);
    expect(run.status).toBe('completed');
    expect(
      run.steps.filter((s) => s.status !== 'skipped').every((s) => s.status === 'verified'),
    ).toBe(true);
    const policyFile = join(dataDir, 'network', 'setup', run.id, 'headscale-policy.json');
    expect(world.changes().map(argvOf)).toEqual([
      'headscale users create nova',
      `headscale policy set --file ${policyFile}`,
      'headscale preauthkeys create --user 2 --expiration 1h --tags tag:nova-hub -o json',
      `tailscale up --login-server=${HS} --auth-key=file:/dev/stdin --hostname=nova-hub --advertise-tags=tag:nova-hub --accept-dns=true`,
      'tailscale set --advertise-routes=192.168.1.0/24',
      'headscale nodes approve-routes --identifier 1 --routes=192.168.1.0/24',
      'tailscale set --advertise-exit-node=true',
      'headscale nodes approve-routes --identifier 1 --routes=192.168.1.0/24,0.0.0.0/0,::/0',
      'ufw allow in on tailscale0 to any port 7419 proto tcp comment nova',
    ]);
    const s = world.state;
    expect(s.tailscale).toMatchObject({
      backendState: 'Running',
      controlUrl: HS,
      hostname: 'nova-hub',
    });
    expect(s.headscale.nodes[0]?.approved_routes).toEqual(['192.168.1.0/24', '0.0.0.0/0', '::/0']);
    const policy = JSON.parse(s.headscale.policy ?? '{}') as {
      tagOwners: unknown;
      acls: unknown[];
    };
    expect(policy.tagOwners).toEqual({ 'tag:nova-hub': ['nova@'] });
    expect(policy.acls).toContainEqual({ action: 'accept', src: ['*'], dst: ['*:*'] });
    expect(statSync(policyFile).mode & 0o777).toBe(0o600);

    // The pre-auth key went from Headscale's stdout to the vault to tailscale's stdin, nowhere else.
    const key = s.headscale.keys[0]!.key;
    expect(
      world
        .calls()
        .filter((c) => c.stdin.includes(key))
        .map((c) => c.args[0]),
    ).toEqual(['up']);
    expect(world.calls().some((c) => c.args.join(' ').includes(key))).toBe(false);
    for (const where of [
      JSON.stringify(audit),
      JSON.stringify(events.events),
      JSON.stringify(logs),
      dump(),
      JSON.stringify(run),
    ])
      expect(where).not.toContain(key);
    // Used up once the Hub joined: gone from the vault.
    expect(await secrets.get(`secret://network/setup/${run.id}/preauth-key`)).toBeNull();

    // Trust, outputs, events, the change log, mesh endpoints and the ACL summary.
    expect(run.outputs).toEqual({ caFingerprint: 'AA:BB:CC' });
    expect(
      events.events.filter((e) => e.name === 'network.setup.step').map((e) => e.payload.status),
    ).toContain('verified');
    expect(changeLog.records.map((r) => r.kind)).toEqual(Array(8).fill('network.setup.step'));
    expect(changeLog.records[0]?.undo).toEqual({
      accountId: ACCOUNT,
      runId: run.id,
      stepId: stepOf(run, 'server.user').id,
    });
    expect((await svc.meshEndpoints()).map((c) => [c.url, c.detail, c.health])).toEqual([
      ['http://nova-hub.nova.mesh:7419', 'tailscale', 'unknown'],
      ['http://100.64.0.5:7419', 'tailscale', 'unknown'],
    ]);
    expect(await svc.aclSummary()).toMatchObject({
      provider: 'headscale',
      source: 'headscale-policy',
      tagOwners: ['tag:nova-hub'],
      tags: ['tag:nova-hub'],
    });
    expect(audit.filter((a) => a.action === 'network.setup.apply').map((a) => a.result)).toEqual(
      Array(8).fill('verified'),
    );

    const verify = await svc.verify(ACCOUNT, run.id);
    expect(verify.ok).toBe(true);
    expect(verify.checks.map((c) => c.name)).toContain('mesh reachable');
    world.update((w) => {
      w.tailscale.backendState = 'Stopped';
    });
    expect((await svc.verify(ACCOUNT, run.id)).ok).toBe(false);
  });

  it('rolls a whole run back in reverse with the undo commands from its snapshots', async () => {
    const run = await applyAll((await headscalePlan()).id);
    world.clearCalls();
    const back = await svc.rollback(ACCOUNT, run.id, {}, 'local');
    expect(back.status).toBe('rolled_back');
    const prev = join(dataDir, 'network', 'setup', run.id, 'headscale-policy.previous.json');
    expect(world.changes().map(argvOf)).toEqual([
      'ufw delete allow in on tailscale0 to any port 7419 proto tcp',
      'tailscale set --advertise-exit-node=false',
      'headscale nodes approve-routes --identifier 1 --routes=192.168.1.0/24',
      'tailscale set --advertise-routes=',
      'headscale nodes approve-routes --identifier 1 --routes=',
      'tailscale logout',
      `headscale policy set --file ${prev}`,
      'headscale users destroy --name nova --force',
    ]);
    const s = world.state;
    expect(s.tailscale.backendState).toBe('NeedsLogin');
    expect(s.headscale.users.map((u) => u.name)).toEqual(['admin']);
    expect(s.ufw.added).toEqual(['allow 22/tcp']);
    expect(JSON.parse(s.headscale.policy ?? '{}')).toEqual({
      acls: [{ action: 'accept', src: ['*'], dst: ['*:*'] }],
    });
    expect(await secrets.has(`secret://network/setup/${run.id}/preauth-key`)).toBe(false);
    expect(stepOf(back, 'mesh.up')).toMatchObject({
      status: 'rolled_back',
      autoRolledBack: false,
      undoCommands: [['tailscale', 'logout']],
    });
    expect(audit.at(-1)).toMatchObject({
      action: 'network.setup.rollback',
      result: 'rolled_back',
      detail: expect.objectContaining({ auto: false }) as unknown,
    });
    expect((await err(svc.rollback(ACCOUNT, run.id, {}, 'local'))).details?.reason).toBe(
      'nothing_to_roll_back',
    );
  });

  it('rolls a step back on its own when the new path fails its reachability test', async () => {
    net.meshOk = false;
    const run = await applyAll((await headscalePlan()).id);
    const up = stepOf(run, 'mesh.up');
    expect(up).toMatchObject({ status: 'rolled_back', autoRolledBack: true });
    expect(up.error).toContain('mesh path failed its reachability test');
    expect(up.checks).toContainEqual({ name: 'mesh reachable', ok: false, detail: 'timed out' });
    expect(world.changes().map(argvOf).slice(-2)).toEqual([
      `tailscale up --login-server=${HS} --auth-key=file:/dev/stdin --hostname=nova-hub --advertise-tags=tag:nova-hub --accept-dns=true`,
      'tailscale logout',
    ]);
    expect(world.state.tailscale.backendState).toBe('NeedsLogin');
    expect(run.status).toBe('failed');
    expect(run.error).toContain('reachability');
    expect(events.events.at(-1)?.payload).toMatchObject({
      status: 'rolled_back',
      autoRolledBack: true,
    });
    expect(audit.find((a) => a.action === 'network.setup.rollback')).toMatchObject({
      actor: 'system',
      detail: expect.objectContaining({ auto: true }) as unknown,
    });
    // Nothing after the failed step ran, and the change log only has what stuck.
    expect(stepOf(run, 'mesh.routes').status).toBe('pending');
    expect(changeLog.records).toHaveLength(3);
  });

  it("rolls back when the step's own check fails", async () => {
    world.update((s) => {
      s.joinState = 'NeedsMachineAuth';
    });
    const run = await applyAll((await headscalePlan()).id);
    expect(stepOf(run, 'mesh.up')).toMatchObject({ status: 'rolled_back', autoRolledBack: true });
    expect(stepOf(run, 'mesh.up').error).toContain('tailscale running did not pass');
    expect(world.changes().map(argvOf).at(-1)).toBe('tailscale logout');
  });

  it('marks a step failed when its command fails, putting back what ran', async () => {
    world.update((s) => {
      s.fail['ufw allow'] = 'ERROR: problem running iptables';
    });
    const run = await applyAll((await headscalePlan()).id);
    const fw = stepOf(run, 'firewall.ports');
    expect(fw.status).toBe('failed');
    expect(fw.error).toBe('ufw allow in failed: exit 1: ERROR: problem running iptables');
    expect(run.status).toBe('failed');
    expect(audit.at(-1)).toMatchObject({ action: 'network.setup.apply', result: 'failed' });
    // Retry once the cause is gone.
    world.update((s) => {
      s.fail = {};
    });
    const { step } = await svc.apply(ACCOUNT, { runId: run.id, stepId: fw.id }, 'local');
    expect(step.status).toBe('verified');
  });

  it('rolls back when the change costs the owner the path they came in on', async () => {
    net.lanFailsAfter = 'ufw allow';
    const run = await applyAll((await headscalePlan()).id, 'lan');
    const fw = stepOf(run, 'firewall.ports');
    expect(fw).toMatchObject({ status: 'rolled_back', autoRolledBack: true });
    expect(fw.error).toContain('stopped answering on the lan path');
    expect(world.changes().map(argvOf).at(-1)).toBe(
      'ufw delete allow in on tailscale0 to any port 7419 proto tcp',
    );
  });

  it('never locks the owner out: a change to the path they use needs another healthy one', async () => {
    world.update((s) => {
      Object.assign(s.tailscale, {
        backendState: 'Running',
        loggedOut: false,
        wantRunning: true,
        controlUrl: HS,
        hostname: 'nova-hub',
        ips: ['100.64.0.5'],
        dnsName: 'nova-hub.nova.mesh',
      });
    });
    const run = await headscalePlan({ advertiseRoutes: [], exitNode: false });
    expect(stepOf(run, 'mesh.up').status).toBe('skipped');
    expect(stepOf(run, 'server.authkey').status).toBe('skipped');
    const user = stepOf(run, 'server.user');
    const acl = stepOf(run, 'server.acl');
    const consent = (s: typeof acl) => ({ stepId: s.id, description: s.description });
    net.lanOk = false;
    await svc.apply(ACCOUNT, { runId: run.id, stepId: user.id, consent: consent(user) }, 'mesh');
    for (const t of ['mesh', 'unknown'] as const) {
      const e = await err(
        svc.apply(ACCOUNT, { runId: run.id, stepId: acl.id, consent: consent(acl) }, t),
      );
      expect(e.code).toBe('conflict');
      expect(e.details).toMatchObject({
        reason: 'would_lock_out',
        transport: t,
        affects: ['mesh'],
      });
    }
    expect(audit.at(-1)).toMatchObject({ decision: 'denied', result: 'would_lock_out' });
    net.lanOk = true;
    const ok = await svc.apply(
      ACCOUNT,
      { runId: run.id, stepId: acl.id, consent: consent(acl) },
      'mesh',
    );
    expect(ok.step.status).toBe('verified');
    // Undoing the policy could cut the mesh too.
    net.lanOk = false;
    const back = await err(svc.rollback(ACCOUNT, run.id, { stepId: acl.id }, 'mesh'));
    expect(back.details).toMatchObject({ reason: 'would_lock_out' });
    // From the Hub itself nothing can be cut.
    await svc.rollback(ACCOUNT, run.id, { stepId: acl.id }, 'local');
  });

  it('rolls back only the last applied step alone, and from the network change log', async () => {
    const run = await headscalePlan();
    const user = stepOf(run, 'server.user');
    const acl = stepOf(run, 'server.acl');
    for (const s of [user, acl])
      await svc.apply(
        ACCOUNT,
        { runId: run.id, consent: { stepId: s.id, description: s.description } },
        'local',
      );
    expect(
      (await err(svc.rollback(ACCOUNT, run.id, { stepId: user.id }, 'local'))).details?.reason,
    ).toBe('not_last_step');
    world.clearCalls();
    const one = await svc.rollback(ACCOUNT, run.id, { stepId: acl.id }, 'local');
    expect(stepOf(one, 'server.acl').status).toBe('rolled_back');
    expect(stepOf(one, 'server.user').status).toBe('verified');
    expect(one.status).toBe('in_progress');
    expect(world.changes().map(argvOf)).toEqual([
      `headscale policy set --file ${join(dataDir, 'network', 'setup', run.id, 'headscale-policy.previous.json')}`,
    ]);
    // The generic rollback reverts the user step through the registered undo handler.
    const userChange = changeLog.records.find((r) => r.undo.stepId === user.id)!;
    await changeLog.handler!(userChange.undo);
    expect(stepOf(await svc.getRun(ACCOUNT, run.id), 'server.user').status).toBe('rolled_back');
    expect(world.state.headscale.users.map((u) => u.name)).toEqual(['admin']);
    // Already undone here: the change log's second try is a no-op.
    await changeLog.handler!(userChange.undo);
  });

  it('applies in order, one at a time', async () => {
    const run = await headscalePlan();
    const acl = stepOf(run, 'server.acl');
    const e = await err(svc.apply(ACCOUNT, { runId: run.id, stepId: acl.id }, 'local'));
    expect(e.details).toMatchObject({
      reason: 'earlier_step_pending',
      stepId: stepOf(run, 'server.user').id,
    });
    expect(
      (
        await err(
          svc.apply(ACCOUNT, { runId: run.id, stepId: stepOf(run, 'mesh.dns').id }, 'local'),
        )
      ).details?.reason,
    ).toBe('not_applicable');
    expect((await err(svc.apply(ACCOUNT, { runId: 'nope' }, 'local'))).code).toBe('not_found');
    expect((await err(svc.apply(ACCOUNT, { runId: run.id, stepId: 'nope' }, 'local'))).code).toBe(
      'not_found',
    );
    const user = stepOf(run, 'server.user');
    await svc.apply(
      ACCOUNT,
      { runId: run.id, consent: { stepId: user.id, description: user.description } },
      'local',
    );
    expect(
      (await err(svc.apply(ACCOUNT, { runId: run.id, stepId: user.id }, 'local'))).details?.reason,
    ).toBe('already_applied');
    expect((await err(svc.verify(ACCOUNT, run.id, acl.id))).details?.reason).toBe('not_applied');
    const done = await applyAll(run.id);
    expect((await err(svc.apply(ACCOUNT, { runId: done.id }, 'local'))).details?.reason).toBe(
      'nothing_to_apply',
    );
  });

  it('refuses a second change while one runs', async () => {
    const run = await headscalePlan();
    const user = stepOf(run, 'server.user');
    const acl = stepOf(run, 'server.acl');
    await svc.apply(
      ACCOUNT,
      { runId: run.id, consent: { stepId: user.id, description: user.description } },
      'local',
    );
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    svc.useReachability({
      test: async () => {
        calls += 1;
        // The baseline passes; the test after applying waits, holding the lock.
        if (calls === 2) await gate;
        return reachability();
      },
    });
    const first = svc.apply(
      ACCOUNT,
      { runId: run.id, consent: { stepId: acl.id, description: acl.description } },
      'lan',
    );
    while (calls < 2) await new Promise((r) => setTimeout(r, 10));
    const other = await headscalePlan();
    expect((await err(svc.apply(ACCOUNT, { runId: other.id }, 'local'))).details?.reason).toBe(
      'setup_busy',
    );
    release();
    expect((await first).step.status).toBe('verified');
  });
});

describe('other providers', { timeout: 30_000 }, () => {
  it('NetBird joins with the setup key in the environment, never argv', async () => {
    world.update((s) => {
      s.installed.netbird = true;
      s.netbird.setupKeys = ['nbkey-0123456789abcdef'];
    });
    const plan = await svc.plan(ACCOUNT, 'netbird', {
      controlUrl: 'https://nb.example.com',
      authKey: 'nbkey-0123456789abcdef',
      advertiseRoutes: ['192.168.1.0/24'],
      exitNode: true,
    });
    expect(plan.options).toMatchObject({ authKey: 'stored' });
    expect(plan.steps.map((s) => [s.kind, s.status])).toEqual([
      ['client.install', 'skipped'],
      ['mesh.up', 'pending'],
      ['mesh.dns', 'manual'],
      ['mesh.routes', 'manual'],
      ['mesh.exitnode', 'manual'],
      ['trust.cert', 'pending'],
      ['firewall.ports', 'pending'],
      ['reachability', 'pending'],
    ]);
    expect(stepOf(plan, 'mesh.up').commands[0]).toEqual([
      'NB_SETUP_KEY=<secret>',
      'netbird',
      'up',
      '--management-url',
      'https://nb.example.com',
      '--hostname',
      'nova-hub',
    ]);
    const run = await applyAll(plan.id);
    expect(run.status).toBe('completed');
    const up = world.calls().find((c) => c.tool === 'netbird' && c.args[0] === 'up')!;
    expect(up.env.NB_SETUP_KEY).toBe('nbkey-0123456789abcdef');
    expect(world.calls().some((c) => c.args.join(' ').includes('nbkey-'))).toBe(false);
    expect(dump()).not.toContain('nbkey-0123456789abcdef');
    expect(world.changes().map(argvOf)).toContain(
      'ufw allow in on wt0 to any port 7419 proto tcp comment nova',
    );
    world.clearCalls();
    await svc.rollback(ACCOUNT, run.id, {}, 'local');
    expect(world.changes().map(argvOf)).toEqual([
      'ufw delete allow in on wt0 to any port 7419 proto tcp',
      'netbird down',
    ]);
  });

  it('WireGuard: installs the tools, writes a private config from the vault key, and undoes it all', async () => {
    const peer = wireguardPublicKey(Buffer.alloc(32, 7).toString('base64'));
    const plan = await svc.plan(ACCOUNT, 'wireguard', {
      wireguard: {
        address: '10.77.0.1/24',
        peers: [{ name: 'phone', publicKey: peer, allowedIps: ['10.77.0.2/32'] }],
      },
    });
    const pub = plan.outputs.wireguardPublicKey!;
    const priv = await secrets.get('secret://network/wireguard/wg-nova/private-key');
    expect(wireguardPublicKey(priv!)).toBe(pub);
    expect(plan.steps.map((s) => [s.kind, s.status])).toEqual([
      ['client.install', 'pending'],
      ['mesh.up', 'pending'],
      ['trust.cert', 'pending'],
      ['firewall.ports', 'pending'],
      ['reachability', 'pending'],
    ]);
    const run = await applyAll(plan.id);
    expect(run.status).toBe('completed');
    const conf = join(dataDir, 'network', 'wireguard', 'wg-nova.conf');
    expect(statSync(conf).mode & 0o777).toBe(0o600);
    expect(readFileSync(conf, 'utf8')).toContain(`PrivateKey = ${priv}`);
    expect(world.changes().map(argvOf)).toEqual([
      'apt-get install -y --no-install-recommends wireguard-tools',
      `wg-quick up ${conf}`,
      'ufw allow in on wg-nova to any port 7419 proto tcp comment nova',
      'ufw allow 51820/udp comment nova',
    ]);
    expect(world.calls().find((c) => c.tool === 'apt-get')?.env.DEBIAN_FRONTEND).toBe(
      'noninteractive',
    );
    for (const c of world.calls()) expect(`${c.args.join(' ')} ${c.stdin}`).not.toContain(priv!);
    expect(dump()).not.toContain(priv!);
    expect((await svc.meshEndpoints()).map((c) => c.url)).toEqual(['http://10.77.0.1:7419']);
    world.clearCalls();
    await svc.rollback(ACCOUNT, run.id, {}, 'local');
    expect(world.changes().map(argvOf)).toEqual([
      'ufw delete allow 51820/udp',
      'ufw delete allow in on wg-nova to any port 7419 proto tcp',
      `wg-quick down ${conf}`,
      'apt-get remove -y wireguard-tools',
    ]);
    expect(existsSync(conf)).toBe(false);
    expect(world.state.installed.wg).toBe(false);
  });

  it('managed Tailscale with a mesh certificate and a Relay', async () => {
    world.update((s) => {
      s.tailscaleAuthKeys = ['tskey-auth-k1234567890'];
    });
    const plan = await svc.plan(ACCOUNT, 'tailscale', {
      authKey: 'tskey-auth-k1234567890',
      certs: 'mesh',
      firewall: false,
      relay: { url: 'wss://relay.example.com' },
    });
    expect(plan.steps.map((s) => s.kind)).toEqual([
      'client.install',
      'mesh.up',
      'mesh.dns',
      'trust.cert',
      'relay.enroll',
      'reachability',
    ]);
    expect(stepOf(plan, 'mesh.up').commands[0]).not.toContain(`--login-server=${HS}`);
    const run = await applyAll(plan.id);
    expect(run.status).toBe('completed');
    expect(certHosts).toEqual(['nova-hub.nova.mesh']);
    expect(run.outputs).toMatchObject({ meshCertHost: 'nova-hub.nova.mesh' });
    expect(relay).toEqual({ enabled: true, url: 'wss://relay.example.com' });
    const up = world.calls().find((c) => c.tool === 'tailscale' && c.args[0] === 'up')!;
    expect(up.stdin).toBe('tskey-auth-k1234567890');
    expect(up.args.join(' ')).not.toContain('tskey-');
    expect(stepOf(run, 'reachability').checks.map((c) => c.name)).toEqual([
      'mesh reachable',
      'relay reachable',
    ]);
    await svc.rollback(ACCOUNT, run.id, {}, 'local');
    expect(relay).toEqual({ enabled: false, url: null });
    expect(world.state.tailscale.backendState).toBe('NeedsLogin');
  });

  it('a remote Headscale gets its address and API key through the environment', async () => {
    world.update((s) => {
      s.headscale.apiKey = 'hs-api-key-0123456789';
    });
    const plan = await svc.plan(ACCOUNT, 'headscale', {
      controlUrl: HS,
      headscale: { cliAddress: 'hs.example.com:50443', apiKey: 'hs-api-key-0123456789' },
      firewall: false,
    });
    expect(plan.options).toMatchObject({
      headscale: { cliAddress: 'hs.example.com:50443', apiKey: 'stored' },
    });
    expect(stepOf(plan, 'server.user').commands[0]?.[0]).toBe('HEADSCALE_CLI_API_KEY=<secret>');
    const user = stepOf(plan, 'server.user');
    await svc.apply(
      ACCOUNT,
      { runId: plan.id, consent: { stepId: user.id, description: user.description } },
      'local',
    );
    const create = world.calls().find((c) => argvOf(c) === 'headscale users create nova')!;
    expect(create.env).toEqual({
      HEADSCALE_CLI_ADDRESS: 'hs.example.com:50443',
      HEADSCALE_CLI_API_KEY: 'hs-api-key-0123456789',
    });
    expect(world.calls().some((c) => c.args.join(' ').includes('hs-api-key'))).toBe(false);
    expect(dump()).not.toContain('hs-api-key-0123456789');
    expect(stepOf(await svc.getRun(ACCOUNT, plan.id), 'server.user').status).toBe('verified');
  });

  it('a step whose area is not connected fails closed', async () => {
    const bare = new NetworkSetupService({
      db,
      secrets,
      events,
      log: new Logger({ module: 'test', sinks: [] }),
      dataDir,
      hubPort: () => 7419,
      allowSystemChanges: () => Promise.resolve(true),
      runner: world.runner,
      probe: {
        interfaces: () => ({}),
        readFile: () => Promise.resolve(null),
        exists: () => false,
        platform: 'linux',
      },
      verifyRetries: 0,
      verifyDelayMs: 0,
    });
    const plan = await bare.plan(ACCOUNT, 'headscale', { controlUrl: HS, firewall: false });
    expect(stepOf(plan, 'client.install').status).toBe('skipped');
    expect(plan.steps.find((s) => s.kind === 'firewall.ports')).toBeUndefined();
    for (const s of plan.steps.filter((x) => x.status === 'pending').slice(0, 3))
      await bare.apply(
        ACCOUNT,
        { runId: plan.id, stepId: s.id, consent: { stepId: s.id, description: s.description } },
        'local',
      );
    // mesh.up expects a reachability test, and none is connected: rolled back.
    const up = stepOf(plan, 'mesh.up');
    const r = await bare.apply(
      ACCOUNT,
      { runId: plan.id, stepId: up.id, consent: { stepId: up.id, description: up.description } },
      'local',
    );
    expect(r.step).toMatchObject({ status: 'rolled_back', autoRolledBack: true });
    expect(r.step.error).toContain('no reachability test is connected');
  });
});

describe('the lock-out guard and lost-path check', () => {
  const r = (
    transport: SetupReachabilityResult['transport'],
    ok: boolean,
  ): SetupReachabilityResult => ({
    transport,
    url: `x://${transport}`,
    ok,
    latencyMs: null,
    detail: null,
  });

  it('refuses only when the owner path is at risk and nothing else answers', () => {
    expect(lockoutRefusal('mesh', [], null)).toBeNull();
    expect(lockoutRefusal('local', ['mesh'], null)).toBeNull();
    expect(lockoutRefusal('lan', ['mesh'], null)).toBeNull();
    expect(lockoutRefusal('mesh', ['mesh'], null)).toMatchObject({ reason: 'would_lock_out' });
    expect(lockoutRefusal('mesh', ['mesh'], [r('mesh', true), r('lan', false)])).not.toBeNull();
    expect(lockoutRefusal('mesh', ['mesh'], [r('lan', true)])).toBeNull();
    expect(lockoutRefusal('mesh', ['mesh', 'lan'], [r('lan', true)])).not.toBeNull();
    expect(lockoutRefusal('unknown', ['mesh'], [r('mesh', true)])).not.toBeNull();
    expect(lockoutRefusal('unknown', ['mesh'], [r('relay', true)])).toBeNull();
  });

  it('notices a lost path only when it answered before', () => {
    expect(transportLost('lan', [], [r('lan', true)], [r('lan', false)])).toBe('lan');
    expect(transportLost('lan', [], [r('lan', false)], [r('lan', false)])).toBeNull();
    expect(transportLost('local', ['lan'], [r('lan', true)], [])).toBeNull();
    expect(transportLost('lan', [], null, [])).toBeNull();
    expect(
      transportLost('unknown', ['mesh'], [r('mesh', true), r('lan', true)], [r('lan', false)]),
    ).toBe('mesh');
  });
});

/** Apply pending steps in order until `kind` (inclusive) or the first that does not verify. */
async function applyThrough(runId: string, kind: string): Promise<NetworkSetupRunView> {
  for (let i = 0; i < 20; i++) {
    const run = await svc.getRun(ACCOUNT, runId);
    const next = run.steps.find((s) => s.status === 'pending');
    if (!next) return run;
    const { step } = await svc.apply(
      ACCOUNT,
      { runId, stepId: next.id, consent: { stepId: next.id, description: next.description } },
      'local',
    );
    if (step.kind === kind || step.status !== 'verified') return svc.getRun(ACCOUNT, runId);
  }
  throw new Error('too many steps');
}

const RESTRICTIVE = JSON.stringify({
  groups: { 'group:admins': ['admin@'] },
  acls: [{ action: 'accept', src: ['group:admins'], dst: ['*:22'] }],
});
const PEER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('review fixes', { timeout: 30_000 }, () => {
  describe('finding 5: the Headscale policy is never guessed', () => {
    beforeEach(() => {
      world.update((s) => {
        s.headscale.policy = RESTRICTIVE;
      });
    });

    it('a failed read before the change stops the step; the owner policy is untouched', async () => {
      flaky.rules.push({ match: argvStarts('headscale', 'policy', 'get'), nth: 1 });
      const run = await applyThrough((await headscalePlan()).id, 'server.acl');
      const acl = stepOf(run, 'server.acl');
      expect(acl.status).toBe('failed');
      expect(acl.error).toContain('connection refused');
      expect(world.state.headscale.policy).toBe(RESTRICTIVE);
      expect(
        world
          .changes()
          .map(argvOf)
          .some((a) => a.includes('policy set')),
      ).toBe(false);
    });

    it('a failed read while verifying rolls back to the original policy', async () => {
      flaky.rules.push({ match: argvStarts('headscale', 'policy', 'get'), nth: 2 });
      const run = await applyThrough((await headscalePlan()).id, 'server.acl');
      expect(stepOf(run, 'server.acl')).toMatchObject({
        status: 'rolled_back',
        autoRolledBack: true,
      });
      expect(JSON.parse(world.state.headscale.policy!)).toEqual(JSON.parse(RESTRICTIVE));
    });

    it('merges into the policy it read and rolls back to it verbatim', async () => {
      const run = await applyThrough((await headscalePlan()).id, 'server.acl');
      expect(stepOf(run, 'server.acl').status).toBe('verified');
      const merged = JSON.parse(world.state.headscale.policy!) as {
        groups: unknown;
        acls: unknown[];
      };
      expect(merged.groups).toEqual({ 'group:admins': ['admin@'] });
      expect(merged.acls).not.toContainEqual({ action: 'accept', src: ['*'], dst: ['*:*'] });
      expect(merged.acls).toContainEqual({
        action: 'accept',
        src: ['*'],
        dst: ['tag:nova-hub:7419'],
      });
      await svc.rollback(ACCOUNT, run.id, {}, 'local');
      expect(world.state.headscale.policy!.trim()).toBe(RESTRICTIVE);
    });
  });

  describe('finding 7: a failed undo stays visible and can be rolled back again', () => {
    it('a firewall rule whose undo failed is removed by the run rollback', async () => {
      const plan = await svc.plan(ACCOUNT, 'wireguard', {
        wireguard: {
          address: '10.77.0.1/24',
          peers: [{ publicKey: PEER, allowedIps: ['10.77.0.2/32'] }],
        },
      });
      await applyThrough(plan.id, 'trust.cert');
      flaky.rules.push(
        { match: argvStarts('ufw', 'allow'), nth: 2, stderr: 'ERROR: problem running iptables' },
        { match: argvStarts('ufw', 'delete'), nth: 1, stderr: 'ERROR: problem running iptables' },
      );
      let run = await applyThrough(plan.id, 'firewall.ports');
      const fw = stepOf(run, 'firewall.ports');
      expect(fw.status).toBe('rollback_failed');
      expect(fw.error).toMatch(
        /ufw allow 51820\/udp failed.*undoing it failed too: ufw delete allow failed/,
      );
      expect(world.state.ufw.added.some((l) => l.includes('7419'))).toBe(true);
      expect(run.status).toBe('failed');
      expect(run.error).toContain('could not be undone');
      expect(audit.at(-1)).toMatchObject({
        action: 'network.setup.rollback',
        result: 'rollback_failed',
        actor: 'system',
      });
      expect(events.events.at(-1)?.payload).toMatchObject({ status: 'rollback_failed' });
      const again = await err(svc.apply(ACCOUNT, { runId: plan.id, stepId: fw.id }, 'local'));
      expect(again.details).toMatchObject({ reason: 'rollback_pending' });
      run = await svc.rollback(ACCOUNT, plan.id, {}, 'local');
      expect(stepOf(run, 'firewall.ports').status).toBe('rolled_back');
      expect(world.state.ufw.added).toEqual(['allow 22/tcp']);
      expect(run.status).toBe('rolled_back');
    });

    it('a route whose undo failed is withdrawn by the run rollback', async () => {
      const plan = await headscalePlan({ exitNode: false });
      await applyThrough(plan.id, 'mesh.up');
      flaky.rules.push(
        { match: argvStarts('headscale', 'nodes', 'list'), nth: 2 },
        { match: argvStarts('tailscale', 'set'), nth: 2, stderr: 'timeout waiting for tailscaled' },
      );
      let run = await applyThrough(plan.id, 'mesh.routes');
      const routes = stepOf(run, 'mesh.routes');
      expect(routes.status).toBe('rollback_failed');
      expect(routes.error).toContain('connection refused');
      expect(routes.error).toContain('timeout waiting for tailscaled');
      expect(world.state.tailscale.routes).toContain('192.168.1.0/24');
      run = await svc.rollback(ACCOUNT, plan.id, {}, 'local');
      expect(stepOf(run, 'mesh.routes').status).toBe('rolled_back');
      expect(world.state.tailscale.routes).toEqual([]);
    });
  });

  it('finding 8: a command that hangs past its timeout fails the step and frees the lock', async () => {
    const hang = new ProcessMeshRunner({
      bins: { hang: ['/bin/sh', '-c', 'sleep 30 & sleep 60'] },
    });
    flaky.rules.push({
      match: argvStarts('headscale', 'users', 'create'),
      nth: 1,
      replace: (cmd) => hang.run({ ...cmd, argv: ['hang'], timeoutMs: 300 }),
    });
    const plan = await headscalePlan();
    const user = stepOf(plan, 'server.user');
    const consent = { stepId: user.id, description: user.description };
    const first = await svc.apply(ACCOUNT, { runId: plan.id, consent }, 'local');
    expect(first.step.status).toBe('failed');
    expect(first.step.error).toContain('timed out');
    const retry = await svc.apply(ACCOUNT, { runId: plan.id, stepId: user.id }, 'local');
    expect(retry.step.status).toBe('verified');
  });

  describe('finding 9: WireGuard AllowedIPs that take over a path', () => {
    it('names what the routes cover', () => {
      const lan = ['192.168.1.0/24'];
      expect(wireguardRoutedTransports(['10.77.0.2/32'], lan)).toEqual([]);
      expect(wireguardRoutedTransports(['192.168.1.0/24'], lan)).toEqual(['lan']);
      expect(wireguardRoutedTransports(['192.168.0.0/16'], lan)).toEqual(['lan']);
      expect(wireguardRoutedTransports(['192.168.1.77/32'], lan)).toEqual(['lan']);
      expect(wireguardRoutedTransports(['0.0.0.0/0'], lan)).toEqual([
        'lan',
        'mesh',
        'relay',
        'direct',
      ]);
      expect(wireguardRoutedTransports(['0.0.0.0/1', '128.0.0.0/1'], lan)).toEqual([
        'lan',
        'mesh',
        'relay',
        'direct',
      ]);
      expect(wireguardRoutedTransports(['::/0'], [])).toEqual(['lan', 'mesh', 'relay', 'direct']);
      expect(wireguardRoutedTransports(['100.64.0.0/10'], lan)).toEqual(['mesh']);
      expect(wireguardRoutedTransports(['8.8.8.8/32'], lan)).toEqual(['relay', 'direct']);
      expect(wireguardRoutedTransports(['fd00:1::/64'], [])).toEqual(['lan']);
      expect(wireguardRoutedTransports(['fe80::/64'], [])).toEqual(['lan']);
      expect(wireguardRoutedTransports(['2001:db8::/32'], [])).toEqual(['relay', 'direct']);
    });

    it('a peer routing the LAN or the default route is guarded', async () => {
      world.update((s) => {
        s.installed.wg = true;
      });
      const run = await svc.plan(ACCOUNT, 'wireguard', {
        wireguard: {
          address: '10.77.0.1/24',
          peers: [{ publicKey: PEER, allowedIps: ['192.168.1.0/24', '0.0.0.0/0'] }],
        },
      });
      const up = stepOf(run, 'mesh.up');
      expect(up.affects).toEqual(['lan', 'mesh', 'relay', 'direct']);
      expect(up.description).toContain('192.168.1.0/24, 0.0.0.0/0');
      expect(up.description).toContain('can cut the lan, mesh, relay, direct paths');
      const e = await err(
        svc.apply(
          ACCOUNT,
          { runId: run.id, stepId: up.id, consent: { stepId: up.id, description: up.description } },
          'lan',
        ),
      );
      expect(e.details).toMatchObject({ reason: 'would_lock_out', transport: 'lan' });
      expect(world.state.wg.interfaces).toEqual([]);
    });
  });

  describe('hardening', () => {
    it('consent covers only the exact description the owner confirmed', async () => {
      const a = await headscalePlan();
      const ua = stepOf(a, 'server.user');
      await svc.apply(
        ACCOUNT,
        { runId: a.id, consent: { stepId: ua.id, description: ua.description } },
        'local',
      );
      // Same words: remembered.
      const b = await headscalePlan();
      expect(stepOf(b, 'server.user').consent.remembered).toBe(true);
      expect((await svc.apply(ACCOUNT, { runId: b.id }, 'local')).step.status).toBe('verified');
      // Another user: a different change, asked again.
      const c = await headscalePlan({ headscale: { user: 'ops' } });
      const uc = stepOf(c, 'server.user');
      expect(uc.consent.remembered).toBe(false);
      const ask = await err(svc.apply(ACCOUNT, { runId: c.id }, 'local'));
      expect(ask.details).toMatchObject({
        reason: 'consent_required',
        description: uc.description,
        changed: true,
      });
      await svc.apply(
        ACCOUNT,
        { runId: c.id, consent: { stepId: uc.id, description: uc.description } },
        'local',
      );
      expect(svc.consents(ACCOUNT).map((x) => x.description)).toEqual([uc.description]);
      // Descriptions carry no run-specific paths, so a re-plan of the same change matches.
      const acl1 = stepOf(await headscalePlan(), 'server.acl').description;
      const acl2 = stepOf(await headscalePlan(), 'server.acl').description;
      expect(acl1).toBe(acl2);
    });

    it('rolls back with host changes off, and audits that it did', async () => {
      const run = await applyThrough((await headscalePlan()).id, 'server.user');
      expect(world.state.headscale.users.map((u) => u.name)).toContain('nova');
      allow = false;
      const back = await svc.rollback(ACCOUNT, run.id, {}, 'local');
      expect(back.status).toBe('rolled_back');
      expect(world.state.headscale.users.map((u) => u.name)).toEqual(['admin']);
      expect(audit.at(-1)).toMatchObject({
        action: 'network.setup.rollback',
        result: 'rolled_back',
        detail: expect.objectContaining({ allowSystemChanges: false }) as unknown,
      });
      // Applying still needs the setting.
      const again = await err(svc.apply(ACCOUNT, { runId: run.id }, 'local'));
      expect(again.details).toMatchObject({ reason: 'system_changes_disabled' });
    });

    it('typed-in secrets leave the vault once used, undone or rolled back', async () => {
      world.update((s) => {
        s.tailscaleAuthKeys = ['tskey-auth-k1234567890'];
        s.headscale.apiKey = 'hs-api-key-0123456789';
      });
      // Managed Tailscale: the auth key goes once the Hub joined.
      const ts = await svc.plan(ACCOUNT, 'tailscale', {
        authKey: 'tskey-auth-k1234567890',
        firewall: false,
        certs: 'none',
      });
      const tsKey = `secret://network/setup/${ts.id}/auth-key`;
      expect(await secrets.has(tsKey)).toBe(true);
      await applyThrough(ts.id, 'mesh.up');
      expect(await secrets.has(tsKey)).toBe(false);
      await svc.rollback(ACCOUNT, ts.id, {}, 'local');

      // An auto-rolled-back join drops its key too.
      net.meshOk = false;
      const ts2 = await svc.plan(ACCOUNT, 'tailscale', {
        authKey: 'tskey-auth-k1234567890',
        firewall: false,
        certs: 'none',
      });
      expect(stepOf(await applyThrough(ts2.id, 'mesh.up'), 'mesh.up').status).toBe('rolled_back');
      expect(await secrets.list(`secret://network/setup/${ts2.id}/`)).toEqual([]);
      net.meshOk = true;

      // A remote Headscale's API key stays while its steps can still be undone, then goes.
      const hs = await svc.plan(ACCOUNT, 'headscale', {
        controlUrl: HS,
        headscale: { cliAddress: 'hs.example.com:50443', apiKey: 'hs-api-key-0123456789' },
        firewall: false,
      });
      const apiKey = `secret://network/setup/${hs.id}/headscale-api-key`;
      await applyThrough(hs.id, 'server.acl');
      expect(await secrets.has(apiKey)).toBe(true);
      await svc.rollback(ACCOUNT, hs.id, {}, 'local');
      expect(await secrets.list(`secret://network/setup/${hs.id}/`)).toEqual([]);
      expect(world.state.headscale.users.map((u) => u.name)).toEqual(['admin']);
    });
  });
});
