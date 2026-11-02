// TEST ONLY. No host commands, credentials, cluster client, downloader or production imports.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { conforms } from './k3s-schema.ts';
const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const serviceName = /^[a-z][a-z0-9-]{0,52}$/;
const versionName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const only = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(v, k));
const schema = JSON.parse(readFileSync(new URL('../../charts/nova-service/values.schema.json', import.meta.url), 'utf8'));
function valuesValid(v, s, op) {
  assert.ok(conforms(v, schema, schema), 'Invalid chart schema.');
  assert.equal(v.namespace, op.namespace);
  assert.equal(v.service.identity, op.service);
  assert.ok(dns.test(v.service.name));
  for (const x of v.versions) {
    for (const name of [x.name, x.previewName, x.networkPolicyName]) assert.ok(dns.test(name));
    const existing = s.services[op.service]?.versions?.find(v => v.version === x.identity);
    if (existing) assert.equal(x.replicas, existing.replicas, 'Prepare may not scale or resurrect retained resources.');
    assert.equal(x.alongside, 'full');
    assert.equal(x.strategy.type, 'RollingUpdate');
    assert.equal(x.state, null, 'No real storage proof is available.');
    assert.deepEqual(x.secretRefs, []);
    assert.equal(x.nodeSelector['kubernetes.io/os'], 'linux');
    const matching = s.nodes.filter(n => n.healthy && Object.entries(x.nodeSelector).every(([k, value]) => n.labels[k] === value) && x.requiredNodeExpressions.every(e => e.operator === 'In' ? e.values.includes(n.labels[e.key]) : /^\d+$/.test(n.labels[e.key] ?? '') && Number(n.labels[e.key]) > Number(e.values[0])));
    assert.ok(x.replicas === 0 || matching.length >= x.replicas, 'No eligible Linux/role/hardware nodes.');
  }
  const current = s.services[op.service];
  assert.equal(v.live, current?.live ?? null, 'Prepare may not change stable traffic.');
  const live = v.versions.find(x => x.identity === v.live);
  if (live) assert.deepEqual(v.stableSelector, live.selector);
  else assert.ok(v.versions.every(x => x.selector['nova/version'] !== v.stableSelector['nova/version']));
}
export async function simulate(tool) {
  let lock;
  let ownsLock = false;
  try {
    const args = process.argv.slice(2);
    assert.equal(args.length, 6);
    assert.equal(args[0], 'nova-simulation');
    assert.equal(args[2], '--namespace');
    assert.equal(args[4], '--service');
    assert.ok(dns.test(args[3]));
    assert.ok(serviceName.test(args[5]));
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; assert.ok(input.length <= 262144); }
    const op = JSON.parse(input);
    assert.equal(op.namespace, args[3]); assert.equal(op.service, args[5]); assert.equal(op.operation, args[1]);
    const keys = { status: [], prepare: ['expected', 'values'], 'prepare-workload': ['expected', 'values'], validate: ['expected', 'version', 'passed'], switch: ['expected', 'version', 'soak_until'], rollback: ['expected', 'version', 'reason'], scale: ['expected', 'version', 'replicas'], remove: ['expected', 'version'] };
    assert.ok(Object.hasOwn(keys, op.operation));
    assert.ok(only(op, ['cluster', 'namespace', 'service', 'operation', ...keys[op.operation], ...(Object.hasOwn(op, 'task_id') ? ['task_id'] : [])]));
    if (op.task_id !== undefined) assert.ok(/^[0-9a-f-]{36}$/.test(op.task_id));
    assert.ok(tool === 'kubectl' || tool === 'helm' && ['prepare', 'prepare-workload'].includes(op.operation) || tool === 'flux' && op.operation === 'status');
    assert.ok(process.env.NOVA_SIM_STATE && process.env.HOME && process.env.PATH);
    lock = `${process.env.NOVA_SIM_STATE}.lock`;
    mkdirSync(lock); ownsLock = true; // One actual server-side transaction across all child processes.
    const state = JSON.parse(readFileSync(process.env.NOVA_SIM_STATE, 'utf8'));
    assert.equal(op.cluster, state.cluster); assert.equal(op.namespace, state.namespace);
    const now = new Date(Number(process.env.NOVA_SIM_NOW)).toISOString();
    state.calls.push({ tool, operation: op.operation, argv: args });
    const save = () => { const temp = `${process.env.NOVA_SIM_STATE}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(state)); renameSync(temp, process.env.NOVA_SIM_STATE); };
    save();
    assert.equal(state.reachable, true, 'Control plane unavailable.');
    if (tool === 'flux') {
      state.fluxWatched = Object.keys(state.services); save();
      process.stdout.write(JSON.stringify({ simulation: true, watched: state.fluxWatched })); return;
    }
    if (tool === 'helm') { valuesValid(op.values, state, op); process.stdout.write(JSON.stringify({ valid: true })); return; }
    let row = state.services[op.service] ?? { schema: 1, cluster: op.cluster, namespace: op.namespace, service: op.service, revision: 0, sequence: 0, observed_at: now, live: null, previous: null, assigned: null, versions: [], soak_until: null, held: null };
    if (op.operation !== 'status') {
      assert.ok(only(op.expected, ['revision', 'state']));
      assert.equal(op.expected.revision, row.revision, 'Resource revision changed.');
      assert.deepEqual(op.expected.state, { live: row.live, previous: row.previous, assigned: row.assigned }, 'Approved state changed.');
      const version = row.versions.find(v => v.version === op.version);
      if (!['prepare', 'prepare-workload'].includes(op.operation) && op.version !== null) assert.ok(versionName.test(op.version) && version);
      switch (op.operation) {
        case 'prepare':
        case 'prepare-workload': {
          valuesValid(op.values, state, op);
          for (const v of op.values.versions) {
            if (row.versions.some(x => x.version === v.identity)) continue;
            row.versions.push({ version: v.identity, replicas: v.replicas, ready: false, ready_at: null, health: { ok: null, checked_at: null, said: null }, status: 'alongside', since: now, device_ids: v.placement.allowedDevices, ports: Object.fromEntries(v.ports.map(p => [p.name, p.port])), state_refs: [] });
            row.assigned = { version: v.identity, want: 'alongside', at: now };
          }
          break;
        }
        case 'validate':
          assert.equal(typeof op.passed, 'boolean');
          assert.equal(version.status, 'alongside');
          version.ready = op.passed && version.replicas > 0 && !state.unhealthy.includes(op.version);
          version.ready_at = now; version.status = version.ready ? 'ready' : 'failed';
          if (!version.ready) version.replicas = 0;
          break;
        case 'switch':
          assert.ok(version.ready && version.replicas > 0 && version.status === 'ready' && !state.unhealthy.includes(op.version));
          if (row.previous) { const stale = row.versions.find(v => v.version === row.previous); stale.status = 'removed'; stale.replicas = 0; stale.ready = false; }
          row.previous = row.live; row.live = op.version; row.soak_until = op.soak_until;
          if (row.previous) { const old = row.versions.find(v => v.version === row.previous); state.keptReplicas ??= {}; state.keptReplicas[JSON.stringify([op.service, old.version])] = old.replicas; old.status = 'kept'; old.replicas = 0; old.ready = false; }
          version.status = 'live'; row.assigned = { version: op.version, want: 'live', at: now }; row.held = null;
          break;
        case 'rollback': {
          assert.equal(op.version, row.previous, 'Rollback target must be the approved previous.');
          const keptCount = op.version ? state.keptReplicas?.[JSON.stringify([op.service, op.version])] : null;
          if (op.version) assert.ok(!state.unhealthy.includes(op.version) && version.status === 'kept' && Number.isInteger(keptCount) && keptCount > 0 && keptCount <= 64, 'Kept target or retained replica observation is unavailable.');
          const old = row.versions.find(v => v.version === row.live);
          if (old) { old.status = 'rolled_back'; old.replicas = 0; old.ready = false; }
          row.live = op.version; row.previous = null; row.soak_until = null;
          if (version) { version.status = 'live'; version.replicas = keptCount; version.ready = true; version.ready_at = now; row.assigned = { version: op.version, want: 'live', at: now }; }
          else { row.held = { reason: 'No kept version; stopped safely.', at: now }; row.assigned = old ? { version: old.version, want: 'stopped', at: now } : null; }
          break;
        }
        case 'scale':
          assert.ok([0, 1].includes(op.replicas));
          assert.equal(version.status, 'kept'); assert.equal(op.replicas, 0, 'Kept resources may only be stopped.');
          version.replicas = 0; version.ready = false;
          break;
        case 'remove':
          assert.equal(version.status, 'kept'); assert.notEqual(row.live, op.version); assert.equal(version.replicas, 0);
          version.status = 'removed'; version.ready = false;
          if (row.previous === op.version) { row.previous = null; row.soak_until = null; }
          break;
      }
      row.revision++;
      if (op.task_id) row.last_mutation = { task_id: op.task_id, operation: op.operation };
    }
    row.nodes = state.nodes.map(n => ({ device_id: n.labels['nova/device'], ready: n.healthy, at: now }));
    row.sequence++; row.observed_at = now;
    for (const version of row.versions) if (version.replicas > 0) {
      version.health = { ok: state.unknown.includes(version.version) ? null : !state.unhealthy.includes(version.version), checked_at: now, said: null };
    }
    state.services[op.service] = row; save();
    process.stdout.write(Object.hasOwn(state, 'statusOverride') ? JSON.stringify(state.statusOverride) : JSON.stringify(row));
  } catch {
    process.stderr.write('Simulation rejected the operation or control-plane observation.\n'); process.exitCode = 1;
  } finally { if (ownsLock) rmSync(lock, { recursive: true, force: true }); }
}
