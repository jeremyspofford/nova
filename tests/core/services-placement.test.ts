// The placement resolver (M10f, docs/plans/M10f.md §2; the orchestration ADR, Point 5): one test per
// mode and per refusal, the failover when a stand-in device stops heartbeating past the window, and
// the two checks of Point 9 (at proposal, and by the device agent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceManager, WORKLOAD_PURPOSES, resolvePlacement, validate, type PlacementDevice, type ServiceDefinition, type ServiceDriver } from '../../src/core/index.ts';
import { WORKLOAD_ROLES, assignmentAllowed } from '../../src/device/trust.ts';

const GB = 1024 ** 3;
const NOW = new Date('2026-10-31T12:00:00.000Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString();
const dev = (o: Partial<PlacementDevice> & { id: string }): PlacementDevice => ({
  name: o.id, kind: 'computer', role: 'spoke', platform: 'linux x64', purposes: ['general-server'], trust: 'trusted',
  hardware: { ram_bytes: 16 * GB, gpus: [], disk: { free_bytes: 200 * GB }, platform: 'linux', arch: 'x64' }, healthy: true, last_seen: ago(5), ...o,
});
const HUB = dev({ id: 'hub', role: 'hub', purposes: ['hub-candidate', 'general-server'] });
const GPU = dev({ id: 'gpu-box', purposes: ['compute'], hardware: { ram_bytes: 32 * GB, gpus: [{ vram_bytes: 12 * GB, unified: false }], disk: { free_bytes: 500 * GB }, platform: 'linux', arch: 'x64' } });
const SMALL_GPU = dev({ id: 'small-gpu', purposes: ['compute'], hardware: { ram_bytes: 16 * GB, gpus: [{ vram_bytes: 10 * GB, unified: false }], disk: { free_bytes: 100 * GB }, platform: 'linux', arch: 'x64' } });
const MAC = dev({ id: 'mac', platform: 'darwin arm64', purposes: ['compute'], hardware: { ram_bytes: 12 * GB, gpus: [{ vram_bytes: 0, unified: true }], disk: { free_bytes: 100 * GB }, platform: 'darwin', arch: 'arm64' } });
const PHONE = dev({ id: 'phone', kind: 'phone', role: 'client', platform: 'iPhone', purposes: ['thin-client'], hardware: null });
const LAPTOP_THIN = dev({ id: 'laptop', purposes: ['thin-client'] });
const BARE = dev({ id: 'bare', purposes: [] });

const program = (plats = ['linux-x64', 'darwin-arm64']) => Object.fromEntries(plats.map((p) => [p, { url: 'file:///opt/stand-in/runtime.js', sha256: 'a'.repeat(64), command: ['node', 'runtime.js'] }]));
const def = (placement: ServiceDefinition['placement'], extra: Partial<ServiceDefinition> = {}): Pick<ServiceDefinition, 'placement' | 'artifact' | 'resources'> => ({ placement, artifact: { program: program() }, ...extra });
const inference = (o: Partial<ServiceDefinition['placement']> = {}) => def({ mode: 'preferred', roles: ['compute'], needs: { gpu_vram_gb: 8 }, failover: 'any', ...o });

test('preferred: an inference service resolves to the compute device with the most GPU memory', () => {
  const r = resolvePlacement(inference(), [HUB, PHONE, SMALL_GPU, GPU, MAC, LAPTOP_THIN], { now: NOW });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(r.ok && r.devices.map((d) => d.id), ['gpu-box']);
  const why = Object.fromEntries(r.considered.map((c) => [c.id, c.why]));
  assert.match(why.hub!, /isn’t compute/);
  assert.match(why.phone!, /thin client, which never receives workloads/);
  assert.match(why.laptop!, /thin client, which never receives workloads/);
  assert.match(why.mac!, /can take it/, 'Apple’s unified memory counts as GPU memory (three quarters of 12 GB is 9 GB, enough for 8)');
});

test('preferred plus failover: stays while its device is healthy or briefly away, then moves past the window', () => {
  const window = { now: NOW, failoverAfterMs: 60_000, current: 'gpu-box' };
  const stays = resolvePlacement(inference(), [GPU, SMALL_GPU], window);
  assert.equal(stays.ok && stays.devices[0]!.id, 'gpu-box');
  // The stand-in stops heartbeating: 30 s is inside the window, so it stays and says so.
  const brief = resolvePlacement(inference(), [{ ...GPU, healthy: false, last_seen: ago(30) }, SMALL_GPU], window);
  assert.ok(brief.ok && brief.devices[0]!.id === 'gpu-box' && !brief.moved);
  assert.match(brief.why, /stays on gpu-box for now/);
  // Past it: the service moves to its failover.
  const gone = resolvePlacement(inference(), [{ ...GPU, healthy: false, last_seen: ago(90) }, SMALL_GPU], window);
  assert.ok(gone.ok && gone.devices[0]!.id === 'small-gpu' && gone.moved, gone.why);
  assert.match(gone.why, /moves to small-gpu, its failover/);
  // A named failover that isn't answering either: down, said plainly.
  const named = resolvePlacement(inference({ failover: 'small-gpu' }), [{ ...GPU, healthy: false, last_seen: ago(90) }, { ...SMALL_GPU, healthy: false }], window);
  assert.ok(!named.ok && named.down);
  assert.match(named.why, /failover, small-gpu, isn’t answering either/);
  // Nothing healthy, nothing placed yet: down, naming who could run it.
  const none = resolvePlacement(inference(), [{ ...GPU, healthy: false }], { now: NOW });
  assert.ok(!none.ok && none.down);
});

test('pinned: that device only; down means the service is down; a thin client is refused', () => {
  const ok = resolvePlacement(def({ mode: 'pinned', device: 'hub' }), [HUB, GPU], { now: NOW, hubId: 'hub' });
  assert.ok(ok.ok && ok.devices[0]!.id === 'hub');
  const down = resolvePlacement(def({ mode: 'pinned', device: 'gpu-box', roles: ['compute'] }), [{ ...GPU, healthy: false }], { now: NOW });
  assert.ok(!down.ok && down.down);
  assert.match(down.why, /pinned to gpu-box, which isn’t answering, so the service is down/);
  const thin = resolvePlacement(def({ mode: 'pinned', device: 'laptop' }), [LAPTOP_THIN], { now: NOW });
  assert.ok(!thin.ok && !thin.down);
  assert.match(thin.why, /thin client, which never receives workloads/);
  assert.match((resolvePlacement(def({ mode: 'pinned', device: 'nowhere' }), [HUB], { now: NOW }) as { why: string }).why, /no such device/);
});

test('floating: one copy on each of up to its replicas, best first, saying when fewer can', () => {
  const r = resolvePlacement(def({ mode: 'floating', replicas: 2 }), [HUB, dev({ id: 'srv', hardware: { ram_bytes: 64 * GB, gpus: [], disk: null } }), BARE, PHONE], { now: NOW });
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.devices.map((d) => d.id), ['srv', 'hub']);
  const few = resolvePlacement(def({ mode: 'floating', replicas: 3 }), [HUB, PHONE], { now: NOW });
  assert.ok(few.ok && few.devices.length === 1);
  assert.match(few.why, /asks for 3 copies; only 1 device is eligible/);
});

