import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hub, enroll, call } from './mesh-support.ts';
import { simulatedK3s } from '../support/k3s.ts';
import { startNetconfig } from '../../scripts/stand-ins/fake-netconfig.js';
import { createCore, renderClusterNetwork, unavailableClusterTools, type ClusterTools, type ClusterNetworkDocument, type Core } from '../../src/core/index.ts';
import { fakeToken } from '../support/infra.ts';

const empty = { live: null, previous: null, assigned: null };
async function setup(o: { capability?: boolean; beforeCore?: (sim: Awaited<ReturnType<typeof simulatedK3s>>) => void } = {}) {
  const sim = await simulatedK3s();
  try { o.beforeCore?.(sim); }
  catch (error) { await sim.close(); throw error; }
  let registrations: any[] = [];
  let provider: ClusterTools | undefined = sim.tools;
  const h = await hub({ core: { now: () => new Date(sim.clock.now()), k3s: {
    registrations: () => registrations, ...(o.capability === false ? {} : { tools: () => provider! }), probeOrigin: () => sim.origin,
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
    setProvider(next: ClusterTools | undefined) { provider = next; },
    async restart() {
      await h.stop(); hubStopped = true;
      const core = createCore({ home: h.home, version: '0.1.0', trustedOrigin: () => false, now: () => new Date(sim.clock.now()), k3s: { registrations: () => registrations, tools: () => provider!, probeOrigin: () => sim.origin, clock: sim.clock } });
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

for (const scenario of ['missing', 'explicit-unavailable', 'wrong-api-cluster', 'hostile-ambient'] as const) {
  // Catch discovery/fallback before even a status child, token read or target snapshot.
  // Wrong API identity is not proof of a future broker's endpoint/grant binding.
  test(`Step1 ${scenario}: fixed Core APIs refuse before any tool, legacy value read or target I/O`, async () => {
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH, KUBECONFIG: process.env.KUBECONFIG, NOVA_SIM_STATE: process.env.NOVA_SIM_STATE };
    const canary = 'step1-private-credential-canary';
    let marker = '';
    let kubeconfig = '';
    let config = '';
    let s: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      s = await setup({ capability: scenario === 'explicit-unavailable' || scenario === 'wrong-api-cluster', beforeCore(sim) {
        const bin = join(sim.home, 'refusal-bin');
        mkdirSync(bin, { mode: 0o700 });
        marker = join(sim.home, 'unexpected-spawn');
        for (const tool of ['kubectl', 'helm', 'flux', 'k3s', 'credential-plugin']) {
          writeFileSync(join(bin, tool), `#!${process.execPath}\nconst { appendFileSync } = require('node:fs');\nappendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(tool)} + '\\n');\nconsole.log(${JSON.stringify(canary)});\nconsole.error(${JSON.stringify(canary)});\nprocess.exit(97);\n`, { mode: 0o700 });
        }
        // Validate the private tripwire before Core exists, then clear its planted hit.
        const planted = spawnSync(join(bin, 'kubectl'), [], { encoding: 'utf8', timeout: 3000 });
        assert.equal(planted.status, 97, planted.stderr);
        assert.equal(readFileSync(marker, 'utf8'), 'kubectl\n');
        assert.equal(planted.stdout.trim(), canary);
        assert.equal(planted.stderr.trim(), canary);
        rmSync(marker);
        process.env.HOME = sim.home;
        process.env.PATH = bin; // Only this K3s test's disposable marker executables.
        if (scenario === 'hostile-ambient') {
          mkdirSync(join(sim.home, '.kube'), { mode: 0o700 });
          kubeconfig = join(sim.home, '.kube', 'config');
          config = JSON.stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': 'simulation', contexts: [{ name: 'simulation', context: { cluster: 'simulation', user: 'hostile' } }], clusters: [{ name: 'simulation', cluster: { server: sim.origin } }], users: [{ name: 'hostile', user: { token: canary, exec: { apiVersion: 'client.authentication.k8s.io/v1', command: join(bin, 'credential-plugin'), interactiveMode: 'Never' } } }] });
          writeFileSync(kubeconfig, config, { mode: 0o600 });
          process.env.KUBECONFIG = kubeconfig;
          process.env.NOVA_SIM_STATE = join(sim.home, 'cluster.json');
          sim.change(state => { state.statusOverride = { credential: canary }; });
        }
      } });
      let toolCalls = 0;
      const execute = s.sim.tools.execute;
      s.sim.tools.execute = async (...args) => { toolCalls++; return execute(...args); };
      if (scenario === 'explicit-unavailable') s.setProvider({
        available: unavailableClusterTools.available,
        execute: async (...args) => { toolCalls++; return unavailableClusterTools.execute(...args); },
      });
      let reads = 0;
      s.h.core.vault.get = () => { reads++; throw new Error(canary); };
      s.h.core.vault.resolve = () => { reads++; throw new Error(canary); };
      const before = s.sim.read();
      const target = s.net.text();
      const tasks = s.h.core.ledger.list();
      const output: unknown[] = [];
      const base = scenario === 'wrong-api-cluster' ? '/services/clusters/other-cluster/echo' : s.base;
      for (const operation of ['network', 'deploy', 'promote', 'rollback'] as const) {
        const r = await s.h.c('POST', `${base}/${operation}`, {
          version: '1', expected: operation === 'rollback' ? { live: '2', previous: '1', assigned: null } : empty,
          ...(operation === 'deploy' ? { network_change: 'c0000000000' } : {}),
        });
        output.push(r.body);
        assert.equal(r.status, scenario === 'wrong-api-cluster' ? 404 : 409, `${operation}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, scenario === 'wrong-api-cluster' ? /not registered/i : /broker|capability/i);
        assert.equal(toolCalls, 0, `${operation}: even status must not execute`);
        assert.equal(existsSync(marker), false, `${operation}: no ambient tool or exec plugin spawn`);
        assert.equal(reads, 0, `${operation}: no legacy value lookup`);
        assert.equal(s.net.hits.length, 0, `${operation}: no target read or write`);
        assert.deepEqual(s.sim.calls(), []);
        assert.deepEqual(s.sim.transcript, []);
        assert.deepEqual(s.h.core.ledger.list(), tasks, 'refusal does not create approvable work');
        assert.equal(s.h.core.network.list().changes.length, 0);
        assert.equal(s.net.text(), target);
        assert.deepEqual(s.sim.read(), before);
      }
      await s.h.core.ledger.idle();
      const log = s.h.core.log.file;
      assert.ok(!JSON.stringify({ output, tasks: s.h.core.ledger.list(), transcript: s.sim.transcript, log: log && existsSync(log) ? readFileSync(log, 'utf8') : '' }).includes(canary), 'private config/tool/vault canary never reaches Core output, ledger, transcript or log');
      if (kubeconfig) assert.equal(readFileSync(kubeconfig, 'utf8'), config, 'hostile ambient kubeconfig remains untouched');
    } finally {
      try { await s?.stop(); }
      finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
}

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
    assert.ok(existsSync(join(s.h.home, 'services', 'k3s', 'simulation')), 'registered definitions retain the existing cluster directory');
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
    assert.equal(service.driver, 'k3s', 'public topology retains the concrete backend identity');
    assert.equal(service.assigned.want, 'live');
    const readyAt = service.versions.find((v: any) => v.version === '1').observed_at;
    assert.equal(Date.parse(before.captured_at) - Date.parse(readyAt), 120000);
    assert.equal(service.health, 'healthy');
    assert.equal(service.status, 'Verified');
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
    assert.equal(after.versions.find((v: any) => v.version === '1').observed_at, readyAt, 'recovery does not invent new readiness timestamps');
    assert.equal(after.health, 'healthy');
    assert.equal(after.status, 'Verified');
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

// Task3 independent-review fix round 1: provider identity is current authority, not cached metadata.
test('fix1 I1: replacing the provider stops warm-driver collection and promotion; restoration retries only the same approved state', async () => {
  const s = await setup();
  try {
    assert.equal((await deploy(s)).state, 'done');
    const beforeMap = (await s.h.c('GET', '/services/topology')).body;
    const observed = beforeMap.machines.find((m: any) => m.id === s.h.core.mesh.identity.id).observations.find((o: any) => o.source === 'cluster');
    const expected = expectedOf(s);
    const p = await s.h.c('POST', `${s.base}/promote`, { version: '1', expected });
    assert.equal(p.status, 200);
    const calls = s.sim.calls().length;
    s.setProvider(unavailableClusterTools);
    s.h.core.ledger.approve(p.body.id);
    const blocked = await s.settle(p.body.id);
    assert.equal(blocked.state, 'waiting');
    assert.equal(blocked.attempts, 0);
    s.sim.clock.advance(1000);
    const afterMap = (await s.h.c('GET', '/services/topology')).body;
    const row = afterMap.machines.find((m: any) => m.id === s.h.core.mesh.identity.id);
    assert.equal(row.observations.find((o: any) => /Actual registered/.test(o.reason)).at, observed.at);
    assert.ok(row.observations.some((o: any) => /Control plane unavailable/.test(o.reason)));
    assert.equal(s.sim.calls().length, calls, 'no I/O through the revoked cached provider');
    s.setProvider(s.sim.tools);
    s.h.core.ledger.retry(blocked.id);
    const restored = await s.settle(blocked.id);
    assert.equal(restored.state, 'done', restored.reason!);
    assert.deepEqual(restored.brief.inputs?.expected, expected);
    assert.equal(restored.id, blocked.id);
  } finally { await s.stop(); }
});

test('fix1 I1: provider removal during awaited network preflight prevents workload prepare', async () => {
  const s = await setup();
  try {
    const change = await s.network();
    const read = s.sim.tools.network!.read;
    s.sim.tools.network!.read = async signal => { const result = await read(signal); s.setProvider(undefined); return result; };
    const p = await s.h.c('POST', `${s.base}/deploy`, { version: '1', expected: empty, network_change: change });
    s.h.core.ledger.approve(p.body.id);
    const task = await s.settle(p.body.id);
    assert.equal(task.state, 'waiting');
    assert.equal(task.attempts, 0);
    assert.equal(s.sim.read().services.echo!.versions.length, 0);
    assert.ok(!s.sim.calls().some(c => c.operation === 'prepare-workload'));
  } finally { await s.stop(); }
});

for (const revoke of ['hub', 'actor', 'registration'] as const) test(`fix1 I2: current ${revoke} authority is checked after awaited M10d read and before policy write`, async () => {
  const s = await setup();
  try {
    const person = await enroll(s.h, { name: 'Network approver', kind: 'phone' });
    s.h.core.db.run('UPDATE device SET can_approve = 1 WHERE id = ?', person.dev.deviceId);
    const r = await call(s.h.mesh, 'POST', `/api/v1${s.base}/network`, { version: '1', expected: empty }, { authorization: `Bearer ${person.token}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await s.settle(r.body.task.id);
    const apply = s.h.core.network.view(r.body.change.id).tasks.find(t => t.step === 'apply')!;
    const read = s.sim.tools.network!.read;
    let once = false;
    s.sim.tools.network!.read = async signal => {
      const result = await read(signal);
      if (!once) {
        once = true;
        if (revoke === 'hub') s.h.core.db.run("UPDATE mesh_state SET role = 'standby', hub_id = 'replacement-hub' WHERE id = 1");
        else if (revoke === 'actor') s.h.core.db.run('UPDATE device SET can_approve = 0 WHERE id = ?', person.dev.deviceId);
        else s.registrations[0].sites.push({ id: 'new-site', name: 'Changed registration' });
      }
      return result;
    };
    const before = s.net.hits.filter((h: any) => h.method === 'PUT').length;
    s.h.core.ledger.approve(apply.id, { confirm: true });
    const finished = await s.settle(apply.id);
    assert.equal(s.net.hits.filter((h: any) => h.method === 'PUT').length, before);
    assert.equal((s.sim.read() as any).networkPolicies?.length ?? 0, 0);
    assert.equal(finished.state, 'failed');
    assert.deepEqual(finished.origin, { kind: 'device', ref: person.dev.deviceId });
    assert.equal((finished.brief.inputs?.cluster_binding as any).actor, person.dev.deviceId);
  } finally { await s.stop(); }
});

test('fix1 I2: generic network input cannot forge the trusted cluster origin or binding', async () => {
  const s = await setup();
  try {
    const patch = { schema: 1, cluster: 'simulation', namespace: 'nova-services', services: { echo: { state: [empty], versions: [{ version: '1', egress: 'none' }] } } };
    const r = await s.h.c('POST', '/network/changes', { target: s.target.id, patch, actor: 'console', cluster_binding: { actor: 'console', cluster: 'simulation', namespace: 'nova-services', registration: 'fake' } });
    assert.equal(r.status, 403);
    assert.equal(s.h.core.network.list().changes.length, 0);
    assert.equal(s.net.hits.length, 0);
  } finally { await s.stop(); }
});

test('fix1 M3: canonical policy entries require registered non-prototype keys, nonempty versions and the live policy', async () => {
  const s = await setup();
  try {
    const document = (service: string, versions: unknown[], state = empty) => ({ schema: 1, cluster: 'simulation', namespace: 'nova-services', services: JSON.parse(JSON.stringify({ [service]: { state: [state], versions } })) });
    for (const name of ['unknown', '__proto__', 'constructor', 'prototype']) {
      assert.throws(() => renderClusterNetwork(document(name, []), s.registrations[0]));
      assert.throws(() => renderClusterNetwork(document(name, [{ version: '1', egress: 'none' }]), s.registrations[0]));
    }
    assert.throws(() => renderClusterNetwork(document('echo', []), s.registrations[0]));
    assert.throws(() => renderClusterNetwork(document('echo', [{ version: '2', egress: 'none' }], { ...empty, live: '1' } as any), s.registrations[0]));
    assert.deepEqual(renderClusterNetwork({ schema: 1, cluster: 'simulation', namespace: 'nova-services', services: {} }, s.registrations[0]), []);
  } finally { await s.stop(); }
});

test('fix1 I1: rollback rejects a provider replacement during status read and resumes the same approved state', async () => {
  const s = await setup();
  try {
    assert.equal((await deploy(s)).state, 'done');
    assert.equal((await promote(s)).state, 'done');
    assert.equal((await deploy(s, '2')).state, 'done');
    assert.equal((await promote(s, '2')).state, 'done');
    const expected = expectedOf(s);
    const p = await s.h.c('POST', `${s.base}/rollback`, { version: '1', expected });
    const execute = s.sim.tools.execute;
    s.sim.tools.execute = async (op, signal) => {
      const result = await execute(op, signal);
      if (op.operation === 'status') s.setProvider(undefined);
      return result;
    };
    const before = s.sim.calls().length;
    s.h.core.ledger.approve(p.body.id);
    const blocked = await s.settle(p.body.id);
    assert.equal(blocked.state, 'waiting');
    assert.equal(blocked.attempts, 0);
    assert.ok(s.sim.calls().slice(before).every(c => c.operation === 'status'));
    assert.equal(s.sim.read().services.echo!.live, '2');
    s.sim.tools.execute = execute; s.setProvider(s.sim.tools);
    s.h.core.ledger.retry(blocked.id);
    assert.equal((await s.settle(blocked.id)).state, 'done');
    assert.equal(s.sim.read().services.echo!.live, '1');
  } finally { await s.stop(); }
});

test('fix1 I1: replacing a network port during awaited snapshot read refuses the old result', async () => {
  const s = await setup();
  try {
    const port = s.sim.tools.network!;
    const read = port.read;
    port.read = async signal => {
      const result = await read(signal);
      s.setProvider({ ...s.sim.tools, network: { read, write: port.write } });
      return result;
    };
    const r = await s.h.c('POST', `${s.base}/network`, { version: '1', expected: empty });
    const task = await s.settle(r.body.task.id);
    assert.equal(task.state, 'failed');
    assert.equal(s.h.core.network.view(r.body.change.id).tasks.filter(t => t.step === 'apply').length, 0);
    assert.equal(s.net.hits.filter((h: any) => h.method === 'PUT').length, 0);
  } finally { await s.stop(); }
});

for (const revoked of [false, true]) test(`fix1 I2: durable requester survives restart and ${revoked ? 'revocation refuses' : 'unchanged approval permits'} the exact network apply`, async () => {
  const s = await setup();
  try {
    const person = await enroll(s.h, { name: 'Durable requester', kind: 'phone' });
    s.h.core.db.run('UPDATE device SET can_approve = 1 WHERE id = ?', person.dev.deviceId);
    const r = await call(s.h.mesh, 'POST', `/api/v1${s.base}/network`, { version: '1', expected: empty }, { authorization: `Bearer ${person.token}` });
    await s.settle(r.body.task.id);
    const apply = s.h.core.network.view(r.body.change.id).tasks.find(t => t.step === 'apply')!;
    const core = await s.restart();
    const restored = core.ledger.get(apply.id);
    assert.deepEqual(restored.origin, { kind: 'device', ref: person.dev.deviceId });
    assert.deepEqual(restored.brief.inputs?.cluster_binding, core.ledger.get(r.body.task.id).brief.inputs?.cluster_binding);
    if (revoked) core.db.run('UPDATE device SET can_approve = 0 WHERE id = ?', person.dev.deviceId);
    core.ledger.approve(apply.id, { confirm: true }); await core.ledger.idle();
    assert.equal(core.ledger.get(apply.id).state, revoked ? 'failed' : 'done');
    assert.equal(s.net.hits.filter((h: any) => h.method === 'PUT').length, revoked ? 0 : 1);
  } finally { await s.stop(); }
});

for (const malformed of ['missing', 'actor', 'registration'] as const) test(`fix1 I2: ${malformed} durable cluster binding cannot invent authority`, async () => {
  const s = await setup();
  try {
    const r = await s.h.c('POST', `${s.base}/network`, { version: '1', expected: empty });
    await s.settle(r.body.task.id);
    const apply = s.h.core.network.view(r.body.change.id).tasks.find(t => t.step === 'apply')!;
    // A legacy/malformed durable record is never upgraded to an implicit console request.
    for (const id of [r.body.task.id, apply.id]) {
      const brief = s.h.core.ledger.get(id).brief;
      if (malformed === 'missing') delete brief.inputs!.cluster_binding;
      else (brief.inputs!.cluster_binding as any)[malformed] = malformed === 'actor' ? 'untrusted-device' : 'changed';
      s.h.core.db.run('UPDATE task SET brief = ? WHERE id = ?', JSON.stringify(brief), id);
    }
    s.h.core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await s.settle(apply.id)).state, 'failed');
    assert.equal(s.net.hits.filter((h: any) => h.method === 'PUT').length, 0);
  } finally { await s.stop(); }
});

test('fix1 I2: dead-man restores its exact snapshot after actor/hub revocation; absent capability waits for a fresh port', async () => {
  const s = await setup();
  try {
    const snapshot = s.net.text();
    const person = await enroll(s.h, { name: 'Revocable requester', kind: 'phone' });
    s.h.core.db.run('UPDATE device SET can_approve = 1 WHERE id = ?', person.dev.deviceId);
    const r = await call(s.h.mesh, 'POST', `/api/v1${s.base}/network`, { version: '1', expected: empty }, { authorization: `Bearer ${person.token}` });
    await s.settle(r.body.task.id);
    const apply = s.h.core.network.view(r.body.change.id).tasks.find(t => t.step === 'apply')!;
    s.h.core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await s.settle(apply.id)).state, 'done');
    s.h.core.db.run('UPDATE device SET can_approve = 0 WHERE id = ?', person.dev.deviceId);
    s.h.core.db.run("UPDATE mesh_state SET role = 'standby', hub_id = 'replacement-hub' WHERE id = 1");
    const before = s.net.hits.length;
    s.setProvider(unavailableClusterTools);
    s.sim.clock.advance(301000); s.h.core.network.sweep(); await s.h.core.ledger.idle();
    const failed = s.h.core.network.view(r.body.change.id);
    assert.equal(failed.state, 'reverting');
    assert.equal(failed.tasks.filter(t => t.step === 'revert').at(-1)!.state, 'failed');
    assert.equal(s.net.hits.length, before, 'missing capability never calls a cached port or legacy adapter');
    assert.notEqual(s.net.text(), snapshot);
    s.h.core.network.close(); // Dispose real timer; exercise the existing due retry sweep.
    s.sim.clock.advance(16000); s.setProvider(s.sim.tools); s.h.core.network.sweep();
    await new Promise(resolve => setTimeout(resolve, 20)); await s.h.core.ledger.idle();
    assert.equal(s.h.core.network.view(r.body.change.id).state, 'reverted');
    assert.equal(s.net.text(), snapshot);
    assert.deepEqual((s.sim.read() as any).networkPolicies, []);
    const revert = s.h.core.network.view(r.body.change.id).tasks.filter(t => t.step === 'revert').at(-1)!;
    assert.equal(revert.approval_tier, 1);
    assert.equal(s.h.core.ledger.get(revert.id).brief.inputs?.by, 'switch');
    assert.deepEqual(s.h.core.ledger.get(revert.id).origin, { kind: 'device', ref: person.dev.deviceId });
  } finally { await s.stop(); }
});

test('fix1 I2: a manual network restore still requires current authority after its awaited read', async () => {
  const s = await setup();
  try {
    const id = await s.network();
    const revert = s.h.core.network.revert(id);
    const read = s.sim.tools.network!.read;
    s.sim.tools.network!.read = async signal => { const result = await read(signal); s.h.core.db.run("UPDATE mesh_state SET role = 'standby', hub_id = 'replacement-hub' WHERE id = 1"); return result; };
    const before = s.net.text(), writes = s.net.hits.filter((h: any) => h.method === 'PUT').length;
    s.h.core.ledger.approve(revert.task.id, { confirm: true });
    assert.equal((await s.settle(revert.task.id)).state, 'failed');
    assert.equal(s.net.hits.filter((h: any) => h.method === 'PUT').length, writes);
    assert.equal(s.net.text(), before);
  } finally { await s.stop(); }
});

test('final I1: failed previews and retained or removed readiness cannot corrupt healthy live topology', async () => {
  const s = await setup();
  try {
    s.registrations[0].services[1].contract_tests = ['http:/fail-contract'];
    assert.equal((await deploy(s)).state, 'done');
    assert.equal((await promote(s)).state, 'done');
    const view = async () => {
      const map = (await s.h.c('GET', '/services/topology')).body;
      const machine = map.machines.find((m: any) => m.id === s.h.core.mesh.identity.id);
      return { map, machine, service: machine.services.find((v: any) => v.service === 'echo') };
    };
    const before = await view();
    assert.equal(before.service.health, 'healthy');
    assert.equal(before.service.status, 'Verified');
    const readyAt = before.service.versions[0].observed_at;
    assert.equal(Date.parse(before.map.captured_at) - Date.parse(readyAt), 120000);
    assert.equal((await deploy(s, '2')).state, 'waiting');
    const failed = await view();
    assert.equal(await s.sim.serving(), '1');
    assert.equal(failed.service.health, 'healthy');
    assert.equal(failed.service.status, 'Verified');
    assert.equal(failed.service.versions.find((v: any) => v.version === '2').status, 'failed');
    assert.equal(failed.service.versions.find((v: any) => v.version === '1').observed_at, readyAt);
    s.sim.change(state => {
      const row = state.services.echo!;
      const prior = structuredClone(row.versions[0]!);
      row.versions.push({ ...prior, version: 'kept-history', replicas: 0, ready: false, status: 'kept' },
        { ...prior, version: 'removed-history', replicas: 0, ready: false, status: 'removed' });
      row.previous = 'kept-history'; row.revision++;
    });
    const history = await view();
    assert.equal(history.service.health, 'healthy');
    assert.equal(history.service.status, 'Verified');
    for (const version of ['kept-history', 'removed-history']) assert.equal(history.service.versions.find((v: any) => v.version === version).observed_at, readyAt);
    // Read-only collection must still expose actual fresh serving and node failures.
    s.sim.change(state => { state.unhealthy = ['1']; });
    const badLive = await view();
    assert.equal(badLive.service.health, 'failed');
    assert.equal(badLive.service.status, 'Failed');
    assert.equal(badLive.service.live, '1');
    assert.equal(badLive.machine.observations.find((o: any) => o.source === 'local').health, 'healthy');
    s.sim.change(state => { const current = state.services.echo!.versions.find(v => v.version === '1')!; current.replicas = 0; current.ready = false; });
    const stoppedLive = await view();
    assert.equal(stoppedLive.service.live, null, 'desired selector is not a serving replica');
    assert.equal(stoppedLive.service.health, 'failed', 'actual fresh failure survives a stopped live resource');
    assert.equal(stoppedLive.service.status, 'Failed');
    s.sim.change(state => { state.services.echo!.versions.find(v => v.version === '1')!.health.ok = true; });
    const stoppedHealthy = await view();
    assert.equal(stoppedHealthy.service.health, 'unknown', 'past healthy measurement cannot claim serving without any replica');
    assert.equal(stoppedHealthy.service.status, 'Waiting');
    s.sim.change(state => { state.services.echo!.versions.find(v => v.version === '1')!.replicas = 1; state.unhealthy = []; state.nodes[0]!.healthy = false; });
    const badNode = await view();
    assert.equal(badNode.service.observations.find((o: any) => /health measurement/.test(o.reason)).health, 'healthy');
    assert.equal(badNode.service.health, 'failed');
    assert.equal(badNode.service.status, 'Failed');
    assert.equal(badNode.machine.health, 'failed');
  } finally { await s.stop(); }
});

test('final I1: readiness fallback belongs only to the current assigned candidate and retains its age', async () => {
  const s = await setup();
  try {
    assert.equal((await deploy(s)).state, 'done');
    const view = async () => (await s.h.c('GET', '/services/topology')).body.machines.find((m: any) => m.id === s.h.core.mesh.identity.id).services.find((v: any) => v.service === 'echo');
    const before = await view();
    assert.equal(before.live, null);
    assert.equal(before.health, 'healthy');
    assert.equal(before.status, 'Verified');
    const at = before.versions[0].observed_at;
    s.sim.change(state => {
      const row = state.services.echo!;
      row.versions.push({ ...structuredClone(row.versions[0]!), version: 'obsolete-failure', replicas: 0, ready: false, status: 'failed' });
      row.revision++;
    });
    assert.equal((await view()).health, 'healthy');
    s.sim.clock.advance(120000);
    const stale = await view();
    assert.equal(stale.health, 'unknown');
    assert.equal(stale.status, 'Waiting');
    assert.equal(stale.observations.find((o: any) => /readiness/.test(o.reason)).age_ms, 120000);
    assert.equal(stale.versions[0].observed_at, at);
    // A historical ready candidate cannot stand in for an unrelated current assignment.
    s.sim.change(state => {
      const row = state.services.echo!;
      row.versions = row.versions.filter(v => v.version === '1');
      row.versions[0]!.ready_at = new Date(s.sim.clock.now()).toISOString();
      row.assigned = { version: 'missing', want: 'alongside', at: new Date(s.sim.clock.now()).toISOString() }; row.revision++;
    });
    assert.equal((await view()).health, 'unknown');
  } finally { await s.stop(); }
});

test('final I2: capacity blocks network proposals and approved deploy before any new effects', async () => {
  const s = await setup();
  try {
    assert.equal((await deploy(s)).state, 'done');
    assert.equal((await promote(s)).state, 'done');
    const expected = expectedOf(s);
    const change = await s.network('2', expected as typeof empty);
    s.sim.change(state => {
      const row = state.services.echo!;
      row.versions.push(...Array.from({ length: 63 }, (_, i) => ({ ...structuredClone(row.versions[0]!), version: `old${i}`, status: 'removed' as const, replicas: 0, ready: false })));
      row.revision++;
    });
    const before = s.sim.read().services.echo!;
    const calls = s.sim.calls().length;
    const hits = s.net.hits.length;
    const network = await s.h.c('POST', `${s.base}/network`, { version: '2', expected });
    assert.equal(network.status, 409);
    assert.equal(s.net.hits.length, hits, 'admission refuses before even a network target snapshot');
    const proposed = await s.h.c('POST', `${s.base}/deploy`, { version: '2', expected, network_change: change });
    assert.equal(proposed.status, 200);
    s.h.core.ledger.approve(proposed.body.id, { confirm: true });
    const task = await s.settle(proposed.body.id);
    assert.equal(task.state, 'waiting');
    assert.match(task.reason!, /capacity/i);
    assert.equal(s.h.core.ledger.events(task.id).some(e => e.kind === 'commit_point'), false);
    assert.ok(s.sim.calls().slice(calls).every(c => c.operation === 'status'));
    const after = s.sim.read().services.echo!;
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.versions, before.versions);
    assert.deepEqual(after.last_mutation, before.last_mutation);
    assert.deepEqual(expectedOf(s), expected);
    assert.equal(await s.sim.serving(), '1');
  } finally { await s.stop(); }
});


test('R1: current candidate readiness cannot replace its measured failure or unknown health', async () => {
  const s = await setup();
  try {
    assert.equal((await deploy(s)).state, 'done');
    const readyAt = s.sim.read().services.echo!.versions[0]!.ready_at;
    const read = async () => (await s.h.c('GET', '/services/topology')).body.machines.find((m: any) => m.id === s.h.core.mesh.identity.id).services.find((v: any) => v.service === 'echo');
    const effects = s.sim.calls().filter(c => c.operation !== 'status').length;
    s.sim.change(state => { state.unhealthy = ['1']; });
    // Match the actual reviewer probe: distinct operations can share an equal, fresh time.
    const failed = await read();
    const actual = s.sim.read().services.echo!.versions[0]!;
    assert.equal(actual.ready, true);
    assert.equal(actual.health.ok, false);
    assert.equal(actual.health.checked_at, readyAt);
    assert.equal(failed.live, null);
    assert.equal(failed.health, 'failed');
    assert.equal(failed.status, 'Failed');
    const measured = (row: any) => row.observations.find((o: any) => /health measurement/.test(o.reason));
    const readiness = (row: any) => row.observations.find((o: any) => /readiness/.test(o.reason));
    assert.equal(measured(failed).health, 'failed');
    assert.equal(measured(failed).at, readyAt);
    assert.equal(measured(failed).age_ms, 0);
    assert.equal(readiness(failed).health, 'healthy');
    assert.equal(readiness(failed).at, readyAt);
    s.sim.clock.advance(5000);
    const later = await read();
    assert.equal(later.health, 'failed');
    assert.equal(later.status, 'Failed');
    assert.equal(measured(later).at, new Date(s.sim.clock.now()).toISOString());
    assert.equal(measured(later).age_ms, 0);
    assert.equal(readiness(later).at, readyAt);
    assert.equal(readiness(later).age_ms, 5000);
    s.sim.change(state => { state.unhealthy = []; state.unknown = ['1']; });
    const unknown = await read();
    assert.equal(unknown.health, 'unknown');
    assert.equal(unknown.status, 'Waiting');
    assert.equal(measured(unknown).health, 'unknown');
    assert.equal(measured(unknown).age_ms, 0);
    assert.equal(readiness(unknown).health, 'healthy');
    s.sim.change(state => { state.unknown = []; });
    s.sim.clock.advance(5000);
    const healthy = await read();
    assert.equal(healthy.health, 'healthy');
    assert.equal(healthy.status, 'Verified');
    assert.equal(measured(healthy).age_ms, 0);
    assert.equal(readiness(healthy).age_ms, 10000);
    // Fresh health is not a fresh readiness receipt, and stopped replicas prove no readiness.
    s.sim.clock.advance(110000);
    const staleReady = await read();
    assert.equal(staleReady.health, 'unknown');
    assert.equal(staleReady.status, 'Waiting');
    assert.equal(measured(staleReady).health, 'healthy');
    assert.equal(measured(staleReady).age_ms, 0);
    assert.equal(readiness(staleReady).at, readyAt);
    assert.equal(readiness(staleReady).age_ms, 120000);
    assert.equal(readiness(staleReady).stale, true);
    s.sim.change(state => { const candidate = state.services.echo!.versions[0]!; candidate.replicas = 0; candidate.ready = false; });
    const stopped = await read();
    assert.equal(stopped.health, 'unknown');
    assert.equal(stopped.status, 'Waiting');
    assert.equal(s.sim.calls().filter(c => c.operation !== 'status').length, effects);
    assert.equal(s.sim.clock.timers.size, 0);
  } finally { await s.stop(); }
});

test('R1: candidate measured-health age remains independent from fresh readiness', async () => {
  const s = await setup();
  try {
    assert.equal((await deploy(s)).state, 'done');
    const oldHealthAt = s.sim.read().services.echo!.versions[0]!.health.checked_at!;
    s.sim.clock.advance(120000);
    const readyAt = new Date(s.sim.clock.now()).toISOString();
    s.sim.change(state => { state.services.echo!.versions[0]!.ready_at = readyAt; });
    // Controlled source timestamps at the existing trusted fixture port; actual children
    // still collect status. This models separate measured-health and validation receipts.
    let healthAt = oldHealthAt;
    const execute = s.sim.tools.execute;
    s.sim.tools.execute = async (op, signal) => {
      const snapshot = await execute(op, signal);
      if (op.operation === 'status') {
        snapshot.versions[0]!.health.checked_at = healthAt;
        snapshot.observed_at = new Date(Math.max(s.sim.clock.now(), Date.parse(healthAt))).toISOString();
      }
      return snapshot;
    };
    const read = async () => (await s.h.c('GET', '/services/topology')).body.machines.find((m: any) => m.id === s.h.core.mesh.identity.id).services.find((v: any) => v.service === 'echo');
    const stale = await read();
    assert.equal(stale.health, 'unknown');
    assert.equal(stale.status, 'Waiting');
    const measured = (row: any) => row.observations.find((o: any) => /health measurement/.test(o.reason));
    const readiness = (row: any) => row.observations.find((o: any) => /readiness/.test(o.reason));
    assert.equal(measured(stale).at, oldHealthAt);
    assert.equal(measured(stale).age_ms, 120000);
    assert.equal(measured(stale).stale, true);
    assert.equal(readiness(stale).at, readyAt);
    assert.equal(readiness(stale).health, 'healthy');
    assert.equal(readiness(stale).age_ms, 0);
    healthAt = new Date(s.sim.clock.now() + 1).toISOString();
    const future = await read();
    assert.equal(future.health, 'unknown');
    assert.equal(future.status, 'Waiting');
    assert.equal(measured(future).at, healthAt);
    assert.equal(measured(future).age_ms, null);
    assert.equal(measured(future).stale, true);
    assert.equal(readiness(future).at, readyAt);
    assert.equal(readiness(future).age_ms, 0);
    s.sim.clock.advance(1);
    const fresh = await read();
    assert.equal(fresh.health, 'healthy');
    assert.equal(fresh.status, 'Verified');
    assert.equal(measured(fresh).age_ms, 0);
    assert.equal(readiness(fresh).at, readyAt);
    assert.equal(readiness(fresh).age_ms, 1);
  } finally { await s.stop(); }
});
