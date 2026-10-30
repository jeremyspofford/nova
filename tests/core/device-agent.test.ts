// The device agent (M4 plan §2) on its own: the queue, the trust rules (roster epochs, the
// challenge, signed bundles), the watchdog, the permission model around the runtime, and the boot
// agent running a real runtime child against stand-in nodes: handoff, signed updates accepted and
// refused, safe mode and its way out, failover to a promoted standby, and never a lower epoch.
// Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDeviceKeys, helloProofMessage, signMessage, signRoster, type Roster } from '../../src/core/index.ts';
import { Queue } from '../../src/device/queue.ts';
import { acceptRoster, checkProof, verifyBundle } from '../../src/device/trust.ts';
import { Watchdog } from '../../src/device/watchdog.ts';
import { Boot, installLocalRuntime, paths, runtimeCommand, runtimeIntact, status } from '../../src/device/boot.ts';
import { FAST, FakeNode, bundle, joinedHome, sleep, until } from './device-support.ts';

const SRC = join(import.meta.dirname, '../../src/device');
const goodFiles = () => ({ 'runtime.ts': readFileSync(join(SRC, 'runtime.ts'), 'utf8'), 'queue.ts': readFileSync(join(SRC, 'queue.ts'), 'utf8') });

test('the queue keeps items in order, takes a key once, survives reopening, and drops bodies once answered', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'nova-queue-')), 'queue');
  let q = new Queue(file);
  const a = q.add('event', { name: 'one' });
  const b = q.add('memory_note', { content: 'A test note.' }, 'note-0000001');
  assert.equal(q.add('memory_note', { content: 'A test note.' }, 'note-0000001').added, false, 'the same key is one item');
  q.add('task_request', { title: 'Test task' });
  q.close();
  q = new Queue(file);
  assert.deepEqual(q.pending().map((i) => i.kind), ['event', 'memory_note', 'task_request'], 'in the order made, after a restart');
  q.settle([{ key: a.key, status: 'accepted' }, { key: b.key, status: 'refused', reason: 'Test reason.' }]);
  assert.deepEqual(q.pending().map((i) => i.kind), ['task_request']);
  assert.deepEqual(q.counts(), { pending: 1, delivered: 2, refused: 1 });
  assert.equal(q.settled().find((s) => s.key === b.key)!.reason, 'Test reason.');
  q.settle([{ key: a.key, status: 'refused' }]);
  assert.equal(q.settled().find((s) => s.key === a.key)!.status, 'accepted', 'a settled item stays as answered first');
  assert.equal(q.add('memory_note', { content: 'A test note.' }, 'note-0000001').added, false, 'an answered key is still one item');
  q.close();
  // On disk: every file the queue keeps, and an answered item's words are in none of them.
  const files = readdirSync(file, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
  assert.ok(!files.some((f) => readFileSync(f, 'utf8').includes('A test note.')), 'an answered item keeps no body');
  assert.ok(files.some((f) => readFileSync(f, 'utf8').includes('Test task')), 'a waiting one does');
  assert.deepEqual(readdirSync(join(file, 'tmp')), [], 'nothing half-written is left');
  assert.throws(() => new Queue(file).add('teleport' as 'event', {}), /kind must be/);
});

