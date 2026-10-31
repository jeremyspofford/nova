// Networking through chat (M10d, docs/plans/M10d.md): a change to a network target through the Work
// Ledger, against a simulated target only: the stand-in (scripts/stand-ins/fake-netconfig.js), a
// loopback server whose configuration is a file in a temp folder. No real interface, firewall, route,
// DNS, router or tailnet is read or changed.
//
// The hub is the real core behind a console and a mesh listener (tests/core/mesh-support.ts), and a
// phone enrolls the way the plan says. The simulated network: the phone reaches the hub's mesh
// listener only while the stand-in's firewall allows "mesh". So a change that drops it cuts the
// phone off, as it would on a real network, and the dead-man's switch has to put it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { httpConfig, mask, mergePatch, secretPaths, type Config } from '../../src/core/network/targets.ts';
import { startNetconfig } from '../../scripts/stand-ins/fake-netconfig.js';
import { call, enroll, hub } from './mesh-support.ts';
import { fakeToken, filesHolding } from '../support/infra.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WINDOW_MS = 800;
// A placeholder home network: a firewall that lets the mesh port through, DNS, and a Wi-Fi key.
const INITIAL = {
  firewall: { allow: ['mesh', 'web'], default: 'drop' },
  dns: { upstream: ['192.0.2.53'], records: { 'printer.home.example': '192.0.2.20' } },
  wifi: { ssid: 'example-net', psk: 'example-wifi-key-0d1e2f3a4b5c' },
};

async function settle(core: Core, id: string, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state) || Date.now() > end) return t;
    await sleep(20);
  }
}

async function until<T>(read: () => T, done: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = read();
  while (!done(v) && Date.now() < end) { await sleep(20); v = read(); }
  return v;
}

// The hub, a target, a phone, and the phone's path to the hub through the simulated firewall.
async function setup(o: { device?: boolean } = {}) {
  const h = await hub({ core: { network: { windowMs: WINDOW_MS } } });
  const dir = mkdtempSync(join(tmpdir(), 'nova-net-'));
  const token = fakeToken();
  const net = await startNetconfig({ file: join(dir, 'router.json'), token, initial: INITIAL });
  const t = h.core.network.createTarget({ name: 'Example router', kind: 'router', url: net.url });
  h.core.network.setToken(t.id, token);
  let phone: Awaited<ReturnType<typeof enroll>> | null = null;
  let polling = false;
  let reached = 0;
  let dropped = 0;
  if (o.device !== false) {
    phone = await enroll(h, { name: 'Example phone', kind: 'phone' });
    polling = true;
    void (async () => {
      while (polling) {
        // The simulated network: the phone's packets get through only while the firewall allows the mesh.
        if ((net.config().firewall?.allow ?? []).includes('mesh')) {
          const r = await call(h.mesh, 'GET', '/api/v1/health', undefined, { authorization: `Bearer ${phone!.token}` }).catch(() => null);
          if (r) reached++;
        } else dropped++;
        await sleep(40);
      }
    })();
  }
  return {
    h, net, t, token, dir, phone,
    reached: () => reached, dropped: () => dropped,
    async stop() { polling = false; await sleep(60); await net.close(); await h.stop(); },
  };
}

const changeTask = (core: Core, id: string, step: string) => {
  const ref = core.network.view(id).tasks.filter((x) => x.step === step).at(-1);
  return ref ? core.ledger.get(ref.id) : null;
};

// Proposes a change and takes it to the apply ask.
async function toReview(core: Core, target: string, patch: unknown, title = 'Example change') {
  const { change, task } = core.network.start({ target, patch, title });
  const prep = await settle(core, task.id);
  assert.equal(prep.state, 'done', prep.reason ?? '');
  return { id: change.id, prep, apply: changeTask(core, change.id, 'apply')! };
}

const messages = (core: Core) => core.db.all<{ text: string }>('SELECT text FROM message').map((m) => m.text).join('\n');

