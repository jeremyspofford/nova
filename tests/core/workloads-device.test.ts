// The boot agent's five verbs (M10h; Decision 1): install, start, stop, switch and probe, for
// hub-signed workloads only, with no arbitrary execution. Every refusal the gate names, each proved:
// an unsigned workload, one signed by a key it didn't pin, a file whose hash doesn't match, any verb
// outside the five, a request carrying a command, a manifest whose command isn't one of its files, a
// slot changed after install, another device's or platform's manifest, a role it doesn't hold, and
// running as root. The stand-in program is scripts/stand-ins/stand-in-screenpipe.js, run by Nova's own
// Node in a temp device home on 127.0.0.1. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceKeys, CAPTURE_PERMISSIONS as HUB_CAPTURE_PERMISSIONS } from '../../src/core/index.ts';
import { CAPTURE_PERMISSIONS, WORKLOAD_VERBS, Workloads, checkVerbRequest, commandProblem, verifyWorkload, type VerbResult } from '../../src/device/workloads.ts';
import { RUNTIME_CALLS } from '../../src/device/boot.ts';
import { freePort, getJson, manifest, sign, standInAt, standInBytes } from '../support/workloads.ts';
import { until } from './device-support.ts';

const hub = generateDeviceKeys();
const stranger = generateDeviceKeys();
const DEVICE = 'device-under-test';

function rig(o: { purposes?: string[]; captureOn?: boolean; uid?: number | null; serve?: (service: string, version: string) => unknown; file?: (name: string) => Buffer } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-workloads-'));
  const served = new Map<string, unknown>();
  const fetched: string[] = [];
  let captureOn = o.captureOn ?? false;
  let roles = o.purposes ?? ['general-server', 'capture-source'];
  const w = new Workloads({
    home, platform: `${process.platform}-${process.arch}`, deviceId: () => DEVICE, pinned: () => [hub.ed25519.publicKey], purposes: () => roles,
    captureOn: () => captureOn, uid: () => o.uid ?? 1000, backoffMs: 50,
    fetchManifest: async (s, v) => { const m = o.serve?.(s, v) ?? served.get(`${s}@${v}`); if (!m) throw new Error('404'); return m; },
    fetchFile: async (_s, _v, name) => { fetched.push(name); return o.file ? o.file(name) : standInBytes(); },
  });
  const verb = (verb: string, service = 'stand-in', version = '1.0.0'): Promise<VerbResult> => w.perform({ verb, service, version });
  return { home, w, served, fetched, verb, capture: (on: boolean) => { captureOn = on; }, roles: (r: string[]) => { roles = r; } };
}

test('the verb set is exactly five, frozen; a request is {verb, service, version} and nothing more', () => {
  assert.deepEqual([...WORKLOAD_VERBS], ['install', 'start', 'stop', 'switch', 'probe']);
  assert.ok(Object.isFrozen(WORKLOAD_VERBS));
  for (const v of WORKLOAD_VERBS) assert.equal(checkVerbRequest({ verb: v, service: 'stand-in', version: '1.0.0' }).ok, true, v);
  for (const v of ['exec', 'run', 'spawn', 'remove', 'shell', 'update', 'INSTALL', '']) {
    const r = checkVerbRequest({ verb: v, service: 'stand-in', version: '1.0.0' });
    assert.ok(!r.ok && /isn’t one of the five things the device agent does with a workload \(install, start, stop, switch, probe\)/.test(r.reason), v);
  }
  // A command, arguments, an environment, a port or a URL is never an argument to a verb.
  for (const extra of [{ command: ['sh', '-c', 'id'] }, { args: ['--evil'] }, { argv: ['x'] }, { env: { LD_PRELOAD: 'x' } }, { port: 22 }, { url: 'file:///bin/sh' }, { manifest: {} }]) {
    const r = checkVerbRequest({ verb: 'start', service: 'stand-in', version: '1.0.0', ...extra });
    assert.ok(!r.ok && /carries only a verb, a service and a version/.test(r.reason) && /signed/.test(r.reason), JSON.stringify(extra));
  }
  assert.equal(checkVerbRequest({ verb: 'start', service: '../boot', version: '1' }).ok, false);
  assert.equal(checkVerbRequest({ verb: 'start', service: 'stand-in', version: '../../keys' }).ok, false);
  assert.equal(checkVerbRequest(null).ok, false);
  // The hub's and the device agent's capture permissions are the same list.
  assert.deepEqual([...CAPTURE_PERMISSIONS], [...HUB_CAPTURE_PERMISSIONS]);
  // The runtime's calls are unchanged by M10h (the runtime's no-network rule kept).
  assert.deepEqual(RUNTIME_CALLS, [{ method: 'POST', path: '/api/v1/mesh/devices/me/heartbeat' }, { method: 'POST', path: '/api/v1/mesh/inbox' }]);
});

