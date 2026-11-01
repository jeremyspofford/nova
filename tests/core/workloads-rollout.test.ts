// The native update pipeline on a device (M10h; the orchestration ADR Point 6(b)), decided by the
// runtime agent and carried out by the boot agent's five verbs: fetch the signed new version, verify
// it, run it alongside or as a shadow where the definition says so, check its health, switch, keep the
// version before for a one-step rollback. First in-process (the runtime's Rollout over the boot
// agent's Workloads), then through the real agents: a boot agent running the sandboxed runtime child
// against a stand-in hub. And a runtime that asks for anything else is refused. Neutral placeholders
// only; the stand-in program runs on 127.0.0.1 in temp folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceKeys } from '../../src/core/index.ts';
import { Workloads } from '../../src/device/workloads.ts';
import { Rollout, type Assignment } from '../../src/device/rollout.ts';
import { Boot } from '../../src/device/boot.ts';
import { FAST, FakeNode, bundle, joinedHome, until } from './device-support.ts';
import { STAND_IN_NAME, freePort, getJson, manifest, sign, standInAt, standInBytes } from '../support/workloads.ts';

const SRC = join(import.meta.dirname, '../../src/device');
const runtimeFiles = () => Object.fromEntries(['runtime.ts', 'queue.ts', 'rollout.ts'].map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));
const at = (n: number) => `2026-11-01T10:0${n}:00.000Z`;
const assign = (version: string, want: Assignment['want'], alongside: Assignment['alongside'], n: number, previous: string | null = null): Assignment => ({ service: 'stand-in', version, want, previous, alongside, capture: false, assigned_at: at(n) });

