import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hub, call, enroll } from './mesh-support.ts';

test('topology read is authenticated, unsupervised is honest, and missing mutation authority refuses', async () => {
  const h = await hub();
  try {
    const r = await h.c('GET', '/services/topology');
    assert.equal(r.status, 200);
    assert.equal(r.body.hub_id, h.core.mesh.identity.id);
    const local = r.body.machines.find((m: any) => m.id === h.core.mesh.identity.id);
    const console = local.services.find((s: any) => s.service === 'nova-console');
    assert.equal(console.driver, 'unsupervised');
    assert.equal(console.rollback.available, false);
    assert.match(console.observations[0].reason, /unsupervised/i);
    assert.equal((await call(h.mesh, 'GET', '/api/v1/services/topology')).status, 401);
    assert.equal((await h.c('POST', '/services/hub/worker/promote', { version: 'v1', confirm: 'worker@v1', expected: { live: null, previous: null, assigned: null } })).status, 409);
    const phone = await enroll(h);
    assert.equal((await call(h.mesh, 'POST', '/api/v1/services/hub/worker/rollback', { confirm: 'rollback' }, { authorization: `Bearer ${phone.token}` })).status, 403);
  } finally { await h.stop(); }
});

test('throwing/malformed cluster callbacks are partial; supervisor unavailable is not unsupervised', async () => {
  let fail = true;
  const h = await hub({ core: { topologyCluster: () => { if (fail) throw new Error('SECRET raw output'); return { machines: [null] } as never; }, supervisor: { state: () => null, request: async () => ({ ok: false, said: 'No' }), onProblem() {} } } });
  try {
    for (const throwing of [true, false]) {
      fail = throwing;
      const r = await h.c('GET', '/services/topology');
      assert.equal(r.status, 200);
      assert.equal(r.body.partial, true);
      assert.ok(!JSON.stringify(r.body).includes('SECRET'));
      const console = r.body.machines[0].services[0];
      assert.equal(console.health, 'unknown');
      assert.equal(console.driver, 'supervisor');
    }
  } finally { await h.stop(); }
});

