import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { hub, enroll, call } from './mesh-support.ts';
import { simulatedK3s } from '../support/k3s.ts';
import { startNetconfig } from '../../scripts/stand-ins/fake-netconfig.js';
import { createCore, renderClusterNetwork, type ClusterNetworkDocument, type Core } from '../../src/core/index.ts';
import { fakeToken } from '../support/infra.ts';

const empty = { live: null, previous: null, assigned: null };
async function setup(o: { capability?: boolean } = {}) {
  const sim = await simulatedK3s();
  let registrations: any[] = [];
  const h = await hub({ core: { now: () => new Date(sim.clock.now()), k3s: {
    registrations: () => registrations, ...(o.capability === false ? {} : { tools: () => sim.tools }), probeOrigin: () => sim.origin,
    clock: sim.clock,
  } } as any });
  h.clock.t = sim.clock.now();
  h.core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
  const id = h.core.mesh.identity.id;
  h.core.db.run("UPDATE device SET platform = 'linux x64', purposes = '[\"general-server\"]' WHERE id = ?", id);
  sim.cluster.hubId = id;
  sim.change(s => { s.nodes[0]!.labels['nova/device'] = id; });
  const token = fakeToken();
  const net = await startNetconfig({ file: join(sim.home, 'network.json'), token, initial: { schema: 1, cluster: 'simulation', namespace: 'nova-services', services: {} } });
  const target = h.core.network.createTarget({ name: 'Simulated cluster network', kind: 'firewall', url: net.url });
  h.core.network.setToken(target.id, token);
  const reviewPhone = await enroll(h, { name: 'Review phone', kind: 'phone' });
  registrations = [{ id: 'simulation', namespace: 'nova-services', hubId: id, deviceIds: [id], sites: [], networkTarget: target.id, services: [sim.definition('1'), sim.definition('2')] }];
  sim.tools.network = {
    read: async signal => {
      const r = await fetch(net.url, { headers: { authorization: `Bearer ${token}` }, signal });
      assert.equal(r.status, 200);
      const text = await r.text();
      return { document: JSON.parse(text) as ClusterNetworkDocument, policies: (sim.read() as any).networkPolicies ?? [], text, version: r.headers.get('etag')!.replace(/^"|"$/g, '') };
    },
    write: async (document, text, version, signal) => {
      const policies = renderClusterNetwork(document, registrations[0]);
      const r = await fetch(net.url, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'if-match': `"${version}"` }, body: text, signal });
      if (!r.ok) throw new Error(`Simulated network CAS refused: ${r.status}`);
      const out = { version: r.headers.get('etag')!.replace(/^"|"$/g, '') };
      sim.change(s => { (s as any).networkPolicies = policies; });
      return out;
    },
  };
  const base = '/services/clusters/simulation/echo';
  const settle = async (id: string) => { await h.core.ledger.idle(); return h.core.ledger.get(id); };
  const network = async (version = '1', expected = empty) => {
    const r = await h.c('POST', `${base}/network`, { version, expected });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.change?.id, 'route creates a real M10d change');
    await settle(r.body.task.id);
    const change = h.core.network.view(r.body.change.id);
    const apply = change.tasks.find(t => t.step === 'apply')!;
    assert.equal(apply.approval_tier, 3);
    h.core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await settle(apply.id)).state, 'done');
    h.core.network.contact(reviewPhone.dev.deviceId, { onHub: false });
    return change.id;
  };
  let hubStopped = false;
  const restarted: Core[] = [];
  return { sim, h, net, target, base, settle, network, registrations,
    async restart() {
      await h.stop(); hubStopped = true;
      const core = createCore({ home: h.home, version: '0.1.0', trustedOrigin: () => false, now: () => new Date(sim.clock.now()), k3s: { registrations: () => registrations, tools: () => sim.tools, probeOrigin: () => sim.origin, clock: sim.clock } });
      restarted.push(core); return core;
    },
    async stop() { if (!hubStopped) await h.stop(); for (const core of restarted) await core.close(); await net.close(); await sim.close(); },
  };
}