test('a roster is taken only when a pinned key signed it, at an epoch no lower than known, naming the node as hub', () => {
  const hub = generateDeviceKeys();
  const standby = generateDeviceKeys();
  const stranger = generateDeviceKeys();
  const m = (k: typeof hub, id: string) => ({ id, url: `http://${id}.example:4320`, public_key: k.ed25519.publicKey, x25519_public_key: k.x25519.publicKey });
  const r = (epoch: number, h: typeof hub, by: typeof hub, sb?: typeof hub): ReturnType<typeof signRoster> => signRoster({ epoch, hub: m(h, h === hub ? 'hub' : 'standby'), ...(sb ? { standby: m(sb, 'standby') } : {}), issued_at: new Date().toISOString() } as Roster, by.ed25519.privateKey);
  const pinned = [hub.ed25519.publicKey, standby.ed25519.publicKey];
  assert.deepEqual(acceptRoster(r(1, hub, hub, standby), { pinned, epoch: 1 }), { ok: true });
  // The promoted standby signs epoch 2 naming itself: taken.
  assert.deepEqual(acceptRoster(r(2, standby, standby), { pinned, epoch: 1, hubKey: standby.ed25519.publicKey }), { ok: true });
  // A lower epoch never, even signed by a pinned key: that is a demoted hub.
  const lower = acceptRoster(r(1, hub, hub), { pinned, epoch: 2 });
  assert.equal(lower.ok, false);
  assert.match((lower as { reason: string }).reason, /lower than the one this device knows/);
  // A key nobody pinned can't make itself hub, whatever the epoch.
  assert.match((acceptRoster(r(9, stranger, stranger), { pinned, epoch: 1 }) as { reason: string }).reason, /isn’t signed by a key this device pinned/);
  // Tampering after signing breaks it.
  const t = r(2, standby, standby);
  t.roster.epoch = 3;
  assert.equal(acceptRoster(t, { pinned, epoch: 1 }).ok, false);
  // Handed over by one node but naming another as hub.
  assert.match((acceptRoster(r(2, standby, standby), { pinned, epoch: 1, hubKey: hub.ed25519.publicKey }) as { reason: string }).reason, /different node/);

  // The challenge: answered with the claimed key, for this challenge, and that key pinned.
  const c = 'x'.repeat(32);
  const proof = (k: typeof hub, challenge: string) => {
    const claim = { id: 'n', role: 'hub', epoch: 1, public_key: k.ed25519.publicKey };
    return { ...claim, signature: signMessage(k.ed25519.privateKey, helloProofMessage(challenge, claim)) };
  };
  assert.deepEqual(checkProof(proof(hub, c), c, pinned), { ok: true });
  assert.match((checkProof(proof(stranger, c), c, pinned) as { reason: string }).reason, /isn’t one this device pinned/);
  assert.equal(checkProof(proof(hub, 'y'.repeat(32)), c, pinned).ok, false, 'an answer to another challenge');
  assert.equal(checkProof({ ...proof(hub, c), epoch: 7 }, c, pinned).ok, false, 'a claim changed after signing');
});

test('a runtime bundle is installed only when a pinned key signed it and every file matches', () => {
  const pinned = generateDeviceKeys();
  const other = generateDeviceKeys();
  const keys = [pinned.ed25519.publicKey];
  assert.equal(verifyBundle(bundle(goodFiles(), pinned), keys).ok, true);
  const refused = (b: ReturnType<typeof bundle>, why: RegExp) => {
    const v = verifyBundle(b, keys);
    assert.equal(v.ok, false);
    assert.match((v as { reason: string }).reason, why);
  };
  refused(bundle(goodFiles(), other), /didn’t pin/);
  const forged = bundle(goodFiles(), other);
  forged.signer = pinned.ed25519.publicKey;
  refused(forged, /signature doesn’t match/);
  const swapped = bundle(goodFiles(), pinned);
  swapped.files['runtime.ts'] = Buffer.from('process.exit(1)').toString('base64');
  refused(swapped, /doesn’t match its hash/);
  const extra = bundle(goodFiles(), pinned);
  extra.files['extra.ts'] = Buffer.from('').toString('base64');
  refused(extra, /aren’t the ones its manifest lists/);
  refused(bundle({ ...goodFiles(), '../boot/keys.ts': 'x' }, pinned), /carries a file it shouldn’t/);
  refused(bundle({ 'queue.ts': 'x' }, pinned), /no runtime.ts/);
});

class FakeChild extends EventEmitter {
  pid = Math.floor(Math.random() * 1e6);
  killed = false;
  kill(): boolean { this.killed = true; setImmediate(() => this.emit('exit', null, 'SIGTERM')); return true; }
  crash(code = 1) { this.emit('exit', code, null); }
}