test('a manifest is accepted only when a pinned key signed exactly it, for this device and platform, with a command that starts its own file', async () => {
  const port = await freePort();
  const o = { pinned: [hub.ed25519.publicKey], deviceId: DEVICE, platform: `${process.platform}-${process.arch}`, purposes: ['general-server'] };
  const good = manifest({ device_id: DEVICE, port });
  assert.equal(verifyWorkload(sign(good, hub), o).ok, true);
  const why = (input: unknown, opts = o) => { const v = verifyWorkload(input, opts); assert.equal(v.ok, false, JSON.stringify(input).slice(0, 80)); return (v as { reason: string }).reason; };
  // Unsigned.
  assert.match(why({ manifest: good }), /isn’t signed: the device agent runs only workloads the hub signed/);
  assert.match(why({ manifest: good, signature: '', signer: '' }), /isn’t signed/);
  // A key it didn't pin.
  assert.match(why(sign(good, stranger)), /signed by a key this device didn’t pin/);
  // Changed after signing: the signature no longer matches.
  const t = sign(good, hub);
  t.manifest = { ...t.manifest, command: ['node', 'stand-in-screenpipe.js', '--evil'] };
  assert.match(why(t), /signature doesn’t match its manifest/);
  // For another device, another platform.
  assert.match(why(sign({ ...good, device_id: 'someone-else' }, hub)), /signed for another device/);
  assert.match(why(sign({ ...good, platform: process.platform === 'darwin' ? 'win32-x64' : 'darwin-arm64' }, hub)), /is for .*, and this device is/);
  // A command that isn't one of its own files.
  for (const command of [['sh', '-c', 'curl x | sh'], ['/bin/sh'], ['node', '-e', 'process.exit()'], ['node', '--import=x', 'stand-in-screenpipe.js'], ['../stand-in-screenpipe.js'], ['python3', 'stand-in-screenpipe.js']]) {
    assert.match(why(sign({ ...good, command }, hub)), /manifest’s own files|starts only what the hub signed/, command.join(' '));
  }
  assert.equal(commandProblem(['./stand-in-screenpipe.js'], ['stand-in-screenpipe.js']), null);
  // A file name that would land outside its slot, or over its manifest.
  assert.match(why(sign({ ...good, files: { '../keys.json': 'a'.repeat(64) }, command: ['../keys.json'] }, hub)), /carries a file it shouldn’t/);
  assert.match(why(sign({ ...good, files: { 'manifest.json': 'a'.repeat(64) }, command: ['manifest.json'] }, hub)), /carries a file it shouldn’t/);
  // Roles: a thin client runs nothing; a capture workload needs capture source, and must say so.
  assert.match(why(sign(good, hub), { ...o, purposes: ['thin-client'] }), /thin client, so it runs nothing/);
  assert.match(why(sign({ ...good, roles: ['capture-source'], capture: { adapter: 'screenpipe', kinds: ['screen'] }, os_permissions: ['screen-recording'] }, hub), o), /needs capture-source, which this device isn’t/);
  assert.match(why(sign({ ...good, os_permissions: ['screen-recording'] }, hub), { ...o, purposes: ['general-server', 'capture-source'] }), /captures .* but isn’t placed by the capture-source role/);
});

