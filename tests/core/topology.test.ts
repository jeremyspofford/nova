import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceStatus } from '../../src/core/services/driver.ts';
import { buildTopology, serializeTopology, projectService, type TopologyInput } from '../../src/core/services/topology.ts';

const at = '2026-11-01T12:00:00.000Z';
const input = (): TopologyInput => ({ captured_at: at, hub_id: 'remote', local_id: 'local', machines: [
  { id: 'local', name: 'Local', roles: ['standby'], observations: [{ source: 'heartbeat', health: 'healthy', at, reason: 'Present' }], services: [] },
  { id: 'remote', name: 'Home hub', roles: ['hub'], observations: [{ source: 'heartbeat', health: 'healthy', at, reason: 'Heartbeat received' }], services: [] },
] });

test('stable IDs merge cluster and heartbeat, worse wins; actual hub leads, native remains, cloud is explicit', () => {
  const snapshot = buildTopology({ ...input(), cluster: { machines: [
    { id: 'remote', name: 'Cluster alias', kind: 'machine', roles: ['worker'], observation: { health: 'degraded', at: '2026-11-01T11:59:30.000Z', reason: 'Node not ready' }, services: [] },
    { id: 'site', name: 'Cloud site', kind: 'cloud', roles: [], observation: { health: 'healthy', at, reason: 'Site checked' }, services: [] },
  ] } });
  assert.deepEqual(snapshot.machines.map(m => m.id), ['remote', 'local', 'site']);
  assert.equal(snapshot.machines[0]!.health, 'degraded');
  assert.deepEqual(snapshot.machines[0]!.observations.map(o => [o.source, o.reason, o.at, o.age_ms]), [
    ['heartbeat', 'Heartbeat received', at, 0], ['cluster', 'Node not ready', '2026-11-01T11:59:30.000Z', 30000],
  ]);
  assert.equal(snapshot.machines[2]!.kind, 'cloud');
  assert.equal(snapshot.mermaid, serializeTopology(snapshot));
});

test('stale, missing, malformed and failed cluster data cannot look healthy', () => {
  const data = input();
  data.machines[0]!.observations[0]!.at = '2020-01-01T00:00:00.000Z';
  data.machines[1]!.observations[0]!.at = null;
  const s = buildTopology({ ...data, cluster: { machines: [{ id: 'local', observation: { health: 'healthy', at } }] } as never });
  assert.equal(s.partial, true);
  assert.ok(s.machines.every(m => m.health === 'unknown' && m.observations[0]!.stale));
  const failed = buildTopology({ ...input(), cluster_error: true });
  assert.equal(failed.partial, true);
  assert.match(failed.issues.join(' '), /Cluster.*unavailable/);
});

test('Mermaid is a literal snapshot with generated IDs; hostile names never become directives', () => {
  const data = input();
  data.machines[0]!.name = 'Local"\nclick evil <script>#;&';
  const s = buildTopology(data);
  assert.equal(s.mermaid, 'flowchart TD\n  m0["Home hub | Verified"]\n  m1["Local#34; click evil #60;script#62;#35;#59;#38; | Verified"]\n  m0 --- m1\n');
});

test('reasons are bounded; service observations and eligible version policies determine actions', () => {
  const data = input();
  data.machines[0]!.services = [{ service: 'worker', driver: 'device', live: null, previous: 'v0', placement: 'local', observation: { source: 'workload', health: 'healthy', at, reason: 'x'.repeat(1000) }, assigned: { version: 'v1', want: 'live', at }, versions: [{ version: 'v1', status: 'ready', since: '2020-01-01T00:00:00.000Z', observed_at: at, promotion_tier: 3 }], authority: 'device' }];
  const service = buildTopology(data).machines[1]!.services[0]!;
  assert.equal(service.live, null, 'assignment is not serving');
  assert.equal(service.observations[0]!.reason.length, 240);
  assert.equal(service.versions[0]!.promote.tier, 3);
  assert.equal(service.versions[0]!.promote.available, true, 'report time, not version since');
  assert.equal(service.rollback.tier, 2);
  data.machines[0]!.services[0]!.versions[0]!.promotion_tier = null;
  assert.equal(buildTopology(data).machines[1]!.services[0]!.versions[0]!.promote.available, false);
  data.machines[0]!.observations[0]!.at = '2020-01-01T00:00:00.000Z';
  assert.equal(buildTopology(data).machines[1]!.services[0]!.rollback.available, false);
});