test('M10d gate: a network change applies, the stand-in loses contact, and Nova reverts to the snapshot by itself', { timeout: 60_000 }, async () => {
  const s = await setup();
  const { core } = s.h;
  try {
    await until(s.reached, (n) => n > 2);
    const before = s.net.text();
    // 1. Snapshot and diff: tier 1, nothing changes.
    const { id, prep, apply } = await toReview(core, 'Example router', { firewall: { allow: ['web'] } }, 'Close everything but the web');
    assert.equal(prep.approval_tier, 1);
    assert.match(prep.verification!.checks[0]!.why, /Nova read its snapshot itself: sha256 [0-9a-f]{12}…, as recorded/);
    assert.equal(s.net.text(), before, 'preparing changed nothing');
    assert.ok(!s.net.hits.some((x) => x.method === 'PUT'));
    // 2. The diff, with the Wi-Fi key masked.
    const v = core.network.view(id);
    assert.equal(v.state, 'review');
    assert.match(String(v.diff), /-\s+"mesh",/);
    assert.ok(!String(v.diff).includes(INITIAL.wifi.psk), 'the Wi-Fi key is never in the diff');
    assert.deepEqual(v.changed, ['firewall.allow']);
    assert.deepEqual(filesHolding(s.h.home, [INITIAL.wifi.psk]), [], 'the snapshot, which holds the Wi-Fi key, is sealed on disk');
    // 3. The apply: tier 3, every time.
    assert.equal(apply.state, 'waiting');
    assert.equal(apply.approval_tier, 3);
    assert.throws(() => core.ledger.approve(apply.id), /explicit confirmation/);
    const checkpoints = core.checkpoints.list().length;
    core.ledger.approve(apply.id, { confirm: true });
    const applied = await settle(core, apply.id);
    assert.equal(applied.state, 'done', applied.reason ?? '');
    assert.match(applied.verification!.checks[0]!.why, /read the target back itself after the change: sha256 [0-9a-f]{12}…, the reviewed configuration exactly/);
    assert.equal(core.checkpoints.list().length, checkpoints + 1, 'a checkpoint was taken before the change');
    assert.deepEqual(s.net.config().firewall.allow, ['web'], 'the change is on the target');
    // 4. The phone is cut off; nothing reaches the hub's mesh listener.
    const reachedAtApply = s.reached();
    await until(() => core.network.view(id).state, (st) => st === 'reverted', WINDOW_MS + 15_000);
    const after = core.network.view(id);
    assert.equal(after.state, 'reverted', String(after.reason));
    assert.equal(after.contact_at, null, 'no contact was confirmed');
    assert.ok(s.dropped() > 0, 'the phone’s requests were dropped while the change was on');
    assert.equal(s.net.text(), before, 'the target is the snapshot again, byte for byte');
    const revert = changeTask(core, id, 'revert')!;
    assert.equal(revert.approval_tier, 1, 'the switch’s revert ran by itself');
    assert.equal(revert.brief.inputs?.by, 'switch');
    assert.equal(revert.state, 'done');
    assert.match(revert.verification!.checks[0]!.why, /the snapshot exactly/);
    assert.match(core.log.problems({ open: true }).map((p) => p.message).join('\n'), /Nova lost contact with your devices after “Close everything but the web” on Example router, so it is putting the snapshot back by itself/);
    assert.match(messages(core), /is back to how it was before “Close everything but the web”/);
    // The phone reaches the hub again.
    await until(s.reached, (n) => n > reachedAtApply + 2);
    // The token and the Wi-Fi key are in no record Nova keeps (the snapshot itself is in Nova's own
    // folder, 0600, never in a record).
    const records = JSON.stringify([core.network.list(), core.network.view(id), ...['prepare', 'apply', 'revert'].map((x) => core.ledger.get(changeTask(core, id, x)!.id)), core.ledger.events(apply.id), core.log.problems()]);
    assert.ok(!records.includes(s.token));
    assert.ok(!records.includes(INITIAL.wifi.psk));
    assert.deepEqual(filesHolding(s.h.home, [s.token, INITIAL.wifi.psk]), [], 'the token and the Wi-Fi key are in no file (the vault keeps the token, and the key that seals the snapshot, encrypted)');
  } finally { await s.stop(); }
});

