// Fixed expected state is public semantic data, never a permission grant. These regressions
// exercise real queues, console lock and native SQL effects, not an always-accepting mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supervised, deploy } from '../supervisor/services-support.ts';
import { fakeRelease } from '../supervisor/fake.ts';
import { standIn, freePort, whoami } from '../support/services.ts';
import { hub, call, enroll } from './mesh-support.ts';
import { DeviceWorkloads, serviceExpected, type ServiceExpectedState, type ServiceOutcome } from '../../src/core/index.ts';
import { standInUrl, standInSha, STAND_IN_NAME } from '../support/workloads.ts';

const state = serviceExpected;
test('expected state survives the actual manager/driver queue for both rollback and promotion source', async () => {
  const h = await supervised('nova-topology-expected-queue-', { timings: { canaryMs: 300, probeEveryMs: 50 } });
  const s = h.s, port = await freePort();
  const current = () => s.manager.status().find(v => v.service === 'stand-in')!;
  try {
    for (const v of ['1.0.0', '2.0.0', '3.0.0', '4.0.0']) { assert.equal((await deploy(s, standIn({ version: v, port, soak_s: 600 }))).ok, true); if (v < '3') assert.equal((await s.manager.promote('stand-in', v, `stand-in@${v}`)).ok, true); }
    const approved = state(current()); assert.deepEqual(approved, { live: '2.0.0', previous: '1.0.0', assigned: null });
    const ahead = s.manager.promote('stand-in', '3.0.0', 'stand-in@3.0.0');
    // Calls happen in this tick, before ahead can move traffic: both pass initial preflight.
    const rollback = s.manager.rollback('stand-in', 'rollback', () => {}, approved);
    const promotion = s.manager.promote('stand-in', '4.0.0', 'stand-in@4.0.0', () => {}, approved);
    assert.equal((await ahead).ok, true);
    const results = await Promise.all([rollback, promotion]);
    assert.ok(results.every(r => !r.ok), 'queued operations must refuse changed live/previous, not act on the new kept version');
    assert.deepEqual(state(current()), { live: '3.0.0', previous: '2.0.0', assigned: null });
    assert.equal((await whoami(port))!.version, '3.0.0');
    assert.equal(current().versions.find(v => v.version === '4.0.0')!.status, 'ready');
    assert.equal((await s.manager.promote('stand-in', '4.0.0', 'stand-in@4.0.0', () => {}, approved)).ok, false, 'stale-after-GET also refuses at manager preflight');
    assert.equal((await s.manager.rollback('stand-in', 'rollback')).ok, true, 'omitted guard preserves generic CLI semantics');
  } finally { await h.stop(); }
});

for (const action of ['promote', 'rollback']) test(`console ${action} enforces approved state inside its existing serialization`, async () => {
  const h = await supervised(`nova-topology-expected-console-${action}-`, { timings: { canaryMs: 150, probeEveryMs: 50 } });
  const s = h.s;
  try {
    fakeRelease(h.repo, 'v1.0.0', 'one-release'); fakeRelease(h.repo, 'v2.0.0', 'two-release');
    assert.equal((await s.deploy('v1.0.0')).ok, true);
    const approved = state(s.manager.status().find(v => v.service === 'nova-console')!);
    const ahead = s.deploy('v2.0.0');
    const busy = await s.services.switch('nova-console', 'v1.0.0', () => {}, approved);
    assert.equal(busy.ok, false, 'console lock refuses a concurrent effect');
    assert.equal((await ahead).ok, true);
    const pid = s.server!.pid;
    const result = action === 'promote' ? await s.services.switch('nova-console', 'v1.0.0', () => {}, approved) : await s.services.rollback('nova-console', { auto: false, reason: 'Approved old target', expected: approved });
    assert.equal(result.ok, false, 'stale console source/kept version cannot be resolved again at execution');
    assert.equal(s.state.releases.current, 'v2.0.0'); assert.equal(s.state.releases.previous, 'v1.0.0'); assert.equal(s.server!.pid, pid);
  } finally { await h.stop(); }
});

