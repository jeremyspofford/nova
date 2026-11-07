// Wake-on-LAN, the wake path's hardening (docs/plans/wol-inference-nodes-adr-2026-11-06.md,
// "Security"): a wake goes only onto the device's own network, from the hub's own card there, to that
// card's broadcast address; never over the mesh, a broad netmask or 255.255.255.255. Waking is opt-in
// per device, rate-limited (4 per device and 12 across the hub per hour), and every wake, sent or
// refused, is recorded in device_wake and the Work Ledger. The person's own wake is a tier-1 task.
//
// No real packet is ever sent: the model manager's sender is a recorder that keeps each packet's
// bytes, target, port and bound address and opens no socket (tests/support/models.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDeviceKeys, type Core } from '../../src/core/index.ts';
import { checkHardware } from '../../src/core/models/hardware.ts';
import { cardFault, prefixOf, targetOnRoute, wakeRoute } from '../../src/core/models/wake.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { HUB_LAN, INSTALLED, SPOKE_LOOPBACK, hubHardware, modelsCore, say, wolRecorder } from '../support/models.ts';
import { enroll, hub } from './mesh-support.ts';

const DELL_MAC = '02:00:5e:10:00:42';
const DELL_LAN = { name: 'eth0', mac: DELL_MAC, address: '192.168.1.42', netmask: '255.255.255.0', wol: 'magic' as const };
const MAGIC = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => Buffer.from([0x02, 0x00, 0x5e, 0x10, 0x00, 0x42]))]);
const noMesh = () => false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T, done: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let v = read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = read(); }
  return v;
}

function addDell(core: Core, name = 'Dell desktop') {
  const keys = generateDeviceKeys();
  return core.mesh.devices.add({ name, platform: 'linux x64', kind: 'computer', purposes: ['compute'], public_key: keys.ed25519.publicKey, x25519_public_key: keys.x25519.publicKey, capabilities: ['heartbeat', 'queue'] }, 'test');
}
const beat = (core: Core, d: ReturnType<typeof addDell>, network: Record<string, unknown>[]) => core.mesh.spokes.heartbeat(d, { hardware: hubHardware({ hostname: 'dell-desktop', network }) });
const rows = (core: Core, id: string) => core.db.all<{ outcome: string; origin: string; sender: string | null; reason: string | null }>('SELECT outcome, origin, sender, reason FROM device_wake WHERE device_id = ? ORDER BY id', id).map((r) => ({ ...r }));

// The owner's Dell on the hub's home network, serving the reasoner, waking on demand, asleep. The
// recorder "wakes" its stand-in Ollama on the first packet.
async function dell(o: { network?: Record<string, unknown>[]; onDemand?: boolean } = {}) {
  const hubOllama = await startFakeOllama({ models: INSTALLED });
  const spoke = await startFakeOllama({ models: [INSTALLED[2]!] });
  const { core, wol } = modelsCore(hubOllama.url);
  const d = addDell(core);
  beat(core, d, o.network ?? [DELL_LAN, SPOKE_LOOPBACK]);
  core.models.setWake({ wait_s: 1 });
  await core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: spoke.url });
  if (o.onDemand !== false) core.models.setPower(d.id, { on_demand: true });
  spoke.setAsleep(true);
  wol.onSend(() => setTimeout(() => spoke.setAsleep(false), 100));
  return { core, wol, d, spoke, close: async () => { await core.close(); await hubOllama.close(); await spoke.close(); } };
}

