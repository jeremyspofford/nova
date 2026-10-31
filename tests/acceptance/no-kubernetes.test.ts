// Nova with no Kubernetes anywhere (M10e; docs/plans/M10-orchestration.md, "With the K3s driver off").
// The suite runs under scripts/tripwire.sh: stand-in kubectl, helm, flux and k3s are first on PATH,
// and any call fails the run. This file checks that the tripwire is armed for this run, that it does
// fire (or its silence would prove nothing), and that Nova running a service leaves no trace of a
// cluster: no KUBECONFIG, no ~/.kube in its homes, no call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort, standIn, whoami } from '../support/services.ts';
import { deploy, supervised } from '../supervisor/services-support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const TRIPWIRE = join(ROOT, 'scripts', 'tripwire.sh');
const TOOLS = ['kubectl', 'helm', 'flux', 'k3s'];

test('the tripwire is armed for this run: every Kubernetes tool on PATH is its stand-in, and KUBECONFIG is unset', () => {
  const bin = process.env.NOVA_K8S_TRIPWIRE;
  assert.ok(bin, 'NOVA_K8S_TRIPWIRE is set: the suite runs through scripts/tripwire.sh (npm test, npm run test:ui, scripts/ui-test.sh)');
  for (const tool of TOOLS) {
    const found = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
    assert.equal(found, join(bin, tool), `${tool} resolves to the tripwire, even where a real one is installed`);
  }
  assert.equal(process.env.KUBECONFIG, undefined);
});

test('the tripwire fires: a call fails the run and says what was called; a clean run passes with its own result', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nova-tripwire-'));
  const run = (script: string) => spawnSync('sh', [TRIPWIRE, 'sh', '-c', script], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, KUBECONFIG: join(tmp, 'kubeconfig') } });
  for (const [tool, args] of [['kubectl', 'get pods -A'], ['helm', 'rollback nova-service 1'], ['flux', 'reconcile kustomization nova'], ['k3s', 'server']] as const) {
    // The command itself succeeds: the tripwire fails the run anyway.
    const r = run(`${tool} ${args} >/dev/null 2>&1; exit 0`);
    assert.equal(r.status, 1, `${tool}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /no-Kubernetes tripwire: armed/);
    assert.match(r.stderr, new RegExp(`tripwire: FIRED[\\s\\S]*${tool} ${args}`));
  }
  const fine = run('test -z "$KUBECONFIG" && exit 0');
  assert.equal(fine.status, 0, `KUBECONFIG is unset inside: ${fine.stderr}`);
  assert.match(fine.stdout, /tripwire: never fired/);
  assert.equal(run('exit 3').status, 3, 'the command’s own failure passes through');
  // Each run cleans up after itself.
  assert.deepEqual(readdirSync(tmp), []);
});

test('Nova running a service under the supervisor driver calls no Kubernetes tool and leaves no ~/.kube', async () => {
  const h = await supervised('nova-no-k8s-');
  try {
    const port = await freePort();
    assert.equal((await deploy(h.s, standIn({ version: '1.0.0', port }))).ok, true);
    assert.equal((await h.s.manager.promote('stand-in', '1.0.0', 'stand-in@1.0.0')).ok, true);
    const w = (await whoami(port))!;
    assert.equal(w.version, '1.0.0');
    assert.ok(!existsSync(join(w.home, '.kube')), 'the service’s HOME has no .kube');
  } finally {
    await h.stop();
  }
  const kube: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (e === '.kube') kube.push(p); else if (statSync(p).isDirectory() && !statSync(p).isSymbolicLink()) walk(p); } };
  walk(h.dir);
  assert.deepEqual(kube, [], 'no .kube anywhere in its homes');
  const log = process.env.NOVA_K8S_TRIPWIRE_LOG;
  if (log) assert.equal(readFileSync(log, 'utf8'), '', 'nothing has called a Kubernetes tool so far in this run');
});
