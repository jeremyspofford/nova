// Wake-on-LAN inference nodes: the ADR's golden cases (docs/plans/wol-inference-nodes-adr-2026-11-06.md,
// "Test plan"). The reference is the owner's Dell, a compute node woken by the always-on hub; the
// addresses are examples and the GPU is the 3090-class sample. Cases 2, 3, 4, 5, 11, 12 and 13 (the
// refusals, the rate limit and who may wake) are in tests/core/wol-hardening.test.ts; the rest are here.
//
// No real packet is ever sent (the recorder in tests/support/models.ts opens no socket), a wake waits
// by a fake clock that moves when it sleeps, and the OS's suspend and inhibitor are stand-ins: a test
// never sleeps a machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceKeys, type Core } from '../../src/core/index.ts';
import { checkHardware, withWol } from '../../src/core/models/hardware.ts';
import { SyncLog } from '../../src/core/mesh/sync.ts';
import { Log } from '../../src/core/log.ts';
import { Runtime, idleStep, type FromRuntime } from '../../src/device/runtime.ts';
import { Power, checkPowerRequest, sleepRefusal } from '../../src/device/power.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { startFakeOpenAI } from '../../scripts/stand-ins/fake-openai.js';
import { INSTALLED, SPOKE_LOOPBACK, hubHardware, modelsCore, say } from '../support/models.ts';

const GiB = 1024 ** 3;
const DELL_MAC = '02:00:5e:10:00:42';
const DELL_LAN = { name: 'eth0', mac: DELL_MAC, address: '192.168.1.42', netmask: '255.255.255.0', wol: 'magic' };
// The Dell's sample GPU, nothing else on it; `busyGiB` is what other programs hold.
const dellHw = (o: { busyGiB?: number; network?: Record<string, unknown>[] } = {}) => hubHardware({
  hostname: 'dell-desktop', network: o.network ?? [DELL_LAN, SPOKE_LOOPBACK],
  gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3090', vram_bytes: 24 * GiB, vram_free_bytes: (24 - (o.busyGiB ?? 0)) * GiB, unified: false }],
});
const big = say('x'.repeat(3000));
const settle = () => new Promise((r) => setImmediate(r));

// A clock that only moves when the wake sleeps; `tick` runs at each step (a heartbeat, Ollama up).
function fakeClock(tick: (t: number) => void | Promise<void> = () => {}) {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; await tick(t); await settle(); }, at: () => t };
}