// A task for routing's wake to be an event on: tier 2, so it waits for an OK and never runs.
const hostTask = (core: Core, title = 'Summarize the lease') => core.ledger.create({ title, owner: 'workspace', goal: title, origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation', note: 'stand-in' }], approval_tier: 2 } as never);

// ---- the rules themselves -----------------------------------------------------------------------

test('the same-network test: private, never mesh, a contiguous /16–/30 mask on both sides, the same subnet; the target is the hub card’s own broadcast', () => {
  assert.equal(prefixOf('255.255.255.0'), 24);
  assert.equal(prefixOf('255.255.0.0'), 16);
  assert.equal(prefixOf('255.255.255.252'), 30);
  assert.equal(prefixOf('255.0.255.0'), null, 'not contiguous');
  assert.equal(prefixOf('0.0.0.0'), 0);
  assert.equal(prefixOf('255.255.255.256'), null);

  // Golden case 1's network: the hub's eth0 192.168.1.10/24, the Dell 192.168.1.42/24.
  const ok = wakeRoute(HUB_LAN, [DELL_LAN], noMesh);
  assert.ok(ok.ok);
  assert.deepEqual({ target: ok.route.target, port: ok.route.port, bind: ok.route.bind, card: ok.route.card.address }, { target: '192.168.1.255', port: 9, bind: '192.168.1.10', card: '192.168.1.42' });
  // A reported broadcast is never the target: the hub computes it from its own card.
  const reported = { ...DELL_LAN, broadcast: '203.0.113.255' };
  const lying = wakeRoute(HUB_LAN, [reported], noMesh);
  assert.ok(lying.ok && lying.route.target === '192.168.1.255');

  // Golden case 2: another network the hub isn't on.
  assert.deepEqual(wakeRoute(HUB_LAN, [{ ...DELL_LAN, address: '192.168.20.42' }], noMesh), { ok: false, reason: 'no_sender' });
  // Golden case 3: only the mesh, as Windows shows it (/10); and a mesh address Nova knows, whatever its mask.
  assert.deepEqual(wakeRoute(HUB_LAN, [{ ...DELL_LAN, address: '100.101.102.103', netmask: '255.192.0.0' }], noMesh), { ok: false, reason: 'mesh' });
  assert.deepEqual(wakeRoute(HUB_LAN, [DELL_LAN], (a) => a === '192.168.1.42'), { ok: false, reason: 'mesh' });
  // A hub card in the mesh's shared range never sends, even to a "device" beside it.
  assert.deepEqual(wakeRoute([{ address: '100.64.1.1', netmask: '255.255.255.0' }], [{ ...DELL_LAN, address: '100.64.1.2' }], noMesh), { ok: false, reason: 'mesh' });
  // Golden case 4: a broad, empty, non-contiguous or too narrow mask.
  for (const netmask of ['255.0.0.0', '0.0.0.0', '255.0.255.0', '255.255.255.254', 'nonsense']) {
    assert.deepEqual(wakeRoute(HUB_LAN, [{ ...DELL_LAN, netmask }], noMesh), { ok: false, reason: 'netmask' }, netmask);
  }
  // A /16 home network is fine when both sides are on it; unequal masks are not the same network.
  const wide = wakeRoute([{ address: '10.1.0.1', netmask: '255.255.0.0' }], [{ ...DELL_LAN, address: '10.1.2.3', netmask: '255.255.0.0' }], noMesh);
  assert.ok(wide.ok && wide.route.target === '10.1.255.255');
  assert.deepEqual(wakeRoute([{ address: '192.168.1.10', netmask: '255.255.254.0' }], [DELL_LAN], noMesh), { ok: false, reason: 'no_sender' });
  // Loopback, the limited broadcast and public addresses are never a wake network.
  for (const address of ['127.0.0.1', '255.255.255.255', '8.8.8.8']) assert.equal(cardFault({ address, netmask: '255.255.255.0' }, noMesh), 'not_private', address);
  assert.deepEqual(wakeRoute(HUB_LAN, [], noMesh), { ok: false, reason: 'no_card' });

  // The person's own target must be on the sender's subnet.
  assert.equal(targetOnRoute('192.168.1.255', ok.route), true);
  assert.equal(targetOnRoute('192.168.5.255', ok.route), false);
  assert.equal(targetOnRoute('8.8.8.8', ok.route), false);
  assert.equal(targetOnRoute('wake.example.com', ok.route), false);
});

test('golden case 5 and the hub boundary: group and all-zero MACs are dropped; wol is magic, off or unknown; a broad netmask is kept for addressing', () => {
  const hw = checkHardware(hubHardware({ network: [
    { ...DELL_LAN, mac: 'ff:ff:ff:ff:ff:ff' }, { ...DELL_LAN, mac: '01:00:5e:00:00:01' }, { ...DELL_LAN, mac: '00:00:00:00:00:00' },
    { ...DELL_LAN, wol: 'sometimes' }, { ...DELL_LAN, mac: '02:00:5e:10:00:44', wol: 'off' }, { ...DELL_LAN, mac: '02:00:5e:10:00:45', netmask: '255.0.0.0', wol: undefined },
  ] }));
  assert.deepEqual(hw.network.map((n) => [n.mac, n.wol, n.netmask]), [[DELL_MAC, 'unknown', '255.255.255.0'], ['02:00:5e:10:00:44', 'off', '255.255.255.0'], ['02:00:5e:10:00:45', 'unknown', '255.0.0.0']]);
});

// ---- the model manager ------------------------------------------------------------------------

test('golden case 1, the wake itself: three 102-byte packets to 192.168.1.255:9 from 192.168.1.10; one wake per task; recorded as routing from the hub, on the task', { timeout: 30_000 }, async () => {
  const { core, wol, d, spoke, close } = await dell();
  try {
    const task = hostTask(core);
    const out = await core.models.infer({ role: 'reasoner', messages: say('x'.repeat(3000)), task_id: task.id });
    assert.equal(out.device, d.id);
    assert.equal(wol.packets.length, 3, 'three packets, one wake');
    for (const p of wol.packets) {
      assert.equal(p.bytes.length, 102);
      assert.ok(p.bytes.equals(MAGIC), 'ff×6, then the MAC×16');
      assert.deepEqual([p.host, p.port, p.bind], ['192.168.1.255', 9, '192.168.1.10']);
    }
    assert.deepEqual(rows(core, d.id), [{ outcome: 'awake', origin: 'routing', sender: 'hub', reason: null }]);
    const ev = core.ledger.events(task.id).filter((e) => e.kind === 'wake');
    assert.equal(ev.length, 1);
    assert.deepEqual((({ device, origin, sender, target, outcome }) => ({ device, origin, sender, target, outcome }))(ev[0]!.detail as Record<string, unknown>), { device: d.id, origin: 'routing', sender: 'hub', target: '192.168.1.255:9', outcome: 'awake' });

    // Asleep again, the same task: no second automatic wake for it; refused, recorded, nothing sent.
    spoke.setAsleep(true);
    await assert.rejects(core.models.infer({ role: 'reasoner', messages: say('x'.repeat(3000)), task_id: task.id }), /already woke Dell desktop once for this task/);
    assert.equal(wol.packets.length, 3);
    assert.deepEqual(rows(core, d.id).at(-1), { outcome: 'refused', origin: 'routing', sender: null, reason: 'once' });
    assert.equal((core.ledger.events(task.id).filter((e) => e.kind === 'wake').at(-1)!.detail as { outcome: string }).outcome, 'refused');
  } finally {
    await close();
  }
});

test('each refusal sends nothing and is recorded with its reason: opt-in off, golden cases 2–5 and 13, Wake-on-LAN off',{ timeout: 60_000 }, async () => {
  const cases: { name: string; network?: Record<string, unknown>[]; onDemand?: boolean; target?: string; reason: string; words: RegExp }[] = [
    { name: 'opt-in off', onDemand: false, reason: 'off', words: /Nova doesn’t wake Dell desktop: you chose to wait until it’s turned on/ },
    { name: '2 no sender', network: [{ ...DELL_LAN, address: '192.168.20.42' }, SPOKE_LOOPBACK], reason: 'no_sender', words: /None of your always-on devices is on its network, so nothing can send the wake signal\. Nova doesn’t send wake signals across networks or over your mesh\./ },
    { name: '3 mesh only', network: [{ ...DELL_LAN, address: '100.101.102.103', netmask: '255.192.0.0' }, SPOKE_LOOPBACK], reason: 'mesh', words: /reports only its mesh address/ },
    { name: '4 a /8', network: [{ ...DELL_LAN, netmask: '255.0.0.0' }, SPOKE_LOOPBACK], reason: 'netmask', words: /netmask that is too broad/ },
    { name: '4 no mask', network: [{ ...DELL_LAN, netmask: '0.0.0.0' }, SPOKE_LOOPBACK], reason: 'netmask', words: /netmask that is too broad/ },
    { name: '5 bad MACs', network: [{ ...DELL_LAN, mac: 'ff:ff:ff:ff:ff:ff' }, { ...DELL_LAN, mac: '01:00:5e:00:00:01' }, { ...DELL_LAN, mac: '00:00:00:00:00:00' }, SPOKE_LOOPBACK], reason: 'not_private', words: /None of Dell desktop’s network cards is on a private network/ },
    { name: 'Wake-on-LAN off', network: [{ ...DELL_LAN, wol: 'off' }, { ...SPOKE_LOOPBACK, wol: 'off' }], reason: 'wol_off', words: /Wake-on-LAN turned off/ },
    { name: '13 the person’s target on another network', target: '192.168.5.255:9', reason: 'target', words: /The wake target you set \(192\.168\.5\.255:9\) isn’t on Dell desktop’s network/ },
  ];
  for (const c of cases) {
    const { core, wol, d, close } = await dell({ ...(c.network ? { network: c.network } : {}), ...(c.onDemand === false ? { onDemand: false } : {}) });
    try {
      if (c.target) core.models.setWake({ target: c.target, wait_s: 1 });
      const w = await core.models.wake(d.id);
      assert.equal(w.ok, false, c.name);
      assert.equal(w.reason, c.reason, c.name);
      assert.match(w.words, c.words, c.name);
      assert.equal(wol.packets.length, 0, `${c.name}: no packet`);
      assert.deepEqual(rows(core, d.id), [{ outcome: 'refused', origin: 'routing', sender: null, reason: c.reason }], c.name);
      // The screen says the same, without sending anything.
      const v = (await core.models.view()).devices.find((x) => x.id === d.id)!;
      assert.equal(v.wake!.able, false, c.name);
      assert.match(v.wake!.words, c.words, c.name);
      assert.equal(wol.packets.length, 0, `${c.name}: the view sends nothing`);
    } finally {
      await close();
    }
  }
  // The person's target on the Dell's own network is used, from the hub's card there.
  const { core, wol, d, close } = await dell();
  try {
    core.models.setWake({ target: '192.168.1.42:7', wait_s: 1 });
    assert.equal((await core.models.wake(d.id)).ok, true);
    assert.deepEqual(wol.packets.map((p) => [p.host, p.port, p.bind]), Array(3).fill(['192.168.1.42', 7, '192.168.1.10']));
  } finally {
    await close();
  }
});

test('a MAC two trusted computers both report wakes neither, and opens a problem',{ timeout: 30_000 }, async () => {
  const { core, wol, d, close } = await dell();
  try {
    const other = addDell(core, 'Small tower');
    beat(core, other, [{ ...DELL_LAN, address: '192.168.1.43' }]);
    const w = await core.models.wake(d.id);
    assert.equal(w.reason, 'duplicate_mac');
    assert.match(w.words, /Dell desktop and Small tower both report the network card 02:00:5e:10:00:42/);
    assert.equal(wol.packets.length, 0);
    assert.ok(core.db.all<{ message: string }>('SELECT message FROM problem').some((p) => /both report the network card 02:00:5e:10:00:42/.test(p.message)));
    beat(core, other, [{ ...DELL_LAN, mac: '02:00:5e:10:00:99', address: '192.168.1.43' }]);
    assert.equal((await core.models.wake(d.id)).ok, true, 'once one changes, the other wakes again');
  } finally {
    await close();
  }
});

test('golden case 11, the rate limits: a fifth wake in the hour is refused with when it may try again, whoever asks; twelve across the hub likewise', { timeout: 30_000 }, async () => {
  const { core, wol, d, close } = await dell();
  try {
    const now = Date.now();
    const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
    for (const m of [50, 40, 30, 20]) core.db.run(`INSERT INTO device_wake (device_id, sent_at, outcome, origin, sender) VALUES (?, ?, 'awake', 'routing', 'hub')`, d.id, at(m));
    // Older than an hour, and refused ones, don't count.
    core.db.run(`INSERT INTO device_wake (device_id, sent_at, outcome, origin, sender) VALUES (?, ?, 'awake', 'routing', 'hub')`, d.id, at(70));
    core.db.run(`INSERT INTO device_wake (device_id, sent_at, outcome, origin, reason) VALUES (?, ?, 'refused', 'routing', 'off')`, d.id, at(5));
    const w = await core.models.wake(d.id, { origin: 'person' });
    assert.equal(w.ok, false);
    assert.equal(w.reason, 'rate_limit');
    assert.match(w.words, /Nova has woken Dell desktop 4 times this hour; it can try again at \d\d:\d\d\./);
    assert.equal(w.retry_at, new Date(now - 50 * 60_000 + 3600_000).toISOString());
    assert.equal(wol.packets.length, 0);
    assert.deepEqual(rows(core, d.id).at(-1), { outcome: 'refused', origin: 'person', sender: null, reason: 'rate_limit' });
    // The person's refused wake is still its own tier-1 task, with the refusal on it.
    const t = core.ledger.get(w.task_id!);
    assert.equal(t.approval_tier, 1);
    assert.equal(t.title, 'Wake Dell desktop');
    assert.equal((core.ledger.events(t.id).find((e) => e.kind === 'wake')!.detail as { outcome: string; reason: string }).reason, 'rate_limit');

    core.db.run('DELETE FROM device_wake');
    for (let i = 0; i < 12; i++) core.db.run(`INSERT INTO device_wake (device_id, sent_at, outcome, origin, sender) VALUES (?, ?, 'awake', 'routing', 'hub')`, `other-${i % 3}`, at(55 - i));
    const hubWide = await core.models.wake(d.id);
    assert.equal(hubWide.reason, 'rate_limit_hub');
    assert.match(hubWide.words, /Nova has sent 12 wakes this hour across your devices; it can try again at \d\d:\d\d\./);
    assert.equal(wol.packets.length, 0);
  } finally {
    await close();
  }
});

test('the sleep and wake choices: a fixed list, for a trusted computer only; the first run keeps waking on for a computer Nova already wakes (the Dell), off for others', { timeout: 30_000 }, async () => {
  const { core, d, close } = await dell({ onDemand: false });
  try {
    assert.deepEqual(core.models.power(d.id), { on_demand: false, sleep_after_min: null });
    assert.deepEqual(core.models.setPower(d.id, { sleep_after_min: 30 }), { on_demand: false, sleep_after_min: 30 });
    assert.deepEqual(core.models.setPower(d.id, { on_demand: true }), { on_demand: true, sleep_after_min: 30 }, 'one choice at a time keeps the other');
    assert.throws(() => core.models.setPower(d.id, { sleep_after_min: 45 }), /null \(never sleep\) or 15, 30, 60 or 120/);
    assert.throws(() => core.models.setPower(d.id, { on_demand: 'yes' }), /on_demand is true/);
    assert.throws(() => core.models.setPower('hub', { on_demand: true }), /isn’t one of your trusted computers/);
    assert.throws(() => core.models.setPower('nobody', { on_demand: true }), /isn’t one of your trusted computers/);
    // The wake worker's tasks are the model manager's alone.
    assert.throws(() => core.ledger.create({ title: 'Wake it', owner: 'wake', goal: 'x', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }], inputs: { device: d.id } } as never), /Only Nova’s model manager makes wake tasks/);
  } finally {
    await close();
  }
  // An upgrade: the Dell serves a role and was woken before; the tower serves one too but never was.
  const first = await dell({ onDemand: false });
  try {
    const tower = addDell(first.core, 'Small tower');
    beat(first.core, tower, [{ ...DELL_LAN, mac: '02:00:5e:10:00:77', address: '192.168.1.77' }, SPOKE_LOOPBACK]);
    first.core.profile.set('models', 'role.embedder', { device: tower.id, runtime: 'ollama', url: 'http://127.0.0.1:9', model: 'example-embed' }, 'settings');
    first.core.db.run(`INSERT INTO device_wake (device_id, sent_at, outcome) VALUES (?, ?, 'awake')`, first.d.id, new Date().toISOString());
    first.core.models.start();
    first.core.models.stop();
    assert.equal(first.core.models.power(first.d.id).on_demand, true);
    assert.equal(first.core.models.power(tower.id).on_demand, false);
    // Only once: turned off afterwards, it stays off.
    first.core.models.setPower(first.d.id, { on_demand: false });
    first.core.models.start();
    first.core.models.stop();
    assert.equal(first.core.models.power(first.d.id).on_demand, false);
  } finally {
    await first.close();
  }
});

