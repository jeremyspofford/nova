import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupervisorDriver } from '../../src/supervisor/services.ts';
import * as core from '../../src/core/index.ts';
import type { ServiceDefinition } from '../../src/core/index.ts';

test('the pure K3s values builder is exported through the public core boundary', () => {
  assert.equal(typeof (core as unknown as Record<string, unknown>).buildK3sValues, 'function');
});


const definition = (extra: Partial<ServiceDefinition> = {}): ServiceDefinition => ({
  service: 'inference', version: '1.4.2',
  artifact: { image: `registry.example/runtime@sha256:${'a'.repeat(64)}`, program: { 'linux-x64': { url: 'file:///disposable/runtime', sha256: 'b'.repeat(64), command: ['runtime', 'serve'] } } },
  ports: [{ name: 'api', port: 11434 }], health: { http: '/api/version', every_s: 30 },
  contract_tests: ['http:/api/tags'], alongside: 'full', placement: { mode: 'pinned', device: 'hub', roles: ['compute'], needs: { gpu_vram_gb: 8 } },
  resources: { memory_mb: 4096 }, secrets: [], egress: 'none', os_permissions: [], soak_s: 86400, ...extra,
});
const context = { namespace: 'nova-services', hubId: 'hub-one', live: null, kept: [] };
// The export assertion above gives a genuine missing-feature failure before the implementation exists.
const build = (...args: Parameters<NonNullable<typeof core.buildK3sValues>>) => core.buildK3sValues(...args);

test('literal values pin image, public ports, Linux, HTTP probes, placement, resources and soak without native commands', () => {
  const values = build([definition()], context);
  assert.deepEqual(values, literalValues);
  assert.ok(!JSON.stringify(values).includes('file:///disposable'));
  assert.ok(!JSON.stringify(values).includes('contract_tests'));
});

test('stable only selects explicit live; kept and alongside none candidates cannot start', () => {
  const one = definition();
  const two = definition({ version: '2.0.0' });
  const noLive = build([one, two], context);
  assert.ok(noLive.versions.every((v) => v.selector['nova/version'] !== noLive.stableSelector['nova/version']));
  const selected = build([one, two], { ...context, live: two.version, kept: [one.version] });
  assert.deepEqual(selected.stableSelector, selected.versions[1]!.selector);
  assert.deepEqual(selected.versions.map((v) => v.replicas), [0, 1]);
  assert.equal(build([definition({ alongside: 'none' })], context).versions[0]!.replicas, 0);
  assert.throws(() => build([one], { ...context, kept: [one.version], replicas: { [one.version]: 1 } }), /kept/);
  assert.throws(() => build([definition({ alongside: 'none' })], { ...context, replicas: { '1.4.2': 1 } }), /alongside/);
});

test('safe state has one writer and only a local-path PVC reference; secret values never enter values', () => {
  const def = definition({ alongside: 'none', state: { volume: 'models', size_gb: 50 }, secrets: ['secret://models/API_key'] });
  const out = build([def], { ...context, live: def.version });
  assert.deepEqual(out.versions[0]!.state, { claimName: 'pvc-5dc3a1d005aeef0279b0696238b4cedc5319d7e3', volume: 'models', sizeGi: 50, mountPath: '/var/lib/nova/state' });
  assert.deepEqual(out.versions[0]!.secretRefs, [{ reference: 'secret://models/API_key', name: 'secret-2b393d732bcb12ca896bc6635c4a1d70f5601295' }]);
  const other = { ...def, version: '2.0.0' };
  const retained = build([def, other], { ...context, live: other.version, kept: [def.version] });
  assert.equal(retained.versions[0]!.state!.claimName, retained.versions[1]!.state!.claimName);
  assert.deepEqual(retained.versions.map((v) => v.replicas), [0, 1]);
  assert.throws(() => build([definition({ state: { volume: 'models' } })], context), /state/);
});

test('floating replicas spread across eligible Linux nodes and preserve integer hardware thresholds', () => {
  const def = definition({ placement: { mode: 'floating', replicas: 3, needs: { gpu_vram_gb: 8, memory_gb: 16, disk_gb: 10 } } });
  const v = build([def], context).versions[0]!;
  assert.equal(v.replicas, 3);
  assert.equal(v.spread, true);
  assert.deepEqual(v.nodeSelector, { 'kubernetes.io/os': 'linux', 'nova/role-general-server': 'true' });
  assert.deepEqual(v.requiredNodeExpressions, [
    { key: 'nova/gpu-vram-gb', operator: 'Gt', values: ['7'] },
    { key: 'nova/memory-gb', operator: 'Gt', values: ['15'] },
    { key: 'nova/disk-gb', operator: 'Gt', values: ['9'] },
  ]);
});