function addComputer(core: Core, name: string) {
  const keys = generateDeviceKeys();
  return core.mesh.devices.add({ name, platform: 'linux x64', kind: 'computer', purposes: ['compute'], public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue', 'power'] }, 'test');
}
const rows = (core: Core, id: string) => core.db.all<{ outcome: string; origin: string; sender: string | null; reason: string | null; waited_ms: number | null }>('SELECT outcome, origin, sender, reason, waited_ms FROM device_wake WHERE device_id = ? ORDER BY id', id).map((r) => ({ ...r }));
const hostTask = (core: Core, title = 'Summarize the lease') => core.ledger.create({ title, owner: 'workspace', goal: title, origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation', note: 'stand-in' }], approval_tier: 2 } as never);
const wakeView = async (core: Core, id: string) => (await core.models.view()).devices.find((x) => x.id === id)!.wake!;

// The Dell, serving the reasoner, waking on demand, asleep; last woken in 38 s (two hours ago). The hub
// has only an embedder, so nothing on it can stand in for the reasoner.
async function dell(o: { privacy?: string; tick?: (t: number, x: { core: Core; d: { id: string }; spoke: Awaited<ReturnType<typeof startFakeOllama>> }) => void | Promise<void>; cloud?: boolean; hubModels?: typeof INSTALLED } = {}) {
  const hubOllama = await startFakeOllama({ models: o.hubModels ?? [INSTALLED[4]!] });
  const spoke = await startFakeOllama({ models: [INSTALLED[2]!] });
  const cloud = o.cloud ? await startFakeOpenAI({ model: 'cloud-model', reply: () => 'Answer from the cloud stand-in.' }) : null;
  const ref: { core?: Core; d?: { id: string } } = {};
  const clock = fakeClock((t) => o.tick?.(t, { core: ref.core!, d: ref.d!, spoke }));
  const { core, wol } = modelsCore(hubOllama.url, { privacy: o.privacy ?? 'local-only', models: { wakePollMs: 1000, wakeClock: clock } });
  const d = addComputer(core, 'Dell desktop');
  Object.assign(ref, { core, d });
  core.mesh.spokes.heartbeat(d, { hardware: dellHw() });
  await core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: spoke.url });
  core.models.setPower(d.id, { on_demand: true });
  core.db.run(`INSERT INTO device_wake (device_id, sent_at, awake_at, waited_ms, outcome, origin, sender) VALUES (?, ?, ?, 38000, 'awake', 'routing', 'hub')`, d.id, new Date(Date.now() - 2 * 3600_000).toISOString(), new Date(Date.now() - 2 * 3600_000 + 38_000).toISOString());
  if (cloud) core.models.setCloud({ name: 'Example cloud', base_url: cloud.url, model: 'cloud-model', usd_per_mtok_in: 1, usd_per_mtok_out: 1 }, true);
  spoke.setAsleep(true);
  // Its agent's last heartbeat said it was going to sleep, so it shows asleep at once.
  core.mesh.spokes.heartbeat(d, { going_to_sleep: true });
  return {
    core, wol, d, spoke, cloud, clock, hubOllama,
    close: async () => { await core.close(); await hubOllama.close(); await spoke.close(); await cloud?.close(); },
  };
}

// ---- 1: the Dell, woken by the hub --------------------------------------------------------------

test('golden case 1: the Dell, woken by the hub: 3 packets to 192.168.1.255:9 from 192.168.1.10, a wait of up to 59 s, then its heartbeat and Ollama, a re-fit, the run; recorded on the task', { timeout: 60_000 }, async () => {
  let waking: Awaited<ReturnType<typeof wakeView>> | null = null;
  const x = await dell({
    tick: async (t, { core, d, spoke }) => {
      if (t === 1000) waking = await wakeView(core, d.id);
      if (t === 2000) core.mesh.spokes.heartbeat(core.mesh.devices.get(d.id), { hardware: dellHw() });
      if (t === 3000) spoke.setAsleep(false);
    },
  });
  try {
    const task = hostTask(x.core);
    const out = await x.core.models.infer({ role: 'reasoner', messages: big, task_id: task.id });
    assert.equal(out.device, x.d.id);
    assert.match(out.notes.join(' '), /Nova woke Dell desktop; it answered after 3 s \(last time 38 s\)/);
    assert.equal(x.wol.packets.length, 3);
    for (const p of x.wol.packets) {
      assert.equal(p.bytes.length, 102);
      assert.deepEqual([...p.bytes.subarray(0, 6)], Array(6).fill(0xff));
      for (let i = 0; i < 16; i++) assert.equal([...p.bytes.subarray(6 + i * 6, 12 + i * 6)].map((b) => b.toString(16).padStart(2, '0')).join(':'), DELL_MAC);
      assert.deepEqual([p.host, p.port, p.bind], ['192.168.1.255', 9, '192.168.1.10']);
    }
    // While it woke, the screen said Waking, with the task, the measured wake and the wait's limit.
    assert.ok(waking);
    const w = waking as unknown as { state: string; screen: { pill: string; waiting: { text: string }; lines: string[] } };
    assert.equal(w.state, 'waking');
    assert.equal(w.screen.pill, 'Waking');
    assert.equal(w.screen.waiting.text, 'Waking Dell desktop for “Summarize the lease”');
    assert.match(w.screen.lines[0]!, /sent the wake signal at \d\d:\d\d\. Waking took 38 s last time, so Nova waits up to 59 s before it says what it will do instead\./);
    assert.match(w.screen.lines[1]!, /This is local only/);
    assert.deepEqual(rows(x.core, x.d.id).at(-1), { outcome: 'awake', origin: 'routing', sender: 'hub', reason: null, waited_ms: 3000 });
    const ev = x.core.ledger.events(task.id).filter((e) => e.kind === 'wake');
    assert.equal((ev.at(-1)!.detail as { outcome: string }).outcome, 'awake');
    assert.equal(x.spoke.requests.filter((r: { path: string }) => r.path === '/api/chat').length, 1, 'the model loaded and ran there');
    assert.equal((await wakeView(x.core, x.d.id)).state, 'awake');
  } finally {
    await x.close();
  }
});

// ---- 6, 9, 10: sent, no wake, and what Nova does instead ---------------------------------------

test('golden case 6: sent, no wake: no_answer after 59 s on the clock; the task waits (local-only); no second packet; the device is paused for new tasks', { timeout: 60_000 }, async () => {
  const x = await dell();
  try {
    const task = hostTask(x.core);
    await assert.rejects(x.core.models.infer({ role: 'reasoner', messages: big, task_id: task.id }), /Dell desktop didn’t answer after Nova woke it: it waited 59 s, half again what waking took last time \(38 s\)\. This is local-only, so it stays on your devices/);
    const last = rows(x.core, x.d.id).at(-1)!;
    assert.equal(last.outcome, 'no_answer');
    assert.ok(last.waited_ms! >= 59_000 && last.waited_ms! < 60_500, String(last.waited_ms));
    assert.equal(x.wol.packets.length, 3);
    const v = await wakeView(x.core, x.d.id);
    assert.equal(v.state, 'wake-failed');
    assert.equal(v.screen.pill, 'Couldn’t wake');
    assert.match(v.screen.lines[0]!, /sent the wake signal at \d\d:\d\d and waited 59 s, half again what waking took last time \(38 s\)\. Dell desktop didn’t answer\./);
    assert.match(v.screen.lines[1]!, /Nothing else that is awake fits example-deep:32b\. This is local only, so “Summarize the lease” waits on your devices and runs once Dell desktop checks in\. Nova won’t keep waking it\./);
    assert.deepEqual(v.screen.actions?.map((a: { action: string }) => a.action), ['models-wake-again']);
    // A new task: no wake until the device is heard from.
    await assert.rejects(x.core.models.infer({ role: 'reasoner', messages: big, task_id: hostTask(x.core, 'Another').id }), /won’t wake it again by itself until Dell desktop is heard from/);
    assert.equal(x.wol.packets.length, 3);
    assert.equal(x.cloud, null);
  } finally {
    await x.close();
  }
});

test('golden case 9: the Dell doesn’t wake and Small tower is awake with a model that fits: it runs there, the task and receipt say so, the cloud gets nothing', { timeout: 60_000 }, async () => {
  const x = await dell({ privacy: 'local-preferred', cloud: true });
  const tower = await startFakeOllama({ models: [INSTALLED[1]!] });
  try {
    const t = addComputer(x.core, 'Small tower');
    x.core.mesh.spokes.heartbeat(t, { hardware: hubHardware({ hostname: 'small-tower', network: [{ ...DELL_LAN, mac: '02:00:5e:10:00:43', address: '192.168.1.43' }, { ...SPOKE_LOOPBACK, mac: '02:00:5e:10:00:44' }], gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060 Ti', vram_bytes: 8 * GiB, vram_free_bytes: 8 * GiB, unified: false }] }) });
    x.core.profile.set('models', `runtime.${t.id}`, tower.url, 'settings');
    const task = hostTask(x.core);
    const out = await x.core.models.infer({ role: 'reasoner', messages: big, task_id: task.id });
    assert.equal(out.device, t.id);
    assert.equal(out.model, 'example-mid:8b');
    assert.match(out.notes.join(' '), /Dell desktop didn’t wake, so example-mid:8b on Small tower answered\./);
    assert.equal(x.core.receipts.list().find((r) => r.id === out.receipt_id)!.provider, 'ollama@small-tower');
    assert.equal(x.cloud!.requests.length, 0, 'the cloud stand-in got nothing');
    assert.match((await wakeView(x.core, x.d.id)).screen.lines[1]!, /so example-mid:8b on Small tower answered/);
  } finally {
    await x.close();
    await tower.close();
  }
});

test('golden case 10: local first, nothing else fits: the task waits and asks “Use the cloud model this once”; the cloud gets nothing until the person says yes', { timeout: 60_000 }, async () => {
  const x = await dell({ privacy: 'local-preferred', cloud: true });
  try {
    const task = hostTask(x.core);
    let reason = '';
    await assert.rejects(x.core.models.infer({ role: 'reasoner', messages: big, task_id: task.id }), (e: Error) => { reason = e.message; return /This is local first, so Nova asks before anything goes to the cloud: it waits until Dell desktop is on, unless you send it to your cloud model this once\./.test(e.message); });
    assert.equal(x.cloud!.requests.length, 0);
    // The task is parked waiting on local capacity, as the ledger does when a worker's call waits.
    x.core.db.run(`UPDATE task SET state = 'waiting', reason = ?, approved_at = ? WHERE id = ?`, reason, new Date().toISOString(), task.id);
    const v = await wakeView(x.core, x.d.id);
    assert.equal(v.state, 'wake-failed');
    assert.ok(v.screen.actions?.some((a: { action: string; label: string }) => a.action === 'models-cloud-once' && a.label === 'Use the cloud model this once'));
    assert.match(v.screen.lines[1]!, /This is local first, so Nova asks before anything goes to the cloud/);
    // Still nothing on its own: the watcher doesn't send it.
    await x.core.models.check();
    assert.equal(x.cloud!.requests.length, 0);
    // The person says yes: recorded on the task, and its next run goes to the cloud once.
    assert.deepEqual(x.core.models.cloudOnce(x.d.id).released, [task.id]);
    assert.ok(x.core.ledger.events(task.id).some((e) => e.kind === 'cloud_once'));
    const out = await x.core.models.infer({ role: 'reasoner', messages: big, task_id: task.id });
    assert.equal(out.served_by, 'cloud');
    assert.equal(x.cloud!.requests.length, 1);
    assert.match(out.notes.join(' '), /went off your devices/);
    // Another task still asks.
    await assert.rejects(x.core.models.infer({ role: 'reasoner', messages: big, task_id: hostTask(x.core, 'Another').id }), /Nova asks before anything goes to the cloud/);
    assert.equal(x.cloud!.requests.length, 1);
  } finally {
    await x.close();
  }
});

// ---- 7, 8: woke, but -----------------------------------------------------------------------------

test('golden case 7: woke, unhealthy: a heartbeat at 40 s and no Ollama: unhealthy a minute later, a problem opened, no second wake', { timeout: 60_000 }, async () => {
  const x = await dell({ tick: (t, { core, d }) => { if (t === 40_000) core.mesh.spokes.heartbeat(core.mesh.devices.get(d.id), { hardware: dellHw() }); } });
  try {
    const task = hostTask(x.core);
    await assert.rejects(x.core.models.infer({ role: 'reasoner', messages: big, task_id: task.id }), /Dell desktop woke after 40 s and its device agent checked in, but Ollama didn’t answer in the minute after/);
    assert.equal(x.clock.at(), 100_000, 'the minute after the heartbeat, not the wake limit');
    assert.equal(rows(x.core, x.d.id).at(-1)!.outcome, 'unhealthy');
    assert.ok(x.core.db.all<{ message: string }>('SELECT message FROM problem').some((p) => /Ollama didn’t answer in the minute after\. Check that Ollama starts with Dell desktop/.test(p.message)));
    await assert.rejects(x.core.models.infer({ role: 'reasoner', messages: big, task_id: task.id }), /already woke Dell desktop once for this task/);
    assert.equal(x.wol.packets.length, 3);
    // It is awake, so it isn't paused for other work.
    assert.equal(rows(x.core, x.d.id).at(-1)!.reason, 'once');
  } finally {
    await x.close();
  }
});

test('golden case 8: woke, no longer fits: the fresh heartbeat shows 18 GB of video memory in use: Won’t fit by the fit engine, nothing loaded, the fallback', { timeout: 60_000 }, async () => {
  const x = await dell({
    tick: (t, { core, d, spoke }) => {
      if (t === 1000) core.mesh.spokes.heartbeat(core.mesh.devices.get(d.id), { hardware: dellHw({ busyGiB: 18 }) });
      if (t === 2000) spoke.setAsleep(false);
    },
  });
  try {
    await assert.rejects(x.core.models.infer({ role: 'reasoner', messages: big, task_id: hostTask(x.core).id }), /Dell desktop woke, but 18 GB of its video memory is in use by other programs now, so example-deep:32b at \S+ with 4k context doesn’t fit/);
    assert.equal(x.spoke.requests.filter((r: { path: string }) => r.path === '/api/chat').length, 0, 'nothing loaded');
    assert.equal(rows(x.core, x.d.id).at(-1)!.outcome, 'awake', 'the wake itself worked');
  } finally {
    await x.close();
  }
});

// ---- 14: an older agent --------------------------------------------------------------------------

test('golden case 14: an older agent: no wol and no power verb: wol unknown, still wakeable on demand, the policy says the OS decides, the hub’s power field ignored', { timeout: 30_000 }, async () => {
  let at = Date.now();
  const hubOllama = await startFakeOllama({ models: [INSTALLED[4]!] });
  const spoke = await startFakeOllama({ models: [INSTALLED[2]!] });
  const { core } = modelsCore(hubOllama.url, { now: () => new Date(at) });
  try {
    const keys = generateDeviceKeys();
    const d = core.mesh.devices.add({ name: 'Old desktop', platform: 'linux x64', kind: 'computer', purposes: ['compute'], public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
    const card = { name: 'eth0', mac: DELL_MAC, address: '192.168.1.42', netmask: '255.255.255.0' };
    const answer = core.mesh.spokes.heartbeat(d, { capabilities: ['heartbeat', 'queue'], hardware: dellHw({ network: [card, SPOKE_LOOPBACK] }) });
    assert.equal(core.models.hardwareOf(d.id)!.network[0]!.wol, 'unknown');
    await core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: spoke.url });
    core.models.setPower(d.id, { on_demand: true, sleep_after_min: 30 });
    // The answer carries power; an agent that doesn't know it reads only the fields it knows.
    assert.deepEqual(core.mesh.spokes.heartbeat(d, { capabilities: ['heartbeat', 'queue'] }).power, { sleep_after_min: 30, hold: false });
    assert.ok(answer.ok);
    at += 3 * 60_000;
    const v = await wakeView(core, d.id);
    assert.equal(v.state, 'asleep-wakeable');
    assert.equal(v.screen.pill, 'Asleep, wakeable');
    assert.match(v.screen.policy.notes[0]!, /Its device agent can’t put it to sleep yet; the OS’s own power settings decide/);
  } finally {
    await core.close();
    await hubOllama.close();
    await spoke.close();
  }
});

test('the device agent reads Wake-on-LAN per card: ethtool’s Wake-on, else the card’s wakeup file; Wi-Fi and Windows unknown; macOS womp', async () => {
  const cards = [{ name: 'eth0', mac: '02:00:00:00:00:01', address: '192.168.1.42', netmask: '255.255.255.0', broadcast: null }, { name: 'eth1', mac: '02:00:00:00:00:02', address: '192.168.2.42', netmask: '255.255.255.0', broadcast: null }, { name: 'wlan0', mac: '02:00:00:00:00:03', address: '192.168.3.42', netmask: '255.255.255.0', broadcast: null }];
  const files: Record<string, string> = { '/sys/class/net/eth1/device/power/wakeup': 'disabled\n', '/sys/class/net/wlan0/uevent': 'DEVTYPE=wlan\n' };
  const linux = await withWol(cards, 'linux', async (p, a) => (p === 'ethtool' && a[0] === 'eth0' ? 'Supports Wake-on: pumbg\n\tWake-on: g\n' : null), (f) => files[f] ?? null);
  assert.deepEqual(linux.map((n) => n.wol), ['magic', 'off', 'unknown']);
  assert.deepEqual((await withWol(cards, 'darwin', async () => ' womp                 1\n')).map((n) => n.wol), ['magic', 'magic', 'magic']);
  assert.deepEqual((await withWol(cards, 'win32', async () => null)).map((n) => n.wol), ['unknown', 'unknown', 'unknown']);
  assert.equal(checkHardware(hubHardware({ network: linux })).network[1]!.wol, 'off');
});

// ---- 15: the sleep policy ------------------------------------------------------------------------

test('golden case 15, the count: hold false and the OS idle both for 30 minutes: one sleep; hold true: never; input at 29 minutes restarts it; Never sleep: never', () => {
  const run = (steps: { min: number; hold?: boolean; idleMin: number | null; policy?: number | null }[]) => {
    let s = { since: null as number | null, asked: false, last: null as number | null };
    const out: number[] = [];
    for (const x of steps) {
      const r = idleStep(s, { now: x.min * 60_000, sleep_after_min: x.policy === undefined ? 30 : x.policy, hold: x.hold ?? false, os_idle_ms: x.idleMin === null ? null : x.idleMin * 60_000 });
      s = r;
      if (r.sleep) out.push(x.min);
    }
    return out;
  };
  const every = (to: number, f: (m: number) => { hold?: boolean; idleMin: number | null; policy?: number | null }) => Array.from({ length: to + 1 }, (_, m) => ({ min: m, ...f(m) }));
  assert.deepEqual(run(every(90, (m) => ({ idleMin: m }))), [30], 'once, at 30 minutes');
  assert.deepEqual(run(every(90, (m) => ({ hold: true, idleMin: m }))), [], 'held: never');
  assert.deepEqual(run(every(90, (m) => ({ idleMin: m < 29 ? m : m - 29 }))), [59], 'input at 29 minutes: 30 more');
  assert.deepEqual(run(every(90, (m) => ({ idleMin: m, policy: null }))), [], 'never sleep');
  assert.deepEqual(run(every(90, () => ({ idleMin: null }))), [], 'an idle time Nova can’t read: never');
  // After it slept (a gap), the count starts again.
  assert.deepEqual(run([...every(31, (m) => ({ idleMin: m })), ...every(70, (m) => ({ idleMin: m })).slice(40)]), [30, 70]);
});

test('golden case 15, the agents: the runtime asks hold while the hub holds it, release after, one sleep when due; the boot agent’s verb takes only its action and checks again; the OS calls are stand-ins', async () => {
  const sent: FromRuntime[] = [];
  let t = 0;
  let power: { sleep_after_min: number | null; hold: boolean } = { sleep_after_min: 30, hold: true };
  let idleMs = 0;
  const home = mkdtempSync(join(tmpdir(), 'nova-power-'));
  const rt: Runtime = new Runtime(home, (m) => {
    sent.push(m);
    // The boot agent's side: the idle time first, then the hub's answer; power verbs answered ok.
    if (m.type === 'call') setImmediate(() => { rt.receive({ type: 'idle', ms: idleMs }); rt.receive({ type: 'answer', id: m.id, status: 200, body: { epoch: 1, power } }); });
    if (m.type === 'power') setImmediate(() => rt.receive({ type: 'power_answer', id: m.id, ok: true, said: 'ok' }));
  }, { now: () => t });
  const beat = async (min: number) => { t = min * 60_000; idleMs = t; await rt.heartbeat(); for (let i = 0; i < 5; i++) await settle(); };
  try {
    rt.receive({ type: 'session', hub_url: 'https://hub.example', device_id: 'd1', expires_at: new Date(Date.now() + 3600_000).toISOString(), version: '0', capabilities: ['heartbeat', 'queue', 'power'], heartbeat_ms: 3_600_000, tick_ms: 3_600_000 });
    for (let i = 0; i < 5; i++) await settle();
    const verbs = () => sent.filter((m): m is Extract<FromRuntime, { type: 'power' }> => m.type === 'power').map((m) => m.action);
    for (let m = 0; m <= 40; m += 5) await beat(m);
    assert.deepEqual(verbs(), ['hold'], 'held while Nova has work, and never asked to sleep');
    power = { sleep_after_min: 30, hold: false };
    for (let m = 45; m <= 100; m += 5) await beat(m);
    assert.deepEqual(verbs(), ['hold', 'release', 'sleep'], 'released, then one sleep 30 minutes later');
  } finally {
    rt.stop();
  }

  // The boot agent's side of the verb.
  assert.deepEqual(checkPowerRequest({ verb: 'power', action: 'sleep' }), { ok: true, action: 'sleep' });
  assert.equal(checkPowerRequest({ verb: 'power', action: 'shutdown' }).ok, false);
  assert.equal(checkPowerRequest({ verb: 'power', action: 'sleep', command: 'rm -rf /' }).ok, false);
  assert.equal(checkPowerRequest({ verb: 'install', action: 'sleep' }).ok, false);
  const ok = { sleep_after_min: 30, hold: false };
  assert.equal(sleepRefusal({ safeMode: false, verbsRunning: 0, power: ok }), null);
  assert.match(String(sleepRefusal({ safeMode: true, verbsRunning: 0, power: ok })), /safe mode/);
  assert.match(String(sleepRefusal({ safeMode: false, verbsRunning: 1, power: ok })), /installed, switched or started/);
  assert.match(String(sleepRefusal({ safeMode: false, verbsRunning: 0, power: { ...ok, hold: true } })), /Nova has work here/);
  assert.match(String(sleepRefusal({ safeMode: false, verbsRunning: 0, power: null })), /Never sleep/);
  const calls: string[] = [];
  let killed = 0;
  const p = new Power({ platform: 'linux', run: async (c, a) => { calls.push(`${c} ${a.join(' ')}`); return ''; }, spawn: (c, a) => { calls.push(`spawn ${c} ${a[0]}`); return { kill: () => { killed++; } }; } });
  p.hold();
  p.hold();
  assert.deepEqual(calls, ['spawn systemd-inhibit --what=sleep:idle'], 'one inhibitor, held once');
  assert.ok(p.held);
  p.release();
  assert.equal(killed, 1);
  assert.deepEqual(await p.sleep(), { ok: true, said: 'Going to sleep.' });
  assert.equal(calls.at(-1), 'systemctl suspend');
  // The OS idle time: logind's IdleSinceHint; a session in use is 0; nothing readable is null.
  const now = 10_000_000;
  const logind = new Power({ platform: 'linux', now: () => now, run: async (_c, a) => (a[0] === 'list-sessions' ? '2 1000 person seat0\n' : `IdleHint=yes\nIdleSinceHint=${(now - 600_000) * 1000}\n`) });
  assert.equal(await logind.osIdleMs(), 600_000);
  assert.equal(await new Power({ platform: 'linux', run: async (_c, a) => (a[0] === 'list-sessions' ? '2 1000 person seat0\n' : 'IdleHint=no\n') }).osIdleMs(), 0);
  assert.equal(await new Power({ platform: 'linux', run: async () => null }).osIdleMs(), null);
  assert.equal(await new Power({ platform: 'darwin', run: async () => '  "HIDIdleTime" = 120000000000\n' }).osIdleMs(), 120_000);
});

test('golden case 15, the hub: hold while a call runs and through the keep-alive; going_to_sleep shows it asleep at once', { timeout: 30_000 }, async () => {
  const x = await dell();
  try {
    x.spoke.setAsleep(false);
    const d = x.core.mesh.devices.get(x.d.id);
    x.core.models.setPower(x.d.id, { sleep_after_min: 30 });
    assert.deepEqual(x.core.mesh.spokes.heartbeat(d, {}).power, { sleep_after_min: 30, hold: false });
    await x.core.models.infer({ role: 'reasoner', messages: say('hello') });
    assert.equal(x.core.mesh.spokes.heartbeat(d, {}).power!.hold, true, 'a model it loaded is within its keep-alive');
    x.core.mesh.spokes.heartbeat(d, { going_to_sleep: true });
    const v = await wakeView(x.core, x.d.id);
    assert.equal(v.state, 'asleep-wakeable', 'asleep at once, not two minutes later');
    assert.match(v.screen.lines[0]!, /Nova wakes it when work needs it: .* sends the wake signal on their shared network\. Waking took 38 s last time\./);
    assert.deepEqual(v.screen.policy, { idle: '30', demand: 'wake', notes: v.screen.policy.notes });
    assert.match(v.screen.policy.notes[0]!, /own device agent puts it to sleep/);
    const routes = (await x.core.models.view()).roles.find((r) => r.role === 'reasoner')!;
    assert.equal(routes.assigned!.wake_words, 'asleep, wakeable; waking took 38 s');
  } finally {
    await x.close();
  }
});

// ---- 16: failover ---------------------------------------------------------------------------------

test('golden case 16: a standby takes over while the Dell sleeps: it has the Dell’s cards and last wake, keeps counting the limits, and case 1 passes from it', { timeout: 60_000 }, async () => {
  const a = await dell();
  const b = await dell();
  try {
    // The old hub's log, applied on the new one (as a standby's pull would), less what is the new
    // hub's own: everything replicated, the Dell's hardware and wake history among it.
    const from = new SyncLog({ db: a.core.db, log: new Log(a.core.db, null), home: mkdtempSync(join(tmpdir(), 'nova-wol-a-')), node: 'hub', now: () => new Date() });
    const batch = from.batch(0, { limit: 10_000, peerSchema: 26 });
    assert.ok(batch.rows.some((r) => r.tbl === 'device_hardware' && r.pk === a.d.id));
    assert.ok(batch.rows.some((r) => r.tbl === 'device_wake'));
    b.core.db.run('DELETE FROM device_wake');
    b.core.db.run('DELETE FROM sync_log');
    // The new hub's own sample Dell isn't part of this story (it would share the MAC).
    b.core.db.run('DELETE FROM device_hardware WHERE device_id = ?', b.d.id);
    b.core.db.raw.exec('UPDATE sync_state SET logging = 0 WHERE id = 1');
    new SyncLog({ db: b.core.db, log: new Log(b.core.db, null), home: mkdtempSync(join(tmpdir(), 'nova-wol-b-')), node: 'standby', now: () => new Date() }).apply(batch, () => {});
    assert.equal(b.core.models.hardwareOf(a.d.id)!.network.find((n) => n.address === '192.168.1.42')!.mac, DELL_MAC);
    assert.equal(b.core.models.wakeLatency(a.d.id), 38_000);
    assert.equal(b.core.models.power(a.d.id).on_demand, true, 'the policy came with the profile');
    // From the new hub, on the same network: the wake goes out as in case 1.
    a.spoke.setAsleep(false);
    b.core.profile.set('models', 'role.reasoner', { device: a.d.id, runtime: 'ollama', url: a.spoke.url, model: 'example-deep:32b' }, 'settings');
    const w = await b.core.models.wake(a.d.id, { origin: 'person' });
    assert.equal(w.ok, true, w.words);
    assert.deepEqual(b.wol.packets.map((p) => [p.host, p.port, p.bind]), Array(3).fill(['192.168.1.255', 9, '192.168.1.10']));
    assert.equal(a.wol.packets.length, 0);
    // The history came along, so the limits count from it: the old hub's wake and the new one's.
    assert.equal(b.core.db.all("SELECT 1 FROM device_wake WHERE device_id = ? AND outcome = 'awake'", a.d.id).length, 2);
  } finally {
    await a.close();
    await b.close();
  }
});
