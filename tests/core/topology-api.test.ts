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
    assert.equal((await h.c('POST', '/services/hub/worker/promote', { version: 'v1', confirm: 'worker@v1' })).status, 409);
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