test('the watchdog restarts with a doubling wait, and three crashes in a minute is safe mode', async () => {
  let t = 0;
  const children: FakeChild[] = [];
  const w = new Watchdog<FakeChild>({ start: () => { const c = new FakeChild(); children.push(c); return c; }, backoffMs: 10, now: () => t });
  const waits: number[] = [];
  let safe = 0;
  w.on('backoff', (ms) => waits.push(ms));
  w.on('safe_mode', () => safe++);
  w.run();
  assert.equal(children.length, 1);
  children[0]!.crash();
  await until(() => children.length, (n) => n === 2);
  t += 61_000; // the next crash is more than a minute after the first: it doesn't count with it
  children[1]!.crash();
  await until(() => children.length, (n) => n === 3);
  children[2]!.crash();
  await until(() => children.length, (n) => n === 4);
  assert.deepEqual(waits, [10, 10, 20]);
  assert.equal(safe, 0);
  children[3]!.crash();
  await sleep(60);
  assert.equal(safe, 1, 'three crashes inside a minute');
  assert.equal(w.safeMode, true);
  assert.equal(children.length, 4, 'safe mode: the runtime stays down');
  w.run();
  assert.equal(children.length, 4, 'run does nothing in safe mode');
  // A restart (a new runtime) leaves safe mode; stopping on purpose is not a crash.
  await w.restart();
  assert.equal(children.length, 5);
  await w.stop();
  assert.equal(children[4]!.killed, true);
  await sleep(30);
  assert.equal(children.length, 5);
  assert.equal(w.safeMode, false);
});

test('the runtime runs under the permission model: it can’t write boot/, read the keys, write its own code, or start processes', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-perm-'));
  const p = paths(home);
  for (const d of [p.boot, p.runtime, p.state]) spawnSync('mkdir', ['-p', d]);
  writeFileSync(p.keys, JSON.stringify({ secret: 'test-private-key' }), { mode: 0o600 });
  installLocalRuntime(p);
  // A probe in runtime/, started with exactly the flags the boot agent uses for runtime.ts.
  writeFileSync(join(p.runtime, 'probe.ts'), `
import { readFileSync, writeFileSync } from 'node:fs';
const home = process.argv[2];
const out = {};
const t = (k, f) => { try { f(); out[k] = 'ok'; } catch (e) { out[k] = e.code ?? e.message; } };
t('write_boot', () => writeFileSync(home + '/boot/planted.json', '{}'));
t('replace_keys', () => writeFileSync(home + '/boot/keys.json', '{}'));
t('read_keys', () => readFileSync(home + '/boot/keys.json'));
t('write_runtime', () => writeFileSync(home + '/runtime/runtime.ts', ''));
t('spawn', () => process.getBuiltinModule('node:child_process').spawnSync('true'));
t('worker', () => new (process.getBuiltinModule('node:worker_threads').Worker)('1', { eval: true }));
t('write_state', () => writeFileSync(home + '/state/probe.txt', 'ok'));
t('read_runtime', () => readFileSync(home + '/runtime/runtime.ts'));
console.log(JSON.stringify(out));
`);
  const run = spawnSync(process.execPath, runtimeCommand(p, join(p.runtime, 'probe.ts')), { encoding: 'utf8', env: {} });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.write_boot, 'ERR_ACCESS_DENIED');
  assert.equal(out.replace_keys, 'ERR_ACCESS_DENIED');
  assert.equal(out.read_keys, 'ERR_ACCESS_DENIED');
  assert.equal(out.write_runtime, 'ERR_ACCESS_DENIED');
  assert.equal(out.spawn, 'ERR_ACCESS_DENIED');
  assert.equal(out.worker, 'ERR_ACCESS_DENIED');
  assert.equal(out.write_state, 'ok');
  assert.equal(out.read_runtime, 'ok');
  assert.ok(!existsSync(join(p.boot, 'planted.json')));
  assert.equal(JSON.parse(readFileSync(p.keys, 'utf8')).secret, 'test-private-key');
  // The flags themselves: no network, child processes, addons, workers or wider reads were
  // granted (device-sandbox.test.ts tries every other way out).
  const flags = runtimeCommand(p);
  assert.ok(flags.includes('--permission'));
  assert.ok(flags.includes('--no-experimental-sqlite'));
  assert.deepEqual(flags.filter((f) => f.startsWith('--allow-')).sort(), [`--allow-fs-read=${p.runtime}/`, `--allow-fs-read=${p.state}/`, `--allow-fs-write=${p.state}/`].sort());
});