test('in-process: shadow, health, switch; a version that can’t run twice starts at the switch; a failing one goes back by itself, downloading nothing', async () => {
  const hub = generateDeviceKeys();
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), 'nova-rollout-'));
  const versions: Record<string, ReturnType<typeof manifest>> = {
    '1.0.0': manifest({ device_id: 'dev', port, alongside: 'shadow' }),
    '2.0.0': manifest({ device_id: 'dev', port, version: '2.0.0', alongside: 'none' }),
    '3.0.0': manifest({ device_id: 'dev', port, version: '3.0.0', alongside: 'none', command: ['node', STAND_IN_NAME, '--sick'] }),
  };
  const downloads: string[] = [];
  const w = new Workloads({
    home, platform: `${process.platform}-${process.arch}`, deviceId: () => 'dev', pinned: () => [hub.ed25519.publicKey], purposes: () => ['general-server'], captureOn: () => false, uid: () => 1000, backoffMs: 50,
    fetchManifest: async (_s, v) => sign(versions[v]!, hub), fetchFile: async (_s, v) => { downloads.push(v); return standInBytes(); },
  });
  const verbs: string[] = [];
  const r = new Rollout({ verb: async (verb, service, version) => { verbs.push(`${verb} ${version}`); return w.perform({ verb, service, version }); }, passes: 2, gapMs: 150, file: join(home, 'rollout.json') });
  const report = (v: string) => r.reports().find((x) => x.version === v);
  try {
    // 1.0.0, deployed as a shadow: started on a port of its own, told it is a shadow, healthy twice.
    await r.step([assign('1.0.0', 'alongside', 'shadow', 1)], w.state());
    assert.equal(report('1.0.0')?.status, 'ready', JSON.stringify(r.reports()));
    assert.match(report('1.0.0')!.said, /passed 2 times in a row as a shadow/);
    const shadow = w.state()[0]!.running.find((x) => x.version === '1.0.0')!;
    assert.equal(shadow.role, 'shadow');
    assert.notEqual(shadow.ports.api, port, 'a shadow never takes the stable port');
    assert.equal((await getJson(`http://127.0.0.1:${shadow.ports.api}/health`)).body.shadow, true, 'it was told it is a shadow');
    assert.equal(await standInAt(port), false, 'nothing serves on the stable port before the promotion');
    // Promoted: switched, live on the stable port, its health checked.
    await r.step([assign('1.0.0', 'live', 'shadow', 2)], w.state());
    assert.equal(report('1.0.0')?.status, 'live');
    assert.equal(report('1.0.0')?.health, true);
    assert.deepEqual((await getJson(`http://127.0.0.1:${port}/health`)).body, { status: 'healthy', version: '1.0.0', shadow: false, frame_status: 'ok', audio_status: 'ok', last_frame_timestamp: null });

    // 2.0.0 can't run twice: ready once installed and checked, started only at the switch.
    await r.step([assign('2.0.0', 'alongside', 'none', 3, '1.0.0')], w.state());
    assert.equal(report('2.0.0')?.status, 'ready');
    assert.match(report('2.0.0')!.said, /can’t run next to the live version, so its health is checked when it is switched to/);
    assert.ok(!w.state()[0]!.running.some((x) => x.version === '2.0.0'), 'not started alongside');
    await r.step([assign('2.0.0', 'live', 'none', 4, '1.0.0')], w.state());
    assert.equal(report('2.0.0')?.status, 'live');
    assert.equal(report('1.0.0')?.status, 'kept');
    assert.equal((await getJson(`http://127.0.0.1:${port}/health`)).body.version, '2.0.0');

    // 3.0.0 fails its health after the switch: back to 2.0.0 by itself, from the kept slot.
    await r.step([assign('3.0.0', 'alongside', 'none', 5, '2.0.0')], w.state());
    const before = downloads.length;
    verbs.length = 0;
    await r.step([assign('3.0.0', 'live', 'none', 6, '2.0.0')], w.state());
    assert.equal(report('3.0.0')?.status, 'rolled_back', JSON.stringify(r.reports()));
    assert.match(report('3.0.0')!.said, /went back to 2\.0\.0 by itself, from the kept slot \(nothing was downloaded\)/);
    assert.deepEqual(verbs.filter((v) => !v.startsWith('probe')), ['switch 3.0.0', 'switch 2.0.0'], 'one step back: a switch, nothing installed');
    assert.equal(downloads.length, before, 'nothing was downloaded to go back');
    assert.equal((await until(() => getJson(`http://127.0.0.1:${port}/health`), (h) => h.body?.version === '2.0.0', 5000)).body.version, '2.0.0');
    assert.deepEqual([w.state()[0]!.live, w.state()[0]!.previous], ['2.0.0', '3.0.0']);
    // Not tried again for the same assignment.
    verbs.length = 0;
    await r.step([assign('3.0.0', 'live', 'none', 6, '2.0.0')], w.state());
    assert.deepEqual(verbs, []);
    // The live slot changed on disk while stopped: the boot agent refuses to start it; the runtime has
    // it installed again from the hub (verified afresh) and started.
    await w.perform({ verb: 'stop', service: 'stand-in', version: '2.0.0' });
    writeFileSync(join(home, 'workloads', 'stand-in', 'v', '2.0.0', STAND_IN_NAME), 'process.exit(1)\n');
    const d0 = downloads.length;
    verbs.length = 0;
    await r.step([assign('2.0.0', 'live', 'none', 7, '3.0.0')], w.state());
    assert.deepEqual((verbs as string[]).filter((v) => !v.startsWith('probe')), ['start 2.0.0', 'install 2.0.0', 'start 2.0.0']);
    assert.equal(downloads.length, d0 + 1, 'fetched again, once');
    assert.equal((await until(() => getJson(`http://127.0.0.1:${port}/health`), (h) => h.body?.version === '2.0.0', 5000)).body.version, '2.0.0');
    // What it reported survives a restart of the runtime.
    assert.equal(new Rollout({ verb: async () => { throw new Error('unused'); }, file: join(home, 'rollout.json') }).reports().find((x) => x.version === '3.0.0')?.status, 'rolled_back');
  } finally {
    await w.close();
  }
});

// A stand-in hub, a device whose roles allow general work, and the real boot agent.
async function device() {
  const hub = await new FakeNode().start();
  hub.roster = hub.sign({ epoch: 1, hub: hub.member() });
  hub.bundle = bundle(runtimeFiles(), hub.keys);
  const dev = joinedHome({ roster: hub.roster, hub, nodes: [hub] });
  const d = JSON.parse(readFileSync(dev.p.device, 'utf8'));
  writeFileSync(dev.p.device, JSON.stringify({ ...d, purposes: ['general-server'] }));
  const lines: string[] = [];
  const boot = new Boot(dev.home, { ...FAST }, { say: (l) => lines.push(l) });
  return { hub, dev, boot, lines, async stop() { await boot.shutdown(0); await hub.stop(); } };
}