test('invalid cast definitions/context and unrenderable semantics fail closed', () => {
  const bad = (extra: Record<string, unknown>) => ({ ...definition(), ...extra }) as ServiceDefinition;
  for (const defs of [[], [bad({ mystery: true })], [bad({ artifact: { image: 'latest' } })], [bad({ service: '{{evil}}' })], [definition(), definition()], [definition(), definition({ service: 'other', version: '2' })], [bad({ placement: { mode: 'pinned', device: 'hub', needs: { memory_gb: Infinity } } })], [bad({ resources: { memory_mb: 0 } })], [bad({ secrets: ['credential-canary-secret'] })], [definition({ artifact: { program: definition().artifact.program } })], [definition({ alongside: 'copy' })], [definition({ alongside: 'shadow' })], [definition({ os_permissions: ['root'] })]]) {
    assert.throws(() => build(defs, context));
  }
  const invalidContexts: core.K3sChartContext[] = [{ ...context, namespace: 'Other/namespace' }, { ...context, namespace: 'a'.repeat(64) }, { ...context, live: 'missing' }, { ...context, kept: ['missing'] }, { ...context, live: '1.4.2', kept: ['1.4.2'] }, { ...context, replicas: { missing: 1 } }, { ...context, replicas: { '1.4.2': -1 } }];
  for (const ctx of invalidContexts) assert.throws(() => build([definition()], ctx));
  assert.throws(() => build([bad({ secrets: ['credential-canary-secret'] })], context), (e: Error) => !e.message.includes('credential-canary-secret'));
});

test('long and hostile accepted node/version identities produce safe distinct deterministic tokens', () => {
  const def = definition({ service: 'a'.repeat(53), version: `V${'_'.repeat(63)}`, placement: { mode: 'pinned', device: 'node\n---\n{{ .Values.secret }}' } });
  const a = build([def], context);
  const b = build([{ ...def, version: `W${'_'.repeat(63)}` }], context);
  const dns = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  for (const name of [a.service.name, a.service.selector, a.versions[0]!.name, a.versions[0]!.previewName, a.versions[0]!.selector['nova/version'], a.versions[0]!.nodeSelector['nova/device']!]) assert.match(name, dns);
  assert.notEqual(a.versions[0]!.name, b.versions[0]!.name);
  assert.deepEqual(build([def], context), a);
  assert.notEqual(a.versions[0]!.name, a.versions[0]!.previewName);
});