test('native supplied state binds observed live, previous and assignment under atomic mutation', async () => {
  const h = await hub();
  try {
    const d = await enroll(h, { name: 'Synthetic desktop', kind: 'computer', platform: 'linux x64', purposes: ['general-server'], capabilities: ['heartbeat'] });
    const heartbeat = (workloads: unknown[]) => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { version: '0.1.0', capabilities: ['heartbeat'], workloads }, { authorization: `Bearer ${d.token}` });
    await heartbeat([]);
    const definition = (version: string) => ({ service: 'worker', version, artifact: { program: { 'linux-x64': { url: standInUrl(), sha256: standInSha(), command: ['node', STAND_IN_NAME] } } }, ports: [{ name: 'api', port: 18790 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'none', placement: { mode: 'pinned', device: d.dev.deviceId }, secrets: [], os_permissions: [], egress: 'none' });
    for (const version of ['1', '2']) { assert.equal((await h.c('POST', '/services/devices/deploy', { definition: definition(version), confirm: `worker@${version}` })).status, 200); await heartbeat([{ service: 'worker', version, status: version === '1' ? 'live' : 'ready', health: true, since: new Date(h.clock.t).toISOString() }]); if (version === '1') assert.equal((await h.c('POST', `/services/devices/${d.dev.deviceId}/worker/promote`, { version, confirm: 'worker@1' })).status, 409); }
    // Set the real prior live intent before capturing the final alongside assignment.
    h.core.db.run("UPDATE device_workload SET previous = '1', want = 'alongside' WHERE device_id = ?", d.dev.deviceId);
    const row = h.core.db.get<any>('SELECT * FROM device_workload WHERE device_id = ?', d.dev.deviceId)!;
    const approved: ServiceExpectedState = { live: '1', previous: '1', assigned: { version: '2', want: 'alongside', at: row.assigned_at } };
    h.core.db.run("UPDATE device_workload SET want = 'stopped' WHERE device_id = ?", d.dev.deviceId);
    const before = h.core.db.get<any>('SELECT * FROM device_workload WHERE device_id = ?', d.dev.deviceId)!;
    const result = await h.c('POST', `/services/devices/${d.dev.deviceId}/worker/promote`, { version: '2', confirm: 'worker@2', expected: approved });
    assert.equal(result.status, 409, 'assignment drift after GET must not be overwritten');
    const workloads = new DeviceWorkloads({ db: h.core.db, log: h.core.log, now: () => new Date(h.clock.t), sign: () => '', publicKey: () => '', epoch: () => 1, hubId: () => h.core.mesh.identity.id, devices: () => [] });
    assert.equal((await workloads.driver(d.dev.deviceId).rollback('worker', { auto: false, reason: 'stale', expected: approved })).ok, false, 'direct driver also enforces the guard, not just API preflight');
    assert.deepEqual(h.core.db.get<any>('SELECT * FROM device_workload WHERE device_id = ?', d.dev.deviceId), before);
  } finally { await h.stop(); }
});

test('fixed hub API requires a closed bounded expected state and forwards exactly that public state', async () => {
  let calls = 0;
  const expected = { live: '2', previous: '1', assigned: null };
  const h = await hub({ core: { supervisor: { state: () => null, request: async () => { throw new Error('Unexpected generic request'); }, onProblem() {}, service: async request => { calls++; assert.deepEqual(request, { action: 'rollback', service: 'worker', confirm: 'rollback', expected }); return { ok: true, accepted: true, said: 'Accepted, not observed serving.' }; } } } });
  try {
    for (const bad of [undefined, null, [], {}, { ...expected, argv: [] }, { ...expected, live: 'x'.repeat(129) }, { ...expected, assigned: { version: '2', want: 'live', at: 'bad' } }, { ...expected, assigned: { version: '2', want: { toString: null }, at: '2026-10-29T10:00:00.000Z' } }]) {
      assert.equal((await h.c('POST', '/services/hub/worker/rollback', { confirm: 'rollback', ...(bad === undefined ? {} : { expected: bad }) })).status, 400);
    }
    assert.equal(calls, 0);
    assert.equal((await h.c('POST', '/services/hub/worker/rollback', { confirm: 'rollback', expected })).status, 200); assert.equal(calls, 1);
  } finally { await h.stop(); }
});

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { releaseRepo, scratch, api, until } from '../supervisor/support.ts';
import { SERVICE_TIMINGS } from '../supervisor/services-support.ts';
import { ROOT } from '../support/services.ts';

test('actual HTTP→IPC approved guard survives acknowledgement delay and a queued traffic change', async () => {
  const dir = scratch('nova-topology-ipc-queue-'), repo = releaseRepo(dir).repo;
  const h = await supervised('nova-topology-ipc-queue-', { dir, repo, make: (d, r) => new Supervisor({ dir: join(d, 'sup'), home: join(d, 'home'), repo: r, base: r, tests: [process.execPath, '--test', 'tests/release.test.js'], env: { PATH: process.env.PATH ?? '', NOVA_PORT: '0', NOVA_VAULT_KEY: 'file', NOVA_AGENT_EGRESS: 'none' }, timings: { ...SERVICE_TIMINGS, canaryMs: 300, probeEveryMs: 50 } }) });
  const s = h.s, port = await freePort();
  const base = () => `http://127.0.0.1:${s.server!.port}`;
  const current = () => s.manager.status().find(x => x.service === 'stand-in')!;
  try {
    for (const version of ['1.0.0', '2.0.0', '3.0.0']) { assert.equal((await deploy(s, standIn({ version, port, soak_s: 600 }))).ok, true); if (version !== '3.0.0') assert.equal((await s.manager.promote('stand-in', version, `stand-in@${version}`)).ok, true); }
    const snapshot = await api(base(), 'GET', '/api/v1/services/topology');
    const approved = snapshot.body.machines.flatMap((m: any) => m.services).find((v: any) => v.service === 'stand-in').rollback.expected;
    assert.deepEqual(approved, state(current()));
    // A real apply holds this service's queue, without changing its live/previous state.
    // Its actual health response is released only after IPC execution has entered the queue.
    const gate = join(dir, 'release-health'), file = join(dir, 'gate-service.js');
    let program = readFileSync(join(ROOT, 'scripts/stand-ins/fake-service.js'), 'utf8').replace('mkdirSync, readFileSync', 'existsSync, mkdirSync, readFileSync');
    program = program.replace("  if (url === '/health') return", "  if (url === '/health' && value('--gate-health')) { const gate = value('--gate-health'); writeFileSync(gate + '.asked', 'waiting'); const poll = setInterval(() => { if (existsSync(gate)) { clearInterval(poll); json(200, {ok:true}); } }, 20); req.on('close', () => clearInterval(poll)); return; }\n  if (url === '/health') return");
    writeFileSync(file, program);
    const hold = deploy(s, standIn({ version: '4.0.0', port, file, flags: ['--gate-health', gate], soak_s: 600 }));
    await until(() => existsSync(gate + '.asked'), 'real readiness probe holding the queue');
    const ahead = s.manager.promote('stand-in', '3.0.0', 'stand-in@3.0.0');
    const original = s.manager.rollback.bind(s.manager);
    const execution: { result: Promise<ServiceOutcome> | null } = { result: null };
    s.manager.rollback = (...args: Parameters<typeof original>) => { execution.result = original(...args); return execution.result; };
    const accepted = await api(base(), 'POST', '/api/v1/services/hub/stand-in/rollback', { confirm: 'rollback', expected: approved });
    assert.equal(accepted.status, 200); assert.equal(accepted.body.accepted, true);
    await until(() => execution.result !== null, '300ms execution callback queued, not merely acknowledged');
    writeFileSync(gate, 'release');
    assert.equal((await hold).ok, true); assert.equal((await ahead).ok, true);
    assert.equal((await execution.result!).ok, false, 'queued rollback cannot reinterpret its approved target after another promotion');
    assert.deepEqual(state(current()), { live: '3.0.0', previous: '2.0.0', assigned: null }); assert.equal((await whoami(port))!.version, '3.0.0');
    assert.equal((await api(base(), 'POST', '/api/v1/services/hub/stand-in/rollback', { confirm: 'rollback', expected: approved })).status, 409, 'actual IPC preflight also refuses a stale GET guard');
    await until(async () => JSON.stringify((await api(base(), 'GET', '/api/v1/problems')).body).includes('was refused when it ran'), 'asynchronous refusal reported to the actual core');
  } finally { await h.stop(); }
});
