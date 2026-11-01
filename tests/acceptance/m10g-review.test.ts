// The adversarial review of #272 (M10g): each probe's scenario, as a test that fails without its fix.
// Two cores in this process over real HTTP on loopback, with loopback forwarders between them (the
// stable-name stand-in used as a plain link) so a link can be cut one way. Temp homes only.
//   R1 (p1)  a link cut during the window: no roll-back by itself; the person may take the hub back,
//            and the node that steps down keeps what it took in a checkpoint, said exactly
//   R2 (p2)  the old hub cut off from everything: it never takes the role; nothing the new hub took is lost
//   R3 (p3)  two hubs at the same epoch: fencing settles it to one, by a fixed rule
//   R4 (p4)  a change landing during the hold: carried to the new hub, not left behind silently
//   R5 (p5)  the old hub restarts during the transfer: it starts holding, and handed-over work doesn't run twice
//   R7 (p7)  the candidate dies at the transfer: held, told, cancellable at tier 3; released as soon as
//            the candidate says, signed, it didn't take it
//   R9 (p9)  the candidate takes the role, then errors: the old hub doesn't resume; it follows
//   plus: a clock off by two minutes, a stale record at restart, the window clamped outside tests, the
//   tap's redaction, the name driver's token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chainLeads, createCore, generateDeviceKeys, linkMessage, loadIdentity, seenMessage, signCall, signMessage, signRoster, writeRole, type Core, type DeviceKeys, type Listener, type SignedLink } from '../../src/core/index.ts';
import { acceptRoster, epochVerdict, rosterKeys } from '../../src/device/trust.ts';
import { Promotions, httpStableName, testing } from '../../src/core/mesh/handover.ts';
import { setTap, tap } from '../../src/core/mesh/tap.ts';
import { call } from '../core/mesh-support.ts';
import { GIB, TOKEN, backedUp, node, pair, problems, promote, prober, sleep, stop, takes, until, verifying } from './m10g-support.ts';
import { startStableName } from '../../scripts/stand-ins/stable-name.js';


test('R1 (p1): a link cut during the window is no reason to take the role back; the person may, at tier 3, and the node that steps down keeps what it took', { timeout: 120_000 }, async () => {
  const p = await pair({ links: true, promotion: { windowS: 600, probeMs: 150 } });
  try {
    assert.equal((await promote(p)).status, 202);
    await verifying(p);
    await sleep(600);
    p.toB!.point(null); // a can't reach b; b reaches a and serves devices through the name
    const watch = prober(p);
    await sleep(2500);
    assert.equal(p.a.core.mesh.role.role(), 'standby', 'no roll-back on a broken link');
    assert.equal(p.b.core.mesh.role.role(), 'hub', 'the new hub stays the hub');
    const rec = p.a.core.mesh.promotions.record()!;
    assert.equal(rec.state, 'verifying');
    assert.ok(rec.probes.slice(-3).every((x) => x.result === 'unknown'), JSON.stringify(rec.probes.slice(-3)));
    assert.ok(problems(p.a.core).some((m) => /can’t reach “Standby”, the hub since the hand-over/.test(m) && /take the hub back here/.test(m)), 'the person is told, with the way out');
    // The person takes the hub back (tier 3), knowing b may still be running.
    assert.equal((await p.a.api('POST', '/mesh/promotion/take-back', {})).status, 400, 'tier 3, every time');
    const tb = await p.a.api('POST', '/mesh/promotion/take-back', { confirm: true });
    assert.equal(tb.status, 200, JSON.stringify(tb.body));
    assert.equal(p.a.core.mesh.role.role(), 'hub');
    assert.equal(p.a.core.mesh.devices.state().epoch, 3);
    // b, still hub for now (it can't be told), takes a change; then it sees a at the higher epoch.
    const w = await p.b.api('POST', '/memory', { kind: 'fact', content: 'Written on the new hub after the hub was taken back.' });
    assert.equal(w.status, 201);
    const f = await p.b.core.mesh.role.fence();
    assert.equal(f.demoted, true);
    await until(() => p.b.core.mesh.promotions.record()?.state, (s) => s === 'stepped-down');
    await watch.stop();
    // Nothing deleted silently: the change is in a named checkpoint on b, and the problem names it.
    const said = problems(p.b.core).find((m) => /never reached the other node/.test(m));
    assert.ok(said && said.includes(w.body.id), `the problem names what wasn't carried over: ${said} / ${JSON.stringify(problems(p.b.core))} / ${JSON.stringify(p.b.core.mesh.promotions.record())}`);
    const cps = readdirSync(join(p.b.home, 'checkpoints')).filter((x) => /changes-/.test(x));
    assert.equal(cps.length, 1, readdirSync(join(p.b.home, 'checkpoints')).join(', '));
    const db = new DatabaseSync(join(p.b.home, 'checkpoints', cps[0]!, 'nova.db'), { readOnly: true });
    try { assert.ok(db.prepare('SELECT 1 FROM memory WHERE id = ?').get(w.body.id), 'the change is in the checkpoint'); } finally { db.close(); }
    assert.equal(p.b.core.mesh.role.role(), 'standby');
  } finally {
    await stop(p);
  }
});