test('cluster API creates real approved Waiting work during control-plane loss and retries the same unchanged task', async () => {
  const s = await setup();
  try {
    const change = await s.network();
    s.sim.change(x => { x.reachable = false; });
    const r = await s.h.c('POST', `${s.base}/deploy`, { version: '1', expected: empty, network_change: change });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.id);
    s.h.core.ledger.approve(r.body.id);
    let task = await s.settle(r.body.id);
    assert.equal(task.state, 'waiting');
    assert.match(task.reason!, /control plane/i);
    assert.equal(task.attempts, 0);
    assert.ok(!s.sim.calls().some(c => c.operation === 'prepare-workload'));
    s.sim.change(x => { x.reachable = true; });
    assert.equal((await s.h.c('POST', `${s.base}/tasks/${task.id}/retry`, {})).status, 200);
    task = await s.settle(task.id);
    assert.equal(task.state, 'done', JSON.stringify({ reason: task.reason, transcript: s.sim.transcript, events: s.h.core.ledger.events(task.id) }));
    assert.deepEqual(task.brief.inputs?.expected, empty);
    assert.equal(await s.sim.serving(), null, 'ready alongside is not serving');
    assert.equal(s.sim.calls().filter(c => c.tool === 'kubectl' && c.operation === 'prepare-workload').length, 1);
  } finally { await s.stop(); }
});

test('read-only callers, unknown cluster and forged internal tasks cannot perform cluster mutations', async () => {
  const s = await setup();
  try {
    const phone = await enroll(s.h, { name: 'Read only', kind: 'phone' });
    const headers = { authorization: `Bearer ${phone.token}` };
    assert.equal((await call(s.h.mesh, 'POST', `/api/v1${s.base}/deploy`, { version: '1', expected: empty, network_change: 'c0000000000' }, headers)).status, 403);
    assert.equal((await s.h.c('POST', '/services/clusters/missing/echo/deploy', { version: '1', expected: empty, network_change: 'c0000000000' })).status, 404);
    assert.equal((await s.h.c('POST', '/tasks', { owner: 'k3s-operations', title: 'forged', goal: 'run', evidence_required: [], inputs: { operation: 'deploy' } })).status, 403);
    assert.equal((await s.h.c('POST', `${s.base}/deploy`, { version: '1', expected: empty, network_change: 'c0000000000', argv: ['bad'] })).status, 400);
    assert.equal((await s.h.c('POST', `${s.base}/replicas`, { version: '1', expected: empty, replicas: 2 })).status, 409);
    assert.equal(s.sim.calls().filter(c => !['status'].includes(c.operation)).length, 0);
  } finally { await s.stop(); }
});

test('approved deploy compares state inside driver queue; observe cannot arm monitors or roll back', async () => {
  const sim = await simulatedK3s();
  try {
    await sim.driver.apply(sim.definition('1'));
    const before = sim.calls().length;
    const out = await sim.driver.apply(sim.definition('2'), undefined, empty);
    assert.equal(out.ok, false, 'stale caller approval is not replaced by a fresh read');
    assert.ok(sim.calls().slice(before).every(c => c.operation === 'status'));
    await sim.driver.switch('echo', '1');
    await sim.driver.close();
    const readOnly = sim.another();
    sim.change(x => { x.unhealthy = ['1']; });
    const n = sim.calls().length;
    assert.equal((await readOnly.observe('echo')).ok, true);
    assert.equal(sim.clock.timers.size, 0);
    assert.equal(await sim.serving(), null);
    assert.equal(sim.read().services.echo!.live, '1');
    assert.ok(sim.calls().slice(n).every(c => c.operation === 'status'));
  } finally { await sim.close(); }
});