test('M10d gate: a change the phone still reaches through is kept: contact is confirmed, and nothing reverts', { timeout: 60_000 }, async () => {
  const s = await setup();
  const { core } = s.h;
  try {
    await until(s.reached, (n) => n > 2);
    const { id, apply } = await toReview(core, s.t.id, { dns: { records: { 'nas.home.example': '192.0.2.30' } } }, 'Add a name for the NAS');
    core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await settle(core, apply.id)).state, 'done');
    const kept = await until(() => core.network.view(id), (x) => x.state !== 'watching', 10_000);
    assert.equal(kept.state, 'kept', String(kept.reason));
    assert.equal(kept.contact_device, 'Example phone');
    assert.match(String(kept.reason), /Nova heard from Example phone after the change/);
    await sleep(WINDOW_MS + 300);
    assert.equal(core.network.view(id).state, 'kept', 'the window passed: still kept');
    assert.equal(changeTask(core, id, 'revert'), null, 'no revert was made');
    assert.equal(s.net.config().dns.records['nas.home.example'], '192.0.2.30');
    assert.match(messages(core), /The change “Add a name for the NAS” to Example router stays: Nova heard from Example phone after it/);
    // The person may still put it back: tier 3.
    const back = core.network.revert(id);
    assert.equal(back.task.approval_tier, 3);
    core.ledger.approve(back.task.id, { confirm: true });
    assert.equal((await settle(core, back.task.id)).state, 'done');
    assert.equal(core.network.view(id).state, 'reverted');
    assert.deepEqual(s.net.config(), INITIAL);
  } finally { await s.stop(); }
});

test('M10d: the hub’s own screen is not contact: with the phone silent, console requests don’t keep a change', { timeout: 60_000 }, async () => {
  const s = await setup();
  const { core } = s.h;
  try {
    const { id, apply } = await toReview(core, s.t.id, { firewall: { allow: ['web'] } });
    core.ledger.approve(apply.id, { confirm: true });
    await settle(core, apply.id);
    // The person at the hub's own screen keeps using the console all through the window.
    const end = Date.now() + WINDOW_MS + 200;
    while (Date.now() < end) { await s.h.c('GET', '/network'); await sleep(50); }
    const v = await until(() => core.network.view(id), (x) => x.state === 'reverted', 10_000);
    assert.equal(v.state, 'reverted');
  } finally { await s.stop(); }
});

test('M10d: no paired device, no change; a patch that sets a secret is refused; a target changed since the snapshot is left alone', { timeout: 60_000 }, async () => {
  const none = await setup({ device: false });
  try {
    assert.throws(() => none.h.core.network.start({ target: none.t.id, patch: { firewall: { allow: ['web'] } } }), /Nova confirms a network change by hearing from one of your devices afterwards, and none is paired/);
  } finally { await none.stop(); }

  const s = await setup();
  const { core } = s.h;
  try {
    assert.throws(() => core.network.start({ target: s.t.id, patch: { wifi: { psk: 'x' } } }), /The patch sets wifi\.psk: secrets aren’t changed from chat/);
    assert.throws(() => core.network.start({ target: s.t.id, patch: {} }), /JSON merge patch/);
    const { id, apply } = await toReview(core, s.t.id, { dns: { upstream: ['192.0.2.54'] } });
    // Someone changes the router after the snapshot.
    const other = { ...INITIAL, dns: { ...INITIAL.dns, upstream: ['192.0.2.99'] } };
    writeFileSync(s.net.file, `${JSON.stringify(other, null, 2)}\n`);
    core.ledger.approve(apply.id, { confirm: true });
    const t = await settle(core, apply.id);
    assert.equal(t.state, 'failed');
    assert.match(String(t.reason), /configuration changed since the snapshot, so Nova applied nothing/);
    assert.deepEqual(s.net.config(), other, 'their change stands');
    assert.ok(!s.net.hits.some((x) => x.method === 'PUT'), 'nothing was written');
    assert.equal(core.network.view(id).state, 'failed');
  } finally { await s.stop(); }
});