test('R2 (p2): the old hub cut off from everything never takes the role; the new hub’s changes survive the heal', { timeout: 120_000 }, async () => {
  const p = await pair({ links: true, promotion: { windowS: 600, probeMs: 150 } });
  try {
    await promote(p);
    await verifying(p);
    await sleep(600);
    p.toB!.point(null); p.toA!.point(null); p.name.stuck(true);
    const watch = prober(p);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) { ids.push((await p.b.api('POST', '/memory', { kind: 'fact', content: `Change ${i} on the new hub during the outage.` })).body.id); await sleep(400); }
    assert.equal(p.a.core.mesh.role.role(), 'standby', 'an isolated old hub stays a standby');
    p.toA!.point(p.a.mesh); p.toB!.point(p.b.mesh); p.name.stuck(false);
    await until(() => ids.every((id) => p.a.core.db.get('SELECT 1 FROM memory WHERE id = ?', id)), (x) => x, 20_000);
    const t = await watch.stop();
    assert.equal(t.both, 0, JSON.stringify(t));
    assert.deepEqual([p.a.core.mesh.role.role(), p.b.core.mesh.role.role()], ['standby', 'hub']);
    assert.ok(ids.every((id) => p.a.core.db.get('SELECT 1 FROM memory WHERE id = ?', id)), 'every change the new hub took is on both');
  } finally {
    await stop(p);
  }
});

test('R3 (p3): two hubs at the same epoch: fencing settles it to one by a fixed rule, from either side', { timeout: 60_000 }, async () => {
  const p = await pair({});
  try {
    await p.a.closeCore();
    const pr = await p.b.api('POST', '/mesh/promote', { confirm: true });
    assert.equal(pr.body.epoch, 2);
    const db = new DatabaseSync(join(p.a.home, 'nova.db'));
    db.prepare('UPDATE mesh_state SET epoch = 2 WHERE id = 1').run();
    db.close();
    p.a.make().start();
    assert.deepEqual([p.a.core.mesh.role.role(), p.b.core.mesh.role.role()], ['hub', 'hub']);
    await p.a.core.mesh.role.fence();
    await p.b.core.mesh.role.fence();
    const roles = [p.a.core.mesh.role.role(), p.b.core.mesh.role.role()];
    assert.equal(roles.filter((r) => r === 'hub').length, 1, `one hub: ${roles}`);
    const winner = [p.a.core.mesh.identity.id, p.b.core.mesh.identity.id].sort()[0];
    assert.equal(roles[0] === 'hub' ? p.a.core.mesh.identity.id : p.b.core.mesh.identity.id, winner, 'the smaller id wins a tie');
    assert.equal((await takes(p.a)) && (await takes(p.b)), false);
  } finally {
    await stop(p);
  }
});

test('R4 (p4): a change that lands during the hold reaches the new hub, or is kept and said; never left behind silently', { timeout: 60_000 }, async () => {
  const p = await pair({ promotion: { windowS: 600 } });
  try {
    let wrote: string | null = null;
    p.a.core.mesh.role.on('change', (s: { held?: string }) => {
      if (s.held && !wrote && p.a.core.mesh.promotions.record()?.last_seq != null) wrote = p.a.core.memory.remember({ kind: 'fact', content: 'Landed on the old hub during the hold.', recorded_by: 'person' }).id;
    });
    await promote(p);
    await verifying(p);
    assert.ok(wrote);
    const onB = !!p.b.core.db.get('SELECT 1 FROM memory WHERE id = ?', wrote);
    const kept = problems(p.a.core).some((m) => m.includes(wrote!) && /kept/.test(m));
    assert.ok(onB || kept, 'carried to the new hub, or kept and named');
    assert.ok(onB, 'with the log recording through the hold, the candidate copies it before the hand-over');
  } finally {
    await stop(p);
  }
});