const offer = (hub: FakeNode, deviceId: string, version: string, port: number, extra: Partial<ReturnType<typeof manifest>> = {}) => {
  hub.workloads.set(`stand-in@${version}`, sign(manifest({ device_id: deviceId, port, version, ...extra }), hub.keys));
  hub.workloadFiles.set(`stand-in@${version}/${STAND_IN_NAME}`, standInBytes());
};
const reported = (hub: FakeNode, version: string) => {
  for (let i = hub.heartbeats.length - 1; i >= 0; i--) {
    const w = (hub.heartbeats[i]!.workloads as { version: string; status: string; health: boolean | null; said: string }[] | undefined)?.find((x) => x.version === version);
    if (w) return w;
  }
  return null;
};

test('through the real agents: the runtime decides from its heartbeat answer, the boot agent installs, switches and rolls back, and the heartbeat reports it', { timeout: 90_000 }, async () => {
  const m = await device();
  const port = await freePort();
  try {
    offer(m.hub, m.dev.deviceId, '1.0.0', port);
    m.hub.heartbeatExtra = { workloads: [assign('1.0.0', 'alongside', 'none', 1)] };
    await m.boot.start({ signals: false });
    assert.equal((await until(() => reported(m.hub, '1.0.0'), (r) => r?.status === 'ready', 30_000))?.status, 'ready', m.lines.join('\n'));
    m.hub.heartbeatExtra = { workloads: [assign('1.0.0', 'live', 'none', 2)] };
    assert.equal((await until(() => reported(m.hub, '1.0.0'), (r) => r?.status === 'live' && r.health === true, 30_000))?.health, true, m.lines.join('\n'));
    assert.equal((await getJson(`http://127.0.0.1:${port}/health`)).body.version, '1.0.0');
    // The program runs as the boot agent's child, not the runtime's: the runtime can't start one.
    // A failing update: switched to, unhealthy, back to 1.0.0 by itself with nothing downloaded.
    offer(m.hub, m.dev.deviceId, '2.0.0', port, { command: ['node', STAND_IN_NAME, '--sick'] });
    m.hub.heartbeatExtra = { workloads: [assign('2.0.0', 'alongside', 'none', 3, '1.0.0')] };
    await until(() => reported(m.hub, '2.0.0'), (r) => r?.status === 'ready', 30_000);
    const downloads = m.hub.downloads.length;
    m.hub.heartbeatExtra = { workloads: [assign('2.0.0', 'live', 'none', 4, '1.0.0')] };
    const back = await until(() => reported(m.hub, '2.0.0'), (r) => r?.status === 'rolled_back', 30_000);
    assert.equal(back?.status, 'rolled_back', m.lines.join('\n'));
    assert.match(back!.said, /went back to 1\.0\.0 by itself/);
    assert.equal(m.hub.downloads.length, downloads, 'nothing was downloaded to go back');
    assert.equal((await until(() => getJson(`http://127.0.0.1:${port}/health`), (h) => h.body?.version === '1.0.0', 10_000)).body.version, '1.0.0');
    assert.deepEqual(m.hub.downloads, [`stand-in@1.0.0/${STAND_IN_NAME}`, `stand-in@2.0.0/${STAND_IN_NAME}`]);
  } finally {
    await m.stop();
  }
  assert.equal(await standInAt(port), false, 'the workload stops with its agent');
});