test('a second fresh report cannot make an old serving-health report current', () => {
  const data = input();
  data.machines[0]!.services = [{ service: 'worker', driver: 'device', live: 'v0', previous: null, placement: 'local', observation: { source: 'workload', health: 'healthy', at: '2020-01-01T00:00:00.000Z', reason: 'Old health' }, versions: [{ version: 'v1', status: 'ready', since: at, observed_at: at, promotion_tier: 2 }], authority: 'device' }];
  const s = buildTopology(data).machines[1]!.services[0]!;
  assert.equal(s.health, 'unknown');
  assert.equal(s.versions[0]!.promote.available, false);
});

test('cluster service disagreement retains both reasons and blocks stale actions; no revoked ID is reintroduced', () => {
  const data = input();
  const service = { service: 'worker', driver: 'device', live: 'v1', previous: 'v0', placement: 'local', observation: { source: 'workload' as const, health: 'healthy' as const, at, reason: 'Native healthy' }, versions: [], authority: 'device' as const };
  data.machines[0]!.services = [service];
  const s = buildTopology({ ...data, cluster: { machines: [{ id: 'local', name: 'Local', kind: 'machine', roles: [], observation: { health: 'healthy', at, reason: 'Node ready' }, services: [{ ...service, observation: { source: 'cluster', health: 'failed', at, reason: 'Pod stopped' } }] }, { id: 'revoked', name: 'Revoked', kind: 'machine', roles: [], observation: { health: 'healthy', at, reason: 'Ready' }, services: [] }] }, excluded_ids: ['revoked'] });
  const svc = s.machines[1]!.services[0]!;
  assert.equal(svc.health, 'failed');
  assert.deepEqual(svc.observations.map(o => o.reason), ['Native healthy', 'Pod stopped']);
  assert.ok(!s.machines.some(m => m.id === 'revoked'));
});

test('no-live readiness health keeps the receipt time of its evidence, not another version’s fresh report', () => {
  const old = '2026-11-01T11:00:00.000Z';
  for (const unrelatedStatus of ['failed', 'installed'] as const) {
    const status: ServiceStatus = {
      service: 'worker', driver: 'device', live: null, previous: null, soak_until: null, held: null,
      health: { ok: null, checked_at: null, said: null }, stable: {}, history: [],
      versions: [
        { version: 'v1', status: 'ready', since: '2020-01-01T00:00:00.000Z', said: null, ports: null, pid: null },
        { version: 'v2', status: unrelatedStatus, since: old, said: null, ports: null, pid: null },
      ],
    };
    const data = input();
    data.machines[0]!.services = [projectService(status, { source: 'workload', placement: 'local', at, authority: 'device', policies: [], reports: [{ version: 'v1', at: old }, { version: 'v2', at }] })];
    const service = buildTopology(data).machines[1]!.services[0]!;
    assert.equal(service.health, 'unknown', unrelatedStatus);
    assert.equal(service.status, 'Waiting');
    assert.equal(service.observations[0]!.at, old);
    assert.equal(service.observations[0]!.age_ms, 3600000);
    assert.equal(service.observations[0]!.stale, true);
    assert.deepEqual(service.versions.map(v => v.observed_at), [old, at]);
  }
});

test('ready candidates cannot replace stale or fresh null-health observations of a live version', () => {
  for (const liveAt of ['2026-11-01T11:00:00.000Z', at]) {
    const status: ServiceStatus = {
      service: 'worker', driver: 'device', live: 'v1', previous: 'v0', soak_until: null, held: null,
      health: { ok: null, checked_at: liveAt, said: null }, stable: {}, history: [],
      versions: [
        { version: 'v1', status: 'live', since: '2020-01-01T00:00:00.000Z', said: null, ports: null, pid: null },
        { version: 'v2', status: 'ready', since: at, said: null, ports: null, pid: null },
      ],
    };
    const data = input();
    data.machines[0]!.services = [projectService(status, { source: 'workload', placement: 'local', at: liveAt, authority: 'device', policies: [{ service: 'worker', version: 'v2', promotion_tier: 2 }], reports: [{ version: 'v1', at: liveAt }, { version: 'v2', at }] })];
    const service = buildTopology(data).machines[1]!.services[0]!;
    assert.equal(service.live, 'v1');
    assert.equal(service.health, 'unknown', liveAt);
    assert.equal(service.status, 'Waiting');
    assert.equal(service.observations[0]!.at, liveAt);
    assert.equal(service.observations[0]!.age_ms, liveAt === at ? 0 : 3600000);
    assert.equal(service.observations[0]!.stale, liveAt !== at);
    assert.match(service.observations[0]!.reason, /No verified service health/);
    assert.equal(service.versions.find(v => v.version === 'v2')!.promote.available, false);
    assert.equal(service.rollback.available, false);
  }
});