// A hub and its standby (stand-ins), a roster naming both signed by the hub, and a device that
// pinned it. The hub ships the real runtime, signed by its key.
async function mesh() {
  const hub = await new FakeNode().start();
  const standby = await new FakeNode().start();
  standby.role = 'standby';
  hub.roster = hub.sign({ epoch: 1, hub: hub.member(), standby: standby.member() });
  hub.bundle = bundle(goodFiles(), hub.keys);
  const dev = joinedHome({ roster: hub.roster, hub, nodes: [hub, standby] });
  const lines: string[] = [];
  const boot = new Boot(dev.home, { ...FAST }, { say: (l) => lines.push(l) });
  return { hub, standby, dev, boot, lines, async stop() { await boot.shutdown(0); await hub.stop(); await standby.stop(); } };
}

test('boot hands the runtime a session over IPC; the runtime heartbeats and flushes the queue; it never holds a key', async () => {
  const m = await mesh();
  try {
    const q = new Queue(m.dev.p.queue);
    q.add('memory_note', { content: 'Queued before start.' }, 'early-0000001');
    await m.boot.start({ signals: false });
    assert.equal(runtimeIntact(m.dev.p)?.source, 'hub', 'the hub’s signed runtime was installed');
    const child = m.boot.watchdog.child!;
    assert.ok(child.pid);
    await until(() => m.hub.heartbeats.length, (n) => n > 0);
    assert.equal(m.hub.heartbeats[0]!.safe_mode, false);
    await until(() => m.hub.received.length, (n) => n === 1);
    q.add('event', { name: 'online' }, 'later-0000001');
    await until(() => m.hub.received.length, (n) => n === 2);
    assert.deepEqual(m.hub.received.map((r) => r.key), ['early-0000001', 'later-0000001']);
    // The answer reaches the runtime through the boot agent, a moment after the hub has it.
    assert.equal((await until(() => q.counts().pending, (n) => n === 0)), 0, readFileSync(m.dev.p.runtimeStatus, 'utf8'));
    q.close();
    // What the runtime was started with: its own folder, the device home, nothing else.
    assert.deepEqual(child.spawnargs.slice(1), runtimeCommand(m.dev.p));
    // It makes no hub call itself: the boot agent made them, with a token the runtime never had.
    assert.ok(!readFileSync(m.dev.p.runtimeStatus, 'utf8').includes('nvs_'), 'no session token in its status');
    const st = status(m.dev.home);
    assert.equal(st.running, true);
    assert.equal((st.runtime_status as { hub_url: string }).hub_url, m.hub.url);
    // The runtime's status file holds no key material.
    assert.ok(!readFileSync(m.dev.p.runtimeStatus, 'utf8').includes(m.dev.keys.ed25519.publicKey));
  } finally {
    await m.stop();
  }
});