test('R5 (p5): the old hub restarts during the transfer: it starts holding, never runs handed-over work again, and follows the new hub', { timeout: 90_000 }, async () => {
  const p = await pair({ promotion: { windowS: 600, drainMs: 300 } });
  const runs: string[] = [];
  const slow = (who: string) => ({ id: 'slow', name: 'Slow', about: 'x', egress: 'none', evidence: [], health: () => ({ ok: true }), run: (b: { task_id: string }, signal?: AbortSignal) => { runs.push(who); return new Promise((_, fail) => { signal?.addEventListener('abort', () => fail(new Error('stopped'))); }); } });
  try {
    p.a.core.ledger.workers.set('slow', slow('A') as never);
    p.b.core.ledger.workers.set('slow', slow('B') as never);
    const t = p.a.core.ledger.create({ title: 'Long work on the hub', owner: 'slow', goal: 'x', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation', note: 'x' }], approval_tier: 0 });
    await until(() => p.a.core.ledger.get(t.id).state, (s) => s === 'active', 3000);
    let closing: Promise<void> | null = null;
    p.a.core.mesh.role.on('change', () => { if (!closing && p.a.core.mesh.promotions.record()?.state === 'transferring') closing = p.a.closeCore(); });
    await promote(p);
    await until(() => closing, (x) => !!x, 15_000);
    await closing;
    await until(() => p.b.core.mesh.role.role(), (r) => r === 'hub', 10_000);
    const c = p.a.make();
    c.ledger.workers.set('slow', slow('A') as never);
    c.start();
    assert.ok(c.mesh.role.held() || c.mesh.role.role() === 'standby', 'it starts holding (or stepped down at once)');
    await until(() => c.mesh.role.role(), (r) => r === 'standby', 20_000);
    await sleep(500);
    assert.equal(runs.filter((r) => r === 'A').length, 1, `handed-over work ran again on the old hub: ${runs.join(',')}`);
    assert.equal(c.mesh.promotions.record()?.state, 'verifying');
  } finally {
    await stop(p);
  }
});

test('R7 (p7): the candidate dies at the transfer: held, told, released when it says (signed) it didn’t take it, or cancelled at tier 3 when it can’t say', { timeout: 120_000 }, async () => {
  // Released on evidence.
  {
    const p = await pair({ promotion: { windowS: 600 } });
    try {
      let closing: Promise<void> | null = null;
      p.a.core.mesh.role.on('change', () => { if (!closing && p.a.core.mesh.promotions.record()?.state === 'transferring') closing = p.b.closeCore(); });
      await promote(p);
      await until(() => closing, (x) => !!x, 15_000);
      await closing;
      await until(() => problems(p.a.core).some((m) => /couldn’t tell whether “Standby” took the hub’s role/.test(m)), (x) => x, 15_000);
      assert.equal(await takes(p.a), false, 'held while it can’t tell');
      p.b.make().start();
      await until(() => p.a.core.mesh.role.held(), (h) => !h, 40_000);
      assert.equal(p.a.core.mesh.role.role(), 'hub');
      assert.equal(await takes(p.a), true, 'released: the candidate said, signed, it didn’t take it');
      assert.equal(p.b.core.mesh.promotions.record()?.state, 'declined', 'and it never will');
    } finally {
      await stop(p);
    }
  }
  // Cancelled when it can't say.
  {
    const p = await pair({ promotion: { windowS: 600 } });
    try {
      let closing: Promise<void> | null = null;
      p.a.core.mesh.role.on('change', () => { if (!closing && p.a.core.mesh.promotions.record()?.state === 'transferring') closing = p.b.close(); });
      await promote(p);
      await until(() => closing, (x) => !!x, 15_000);
      await closing;
      await until(() => p.a.core.mesh.promotions.record()?.told ?? [], (t) => t.includes('unknown'), 15_000);
      assert.equal((await p.a.api('POST', '/mesh/promotion/cancel', {})).status, 400, 'tier 3, every time');
      const r = await p.a.api('POST', '/mesh/promotion/cancel', { confirm: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.said, /without knowing whether it took the role/);
      assert.equal(p.a.core.mesh.devices.state().epoch, 3, 'two past where it was');
      assert.equal(await takes(p.a), true);
      assert.equal(p.a.core.mesh.promotions.record()?.state, 'cancelled');
    } finally {
      await stop(p);
    }
  }
});

test('R9 (p9): the candidate takes the role and then errors: the old hub doesn’t resume; it follows once the candidate says', { timeout: 90_000 }, async () => {
  const p = await pair({ promotion: { windowS: 600 } });
  try {
    let closing: Promise<void> | null = null;
    p.b.core.mesh.role.on('promoted', () => { if (!closing) closing = p.b.closeCore(); });
    await promote(p);
    await until(() => closing, (x) => !!x, 15_000);
    await closing;
    await sleep(1500);
    assert.equal(await takes(p.a), false, 'no resume without the candidate’s word');
    assert.notEqual(p.a.core.mesh.promotions.record()?.state, 'failed');
    p.b.make().start();
    assert.equal(p.b.core.mesh.role.role(), 'hub');
    await until(() => p.a.core.mesh.role.role(), (r) => r === 'standby', 40_000);
    assert.equal(p.a.core.mesh.promotions.record()?.state, 'verifying');
    assert.equal(p.b.core.mesh.promotions.record()?.state, 'verifying', 'its record caught up at its restart');
  } finally {
    await stop(p);
  }
});

test('a clock off by two minutes makes probes unknown, never a roll-back; a stale record isn’t probed at restart', { timeout: 90_000 }, async () => {
  const skewA = { ms: 0 };
  const p = await pair({ promotion: { windowS: 600, probeMs: 150 }, skewA });
  try {
    await promote(p);
    await verifying(p);
    await sleep(500);
    skewA.ms = 120_000;
    await until(() => p.a.core.mesh.promotions.record()!.probes.slice(-3), (x) => x.length === 3 && x.every((y) => y.result === 'unknown'), 15_000);
    await sleep(800);
    assert.equal(p.a.core.mesh.role.role(), 'standby');
    assert.equal(p.b.core.mesh.role.role(), 'hub');
    skewA.ms = 0;
    // A record that no longer matches this node's state at restart: ended, not probed.
    await p.a.closeCore();
    const file = join(p.a.home, 'mesh', 'promotion.json');
    const r = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...r, to: { ...r.to, id: 'someone-else' } }));
    const c = p.a.make();
    c.start();
    assert.equal(c.mesh.promotions.record()?.state, 'ended');
    await sleep(600);
    assert.equal(c.mesh.promotions.record()?.probes.length, r.probes.length, 'no probe from a stale record');
  } finally {
    await stop(p);
  }
});