test('a runtime that asks for anything but the five verbs, or puts a command in a request, is refused, and the hub is told', { timeout: 60_000 }, async () => {
  const m = await device();
  const port = await freePort();
  try {
    offer(m.hub, m.dev.deviceId, '1.0.0', port);
    // A runtime that tries: a verb outside the five, a command of its own, a port, a manifest of its
    // own, and an unsigned version the hub never assigned; it writes down each answer.
    const sly = `
import { renameSync, writeFileSync } from 'node:fs';
const home = process.argv[2];
const answers = {};
const ask = (id, extra) => process.send({ type: 'verb', id, service: 'stand-in', version: '1.0.0', ...extra });
process.on('message', (m) => {
  if (m.type === 'session') {
    ask(1, { verb: 'exec' });
    ask(2, { verb: 'start', command: ['sh', '-c', 'touch ' + home + '/state/pwned'] });
    ask(3, { verb: 'install', port: 22 });
    ask(4, { verb: 'install', manifest: { files: {}, command: ['sh'] } });
    ask(5, { verb: 'install', version: '6.6.6' });
    ask(6, { verb: 'install' });
  }
  if (m.type === 'verb_answer') {
    answers[m.id] = { ok: m.ok, refused: !!m.refused, said: m.said };
    writeFileSync(home + '/state/answers.json.tmp', JSON.stringify(answers));
    renameSync(home + '/state/answers.json.tmp', home + '/state/answers.json');
  }
});
process.send({ type: 'ready' });
`;
    m.hub.bundle = bundle({ 'runtime.ts': sly, 'queue.ts': '' }, m.hub.keys);
    await m.boot.start({ signals: false });
    const file = join(m.dev.p.state, 'answers.json');
    const a = await until(() => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}), (x) => Object.keys(x).length === 6, 30_000);
    assert.match(a[1].said, /"exec" isn’t one of the five things the device agent does with a workload/);
    for (const i of [2, 3, 4]) {
      assert.equal(a[i].ok, false, String(i));
      assert.equal(a[i].refused, true, String(i));
      assert.match(a[i].said, /carries only a verb, a service and a version/);
    }
    assert.equal(a[5].ok, false, 'a version the hub never signed for it');
    assert.match(a[5].said, /Couldn’t fetch the manifest of stand-in 6\.6\.6/);
    assert.equal(a[6].ok, true, 'the signed, assigned one installs');
    assert.ok(!existsSync(join(m.dev.p.state, 'pwned')), 'its command never ran');
    assert.equal(await standInAt(port), false, 'and nothing was started');
    await until(() => m.hub.reports.filter((r) => r.problem === 'workload_refused').length, (n) => n >= 4, 10_000);
    assert.ok(m.hub.reports.filter((r) => r.problem === 'workload_refused').length >= 4, 'each refusal is reported to the hub');
  } finally {
    await m.stop();
  }
});

// The runtime's decisions alone, with stand-in verbs: what it asks for, given what the boot agent says.
function fake(state: { live: string | null; previous: string | null; installed: string[]; running: string[] }, probe: (v: string) => boolean) {
  const asked: string[] = [];
  const view = () => [{ service: 'stand-in', live: state.live, previous: state.previous, installed: state.installed, running: state.running.map((v) => ({ version: v, role: 'live' as const, ports: {}, since: '', failed: null })), capture: false, capture_on: false }];
  const verb = async (v: string, _s: string, version: string) => {
    asked.push(`${v} ${version}`);
    if (v === 'start') state.running = [...new Set([...state.running, version])];
    if (v === 'switch') { state.previous = state.live; state.live = version; state.running = [version]; }
    return { ok: v === 'probe' ? probe(version) : true, said: v, state: view() };
  };
  return { asked, view, verb };
}

test('the runtime goes back only to the version the hub keeps, never one it withdrew; the live version runs while a new one is tried', async () => {
  // After 3.0.0 failed and the device went back to 2.0.0, its own state still names 3.0.0 as kept, but
  // the hub cleared it: 2.0.0 failing its health now goes nowhere, least of all to 3.0.0.
  const a = fake({ live: '2.0.0', previous: '3.0.0', installed: ['2.0.0', '3.0.0'], running: ['2.0.0'] }, () => false);
  const r = new Rollout({ verb: a.verb as never, passes: 1, gapMs: 1, failsLive: 3 });
  for (let i = 0; i < 5; i++) await r.step([assign('2.0.0', 'live', 'none', 1, null)], a.view());
  assert.ok(!a.asked.includes('switch 3.0.0'), a.asked.join(', '));
  assert.equal(r.reports().find((x) => x.version === '2.0.0')?.health, false, 'it reports the failing health');
  // With the hub's kept version, it goes back to that one.
  const b = fake({ live: '2.0.0', previous: '3.0.0', installed: ['1.0.0', '2.0.0', '3.0.0'], running: ['2.0.0'] }, (v) => v !== '2.0.0');
  const rb = new Rollout({ verb: b.verb as never, passes: 1, gapMs: 1, failsLive: 3 });
  for (let i = 0; i < 4; i++) await rb.step([assign('2.0.0', 'live', 'none', 1, '1.0.0')], b.view());
  assert.ok(b.asked.includes('switch 1.0.0') && !b.asked.includes('switch 3.0.0'), b.asked.join(', '));
  // A new version deployed alongside: the live one, stopped (a restart), is started again first.
  const c = fake({ live: '1.0.0', previous: null, installed: ['1.0.0'], running: [] }, () => true);
  await new Rollout({ verb: c.verb as never, passes: 1, gapMs: 1 }).step([assign('2.0.0', 'alongside', 'none', 2, '1.0.0')], c.view());
  assert.deepEqual(c.asked.slice(0, 2), ['install 2.0.0', 'start 1.0.0']);
});