test('the boot agent makes only the runtime’s own hub calls for it: anything else is refused without reaching the hub', async () => {
  const m = await mesh();
  try {
    // A runtime that asks for more than it should, and writes down what it was told.
    const greedy = `
import { writeFileSync } from 'node:fs';
const home = process.argv[2];
const answers = {};
const ask = (id, method, path, body) => process.send({ type: 'call', id, method, path, body });
process.on('message', (m) => {
  if (m.type === 'session') {
    ask(1, 'GET', '/api/v1/mesh/roster');
    ask(2, 'POST', '/api/v1/mesh/devices/someone-else/revoke', { confirm: true });
    ask(3, 'POST', '/api/v1/mesh/inbox', { items: [{ key: 'greedy-000001', kind: 'event', body: { name: 'big', data: 'x'.repeat(1_000_000) } }] });
    ask(4, 'POST', '/api/v1/mesh/devices/me/heartbeat', { safe_mode: false });
  }
  if (m.type === 'answer') {
    answers[m.id] = { status: m.status ?? null, error: m.error ?? null };
    writeFileSync(home + '/state/answers.json', JSON.stringify(answers));
  }
});
process.send({ type: 'ready' });
`;
    m.hub.bundle = bundle({ 'runtime.ts': greedy, 'queue.ts': '' }, m.hub.keys);
    await m.boot.start({ signals: false });
    const file = join(m.dev.p.state, 'answers.json');
    const answers = await until(() => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}), (a) => Object.keys(a).length === 4);
    assert.equal(answers[1].status, 403, 'not one of its calls');
    assert.equal(answers[2].status, 403, 'not one of its calls');
    assert.equal(answers[3].status, 413, 'too big to send');
    assert.equal(answers[4].status, 200, 'its heartbeat goes through');
    assert.equal(m.hub.received.length, 0, 'nothing refused reached the hub');
  } finally {
    await m.stop();
  }
});

test('updates: a bundle signed by an unpinned key is refused and reported; a signed one replaces the runtime', async () => {
  const m = await mesh();
  try {
    const stranger = generateDeviceKeys();
    m.hub.bundle = bundle(goodFiles(), stranger);
    await m.boot.start({ signals: false });
    assert.ok(m.lines.some((l) => /Refused a runtime update from the hub: It was signed by a key this device didn’t pin/.test(l)), m.lines.join('\n'));
    assert.equal(m.hub.reports[0]?.problem, 'runtime_update_refused');
    assert.equal(runtimeIntact(m.dev.p)?.source, 'local', 'it runs its own files instead');
    await until(() => m.hub.heartbeats.length, (n) => n > 0);

    // A bundle the hub signed, with a change: installed, and the runtime restarted on it.
    const first = m.boot.watchdog.child!.pid;
    m.hub.bundle = bundle({ ...goodFiles(), 'runtime.ts': `${goodFiles()['runtime.ts']}\n// a newer runtime\n` }, m.hub.keys);
    await until(() => runtimeIntact(m.dev.p)?.version, (v) => v === m.hub.bundle!.manifest.version);
    await until(() => m.boot.watchdog.child?.pid, (pid) => !!pid && pid !== first);
    const n = m.hub.heartbeats.length;
    await until(() => m.hub.heartbeats.length, (k) => k > n);
    assert.equal((m.hub.heartbeats.at(-1) as { runtime_version: string }).runtime_version, m.hub.bundle.manifest.version);
  } finally {
    await m.stop();
  }
});

test('three crashes in a minute: safe mode, said in the heartbeat; a new signed runtime brings it back', async () => {
  const m = await mesh();
  try {
    m.hub.bundle = bundle({ 'runtime.ts': 'process.exit(7);\n', 'queue.ts': '' }, m.hub.keys);
    await m.boot.start({ signals: false });
    await until(() => m.lines.some((l) => /safe mode/.test(l)), Boolean);
    assert.equal(m.lines.filter((l) => /crash \d in a minute/.test(l)).length, 3, m.lines.join('\n'));
    assert.equal(m.boot.watchdog.child, null, 'the runtime stays down');
    await until(() => m.hub.heartbeats.some((h) => h.safe_mode === true), Boolean);
    assert.equal(status(m.dev.home).safe_mode, true);

    m.hub.bundle = bundle(goodFiles(), m.hub.keys);
    await until(() => m.hub.heartbeats.at(-1)?.safe_mode, (v) => v === false);
    assert.ok(m.lines.some((l) => /Leaving safe mode/.test(l)));
    assert.equal(status(m.dev.home).safe_mode, false);
  } finally {
    await m.stop();
  }
});