async function deploy(s: Awaited<ReturnType<typeof setup>>, version = '1') {
  const snapshot = s.sim.read().services.echo;
  const expected = snapshot ? { live: snapshot.live, previous: snapshot.previous, assigned: snapshot.assigned } : empty;
  const change = await s.network(version, expected as typeof empty);
  const r = await s.h.c('POST', `${s.base}/deploy`, { version, expected, network_change: change });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.h.core.ledger.approve(r.body.id, { confirm: true });
  return s.settle(r.body.id);
}
const expectedOf = (s: Awaited<ReturnType<typeof setup>>) => {
  const r = s.sim.read().services.echo!;
  return { live: r.live, previous: r.previous, assigned: r.assigned };
};
async function promote(s: Awaited<ReturnType<typeof setup>>, version = '1') {
  const r = await s.h.c('POST', `${s.base}/promote`, { version, expected: expectedOf(s) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s.h.core.ledger.approve(r.body.id, { confirm: true });
  return s.settle(r.body.id);
}

test('absent launcher refuses actual cluster network and deploy APIs before credential reads or effects', async () => {
  const s = await setup({ capability: false });
  try {
    let reads = 0;
    const get = s.h.core.vault.get.bind(s.h.core.vault);
    s.h.core.vault.get = name => { reads++; return get(name); };
    for (const operation of ['network', 'deploy']) {
      const r = await s.h.c('POST', `${s.base}/${operation}`, { version: '1', expected: empty, ...(operation === 'deploy' ? { network_change: 'c0000000000' } : {}) });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.match(r.body.error, /broker|capability/i);
    }
    assert.equal(reads, 0);
    assert.equal(s.net.hits.length, 0);
    assert.deepEqual(s.sim.calls(), []);
    assert.equal(s.h.core.network.list().changes.length, 0);
  } finally { await s.stop(); }
});

test('M10d lost network acknowledgement arms dead-man and restores exact original snapshot without cluster workload effects', async () => {
  const s = await setup();
  try {
    const before = s.net.text();
    const write = s.sim.tools.network!.write;
    let lose = true;
    s.sim.tools.network!.write = async (...args) => { const result = await write(...args); if (lose) { lose = false; throw new Error('Simulated lost acknowledgement'); } return result; };
    const r = await s.h.c('POST', `${s.base}/network`, { version: '1', expected: empty });
    await s.settle(r.body.task.id);
    const apply = s.h.core.network.view(r.body.change.id).tasks.find(t => t.step === 'apply')!;
    assert.equal(apply.approval_tier, 3);
    assert.throws(() => s.h.core.ledger.approve(apply.id), /explicit/i);
    s.h.core.ledger.approve(apply.id, { confirm: true });
    await s.settle(apply.id);
    assert.equal(s.h.core.network.view(r.body.change.id).state, 'watching');
    assert.notEqual(s.net.text(), before);
    assert.equal((s.sim.read() as any).networkPolicies[0].kind, 'NetworkPolicy');
    s.sim.clock.advance(301000);
    s.h.core.network.sweep();
    await s.h.core.ledger.idle();
    assert.equal(s.h.core.network.view(r.body.change.id).state, 'reverted');
    assert.equal(s.net.text(), before);
    assert.deepEqual((s.sim.read() as any).networkPolicies, []);
    assert.ok(s.sim.calls().every(c => c.operation === 'status'));
  } finally { await s.stop(); }
});

test('network gate rejects unapproved, substituted, replayed and raw arbitrary artifacts', async () => {
  const s = await setup();
  try {
    const r = await s.h.c('POST', `${s.base}/network`, { version: '1', expected: empty });
    await s.settle(r.body.task.id);
    const proposal = await s.h.c('POST', `${s.base}/deploy`, { version: '1', expected: empty, network_change: r.body.change.id });
    s.h.core.ledger.approve(proposal.body.id);
    assert.equal((await s.settle(proposal.body.id)).state, 'waiting');
    assert.ok(s.sim.calls().every(c => c.operation === 'status'));
    const apply = s.h.core.network.view(r.body.change.id).tasks.find(t => t.step === 'apply')!;
    s.h.core.ledger.approve(apply.id, { confirm: true }); await s.settle(apply.id);
    const swapped = await s.h.c('POST', `${s.base}/deploy`, { version: '2', expected: empty, network_change: r.body.change.id });
    assert.equal(swapped.status, 409);
    const target = s.h.core.network.createTarget({ name: 'Wrong target', kind: 'firewall', url: s.net.url });
    assert.equal(await s.h.core.network.appliedBinding(r.body.change.id, target.id, {}), false);
    assert.throws(() => renderClusterNetwork({ schema: 1, cluster: 'simulation', namespace: 'nova-services', services: { echo: { state: [empty], versions: [{ version: '1', egress: 'internet' }] } } }, s.registrations[0]), /immutable/);
    assert.throws(() => renderClusterNetwork({ schema: 1, cluster: 'simulation', namespace: 'nova-services', services: {}, manifest: 'secret' }, s.registrations[0]), /Invalid/);
    assert.equal((await s.h.c('POST', '/network/changes', { target: s.target.id, patch: { public: 'a'.repeat(64) } })).status, 400, 'generic secret-looking values remain rejected');
    s.h.core.ledger.retry(proposal.body.id);
    assert.equal((await s.settle(proposal.body.id)).state, 'done');
    const again = await s.h.c('POST', `${s.base}/deploy`, { version: '1', expected: empty, network_change: r.body.change.id });
    assert.equal(again.body.id, proposal.body.id);
    assert.equal(s.sim.calls().filter(c => c.tool === 'kubectl' && c.operation === 'prepare-workload').length, 1);
  } finally { await s.stop(); }
});

test('changed state is rejected at the real server CAS after network authorization; current role revocation blocks queued execution', async () => {
  const s = await setup();
  try {
    const change = await s.network();
    const execute = s.sim.tools.execute;
    s.sim.tools.execute = async (op, signal) => {
      if (op.operation === 'prepare-workload') s.sim.change(x => { x.services.echo!.assigned = { version: 'other', want: 'alongside', at: new Date(s.sim.clock.now()).toISOString() }; x.services.echo!.revision++; });
      return execute(op, signal);
    };
    const r = await s.h.c('POST', `${s.base}/deploy`, { version: '1', expected: empty, network_change: change });
    s.h.core.ledger.approve(r.body.id);
    assert.equal((await s.settle(r.body.id)).state, 'waiting');
    assert.equal(s.sim.read().services.echo!.versions.length, 0);
    assert.equal(s.sim.read().services.echo!.assigned!.version, 'other');
    s.sim.tools.execute = execute;
    const p = await s.h.c('POST', `${s.base}/promote`, { version: '1', expected: expectedOf(s) });
    s.h.core.db.run("UPDATE device SET purposes = '[]' WHERE id = ?", s.h.core.mesh.identity.id);
    s.h.core.ledger.approve(p.body.id);
    const task = await s.settle(p.body.id);
    assert.equal(task.state, 'waiting');
    assert.equal(task.attempts, 0);
  } finally { await s.stop(); }
});

for (const lost of ['prepare-workload', 'validate'] as const) test(`lost ${lost} acknowledgement reconciles without replaying a cluster mutation`, async () => {
  const s = await setup();
  try {
    const execute = s.sim.tools.execute;
    let lostOnce = false;
    s.sim.tools.execute = async (op, signal) => { const result = await execute(op, signal); if (op.operation === lost && !lostOnce) { lostOnce = true; throw new Error('Lost response'); } return result; };
    const t = await deploy(s);
    assert.equal(t.state, 'waiting');
    assert.equal(t.attempts, 1);
    const effects = s.sim.calls().filter(c => c.operation !== 'status').length;
    s.h.core.ledger.retry(t.id);
    assert.equal(s.h.core.ledger.get(t.id).approved_at, null);
    s.h.core.ledger.approve(t.id);
    const reconciled = await s.settle(t.id);
    assert.equal(reconciled.state, lost === 'validate' ? 'done' : 'waiting', reconciled.reason!);
    assert.equal(s.sim.calls().filter(c => c.operation !== 'status').length, effects);
  } finally { await s.stop(); }
});

test('interrupted canary remains unverified after elapsed time; cancellation before effects stops the task', async () => {
  const s = await setup();
  try {
    assert.equal((await deploy(s)).state, 'done');
    s.sim.clock.onSleep = () => { throw new Error('Interrupted process'); };
    const task = await promote(s);
    assert.equal(task.state, 'waiting');
    assert.equal(s.sim.read().services.echo!.live, '1');
    s.sim.clock.onSleep = null;
    s.sim.clock.advance(180000);
    s.h.core.ledger.retry(task.id); s.h.core.ledger.approve(task.id);
    assert.equal((await s.settle(task.id)).state, 'waiting');
    assert.equal(s.sim.calls().filter(c => c.operation === 'switch').length, 1);
    s.h.core.ledger.cancel(task.id);
    assert.equal(s.h.core.ledger.get(task.id).state, 'cancelled');
    const p = await s.h.c('POST', `${s.base}/promote`, { version: '1', expected: expectedOf(s) });
    s.h.core.ledger.cancel(p.body.id);
    assert.throws(() => s.h.core.ledger.retry(p.body.id));
    assert.equal(s.sim.calls().filter(c => c.operation === 'switch').length, 1);
  } finally { await s.stop(); }
});

test('trusted topology preserves independent node, readiness, workload and control-plane ages; GET never mutates', async () => {
  const s = await setup();
  try {
    const native = await enroll(s.h, { name: 'Native outside cluster', kind: 'computer', platform: 'linux x64', purposes: ['general-server'] });
    s.registrations[0].sites = [{ id: 'cloud-site', name: 'Explicit cloud' }];
    s.sim.change(x => { x.nodes.push({ healthy: true, labels: { 'nova/device': 'cloud-site' } }); x.nodes.push({ healthy: true, labels: { 'nova/device': 'untrusted-node' } }); });
    assert.equal((await deploy(s)).state, 'done');
    assert.equal((await promote(s)).state, 'done');
    const effects = s.sim.calls().filter(c => c.operation !== 'status').length;
    const read = async () => (await s.h.c('GET', '/services/topology')).body;
    const before = await read();
    const row = before.machines.find((m: any) => m.id === s.h.core.mesh.identity.id);
    assert.ok(row.observations.some((o: any) => o.source === 'local'));
    assert.ok(row.observations.some((o: any) => o.source === 'cluster'));
    assert.equal(before.machines.find((m: any) => m.id === 'cloud-site').kind, 'cloud');
    assert.ok(before.machines.some((m: any) => m.id === native.dev.deviceId));
    assert.ok(!before.machines.some((m: any) => m.id === 'untrusted-node'));
    const service = row.services.find((v: any) => v.service === 'echo');
    assert.equal(service.assigned.want, 'live');
    assert.ok(service.observations.some((o: any) => /readiness/.test(o.reason)));
    const health = service.observations.find((o: any) => /health measurement/.test(o.reason));
    s.sim.change(x => { x.reachable = false; }); s.sim.clock.advance(30000);
    let map = await read();
    let after = map.machines.find((m: any) => m.id === row.id).services.find((v: any) => v.service === 'echo');
    assert.notEqual(after.health, 'failed');
    assert.equal(after.observations.find((o: any) => /health measurement/.test(o.reason)).at, health.at);
    assert.equal(after.observations.find((o: any) => /health measurement/.test(o.reason)).age_ms, 30000);
    assert.ok(after.observations.some((o: any) => /Control plane/.test(o.reason)));
    s.sim.clock.advance(121000); map = await read();
    after = map.machines.find((m: any) => m.id === row.id).services.find((v: any) => v.service === 'echo');
    assert.equal(after.observations.find((o: any) => /health measurement/.test(o.reason)).stale, true);
    s.sim.change(x => { x.reachable = true; });
    map = await read();
    after = map.machines.find((m: any) => m.id === row.id).services.find((v: any) => v.service === 'echo');
    assert.equal(after.observations.find((o: any) => /health measurement/.test(o.reason)).health, 'healthy');
    assert.ok(!after.observations.some((o: any) => /Control plane/.test(o.reason)));
    assert.equal(after.observations.find((o: any) => /readiness/.test(o.reason)).stale, true, 'recovery does not invent new readiness timestamps');
    assert.equal(s.sim.calls().filter(c => c.operation !== 'status').length, effects);
    assert.equal(s.sim.clock.timers.size, 0);
    s.h.core.db.run("UPDATE device SET trust = 'revoked' WHERE id = ?", row.id);
    assert.ok(!(await read()).machines.some((m: any) => m.id === row.id));
  } finally { await s.stop(); }
});

test('current trust change during awaited network authorization cannot reuse an old floating placement', async () => {
  const s = await setup();
  try {
    const another = await enroll(s.h, { name: 'Other Linux', kind: 'computer', platform: 'linux x64', purposes: ['general-server'] });
    const otherId = another.dev.deviceId;
    s.registrations[0].deviceIds.push(otherId);
    s.registrations[0].services[0].placement = { mode: 'floating', replicas: 1 };
    s.sim.change(x => { x.nodes.push({ healthy: true, labels: { ...x.nodes[0]!.labels, 'nova/device': otherId } }); });
    const change = await s.network();
    const read = s.sim.tools.network!.read;
    s.sim.tools.network!.read = async signal => {
      const result = await read(signal);
      s.h.core.db.run("UPDATE device SET trust = 'revoked' WHERE id = ?", s.h.core.mesh.identity.id);
      return result;
    };
    const p = await s.h.c('POST', `${s.base}/deploy`, { version: '1', expected: empty, network_change: change });
    s.h.core.ledger.approve(p.body.id);
    const task = await s.settle(p.body.id);
    assert.equal(task.state, 'waiting');
    assert.equal(s.sim.read().services.echo!.versions.length, 0, 'no effect may target the now revoked device');
    assert.equal(task.attempts, 0, 'revoked placement refused before commit');
  } finally { await s.stop(); }
});

test('requesting approver revocation and cancelling in-flight preflight prevent all workload effects', async () => {
  const s = await setup();
  try {
    const change = await s.network();
    const person = await enroll(s.h, { name: 'Approver', kind: 'phone' });
    s.h.core.db.run('UPDATE device SET can_approve = 1 WHERE id = ?', person.dev.deviceId);
    const p = await call(s.h.mesh, 'POST', `/api/v1${s.base}/deploy`, { version: '1', expected: empty, network_change: change }, { authorization: `Bearer ${person.token}` });
    assert.equal(p.status, 200);
    s.h.core.db.run('UPDATE device SET can_approve = 0 WHERE id = ?', person.dev.deviceId);
    s.h.core.ledger.approve(p.body.id);
    assert.equal((await s.settle(p.body.id)).attempts, 0);
    assert.ok(s.sim.calls().every(c => c.operation === 'status'));
    s.h.core.ledger.cancel(p.body.id);
    // A separate promotion preflight is paused before its first effect; cancellation must abort it.
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(r => { entered = r; });
    const wait = new Promise<void>(r => { release = r; });
    const execute = s.sim.tools.execute;
    s.sim.tools.execute = async (op, signal) => { entered(); await wait; signal?.throwIfAborted(); return execute(op, signal); };
    const next = await s.h.c('POST', `${s.base}/promote`, { version: '1', expected: empty });
    s.h.core.ledger.approve(next.body.id);
    await enteredPromise;
    s.h.core.ledger.cancel(next.body.id); release();
    assert.equal((await s.settle(next.body.id)).state, 'cancelled');
    assert.ok(s.sim.calls().every(c => c.operation === 'status'));
  } finally { await s.stop(); }
});

test('the ordinary ServiceManager cannot automatically select a cluster even when explicitly in its driver list', async () => {
  const { ServiceManager } = await import('../../src/core/index.ts');
  const sim = await simulatedK3s();
  try {
    const manager = new ServiceManager({ dir: join(sim.home, 'manager'), drivers: [sim.driver] });
    const result = manager.plan(sim.definition('1'));
    assert.equal(result.ok, false, 'cluster selection belongs only to explicit registered ledger operations');
    assert.deepEqual(sim.calls(), []);
  } finally { await sim.close(); }
});

test('restarting Core preserves same Waiting task and reconciles task-bound ready evidence without replay', async () => {
  const s = await setup();
  try {
    const execute = s.sim.tools.execute;
    let lost = false;
    s.sim.tools.execute = async (op, signal) => { const result = await execute(op, signal); if (op.operation === 'validate' && !lost) { lost = true; throw new Error('Lost result at process interruption'); } return result; };
    const task = await deploy(s);
    assert.equal(task.state, 'waiting');
    // The process stopped after the commit point, before receiving a report.
    s.h.core.db.run("UPDATE task SET state = 'active', report = NULL WHERE id = ?", task.id);
    const before = s.sim.calls().filter(c => c.operation !== 'status').length;
    const core = await s.restart();
    core.ledger.recover(); await core.ledger.idle();
    assert.equal(core.ledger.get(task.id).state, 'waiting');
    assert.equal(s.sim.calls().filter(c => c.operation !== 'status').length, before);
    core.k3s!.retry('simulation', 'echo', task.id, { kind: 'console' });
    core.ledger.approve(task.id);
    await core.ledger.idle();
    assert.equal(core.ledger.get(task.id).state, 'done');
    assert.deepEqual(core.ledger.get(task.id).brief.inputs, task.brief.inputs);
    assert.equal(s.sim.calls().filter(c => c.operation !== 'status').length, before);
  } finally { await s.stop(); }
});

test('normal promotion has actual canary evidence and manual rollback is tier2, with no prepare or network changes', async () => {
  const s = await setup();
  try {
    assert.equal((await deploy(s)).state, 'done');
    const one = await promote(s);
    assert.equal(one.state, 'done');
    assert.ok(s.h.core.ledger.events(one.id).some(e => e.kind === 'k3s_completed' && (e.detail as any).canary_completed === true));
    assert.equal((await deploy(s, '2')).state, 'done');
    assert.equal((await promote(s, '2')).state, 'done');
    const calls = s.sim.calls().length, writes = s.net.hits.filter((h: any) => h.method === 'PUT').length;
    const p = await s.h.c('POST', `${s.base}/rollback`, { version: '1', expected: expectedOf(s) });
    assert.equal(p.body.approval_tier, 2);
    s.h.core.ledger.approve(p.body.id);
    assert.equal((await s.settle(p.body.id)).state, 'done');
    assert.equal(await s.sim.serving(), '1');
    assert.ok(s.sim.calls().slice(calls).every(c => ['rollback', 'status'].includes(c.operation)));
    assert.equal(s.net.hits.filter((h: any) => h.method === 'PUT').length, writes);
  } finally { await s.stop(); }
});

test('console promotions require tier3 every time; unsupported state, secrets and alongside semantics refuse plainly', async () => {
  const s = await setup();
  try {
    const def = { ...s.sim.definition('1'), service: 'nova-console' };
    s.registrations[0].services.push(def);
    const route = '/services/clusters/simulation/nova-console/promote';
    const p = await s.h.c('POST', route, { version: '1', expected: empty });
    assert.equal(p.body.approval_tier, 3);
    assert.throws(() => s.h.core.ledger.approve(p.body.id), /explicit/);
    s.h.core.ledger.cancel(p.body.id);
    let version = 3;
    for (const change of [{ state: { volume: 'data' } }, { secrets: ['secret://echo/api'] }, { alongside: 'copy' }, { alongside: 'shadow' }, { alongside: 'none' }]) {
      const next = String(version++);
      s.registrations[0].services[0] = { ...s.sim.definition(next), ...change };
      const r = await s.h.c('POST', `${s.base}/deploy`, { version: next, expected: empty, network_change: 'c0000000000' });
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.ok(!s.sim.calls().some(c => c.operation !== 'status'));
    }
  } finally { await s.stop(); }
});

test('bound cluster targets never fall back to legacy credentials after configuration or capability removal', async () => {
  const s = await setup();
  try {
    const r = await s.h.c('POST', `${s.base}/network`, { version: '1', expected: empty });
    await s.settle(r.body.task.id);
    assert.equal(s.h.core.network.target(s.target.id).adapter, 'k3s-public');
    const apply = s.h.core.network.view(r.body.change.id).tasks.find(t => t.step === 'apply')!;
    let legacyReads = 0;
    const get = s.h.core.vault.get.bind(s.h.core.vault);
    s.h.core.vault.get = name => { if (name === `network/${s.target.id}/token`) legacyReads++; return get(name); };
    const before = s.net.hits.length;
    s.registrations.splice(0);
    s.h.core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await s.settle(apply.id)).state, 'failed');
    assert.equal(legacyReads, 0);
    assert.equal(s.net.hits.length, before);
  } finally { await s.stop(); }
});