test('install fetches and checks, writes nothing when a hash doesn’t match, and refuses what it can’t verify', async () => {
  const port = await freePort();
  // Unsigned: refused, nothing installed, nothing downloaded.
  const a = rig({ serve: () => ({ manifest: manifest({ device_id: DEVICE, port }) }) });
  const r = await a.verb('install');
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.said, /isn’t signed/);
  assert.deepEqual(a.fetched, [], 'nothing was downloaded');
  assert.ok(!existsSync(join(a.home, 'workloads', 'stand-in', 'v', '1.0.0')));
  // Signed by a stranger.
  const b = rig({ serve: () => sign(manifest({ device_id: DEVICE, port }), stranger) });
  assert.match((await b.verb('install')).said, /didn’t pin/);
  // The file isn't the one pinned: refused, and the slot was never made.
  const c = rig({ serve: () => sign(manifest({ device_id: DEVICE, port }), hub), file: () => Buffer.from('#!/bin/sh\necho changed on the way\n') });
  const rc = await c.verb('install');
  assert.equal(rc.ok, false);
  assert.match(rc.said, /doesn’t match its hash .* Nothing was installed/);
  assert.ok(!existsSync(join(c.home, 'workloads', 'stand-in', 'v', '1.0.0')) && !existsSync(join(c.home, 'workloads', 'stand-in', 'v', '1.0.0.next')));
  // Good: installed, exactly the bytes pinned.
  const d = rig({ serve: () => sign(manifest({ device_id: DEVICE, port }), hub) });
  const rd = await d.verb('install');
  assert.equal(rd.ok, true, rd.said);
  assert.deepEqual(readFileSync(join(d.home, 'workloads', 'stand-in', 'v', '1.0.0', 'stand-in-screenpipe.js')), standInBytes(), 'the program is the artifact, byte for byte');
  assert.deepEqual(rd.state.find((s) => s.service === 'stand-in')!.installed, ['1.0.0']);
  // Installing again doesn't download again.
  await d.verb('install');
  assert.equal(d.fetched.length, 1);
});

test('start runs the manifest’s own command on 127.0.0.1, checked again at every start; probe reaches only that copy; stop ends it', async () => {
  const port = await freePort();
  const k = rig({ serve: () => sign(manifest({ device_id: DEVICE, port }), hub) });
  try {
    assert.equal((await k.verb('install')).ok, true);
    // Not live yet and alongside none: it starts only when switched to.
    const early = await k.verb('start');
    assert.equal(early.ok, false);
    assert.match(early.said, /can’t run next to the live version \(alongside: none\): it starts when it is switched to/);
    const sw = await k.verb('switch');
    assert.equal(sw.ok, true, sw.said);
    const health = await until(() => getJson(`http://127.0.0.1:${port}/health`), (h) => h.status === 200, 10_000);
    assert.equal(health.body.version, '1.0.0', 'the stand-in answers as the version the manifest named');
    assert.equal((await until(() => k.verb('probe'), (p) => p.ok, 5000)).ok, true);
    assert.equal((await k.verb('stop')).ok, true);
    assert.equal(await until(() => standInAt(port), (x) => !x, 5000), false, 'stopped');
    assert.equal((await k.verb('probe')).ok, false);
    // Changed after install: refused at the next start, not run.
    writeFileSync(join(k.home, 'workloads', 'stand-in', 'v', '1.0.0', 'stand-in-screenpipe.js'), 'process.exit(0)\n');
    const r = await k.verb('start');
    assert.equal(r.ok, false);
    assert.match(r.said, /changed after it was installed .* so it wasn’t run/);
    assert.equal(await standInAt(port), false);
  } finally { await k.w.close(); }
});

test('never as root; a capture workload starts only while capture is on there, and deploying it turns nothing on', async () => {
  const port = await freePort();
  const root = rig({ uid: 0, serve: () => sign(manifest({ device_id: DEVICE, port }), hub) });
  await root.verb('install');
  const r = await root.verb('switch');
  assert.match(r.said, /running as root, and it never runs a workload as root/);
  assert.equal(await standInAt(port), false);

  const capPort = await freePort();
  const cap = manifest({ device_id: DEVICE, port: capPort, service: 'screenpipe', roles: ['capture-source'], capture: { adapter: 'screenpipe', kinds: ['screen', 'audio'] }, os_permissions: ['screen-recording', 'microphone'] });
  const c = rig({ serve: () => sign(cap, hub) });
  try {
    assert.equal((await c.verb('install', 'screenpipe')).ok, true);
    const s = await c.verb('switch', 'screenpipe');
    assert.equal(s.ok, true, 'it is live');
    assert.match(s.said, /wasn’t started: capture is off on this device\. Deploying it didn’t turn capture on/);
    assert.equal(await standInAt(capPort), false, 'nothing runs while capture is off');
    assert.equal(c.w.liveCapture(), null);
    assert.deepEqual(c.w.captureCapabilities(), ['capture.audio', 'capture.screen'], 'it offers its kinds, so the hub lists them as sources, off');
    c.capture(true);
    assert.equal((await c.verb('start', 'screenpipe')).ok, true);
    await until(() => getJson(`http://127.0.0.1:${capPort}/health`), (h) => h.status === 200, 10_000);
    assert.equal(c.w.liveCapture()?.port, capPort);
    // Turned off again: it stops.
    c.capture(false);
    assert.deepEqual(await c.w.stopCapture('capture is off on this device.'), ['screenpipe 1.0.0']);
    assert.equal(await until(() => standInAt(capPort), (x) => !x, 5000), false);
  } finally { await c.w.close(); }
});