test('native reports use hub receipt time, preserve assignment versus serving, and filter revoked devices', async () => {
  const { standInUrl, standInSha, STAND_IN_NAME } = await import('../support/workloads.ts');
  const h = await hub();
  try {
    const d = await enroll(h, { name: 'Study desktop', kind: 'computer', platform: 'linux x64', purposes: ['general-server', 'capture-source'], capabilities: ['heartbeat'] });
    const headers = { authorization: `Bearer ${d.token}` };
    const heartbeat = (workloads: unknown[] = []) => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat'], workloads }, headers);
    await heartbeat();
    const def = { service: 'worker', version: '1', artifact: { program: { 'linux-x64': { url: standInUrl(), sha256: standInSha(), command: ['node', STAND_IN_NAME] } } }, ports: [{ name: 'api', port: 18790 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'none', placement: { mode: 'pinned', device: d.dev.deviceId }, secrets: [], os_permissions: [], egress: 'none' };
    assert.equal((await h.c('POST', '/services/devices/deploy', { definition: def, confirm: 'worker@1' })).status, 200);
    const row = async () => (await h.c('GET', '/services/topology')).body.machines.find((m: any) => m.id === d.dev.deviceId);
    assert.equal((await row()).services[0].live, null);
    assert.equal((await row()).services[0].versions[0].promote.available, false);
    await heartbeat([{ service: 'worker', version: '1', status: 'ready', health: null, since: '2020-01-01T00:00:00.000Z', said: 'SECRET raw process output' }]);
    let svc = (await row()).services[0];
    assert.equal(svc.versions[0].promote.available, true);
    assert.equal(svc.versions[0].observed_at, new Date(h.clock.t).toISOString());
    assert.equal((await h.c('POST', `/services/devices/${d.dev.deviceId}/worker/promote`, { version: '1', confirm: 'worker@1' })).status, 200);
    svc = (await row()).services[0];
    assert.equal(svc.assigned.want, 'live');
    assert.equal(svc.live, null);
    assert.ok(!JSON.stringify(svc).includes('SECRET'));
    await heartbeat([{ service: 'worker', version: '1', status: 'live', health: true, since: '2020-01-01T00:00:00.000Z' }]);
    await call(h.mesh, 'POST', '/api/v1/mesh/capture/status', { queued: 0 }, headers);
    h.core.db.run('UPDATE capture_device_sync SET synced_to = ? WHERE device_id = ?', '2020-01-01T00:00:00.000Z', d.dev.deviceId);
    assert.equal((await row()).services[0].health, 'healthy', 'idle capture event age is not health');
    assert.equal((await row()).capture_lag.queued, 0);
    h.tick(120001);
    await heartbeat();
    assert.equal((await row()).services[0].health, 'unknown', 'a heartbeat alone does not refresh service reports');
    assert.equal((await row()).services[0].rollback.available, false);
    h.core.db.run("UPDATE device SET trust = 'revoked' WHERE id = ?", d.dev.deviceId);
    assert.equal(await row(), undefined);
  } finally { await h.stop(); }
});

test('remote active hub leads, local supervisor stays local; cloud sites require explicit cluster records', async () => {
  const h = await hub({ core: { topologyCluster: () => ({ machines: [{ id: 'site', name: 'Cloud site', kind: 'cloud', roles: [], observation: { health: 'healthy', at: '2026-10-29T10:00:00.000Z', reason: 'Site observed' }, services: [] }] }) } });
  try {
    const d = await enroll(h, { name: 'Future hub', kind: 'computer', platform: 'linux x64', purposes: ['general-server'], capabilities: ['heartbeat'] });
    h.core.db.run('UPDATE mesh_state SET hub_id = ? WHERE id = 1', d.dev.deviceId);
    h.core.db.run("UPDATE device SET address = 'https://arbitrary.example/cloud' WHERE id = ?", d.dev.deviceId);
    const map = (await h.c('GET', '/services/topology')).body;
    assert.equal(map.machines[0].id, d.dev.deviceId);
    assert.equal(map.machines[0].services.length, 0);
    assert.equal(map.machines.find((m: any) => m.id === h.core.mesh.identity.id).services[0].service, 'nova-console');
    assert.deepEqual(map.machines.filter((m: any) => m.kind === 'cloud').map((m: any) => m.id), ['site']);
  } finally { await h.stop(); }
});

test('native readiness health follows its own reports without replacing a live version’s observation', async () => {
  const { standInUrl, standInSha, STAND_IN_NAME } = await import('../support/workloads.ts');
  const h = await hub();
  try {
    const d = await enroll(h, { name: 'Study desktop', kind: 'computer', platform: 'linux x64', purposes: ['general-server'], capabilities: ['heartbeat'] });
    const headers = { authorization: `Bearer ${d.token}` };
    const heartbeat = (workloads: unknown[] = []) => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat'], workloads }, headers);
    const definition = (version: string) => ({ service: 'worker', version, artifact: { program: { 'linux-x64': { url: standInUrl(), sha256: standInSha(), command: ['node', STAND_IN_NAME] } } }, ports: [{ name: 'api', port: 18790 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'none', placement: { mode: 'pinned', device: d.dev.deviceId }, secrets: [], os_permissions: [], egress: 'none' });
    const deploy = (version: string) => h.c('POST', '/services/devices/deploy', { definition: definition(version), confirm: `worker@${version}` });
    const read = async () => (await h.c('GET', '/services/topology')).body.machines.find((m: any) => m.id === d.dev.deviceId).services[0];
    await heartbeat();
    assert.equal((await deploy('1')).status, 200);
    const readyAt = new Date(h.clock.t).toISOString();
    await heartbeat([{ service: 'worker', version: '1', status: 'ready', health: null, since: '2020-01-01T00:00:00.000Z' }]);
    assert.equal((await read()).status, 'Verified');
    h.tick(3600000);
    await heartbeat();
    assert.equal((await deploy('2')).status, 200);
    for (const status of ['failed', 'installed']) {
      await heartbeat([{ service: 'worker', version: '2', status, health: false, since: '2020-01-01T00:00:00.000Z' }]);
      const service = await read();
      assert.equal(service.live, null);
      assert.equal(service.health, 'unknown', status);
      assert.equal(service.status, 'Waiting');
      assert.equal(service.observations[0].at, readyAt);
      assert.equal(service.observations[0].age_ms, 3600000);
      assert.equal(service.observations[0].stale, true);
      assert.equal(service.versions.find((v: any) => v.version === '2').observed_at, new Date(h.clock.t).toISOString());
    }
    // A fresh report of the actual ready version can establish readiness again.
    await heartbeat([{ service: 'worker', version: '1', status: 'ready', health: null, since: '2020-01-01T00:00:00.000Z' }]);
    assert.equal((await read()).status, 'Verified');
    assert.equal((await read()).observations[0].at, new Date(h.clock.t).toISOString());
    // Once a version is live, its missing health is not supplied by candidate readiness.
    const liveAt = new Date(h.clock.t).toISOString();
    await heartbeat([{ service: 'worker', version: '1', status: 'live', health: null, since: '2020-01-01T00:00:00.000Z' }]);
    h.tick(3600000);
    await heartbeat([{ service: 'worker', version: '2', status: 'ready', health: null, since: '2020-01-01T00:00:00.000Z' }]);
    let service = await read();
    assert.equal(service.live, '1');
    assert.equal(service.health, 'unknown');
    assert.equal(service.status, 'Waiting');
    assert.equal(service.observations[0].at, liveAt);
    assert.equal(service.observations[0].age_ms, 3600000);
    assert.equal(service.versions.find((v: any) => v.version === '2').promote.available, false);
    // Even a fresh null-health live report stays unknown until serving health is observed.
    await heartbeat([{ service: 'worker', version: '1', status: 'live', health: null, since: '2020-01-01T00:00:00.000Z' }]);
    service = await read();
    assert.equal(service.health, 'unknown');
    assert.equal(service.observations[0].age_ms, 0);
    assert.equal(service.versions.find((v: any) => v.version === '2').promote.available, false);
    await heartbeat([{ service: 'worker', version: '1', status: 'live', health: true, since: '2020-01-01T00:00:00.000Z' }]);
    assert.equal((await read()).status, 'Verified');
  } finally { await h.stop(); }
});

test('native first-live failure stays Failed with its own receipt time, expires, and recovers', async () => {
  const { standInUrl, standInSha, STAND_IN_NAME } = await import('../support/workloads.ts');
  const h = await hub();
  try {
    const d = await enroll(h, { name: 'Failure test desktop', kind: 'computer', platform: 'linux x64', purposes: ['general-server'], capabilities: ['heartbeat'] });
    const heartbeat = async (workloads: unknown[] = []) => {
      const result = await call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat'], workloads }, { authorization: `Bearer ${d.token}` });
      assert.equal(result.status, 200);
    };
    const definition = (version: string) => ({ service: 'worker', version, artifact: { program: { 'linux-x64': { url: standInUrl(), sha256: standInSha(), command: ['node', STAND_IN_NAME] } } }, ports: [{ name: 'api', port: 18790 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'none', placement: { mode: 'pinned', device: d.dev.deviceId }, secrets: [], os_permissions: [], egress: 'none' });
    const read = async () => {
      const response = await h.c('GET', '/services/topology'); assert.equal(response.status, 200);
      return { snapshot: response.body, service: response.body.machines.find((m: any) => m.id === d.dev.deviceId).services[0] };
    };
    const report = (version: string, status: string, health: boolean | null) => ({ service: 'worker', version, status, health, since: '2020-01-01T00:00:00.000Z', said: 'SECRET device process output' });
    await heartbeat();
    assert.equal((await h.c('POST', '/services/devices/deploy', { definition: definition('1'), confirm: 'worker@1' })).status, 200);
    await heartbeat([report('1', 'ready', null)]);
    assert.equal((await h.c('POST', `/services/devices/${d.dev.deviceId}/worker/promote`, { version: '1', confirm: 'worker@1' })).status, 200);
    h.tick(1000);
    const failedAt = new Date(h.clock.t).toISOString();
    await heartbeat([report('1', 'failed', false)]);
    let { service, snapshot } = await read();
    assert.equal(service.status, 'Failed');
    assert.equal(service.live, null);
    assert.equal(service.previous, null);
    assert.equal(service.assigned.want, 'live');
    assert.equal(service.observations.find((o: any) => o.health === 'failed').at, failedAt);
    assert.match(snapshot.mermaid, /worker.*No observed serving version.*Failed/);
    assert.ok(!JSON.stringify(service).includes('SECRET'));
    h.tick(120000);
    await heartbeat();
    ({ service } = await read());
    assert.equal(service.status, 'Waiting');
    const expired = service.observations.find((o: any) => /failed/.test(o.reason));
    assert.equal(expired.at, failedAt);
    assert.equal(expired.age_ms, 120000);
    assert.equal(expired.stale, true);
    assert.equal(expired.health, 'unknown');
    await heartbeat([report('1', 'live', true)]);
    ({ service } = await read());
    assert.equal(service.status, 'Verified');
    assert.equal(service.live, '1');
    assert.ok(service.observations.every((o: any) => o.health !== 'failed'));
    // An unrelated failed alongside candidate does not turn healthy serving work into Failed.
    assert.equal((await h.c('POST', '/services/devices/deploy', { definition: definition('2'), confirm: 'worker@2' })).status, 200);
    await heartbeat([report('2', 'failed', false)]);
    ({ service } = await read());
    assert.equal(service.status, 'Verified');
    assert.equal(service.live, '1');
    assert.equal(service.assigned.want, 'alongside');
    assert.equal(service.versions.find((v: any) => v.version === '2').status, 'failed');
    // After promotion, a surviving observed live version is still distinct from the failed target.
    await heartbeat([report('2', 'ready', null)]);
    assert.equal((await h.c('POST', `/services/devices/${d.dev.deviceId}/worker/promote`, { version: '2', confirm: 'worker@2' })).status, 200);
    await heartbeat([report('2', 'failed', false)]);
    ({ service } = await read());
    assert.equal(service.assigned.want, 'live');
    assert.equal(service.live, '1');
    assert.equal(service.status, 'Verified');
    await heartbeat([report('1', 'live', null)]);
    assert.equal((await read()).service.status, 'Waiting', 'candidate failure cannot replace actual live unknown health');
    await heartbeat([report('1', 'kept', null)]);
    ({ service } = await read());
    assert.equal(service.live, null);
    assert.equal(service.status, 'Failed', 'a kept version does not establish current serving');
  } finally { await h.stop(); }
});

test('supervisor API keeps hold occurrence, current stop attestation and health ages separate', async () => {
  const now = '2026-10-29T10:00:00.000Z', old = '2026-10-29T09:50:00.000Z';
  const state: import('../../src/core/resilience/link.ts').SupervisorState = {
    v: 1, pid: 1, mode: 'running', since: old,
    server: { pid: 2, port: 0, started_at: old, restarts: 0, last_exit: null, code: 'SECRET path' },
    safe_mode: { at: old, reason: 'SECRET raw failure', last_good: null, output: 'SECRET process output' },
    health: { last_check_at: old, last_ok_at: old, failing: 0, said: 'SECRET health' },
    releases: { current: 'base', previous: null, last_good: null, slots: [] }, deploy: null, history: [],
    observed_at: now, services: [], service_policies: [],
  };
  const h = await hub({ core: { supervisor: { state: () => state, request: async () => ({ ok: false, said: 'Unused' }), onProblem() {} } } });
  try {
    const read = async () => {
      const r = await h.c('GET', '/services/topology'); assert.equal(r.status, 200);
      return r.body.machines.find((m: any) => m.id === h.core.mesh.identity.id).services[0];
    };
    for (const holdAt of [now, old]) {
      state.safe_mode!.at = holdAt;
      const service = await read();
      assert.equal(service.status, 'Failed');
      assert.equal(service.live, 'base', 'driver live identity remains available to expected-state guards');
      assert.equal(service.rollback.expected.live, 'base');
      const held = service.observations.find((o: any) => /held/.test(o.reason));
      assert.equal(held.at, now); assert.ok(held.reason.includes(holdAt));
      const health = service.observations.find((o: any) => /healthy/.test(o.reason));
      assert.equal(health.at, old); assert.equal(health.age_ms, 600000); assert.equal(health.health, 'unknown');
      assert.ok(!JSON.stringify(service).includes('SECRET'));
    }
    h.tick(120000);
    assert.equal((await read()).status, 'Waiting');
    state.observed_at = new Date(h.clock.t).toISOString();
    state.safe_mode = null; state.mode = 'stopped';
    assert.equal((await read()).status, 'Failed');
    state.mode = 'running';
    assert.equal((await read()).status, 'Waiting', 'recovery cannot refresh old health');
    state.health.last_check_at = state.observed_at;
    assert.equal((await read()).status, 'Verified');
  } finally { await h.stop(); }
});