test('node failure survives control-plane loss independently of healthy local heartbeat and later becomes stale', async () => {
  const s = await setup();
  try {
    s.sim.change(x => { x.nodes[0]!.healthy = false; });
    const read = async () => (await s.h.c('GET', '/services/topology')).body.machines.find((m: any) => m.id === s.h.core.mesh.identity.id);
    const before = await read();
    assert.equal(before.health, 'failed');
    assert.equal(before.observations.find((o: any) => o.source === 'local').health, 'healthy');
    const at = before.observations.find((o: any) => o.source === 'cluster').at;
    s.sim.change(x => { x.reachable = false; }); s.sim.clock.advance(30000);
    const after = await read();
    assert.equal(after.health, 'failed');
    assert.equal(after.observations.find((o: any) => o.health === 'failed').at, at);
    assert.equal(after.observations.find((o: any) => o.health === 'failed').age_ms, 30000);
    s.sim.clock.advance(121000);
    assert.equal((await read()).health, 'unknown');
  } finally { await s.stop(); }
});

test('snapshot node ages reject regressed evidence without resetting previous observations', async () => {
  const sim = await simulatedK3s();
  try {
    assert.equal((await sim.driver.observe('echo')).ok, true);
    const before = sim.driver.snapshot('echo')!;
    sim.clock.advance(1000);
    sim.change(s => { s.statusOverride = { ...before, sequence: before.sequence + 100, observed_at: new Date(sim.clock.now()).toISOString(), nodes: before.nodes!.map(n => ({ ...n, at: new Date(Date.parse(n.at) - 1000).toISOString() })) }; });
    assert.equal((await sim.driver.observe('echo')).ok, false);
    assert.equal(sim.driver.snapshot('echo')!.nodes![0]!.at, before.nodes![0]!.at);
  } finally { await sim.close(); }
});