test('failover: queued while the hub is down, waits for the standby to be promoted, moves to it, re-signs, delivers once; never back to a lower epoch', async () => {
  const m = await mesh();
  try {
    await m.boot.start({ signals: false });
    const q = new Queue(m.dev.p.queue);
    q.add('event', { name: 'before' }, 'fail-0000001');
    await until(() => q.counts().pending, (n) => n === 0);
    assert.equal(m.hub.received.length, 1);

    await m.hub.stop();
    q.add('task_request', { title: 'Queued while the hub is down' }, 'fail-0000002');
    q.add('memory_note', { content: 'Noted while the hub is down.' }, 'fail-0000003');
    await sleep(600);
    assert.equal(q.counts().pending, 2, 'nothing is lost while nobody is hub');
    assert.equal(m.standby.sessionsStarted, 0, 'a standby that isn’t hub gets no signature');

    // Promotion: epoch 2, the standby names itself hub, signed with its own (pinned) key.
    m.standby.role = 'hub';
    m.standby.epoch = 2;
    m.standby.roster = m.standby.sign({ epoch: 2, hub: m.standby.member() });
    m.standby.bundle = bundle(goodFiles(), m.standby.keys, m.hub.bundle!.manifest.version);
    await until(() => m.standby.received.length, (n) => n === 2);
    assert.deepEqual(m.standby.received.map((r) => r.key), ['fail-0000002', 'fail-0000003']);
    assert.ok(m.lines.some((l) => l === `Moved to the hub at ${m.standby.url} (epoch 2).`), m.lines.join('\n'));
    const s = status(m.dev.home);
    assert.equal(s.hub_url, m.standby.url);
    assert.equal(s.epoch, 2);
    await until(() => m.standby.heartbeats.length, (n) => n > 0);

    // The old hub comes back still thinking it is hub at epoch 1 (not yet fenced). The device
    // doesn't go back to it, even with the new hub down.
    await m.hub.start();
    await m.standby.stop();
    q.add('event', { name: 'after' }, 'fail-0000004');
    await sleep(800);
    assert.equal(m.hub.received.length, 1, 'nothing went to the demoted hub');
    assert.equal(q.counts().pending, 1);
    assert.equal(status(m.dev.home).epoch, 2);
    q.close();
  } finally {
    await m.stop();
  }
});

test('a node that can’t prove a pinned key gets no signature, and a revoked device stops and says so', async () => {
  const m = await mesh();
  try {
    // An impostor at the hub's address: its own key, claiming to be hub at a high epoch.
    await m.hub.stop();
    const impostor = await new FakeNode({ port: Number(new URL(m.hub.url).port) }).start();
    impostor.epoch = 99;
    impostor.devices.set(m.dev.deviceId, m.dev.keys.ed25519.publicKey);
    impostor.roster = impostor.sign({ epoch: 99, hub: impostor.member() });
    const boot = new Boot(m.dev.home, { ...FAST }, { say: (l) => m.lines.push(l) });
    await boot.start({ signals: false });
    await sleep(500);
    assert.equal(impostor.sessionsStarted, 0, 'no session request was signed for it');
    await boot.shutdown(0);
    await impostor.stop();

    // Revoked on the hub: the next session is refused, and the agent stops, saying why.
    await m.hub.start();
    const b2 = new Boot(m.dev.home, { ...FAST }, { say: (l) => m.lines.push(l) });
    await b2.start({ signals: false });
    await until(() => m.hub.heartbeats.length, (n) => n > 0);
    m.hub.revoked.add(m.dev.deviceId);
    const code = await b2.finished;
    assert.equal(code, 3);
    assert.ok(m.lines.some((l) => /the hub revoked it\. The agent has stopped/.test(l)));
    assert.equal(b2.watchdog.child, null);
    const s = status(m.dev.home);
    assert.equal(s.revoked, true);
    assert.equal(s.running, false);
    // It won't start again.
    const b3 = new Boot(m.dev.home, { ...FAST }, { say: (l) => m.lines.push(l) });
    await b3.start({ signals: false });
    assert.equal(await b3.finished, 3);
  } finally {
    await m.stop();
  }
});