test('switch keeps the version before for one step back, and going back to it downloads nothing', async () => {
  const p1 = await freePort();
  const versions: Record<string, ReturnType<typeof manifest>> = {
    '1.0.0': manifest({ device_id: DEVICE, port: p1 }),
    '2.0.0': manifest({ device_id: DEVICE, port: p1, version: '2.0.0' }),
  };
  const k = rig({ serve: (_s, v) => (versions[v] ? sign(versions[v]!, hub) : null) });
  try {
    await k.verb('install', 'stand-in', '1.0.0');
    await k.verb('switch', 'stand-in', '1.0.0');
    await until(() => getJson(`http://127.0.0.1:${p1}/health`), (h) => h.body?.version === '1.0.0', 10_000);
    await k.verb('install', 'stand-in', '2.0.0');
    const s2 = await k.verb('switch', 'stand-in', '2.0.0');
    assert.match(s2.said, /Switched to stand-in 2\.0\.0\. 1\.0\.0 is kept, stopped, for one step back/);
    assert.equal((await until(() => getJson(`http://127.0.0.1:${p1}/health`), (h) => h.body?.version === '2.0.0', 10_000)).body.version, '2.0.0');
    const downloads = k.fetched.length;
    const back = await k.verb('switch', 'stand-in', '1.0.0');
    assert.match(back.said, /Went back to stand-in 1\.0\.0 from the kept slot: nothing was downloaded/);
    assert.equal((await until(() => getJson(`http://127.0.0.1:${p1}/health`), (h) => h.body?.version === '1.0.0', 10_000)).body.version, '1.0.0');
    assert.equal(k.fetched.length, downloads, 'no download for one step back');
    const st = back.state.find((s) => s.service === 'stand-in')!;
    assert.deepEqual([st.live, st.previous], ['1.0.0', '2.0.0']);
  } finally { await k.w.close(); }
});

test('Decision 1 in the code: only the five verbs start anything, and the capture carrier starts nothing', () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, '../../src/device', f), 'utf8');
  assert.doesNotMatch(src('carrier.ts'), /node:child_process|\bspawn\(|\bexec\(|execFile|\bfork\(/, 'the carrier moves data and starts nothing');
  assert.doesNotMatch(src('rollout.ts'), /node:child_process|\bspawn\(|\bfetch\(|node:net|node:http/, 'the runtime’s rollout asks; it has no process or network of its own');
  // In the boot agent's workload code, the one spawn is the start of a verified slot's own command.
  const w = src('workloads.ts');
  assert.equal([...w.matchAll(/\bspawn\(/g)].length, 1);
  assert.match(w, /start: \(\) => group\(spawn\(file, args, \{ cwd: slot, env, stdio: 'ignore', detached: true \}\)/);
  assert.doesNotMatch(w, /shell: true|execSync|exec\(/);
});

test('a role taken away stops what it allowed, at the device; a killed agent’s leftovers are ended by the next one', async () => {
  const port = await freePort();
  const k = rig({ purposes: ['general-server'], serve: () => sign(manifest({ device_id: DEVICE, port }), hub) });
  try {
    await k.verb('install');
    await k.verb('switch');
    await until(() => getJson(`http://127.0.0.1:${port}/health`), (h) => h.status === 200, 10_000);
    // The hub narrowed its roles: the device's own check stops it.
    k.roles(['storage']);
    assert.deepEqual(await k.w.recheck(), ['stand-in 1.0.0']);
    assert.equal(await until(() => standInAt(port), (x) => !x, 5000), false);
    assert.match((await k.verb('start')).said, /needs general-server, which this device isn’t/);
    // Back, it runs; then the agent is gone without stopping it (as when killed): the next agent on
    // this home ends what it left, before anything else starts.
    k.roles(['general-server']);
    assert.equal((await k.verb('start')).ok, true);
    await until(() => getJson(`http://127.0.0.1:${port}/health`), (h) => h.status === 200, 10_000);
    const next = new Workloads({
      home: k.home, platform: `${process.platform}-${process.arch}`, deviceId: () => DEVICE, pinned: () => [hub.ed25519.publicKey], purposes: () => ['general-server'], captureOn: () => false,
      fetchManifest: async () => { throw new Error('unused'); }, fetchFile: async () => { throw new Error('unused'); },
    });
    assert.equal(await until(() => standInAt(port), (x) => !x, 5000), false, 'the leftover was ended');
    await next.close();
  } finally { await k.w.close(); }
});