test('refusals: no workload role, a missing role, hardware not reported, too little, no program, containers off Linux, an unknown need, revoked', () => {
  const why = (d: ReturnType<typeof def>, device: PlacementDevice) => resolvePlacement(d, [device], { now: NOW }).considered[0]!.why;
  assert.match(why(def({ mode: 'floating' }), BARE), /no workload role yet/);
  assert.match(why(def({ mode: 'floating', roles: ['storage'] }), GPU), /isn’t storage/);
  assert.match(why(inference(), { ...GPU, hardware: null }), /hasn’t reported its hardware/);
  assert.match(why(inference({ needs: { gpu_vram_gb: 16 } }), GPU), /12 GB of GPU memory; it needs 16 GB/);
  assert.match(why(def({ mode: 'floating' }, { resources: { memory_mb: 64 * 1024 } }), HUB), /16 GB of memory; it needs 65536 MB/);
  assert.match(why(inference({ needs: { disk_gb: 1000 } }), GPU), /500 GB free; it needs 1000 GB/);
  assert.match(why({ placement: { mode: 'floating', roles: ['compute'] }, artifact: { program: program(['linux-x64']) } }, MAC), /darwin-arm64, and there is no program for it/);
  assert.match(why({ placement: { mode: 'floating', roles: ['compute'] }, artifact: { image: `registry.example/x@sha256:${'b'.repeat(64)}` } }, MAC), /containers run only on Linux/);
  assert.match(why(inference({ needs: { tpu_count: 1 } }), GPU), /can’t check tpu_count/);
  assert.match(why(def({ mode: 'floating' }), { ...HUB, trust: 'revoked' }), /was revoked/);
  // A phone or browser runs no agent: refused whatever its record says (a record can't say more, but the resolver doesn't rely on that).
  assert.match(why(def({ mode: 'floating', roles: ['compute'] }), { ...PHONE, purposes: ['compute'] }), /phone: a thin client, which never receives workloads/);
  const nowhere = resolvePlacement(def({ mode: 'preferred', roles: ['storage'] }), [HUB, PHONE], { now: NOW });
  assert.ok(!nowhere.ok && !nowhere.down);
  assert.match(nowhere.why, /No device may run it/);
});

