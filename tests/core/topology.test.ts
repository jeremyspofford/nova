import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceStatus } from '../../src/core/services/driver.ts';
import { buildTopology, serializeTopology, projectService, supervisorServices, type TopologyInput } from '../../src/core/services/topology.ts';

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

function supervisorState(heldAt: string | null, observedAt = at, healthAt: string | null = '2026-11-01T11:50:00.000Z'): import('../../src/core/resilience/link.ts').SupervisorState {
  return {
    v: 1, pid: 1, mode: 'running', since: at,
    server: { pid: 2, port: 0, started_at: at, restarts: 0, last_exit: null, code: 'SECRET path' },
    safe_mode: null, health: { last_check_at: healthAt, last_ok_at: healthAt, failing: 0, said: 'SECRET health' },
    releases: { current: 'base', previous: null, last_good: null, slots: [] }, deploy: null, history: [], observed_at: observedAt, service_policies: [],
    services: [{ service: 'worker', driver: 'supervisor', live: 'v1', previous: null, soak_until: null,
      held: heldAt ? { at: heldAt, reason: 'SECRET process output' } : null,
      health: { ok: healthAt ? true : null, checked_at: healthAt, said: 'SECRET health' }, stable: {}, history: [],
      versions: [{ version: 'v1', status: 'live', since: at, said: null, ports: null, pid: null }],
    }],
  };
}

test('supervisor hold attestation is independent of hold occurrence and measured health', () => {
  const old = '2026-11-01T11:50:00.000Z';
  for (const heldAt of [at, old]) for (const healthAt of [old, at, null]) {
    const data = input();
    data.machines[0]!.services = supervisorServices(supervisorState(heldAt, at, healthAt), true, 'local', at, 'base').services;
    const snapshot = buildTopology(data), service = snapshot.machines[1]!.services.find(s => s.service === 'worker')!;
    assert.equal(service.status, 'Failed', `held ${heldAt}, health ${healthAt}`);
    const held = service.observations.find(o => /held/.test(o.reason))!;
    assert.equal(held.at, at);
    assert.equal(held.stale, false);
    assert.match(held.reason, new RegExp(heldAt.replaceAll('.', '\\.')), 'hold occurrence remains available');
    const health = service.observations.find(o => /healthy|No verified/.test(o.reason))!;
    assert.equal(health.at, healthAt);
    assert.equal(health.age_ms, healthAt === at ? 0 : healthAt ? 600000 : null);
    assert.equal(health.health, healthAt === at ? 'healthy' : 'unknown');
    assert.match(snapshot.mermaid, /worker.*Failed/);
    assert.ok(!JSON.stringify(service).includes('SECRET'));
  }
});

test('stale supervisor hold attestations expire and recovery cannot refresh old health', () => {
  const old = '2026-11-01T11:50:00.000Z';
  for (const heldAt of [old, null]) for (const healthAt of [old, at]) {
    const state = supervisorState(heldAt, heldAt ? old : at, healthAt);
    const data = input();
    data.machines[0]!.services = supervisorServices(state, true, 'local', at, 'base').services;
    const service = buildTopology(data).machines[1]!.services.find(s => s.service === 'worker')!;
    assert.equal(service.status, !heldAt && healthAt === at ? 'Verified' : 'Waiting');
    assert.equal(service.observations[0]!.at, healthAt);
    if (heldAt) assert.equal(service.observations.find(o => /held/.test(o.reason))!.health, 'unknown');
  }
});

test('stopped console attestation expires independently of its last health check', () => {
  const old = '2026-11-01T11:50:00.000Z';
  for (const observedAt of [at, old]) {
    const state = supervisorState(null, observedAt); state.mode = 'stopped';
    const data = input();
    data.machines[0]!.services = supervisorServices(state, true, 'local', at, 'base').services;
    const service = buildTopology(data).machines[1]!.services.find(s => s.service === 'nova-console')!;
    assert.equal(service.status, observedAt === at ? 'Failed' : 'Waiting');
    assert.equal(service.observations.find(o => /console stopped/.test(o.reason))!.at, observedAt);
    const health = service.observations.find(o => /healthy/.test(o.reason))!;
    assert.equal(health.at, old);
    assert.equal(health.age_ms, 600000);
  }
});

test('only the assigned live native version can attest a current stopped workload', () => {
  const old = '2026-11-01T11:50:00.000Z';
  for (const c of [
    { want: 'live', assigned: 'v1', live: null, reportAt: at, assignedAt: old, expected: 'Failed' },
    { want: 'live', assigned: 'v1', live: null, reportAt: old, assignedAt: old, expected: 'Waiting' },
    { want: 'live', assigned: 'v1', live: null, reportAt: old, assignedAt: at, expected: 'Waiting' },
    { want: 'alongside', assigned: 'v1', live: null, reportAt: at, assignedAt: old, expected: 'Waiting' },
    { want: 'stopped', assigned: 'v1', live: null, reportAt: at, assignedAt: old, expected: 'Waiting' },
    { want: 'live', assigned: 'v2', live: null, reportAt: at, assignedAt: old, expected: 'Waiting' },
    { want: 'live', assigned: 'v1', live: 'v2', reportAt: at, assignedAt: old, expected: 'Verified' },
  ] as const) {
    const status: ServiceStatus = { service: 'worker', driver: 'device', live: c.live, previous: null, soak_until: null, held: null,
      health: { ok: c.live ? true : null, checked_at: c.live ? at : null, said: null }, stable: {}, history: [],
      versions: [{ version: 'v1', status: 'failed', since: old, said: 'SECRET output', ports: null, pid: null }, { version: 'v0', status: 'ready', since: old, said: null, ports: null, pid: null }],
    };
    const data = input();
    data.machines[0]!.services = [projectService(status, { source: 'workload', placement: 'local', at: status.health.checked_at, authority: 'device', policies: [], reports: [{ version: 'v1', at: c.reportAt }, { version: 'v0', at: old }], assigned: { version: c.assigned, want: c.want, at: c.assignedAt } })];
    const service = buildTopology(data).machines[1]!.services[0]!;
    assert.equal(service.status, c.expected, JSON.stringify(c));
    assert.equal(service.live, c.live);
    if (c.expected === 'Failed') {
      assert.equal(service.observations.find(o => o.health === 'failed')!.at, c.reportAt);
      assert.equal(service.observations[0]!.at, old, 'current failure does not refresh readiness');
      assert.equal(service.observations[0]!.age_ms, 600000);
      assert.equal(service.observations[0]!.health, 'unknown');
      assert.ok(!JSON.stringify(service).includes('SECRET'));
    }
  }
});