test('outside a test or the drill, the window is never shorter than 30 minutes; the tap redacts the vault key and is off unless set; the name driver needs its token and this machine or https', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-review-clamp-'));
  const was = process.env.NODE_TEST_CONTEXT;
  try {
    assert.equal(testing(home), true);
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(testing(home), false);
    assert.equal(testing(home, { NOVA_DRILL: '1' }), true);
    assert.equal(testing('/home/someone/Nova', { NOVA_DRILL: '1' }), false, 'never on a home outside the temp folder');
    const c = createCore({ home, version: '0.1.0', trustedOrigin: () => true, promotion: { windowS: 2, probeMs: 150 } });
    try {
      const pr = c.mesh.promotions as Promotions;
      assert.equal(pr.windowS, 1800);
      assert.equal(pr.probeMs, 5000);
    } finally { void c.close(); }
  } finally {
    if (was !== undefined) process.env.NODE_TEST_CONTEXT = was;
  }
  const dir = mkdtempSync(join(tmpdir(), 'nova-review-tap-'));
  tap('sync', { rows: [] });
  assert.deepEqual(readdirSync(dir), [], 'off unless set');
  setTap(dir);
  const key = Buffer.alloc(32, 7).toString('base64');
  tap('sync', { rows: [{ tbl: 'vault', row: JSON.stringify({ sha256: 'x', file: 'y', key }) }] });
  setTap(null);
  const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('');
  assert.ok(!text.includes(key), 'no vault key in clear');
  assert.match(text, /vault key, sha256 /);
  assert.equal(httpStableName('http://127.0.0.1:9/point', 'http://name.test', null), null, 'no token, no driver');
  assert.equal(httpStableName('http://192.0.2.1:9/point', 'http://name.test', TOKEN), null, 'plain http only on this machine');
  assert.ok(httpStableName('https://name-control.test/point', 'http://name.test', TOKEN));
  assert.ok(httpStableName('http://127.0.0.1:9/point', 'http://name.test', TOKEN));
});