test('M10d: a revert that finds someone else’s change after Nova’s doesn’t overwrite it, and says so', { timeout: 60_000 }, async () => {
  const s = await setup();
  const { core } = s.h;
  try {
    const { id, apply } = await toReview(core, s.t.id, { firewall: { allow: ['web'] } });
    core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await settle(core, apply.id)).state, 'done');
    // Someone changes the router by hand inside the window (and the phone still can't get through).
    const theirs = { ...INITIAL, firewall: { allow: ['web', 'ssh'], default: 'drop' } };
    writeFileSync(s.net.file, `${JSON.stringify(theirs, null, 2)}\n`);
    const v = await until(() => core.network.view(id), (x) => ['kept', 'reverted', 'revert_failed'].includes(x.state), 15_000);
    assert.equal(v.state, 'revert_failed', String(v.reason));
    assert.match(String(v.reason), /changed after Nova’s change \(it isn’t the snapshot or Nova’s change\), so Nova didn’t overwrite it/);
    assert.match(core.log.problems({ open: true }).map((p) => p.message).join('\n'), /Nova couldn’t put Example router back to the snapshot/);
    assert.deepEqual(s.net.config(), theirs);
  } finally { await s.stop(); }
});

test('M10d: only a device trusted at the apply counts: one paired afterwards doesn’t keep the change', { timeout: 60_000 }, async () => {
  const h = await hub({ core: { network: { windowMs: 4000 } } });
  const dir = mkdtempSync(join(tmpdir(), 'nova-net-'));
  const token = fakeToken();
  const net = await startNetconfig({ file: join(dir, 'router.json'), token, initial: INITIAL });
  try {
    // The person's phone is paired, and silent: it can't reach the hub after the change.
    await enroll(h, { name: 'Example phone', kind: 'phone' });
    const t = h.core.network.createTarget({ name: 'Example router', kind: 'router', url: net.url });
    h.core.network.setToken(t.id, token);
    const { id, apply } = await toReview(h.core, t.id, { firewall: { allow: ['web'] } });
    h.core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await settle(h.core, apply.id)).state, 'done');
    // A second device, paired after the change, makes requests all through the window.
    const late = await enroll(h, { name: 'Example tablet', kind: 'browser' });
    const end = Date.now() + 4500;
    while (Date.now() < end && h.core.network.view(id).state === 'watching') {
      await call(h.mesh, 'GET', '/api/v1/health', undefined, { authorization: `Bearer ${late.token}` });
      await sleep(50);
    }
    const v = await until(() => h.core.network.view(id), (x) => x.state === 'reverted', 10_000);
    assert.equal(v.state, 'reverted', String(v.reason));
    assert.equal(v.contact_at, null);
    assert.deepEqual(net.config(), INITIAL);
  } finally {
    await net.close();
    await h.stop();
  }
});