const literalValues = {
  namespace: 'nova-services',
  service: { identity: 'inference', name: 'service-11fb499f16d38045efc6b601d6bfea77ffbd584c', selector: 'selector-2d571c62ef00c5813578d5dd8b5e52396719ade6', ports: [{ name: 'api', port: 11434 }] },
  live: null,
  stableSelector: { 'nova/service': 'selector-2d571c62ef00c5813578d5dd8b5e52396719ade6', 'nova/version': 'unselected-f31542a884ee7b8b7d1c728ae9c82f8952b7d94d' },
  versions: [{
    identity: '1.4.2', name: 'deployment-dd330cc4d8b63dbdbd236b95606c27779999a6ba', previewName: 'preview-8c280df3ddbe85755210f65e314093532e2b306c', networkPolicyName: 'network-6f133be8f2240420c4cb512c96a76e713014014c',
    selector: { 'nova/service': 'selector-2d571c62ef00c5813578d5dd8b5e52396719ade6', 'nova/version': 'version-5e5b18e3b3d6153fa86ba4dfdd722b766b8d58ca' },
    replicas: 1, image: { repository: 'registry.example/runtime', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    ports: [{ name: 'api', port: 11434 }], probe: { httpGet: { path: '/api/version', port: 'api', scheme: 'HTTP' }, periodSeconds: 30 },
    placement: { mode: 'pinned', device: 'hub-one', roles: ['compute'], needs: { gpu_vram_gb: 8 }, failover: null, allowedDevices: [] },
    nodeSelector: { 'kubernetes.io/os': 'linux', 'nova/role-compute': 'true', 'nova/device': 'hub-one' },
    requiredNodeExpressions: [{ key: 'nova/gpu-vram-gb', operator: 'Gt', values: ['7'] }], preferredNodeExpressions: [], spread: false,
    resources: { requests: { memory: '4096Mi' }, limits: { memory: '4096Mi' } }, state: null, secretRefs: [], alongside: 'full', egress: 'none', soakSeconds: 86400,
  }],
};

test('preferred placement consumes the real resolver result and confines scheduling to that choice', () => {
  const def = definition({ placement: { mode: 'preferred', roles: ['compute'], needs: { gpu_vram_gb: 8 }, failover: 'any' } });
  const resolution = core.resolvePlacement(def, [{ id: 'worker-one', name: 'Worker', kind: 'computer', role: 'spoke', platform: 'linux x64', purposes: ['compute'], trust: 'trusted', healthy: true, last_seen: null, hardware: { ram_bytes: 32 * 1024 ** 3, gpus: [{ vram_bytes: 12 * 1024 ** 3, unified: false }], disk: { free_bytes: 100 * 1024 ** 3 }, platform: 'linux', arch: 'x64' } }]);
  assert.equal(resolution.ok, true);
  const v = build([def], { ...context, placements: { '1.4.2': resolution } }).versions[0]!;
  assert.deepEqual(v.placement.allowedDevices, ['worker-one']);
  assert.deepEqual(v.requiredNodeExpressions, [{ key: 'nova/gpu-vram-gb', operator: 'Gt', values: ['7'] }, { key: 'nova/device', operator: 'In', values: ['worker-one'] }]);
  assert.deepEqual(v.preferredNodeExpressions, [{ key: 'nova/device', operator: 'In', values: ['worker-one'] }]);
  assert.throws(() => build([def], context), /resolved/);
  assert.throws(() => build([def], { ...context, placements: { '1.4.2': { ok: false, mode: 'preferred', down: true, why: 'offline', considered: [] } } }), /resolved/);
});

const chart = (path: string) => readFileSync(new URL(`../../charts/nova-service/${path}`, import.meta.url), 'utf8');
test('repository chart has closed local schema and fixed namespace, Linux, PVC, probe and routing templates', () => {
  const schema = JSON.parse(chart('values.schema.json')) as Record<string, unknown>;
  assert.equal(schema.additionalProperties, false);
  const source = chart('templates/workloads.yaml');
  assert.match(chart('Chart.yaml'), /name: nova-service/);
  for (const needle of ['.Release.Namespace', '.Values.namespace', 'kind: Deployment', 'kind: Service', 'stableSelector', 'previewName', 'readinessProbe', 'livenessProbe', 'runAsNonRoot', 'allowPrivilegeEscalation: false', 'RuntimeDefault', 'type: Recreate', 'persistentVolumeClaim', 'requiredDuringSchedulingIgnoredDuringExecution', 'preferredDuringSchedulingIgnoredDuringExecution', 'podAntiAffinity']) assert.ok(source.includes(needle), needle);
  const storage = chart('templates/storage.yaml');
  assert.match(storage, /storageClassName: local-path/);
  assert.match(storage, /ReadWriteOnce/);
  const network = chart('templates/network.yaml');
  assert.match(network, /kind: NetworkPolicy/);
  assert.match(network, /egress: \[\]/);
  for (const file of [source, storage, network]) {
    assert.doesNotMatch(file, /\b(?:tpl|lookup|hostPath|hostNetwork|hostPID|hostIPC|ClusterRole|Secret)\b/);
    assert.doesNotMatch(file, /\.Values\.live/);
  }
  assert.match(chart('README.md'), /stopped/);
});

// Test-only evaluator for the exact local draft-07 vocabulary used by this schema. This checks
// data/schema drift; it does not stand in for a Helm process or Kubernetes API validation.
type Schema = { [key: string]: unknown };
function conforms(value: unknown, schema: Schema, root: Schema): boolean {
  if (typeof schema.$ref === 'string') {
    assert.match(schema.$ref, /^#\/definitions\/[A-Za-z]+$/);
    return conforms(value, (root.definitions as Record<string, Schema>)[schema.$ref.slice('#/definitions/'.length)]!, root);
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s) => conforms(value, s as Schema, root))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  const matches = (type: unknown) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || (typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) return false;
  if (typeof value === 'string' && ((typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) || (typeof schema.minLength === 'number' && value.length < schema.minLength) || (typeof schema.maxLength === 'number' && value.length > schema.maxLength))) return false;
  if (Array.isArray(value)) {
    if ((typeof schema.minItems === 'number' && value.length < schema.minItems) || (typeof schema.maxItems === 'number' && value.length > schema.maxItems)) return false;
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every((v) => conforms(v, schema.items as Schema, root))) return false;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((k) => !Object.hasOwn(obj, k as string))) return false;
    const props = schema.properties as Record<string, Schema> | undefined;
    for (const [k, v] of Object.entries(obj)) {
      if (props && Object.hasOwn(props, k)) { if (!conforms(v, props[k]!, root)) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  return true;
}

test('schema accepts literal and state/preferred/floating output and rejects malformed nested data', () => {
  const schema = JSON.parse(chart('values.schema.json')) as Schema;
  const state = definition({ alongside: 'none', state: { volume: 'models', size_gb: 50 }, secrets: ['secret://models/API_key'] });
  for (const value of [literalValues, build([state], { ...context, live: state.version }), build([definition({ placement: { mode: 'floating', replicas: 2 } })], context), JSON.parse(chart('values.yaml').replace(/^#.*\n/, ''))]) assert.equal(conforms(value, schema, schema), true);
  for (const mutate of [
    (v: Record<string, any>) => { v.arbitraryManifest = {}; },
    (v: Record<string, any>) => { v.namespace = 'bad/namespace'; },
    (v: Record<string, any>) => { v.versions[0].image.digest = 'latest'; },
    (v: Record<string, any>) => { v.versions[0].nodeSelector['kubernetes.io/os'] = 'windows'; },
    (v: Record<string, any>) => { v.versions[0].probe.exec = { command: ['sh'] }; },
    (v: Record<string, any>) => { v.versions[0].resources.requests.cpu = '1'; },
    (v: Record<string, any>) => { v.versions[0].state = { hostPath: '/private' }; },
    (v: Record<string, any>) => { v.versions[0].secretRefs = [{ reference: 'credential-canary', name: 'private' }]; },
    (v: Record<string, any>) => { v.versions[0].replicas = -1; },
    (v: Record<string, any>) => { v.versions[0].placement.needs.unknown = 1; },
    (v: Record<string, any>) => { delete v.stableSelector; },
  ]) {
    const value = structuredClone(literalValues);
    mutate(value);
    assert.equal(conforms(value, schema, schema), false);
  }
  const visit = (v: unknown) => {
    if (v && typeof v === 'object') {
      if ('$ref' in v) assert.match(String(v.$ref), /^#\/definitions\//);
      if ('type' in v && v.type === 'object') assert.equal((v as Schema).additionalProperties, false);
      for (const child of Object.values(v)) visit(child);
    }
  };
  visit(schema);
});


test('the identical image-plus-program definition still produces the literal native supervisor plan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-k3s-plan-'));
  const unused = (): never => { throw new Error('No console call expected in a pure plan.'); };
  try {
    const driver = new SupervisorDriver({ dir, platform: 'linux-x64', hubId: () => 'hub-one', timings: { backoffMs: 1, maxBackoffMs: 1, crashes: 1, windowMs: 1, healthFailures: 1, readyMs: 1, canaryMs: 1, probeEveryMs: 1 }, problem: () => {}, console: { definition: unused, status: unused, prepare: unused, deploy: unused, rollback: unused } });
    const def = definition();
    assert.deepEqual(build([def], context), literalValues);
    const exe = join(dir, 'services', 'inference', 'versions', '1.4.2', 'bin', 'runtime');
    assert.deepEqual(driver.plan(def), {
      driver: 'supervisor', service: 'inference', version: '1.4.2', tier: 2, where: 'this hub', ok: true, refused: [], command: [exe, 'serve'],
      steps: [
        { step: 'install', said: 'Copy runtime from its file: address into a slot of its own for 1.4.2, checking its SHA-256 (bbbbbbbbbbbb…). Nothing is downloaded.' },
        { step: 'alongside', said: `Start it next to the live version, on loopback ports of its own, with no traffic (full); after the switch both run on the real state until the old one stops. It runs exactly: ${JSON.stringify(exe)} "serve"` },
        { step: 'tests', said: 'Contract tests on its own port: GET /api/tags, each answering 2xx.' },
        { step: 'health', said: 'GET /api/version answers 2xx 3 times in a row.' },
        { step: 'approval', said: 'Promotion asks first (tier 2).' },
        { step: 'canary', said: 'Point the stable port (api 127.0.0.1:11434) at it, then watch its health. A failure points it back by itself.' },
        { step: 'promote', said: 'Stop the old version and keep its slot for 86400 s. A failure in that time goes back in one step, with nothing installed.' },
      ],
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prototype-named versions use only explicit replica and placement keys', () => {
  for (const version of ['constructor', 'toString', 'hasOwnProperty']) {
    const def = definition({ version });
    assert.equal(build([def], context).versions[0]!.replicas, 1);
    assert.equal(build([def], { ...context, replicas: { [version]: 0 } }).versions[0]!.replicas, 0);
  }
});

test('invalid primitive namespace, unrenderable ports/images and duplicate refs never escape the closed schema', () => {
  const schema = JSON.parse(chart('values.schema.json')) as Schema;
  assert.throws(() => build([definition()], { ...context, namespace: 123 as unknown as string }));
  assert.throws(() => build([definition({ ports: [{ name: 'api-', port: 11434 }] })], context), /port/);
  assert.throws(() => build([definition({ artifact: { image: `registry.example//runtime@sha256:${'a'.repeat(64)}` } })], context), /image/);
  const def = definition({ placement: { mode: 'pinned', device: 'hub', roles: ['compute', 'compute'] }, secrets: ['secret://one', 'secret://one'] });
  const out = build([def], context);
  assert.deepEqual(out.versions[0]!.placement.roles, ['compute']);
  assert.equal(out.versions[0]!.secretRefs.length, 1);
  assert.equal(conforms(out, schema, schema), true);
});

test('state claim size/device conflicts and replica surges refuse; traffic changes leave pod inputs unchanged', () => {
  const one = definition({ alongside: 'none', state: { volume: 'models', size_gb: 50 } });
  const two = { ...one, version: '2.0.0' };
  assert.throws(() => build([one, { ...two, state: { volume: 'models', size_gb: 51 } }], { ...context, live: one.version }), /size/);
  assert.throws(() => build([one, { ...two, placement: { mode: 'pinned', device: 'other-node' } }], { ...context, live: one.version }), /device/);
  assert.throws(() => build([one], { ...context, live: one.version, replicas: { [one.version]: 2 } }), /replicas/);
  const before = build([one, two], { ...context, live: one.version });
  const after = build([one, two], { ...context, live: two.version, kept: [one.version] });
  const podInputs = (values: core.K3sChartValues) => values.versions.map(({ replicas: _replicas, ...v }) => v);
  assert.deepEqual(podInputs(before), podInputs(after));
  assert.notDeepEqual(before.stableSelector, after.stableSelector);
});

test('opaque device tokens cannot alias accepted literal device IDs or prototype-named placement keys', () => {
  const hostile = definition({ placement: { mode: 'pinned', device: 'hostile\nnode' } });
  const first = build([hostile], context).versions[0]!.nodeSelector['nova/device']!;
  const literal = definition({ placement: { mode: 'pinned', device: first } });
  assert.notEqual(build([literal], context).versions[0]!.nodeSelector['nova/device'], first);
  const preferred = definition({ version: 'constructor', placement: { mode: 'preferred' } });
  assert.throws(() => build([preferred], { ...context, placements: {} }), /resolved/);
});

test('schema output also accepts fractional hardware thresholds and explicit successful preferred placement', () => {
  const def = definition({ placement: { mode: 'preferred', roles: ['storage'], needs: { disk_gb: 1.5 } } });
  const resolution: core.PlacementResolution = { ok: true, mode: 'preferred', devices: [{ id: 'worker\n{{ unsafe }}', name: 'Worker' }], moved: false, why: 'selected', considered: [] };
  const out = build([def], { ...context, placements: { [def.version]: resolution } });
  const schema = JSON.parse(chart('values.schema.json')) as Schema;
  assert.equal(conforms(out, schema, schema), true);
  assert.deepEqual(out.versions[0]!.requiredNodeExpressions[0], { key: 'nova/disk-gb', operator: 'Gt', values: ['1'] });
});

test('cast placement results cannot contain duplicate/missing devices or contradict a pinned target', () => {
  const resolution: core.PlacementResolution = { ok: true, mode: 'pinned', devices: [{ id: 'other', name: 'Other' }], moved: false, why: 'chosen', considered: [] };
  const cast = (devices: unknown, mode: 'pinned' | 'preferred' = 'preferred') => ({ ...resolution, mode, devices }) as unknown as core.PlacementResolution;
  const preferred = definition({ placement: { mode: 'preferred' } });
  for (const result of [cast([{ id: 'a', name: 'A' }, { id: 'a', name: 'A' }]), cast([,]), cast([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])]) assert.throws(() => build([preferred], { ...context, placements: { '1.4.2': result } }), /resolved/);
  assert.throws(() => build([definition()], { ...context, placements: { '1.4.2': { ...resolution, devices: [...resolution.devices] } } }), /pinned/);
  assert.throws(() => build([definition()], { ...context, placements: { '1.4.2': undefined as unknown as core.PlacementResolution } }));
});
