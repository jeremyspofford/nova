import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildK3sValues, serviceExpected, type ClusterOperation } from '../../src/core/index.ts';
import { simulatedK3s } from '../support/k3s.ts';
import { conforms } from '../../scripts/stand-ins/k3s-schema.ts';

test('actual fake children independently reject namespace/name/schema/argv and unsupported schema vocabulary', async () => {
  const h = await simulatedK3s();
  try {
    const status: ClusterOperation = { operation: 'status', cluster: h.cluster.id, namespace: h.cluster.namespace, service: 'echo' };
    for (const op of [{ ...status, namespace: 'other/namespace' }, { ...status, service: '../echo' }, { ...status, arbitrary: 'manifest' }, { ...status, cluster: 'wrong-cluster' }]) await assert.rejects(h.raw('kubectl', op));
    const s = await h.tools.execute(status);
    const values = buildK3sValues([h.definition('1')], { namespace: h.cluster.namespace, hubId: h.cluster.hubId, live: null, kept: [] });
    const prepare: ClusterOperation = { ...status, operation: 'prepare', values, expected: { revision: s.revision, state: serviceExpected(s) } };
    await h.raw('helm', prepare);
    for (const mutate of [(v: typeof values) => { v.versions[0]!.image.digest = 'latest'; }, (v: typeof values) => { v.versions[0]!.nodeSelector['kubernetes.io/os'] = 'windows'; }, (v: typeof values) => { v.versions[0]!.name = '../bad'; }, (v: typeof values) => { (v.versions[0] as unknown as Record<string, unknown>).arbitraryManifest = {}; }]) {
      const malformed = structuredClone(values); mutate(malformed);
      await assert.rejects(h.raw('helm', { ...prepare, values: malformed }));
      await assert.rejects(h.raw('kubectl', { ...prepare, values: malformed }));
    }
    assert.deepEqual(h.read().services.echo!.versions, []);
    const schema = JSON.parse(readFileSync(new URL('../../charts/nova-service/values.schema.json', import.meta.url), 'utf8'));
    assert.throws(() => conforms(values, { ...schema, not: {} }, { ...schema, not: {} }), /Unsupported/);
    assert.throws(() => conforms(values, { $ref: 'https://invalid.example/schema' }, { $ref: 'https://invalid.example/schema' }));
  } finally { await h.close(); }
});

test('missing fixture executable never falls back to ambient host PATH', async () => {
  const h = await simulatedK3s();
  try {
    rmSync(join(h.bin, 'kubectl'));
    assert.equal((await h.driver.apply(h.definition('1'))).ok, false);
    assert.ok(!h.calls().some(c => c.tool === 'kubectl'));
  } finally { await h.close(); }
});

test('fake process refuses a concurrent server transaction without removing another owner lock', async () => {
  const h = await simulatedK3s();
  try {
    const lock = join(h.home, 'cluster.json.lock'); mkdirSync(lock);
    await assert.rejects(h.raw('kubectl', { operation: 'status', cluster: h.cluster.id, namespace: h.cluster.namespace, service: 'echo' }));
    assert.equal(existsSync(lock), true, 'a rejected contender must not remove another transaction’s lock');
  } finally { await h.close(); }
});

test('server-side revision CAS rejects concurrent owners, and control-plane loss blocks scale/remove', async () => {
  const h = await simulatedK3s();
  try {
    await h.driver.apply(h.definition('1'));
    const s = h.read().services.echo!;
    const op: ClusterOperation = { operation: 'switch', cluster: h.cluster.id, namespace: h.cluster.namespace, service: 'echo', version: '1', soak_until: null, expected: { revision: s.revision, state: serviceExpected(s) } };
    const results = await Promise.allSettled([h.raw('kubectl', op), h.raw('kubectl', op)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    h.change(s => { s.reachable = false; });
    for (const op of [{ operation: 'scale', replicas: 0 }, { operation: 'remove' }] as const) await assert.rejects(h.tools.execute({ ...op, cluster: h.cluster.id, namespace: h.cluster.namespace, service: 'echo', version: '1', expected: { revision: s.revision, state: serviceExpected(s) } }));
  } finally { await h.close(); }
});

test('the default tripwire positively catches a planted tool invocation', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('sh', ['scripts/tripwire.sh', process.execPath, '--input-type=module', '-e', "import {spawnSync} from 'node:child_process'; spawnSync('kubectl', ['get', 'pods']);"], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /tripwire: FIRED/);
  assert.match(result.stdout + result.stderr, /kubectl get pods/);
});

test('prepare cannot resurrect a failed preview when adding another version', async () => {
  const h = await simulatedK3s();
  try {
    const failed = h.definition('1', { failContract: true });
    assert.equal((await h.driver.apply(failed)).ok, false);
    const row = h.read().services.echo!;
    const values = buildK3sValues([failed, h.definition('2')], { namespace: h.cluster.namespace, hubId: h.cluster.hubId, live: null, kept: [] });
    await assert.rejects(h.raw('kubectl', { operation: 'prepare', cluster: h.cluster.id, namespace: h.cluster.namespace, service: 'echo', expected: { revision: row.revision, state: serviceExpected(row) }, values }));
    assert.equal((await h.driver.apply(h.definition('2'))).ok, true);
    assert.equal(h.read().services.echo!.versions.find(v => v.version === '1')!.replicas, 0);
  } finally { await h.close(); }
});