test('M10d: after a restart, a change past its deadline with no contact reverts', { timeout: 60_000 }, async () => {
  // A long window, so only the restart's own check can fire it.
  const h = await hub({ core: { network: { windowMs: 3_600_000 } } });
  const dir = mkdtempSync(join(tmpdir(), 'nova-net-'));
  const token = fakeToken();
  const net = await startNetconfig({ file: join(dir, 'router.json'), token, initial: INITIAL });
  let core2: Core | null = null;
  try {
    await enroll(h, { name: 'Example phone', kind: 'phone' });
    const t = h.core.network.createTarget({ name: 'Example router', kind: 'router', url: net.url });
    h.core.network.setToken(t.id, token);
    const { id, apply } = await toReview(h.core, t.id, { firewall: { allow: ['web'] } });
    h.core.ledger.approve(apply.id, { confirm: true });
    assert.equal((await settle(h.core, apply.id)).state, 'done');
    assert.equal(h.core.network.view(id).state, 'watching');
    const clock = h.clock.t;
    await h.stop();
    // Nova starts again two hours later.
    core2 = createCore({ home: h.home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(clock + 2 * 3600_000), mesh: { publicUrl: 'http://hub.example:4320', transport: 'network' } });
    core2.start();
    const v = await until(() => core2!.network.view(id), (x) => x.state === 'reverted', 15_000);
    assert.equal(v.state, 'reverted', String(v.reason));
    assert.deepEqual(net.config(), INITIAL);
  } finally {
    await core2?.close();
    await net.close();
  }
});

test('M10d: Nova stopped mid-write still has a switch: after the restart, without contact, the change reverts', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-net-'));
  const token = fakeToken();
  const net = await startNetconfig({ file: join(dir, 'router.json'), token, initial: INITIAL });
  // The write lands on the target, and Nova stops before it hears back (as a power cut would).
  const landed = { yes: false };
  const hanging = (t: { url: string; token: () => string | null }) => {
    const real = httpConfig({ url: t.url, token: t.token });
    return { read: real.read, write: async (config: Config, v: string) => { await real.write(config, v); landed.yes = true; return new Promise<never>(() => {}); } };
  };
  const h = await hub({ core: { network: { windowMs: 3_600_000, target: hanging } } });
  let core2: Core | null = null;
  try {
    await enroll(h, { name: 'Example phone', kind: 'phone' });
    const t = h.core.network.createTarget({ name: 'Example router', kind: 'router', url: net.url });
    h.core.network.setToken(t.id, token);
    const { id, apply } = await toReview(h.core, t.id, { firewall: { allow: ['web'] } });
    h.core.ledger.approve(apply.id, { confirm: true });
    await until(() => landed.yes, (x) => x, 10_000);
    assert.deepEqual(net.config().firewall.allow, ['web'], 'the change landed');
    assert.equal(h.core.network.view(id).state, 'applying');
    assert.ok(h.core.network.view(id).deadline, 'the deadline was written before the write');
    const clock = h.clock.t;
    await h.stop();
    core2 = createCore({ home: h.home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(clock + 2 * 3600_000), mesh: { publicUrl: 'http://hub.example:4320', transport: 'network' } });
    core2.start();
    const v = await until(() => core2!.network.view(id), (x) => x.state === 'reverted', 15_000);
    assert.equal(v.state, 'reverted', String(v.reason));
    assert.deepEqual(net.config(), INITIAL, 'the snapshot is back');
    assert.equal(core2.ledger.get(apply.id).state, 'cancelled', 'the held apply was settled by the switch');
  } finally {
    await core2?.close();
    await net.close();
  }
});

test('M10d network pieces: merge patch, masking, secret paths', () => {
  assert.deepEqual(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 }, f: [1] }), { a: 1, b: { d: 3, e: 4 }, f: [1] });
  assert.deepEqual(mask({ wifi: { ssid: 'x', psk: 'y' }, users: [{ name: 'a', password: 'b' }], api_key: { v: 1 } }), { wifi: { ssid: 'x', psk: '[secret]' }, users: [{ name: 'a', password: '[secret]' }], api_key: '[secret]' });
  // A diff whose context shows a secret line shows it masked.
  assert.deepEqual(mask(mergePatch(INITIAL, { wifi: { ssid: 'example-net-2' } })), { ...INITIAL, wifi: { ssid: 'example-net-2', psk: '[secret]' } });
  assert.deepEqual(secretPaths({ wifi: { psk: 'x' }, vpn: { private_key: null }, dns: { upstream: [] } }), ['wifi.psk', 'vpn.private_key']);
  void readFileSync;
});