test('the validator places by workload roles only, and names a need it can’t check', () => {
  const base = { service: 'stand-in', version: '1.0.0', artifact: { program: program(['linux-x64']) }, ports: [{ name: 'api', port: 18080 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'full', secrets: [], egress: 'local', os_permissions: [] };
  const problems = (placement: unknown) => { const v = validate({ ...base, placement }); return v.ok ? [] : v.problems; };
  assert.ok(problems({ mode: 'preferred', roles: ['thin-client'] }).some((p) => /“thin-client” isn’t a role a service is placed by/.test(p)));
  assert.ok(problems({ mode: 'preferred', roles: ['hub-candidate'] }).some((p) => /“hub-candidate” isn’t a role/.test(p)));
  assert.ok(problems({ mode: 'preferred', roles: ['compute'], needs: { tpu_count: 1 } }).some((p) => /needs\.tpu_count isn’t something Nova can check/.test(p)));
  assert.deepEqual(problems({ mode: 'preferred', roles: ['compute'], needs: { gpu_vram_gb: 8 } }), []);
});

test('checked twice: a placement on a thin client is refused at proposal, and again by the device agent', async () => {
  // At proposal: the Service Manager, given the hub's devices, refuses before any driver is asked.
  let asked = 0;
  const driver: ServiceDriver = {
    name: 'recording', available: () => ({ ok: true, said: 'here' }),
    plan: (d) => { asked++; return { driver: 'recording', service: d.service, version: d.version, tier: 2, ok: true, refused: [], where: 'hub', steps: [] }; },
    apply: async () => ({ ok: true, said: 'applied' }), status: () => [], switch: async () => ({ ok: true, said: '' }), rollback: async () => ({ ok: true, said: '' }),
  };
  const m = new ServiceManager({ dir: '/nonexistent-registry', drivers: [driver], placement: () => ({ devices: [HUB, LAPTOP_THIN, PHONE, GPU], hubId: 'hub' }) });
  const service = { service: 'stand-in', version: '1.0.0', artifact: { program: program(['linux-x64']) }, ports: [{ name: 'api', port: 18080 }], health: { http: '/health', every_s: 5 }, contract_tests: [], alongside: 'full', secrets: [], egress: 'local', os_permissions: [] };
  const thin = m.plan({ ...service, placement: { mode: 'pinned', device: 'laptop' } });
  assert.equal(thin.ok, false);
  assert.match((thin as { problems: string[] }).problems.join(' '), /pinned to laptop, which can’t take it: laptop is a thin client/);
  const out = await m.deploy({ ...service, placement: { mode: 'pinned', device: 'phone' } });
  assert.equal(out.ok, false);
  assert.match(out.said, /thin client, which never receives workloads/);
  assert.equal(asked, 0, 'no driver was asked to plan it');
  // A placement that resolves to another device is refused by a Service Manager with no remote
  // driver (the supervisor's): native workloads go through the hub's device driver (M10h).
  const away = m.plan({ ...service, placement: { mode: 'preferred', roles: ['compute'], needs: { gpu_vram_gb: 8 } } });
  assert.match((away as { problems: string[] }).problems.join(' '), /run on gpu-box\. This Service Manager runs services on the hub only/);
  assert.equal(m.plan({ ...service, placement: { mode: 'pinned', device: 'hub' } }).ok, true);

  // At the device: the agent's own check, against the roles it holds.
  assert.deepEqual(WORKLOAD_ROLES, WORKLOAD_PURPOSES, 'the device agent’s list is the hub’s');
  const refused = assignmentAllowed(['thin-client'], { service: 'stand-in' });
  assert.ok(!refused.ok && /thin client, so it runs nothing/.test(refused.reason));
  assert.equal(assignmentAllowed([], { service: 'stand-in' }).ok, false);
  assert.equal(assignmentAllowed(undefined, { service: 'stand-in' }).ok, false, 'a device that never heard its roles runs nothing');
  const wrong = assignmentAllowed(['storage'], { service: 'inference', roles: ['compute'] });
  assert.ok(!wrong.ok && /needs compute/.test(wrong.reason));
  assert.equal(assignmentAllowed(['compute', 'storage'], { service: 'inference', roles: ['compute'] }).ok, true);
});

test('review finding 8: a device that lost its role is said so, not “hasn’t answered”; a removed device counts as moved; floating waits out one late heartbeat', () => {
  // Answering, but no longer compute: it moves, and says why.
  const lost = resolvePlacement(inference(), [{ ...GPU, purposes: ['storage'] }, SMALL_GPU], { now: NOW, current: 'gpu-box' });
  assert.ok(lost.ok && lost.moved && lost.devices[0]!.id === 'small-gpu', JSON.stringify(lost));
  assert.match(lost.why, /gpu-box can no longer take it: gpu-box isn’t compute[\s\S]*moves to small-gpu/);
  assert.doesNotMatch(lost.why, /hasn’t answered/);
  // Its device removed from the registry: moved, and said so.
  const gone = resolvePlacement(inference(), [SMALL_GPU], { now: NOW, current: 'gpu-box' });
  assert.ok(gone.ok && gone.moved, JSON.stringify(gone));
  assert.match(gone.why, /gpu-box is no longer one of your devices[\s\S]*moves to small-gpu/);
  // Floating: the copy's device misses one heartbeat; inside the window it stays, past it it moves.
  const big = dev({ id: 'big', hardware: { ram_bytes: 64 * GB, gpus: [], disk: null } });
  const small = dev({ id: 'small' });
  const late = resolvePlacement(def({ mode: 'floating', replicas: 1 }), [{ ...big, healthy: false, last_seen: ago(30) }, small], { now: NOW, current: ['big'], failoverAfterMs: 60_000 });
  assert.ok(late.ok && late.devices[0]!.id === 'big' && !late.moved, JSON.stringify(late));
  const away = resolvePlacement(def({ mode: 'floating', replicas: 1 }), [{ ...big, healthy: false, last_seen: ago(90) }, small], { now: NOW, current: ['big'], failoverAfterMs: 60_000 });
  assert.ok(away.ok && away.devices[0]!.id === 'small' && away.moved, JSON.stringify(away));
});