test('golden case 12, who may wake: the console makes a tier-1 task and sends; a paired computer gets 403 and a public caller 401, with no packets', { timeout: 60_000 }, async () => {
  const hubOllama = await startFakeOllama({ models: INSTALLED });
  const spoke = await startFakeOllama({ models: [INSTALLED[2]!] });
  const wol = wolRecorder(() => setTimeout(() => spoke.setAsleep(false), 100));
  const h = await hub({ core: { models: { ollamaUrl: hubOllama.url, hardware: async () => hubHardware() as never, hubCards: () => HUB_LAN, wakeSender: wol.sender, wakeGapMs: 0, wakePollMs: 50 } } });
  try {
    const d = addDell(h.core);
    beat(h.core, d, [DELL_LAN, SPOKE_LOOPBACK]);
    h.core.models.setWake({ wait_s: 2 });
    await h.core.models.assign('reasoner', { device: d.id, model: 'example-deep:32b', url: spoke.url });
    assert.equal((await h.c('PUT', `/models/devices/${d.id}/power`, { on_demand: true })).status, 200);
    spoke.setAsleep(true);
    const { token } = await enroll(h, { kind: 'computer', name: 'Example computer', platform: 'linux x64', capabilities: ['heartbeat'] });
    const post = (headers: Record<string, string>) => fetch(`${h.mesh}/api/v1/models/devices/${d.id}/wake`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1', ...headers }, body: '{}' });
    assert.equal((await post({ authorization: `Bearer ${token}` })).status, 403, 'a paired computer');
    assert.equal((await post({})).status, 401, 'a public caller');
    assert.equal(wol.packets.length, 0);
    assert.equal(h.core.db.all('SELECT 1 FROM device_wake').length, 0, 'nothing even refused: they never reached the wake');

    const r = await h.c('POST', `/models/devices/${d.id}/wake`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(wol.packets.length, 3);
    const t = await until(() => h.core.ledger.get(r.body.task_id), (x) => x.state === 'done');
    assert.equal(t.state, 'done');
    assert.equal(t.approval_tier, 1);
    assert.equal(t.title, 'Wake Dell desktop');
    assert.equal((h.core.ledger.events(t.id).find((e) => e.kind === 'wake')!.detail as { origin: string; outcome: string }).origin, 'person');
    assert.deepEqual(rows(h.core, d.id), [{ outcome: 'awake', origin: 'person', sender: 'hub', reason: null }]);
  } finally {
    await h.stop();
    await hubOllama.close();
    await spoke.close();
  }
});