test('R6 (p6): a device never follows another hub at an equal epoch, nor one that skips more than 3 epochs, nor past the ceiling', () => {
  const H = generateDeviceKeys();
  const C = generateDeviceKeys();
  const m = (id: string, k: DeviceKeys) => ({ id, url: 'http://127.0.0.1:1', public_key: k.ed25519.publicKey, x25519_public_key: k.x25519.publicKey });
  const held = signRoster({ epoch: 2, hub: m('hub', H), candidates: [m('cand', C)], issued_at: 't' }, H.ed25519.privateKey);
  const pinned = rosterKeys(held.roster);
  const o = { pinned, epoch: 2, currentHub: H.ed25519.publicKey };
  const at = (e: number, k = C, id = 'cand') => signRoster({ epoch: e, hub: m(id, k), issued_at: 't' }, k.ed25519.privateKey);
  assert.match((acceptRoster(at(2), o) as { reason: string }).reason, /the same as the hub this device follows/, 'equal epoch, another signer: refused');
  assert.equal(acceptRoster(at(3), o).ok, true, 'strictly higher: followed');
  assert.equal(acceptRoster(at(5), o).ok, true, '+3: followed');
  assert.match((acceptRoster(at(6), o) as { reason: string }).reason, /more than 3 past the 2/, '+4 from another signer: refused');
  assert.equal(acceptRoster(at(9, H, 'hub'), o).ok, true, 'the current hub may jump');
  assert.equal(epochVerdict(2 ** 53, C.ed25519.publicKey, { known: 2 }).ok, false, 'no epoch past the ceiling');
  assert.equal(epochVerdict(2, H.ed25519.publicKey, { known: 2, current: H.ed25519.publicKey }).ok, true, 'the same hub, same epoch: a refresh');
});

test('R3b (p3): an emergency promotion’s epoch is above any roster a device showed this node, and the sheet says where it came from', { timeout: 60_000 }, async () => {
  const p = await pair({});
  try {
    const a = p.a.core;
    const r7 = signRoster({ epoch: 7, hub: { id: a.mesh.identity.id, url: p.a.mesh, public_key: a.mesh.identity.publicKey, x25519_public_key: a.mesh.identity.x25519PublicKey }, issued_at: new Date().toISOString() }, a.mesh.identity.signer());
    const stranger = generateDeviceKeys();
    const forged = signRoster({ epoch: 40, hub: { id: 'x', url: null, public_key: stranger.ed25519.publicKey, x25519_public_key: stranger.x25519.publicKey }, issued_at: 't' }, stranger.ed25519.privateKey);
    // A device's report, signed by the device (here the old hub, a trusted device in B's registry).
    const report = (roster: unknown) => { const time = Math.floor(Date.now() / 1000); return { roster, device_id: a.mesh.identity.id, time, signature: a.mesh.identity.sign(seenMessage(a.mesh.identity.id, time, roster as never)) }; };
    assert.equal((await call(p.b.mesh, 'POST', '/api/v1/mesh/seen', report(forged))).body.kept, false, 'only a roster signed by a key this node trusts to be hub');
    await sleep(1100);
    assert.equal((await call(p.b.mesh, 'POST', '/api/v1/mesh/seen', report(r7))).body.kept, true);
    const v = (await p.b.api('GET', '/mesh/promotion/cold')).body;
    assert.equal(v.facts.seen.max, 7);
    assert.equal(v.facts.epoch_new, 8, 'max + 1 over what the devices showed, not only its own record');
    assert.match(v.sheet.find((f: { label: string }) => f.label === 'Epoch').text, /newest roster your devices have shown it \(epoch 7, from one device\)/);
  } finally {
    await stop(p);
  }
});