test('matching canonical network intent without actual rendered policies cannot authorize workload preparation', async () => {
  const s = await setup();
  try {
    const change = await s.network();
    const actual = (s.sim.read() as any).networkPolicies;
    s.sim.change(x => { (x as any).networkPolicies = []; });
    const read = s.sim.tools.network!.read;
    s.sim.tools.network!.read = async signal => ({ ...await read(signal), policies: (s.sim.read() as any).networkPolicies });
    const p = await s.h.c('POST', `${s.base}/deploy`, { version: '1', expected: empty, network_change: change });
    s.h.core.ledger.approve(p.body.id);
    const t = await s.settle(p.body.id);
    assert.equal(t.state, 'waiting');
    assert.equal(t.attempts, 0);
    assert.equal(s.sim.read().services.echo!.versions.length, 0);
    actual[0].spec.egress = [{}];
    s.sim.change(x => { (x as any).networkPolicies = actual; });
    s.h.core.ledger.retry(t.id);
    assert.equal((await s.settle(t.id)).state, 'waiting');
    assert.equal(s.sim.read().services.echo!.versions.length, 0);
  } finally { await s.stop(); }
});

test('revoked launcher availability marks collection unavailable without refreshing cached evidence ages', async () => {
  const sim = await simulatedK3s();
  try {
    await sim.driver.observe('echo');
    const before = sim.driver.status('echo')[0]!;
    sim.tools.available = () => ({ ok: false, said: 'Broker capability revoked.' });
    sim.clock.advance(1000);
    assert.equal((await sim.driver.observe('echo')).ok, false);
    const after = sim.driver.status('echo')[0]!;
    assert.ok(after.failure);
    assert.equal(after.observed_at, before.observed_at);
    const failureAt = after.failure.at;
    sim.clock.advance(1000); await sim.driver.observe('echo');
    assert.equal(sim.driver.status('echo')[0]!.failure!.at, failureAt);
  } finally { await sim.close(); }
});

test('optional cluster composition preserves malformed-source diagnostics from the existing topology seam', async () => {
  const h = await hub({ core: { topologyCluster: () => ({}) as never } });
  try {
    const r = await h.c('GET', '/services/topology');
    assert.ok(r.body.issues.includes('Cluster observations malformed.'));
  } finally { await h.stop(); }
});
