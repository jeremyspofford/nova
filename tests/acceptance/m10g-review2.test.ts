// The second adversarial review of #272 (M10g): each new probe's scenario as a test that fails
// without its fix (p10–p15). Two cores over HTTP on loopback, temp homes only (m10g-support.ts).
//   R10 (p10)  /mesh/seen: only a paired device's signed report; the highest epoch only rises; one per
//              device a second, counted after the checks; "from N devices" counts devices
//   R11 (p11)  a tie: the winner goes one epoch higher at once, so devices follow it; the loser keeps
//              what it took in a named checkpoint, naming only real changes
//   R12 (p12)  a cancel during a split: once it settles, the stable name leads to the hub
//   R13 (p13)  a replayed "unhealthy" or stand-down answer is refused: answers are bound to their request
//   R14 (p14)  a take-back while the name can't be moved: once it settles, the name leads to the hub
//   R15 (p15)  a computer away through five planned promotions follows the chain of hand-overs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chainLeads, generateDeviceKeys, linkMessage, seenMessage, signCall, signMessage, signRoster, type Core, type DeviceKeys, type SignedLink } from '../../src/core/index.ts';
import { answers, summarize } from '../../src/core/mesh/handover.ts';
import { acceptRoster, epochVerdict, rosterKeys } from '../../src/device/trust.ts';
import { agentEnv } from '../../src/agent.js';
import { knownSecrets } from '../../src/core/diagnostics/index.ts';
import { call } from '../core/mesh-support.ts';
import { pair, problems, promote, prober, sleep, stop, takes, until, verifying } from './m10g-support.ts';

const nowS = () => Math.floor(Date.now() / 1000);

test('R10 (p10): /mesh/seen keeps only a paired device’s signed report; the highest epoch never falls; junk can’t crowd out a device; devices are counted, not reports', { timeout: 60_000 }, async () => {
  const p = await pair({});
  try {
    const a = p.a.core;
    const old = (await call(p.a.mesh, 'GET', '/api/v1/mesh/hello')).body.roster;
    a.mesh.role.raiseEpoch(3);
    const real = a.mesh.devices.roster();
    const as = (c: Core, roster: unknown) => { const time = nowS(); return { roster, device_id: c.mesh.identity.id, time, signature: c.mesh.identity.sign(seenMessage(c.mesh.identity.id, time, roster as never)) }; };
    const post = (b: unknown) => call(p.b.mesh, 'POST', '/api/v1/mesh/seen', b).then((r) => r.body);
    assert.equal((await post({ roster: real })).kept, false, 'unsigned: refused');
    assert.equal((await post({ ...as(a, real), device_id: 'someone' })).kept, false, 'not a paired device: refused');
    assert.equal((await post(as(a, real))).kept, true);
    let f = (await p.b.core.mesh.promotions.coldView()).facts;
    assert.deepEqual([f.seen?.max, f.seen?.count], [4, 1]);
    // The old public roster, replayed (even by the same device, signed): the highest stays.
    for (let i = 0; i < 3; i++) { await sleep(1050); await post(as(a, old)); }
    f = (await p.b.core.mesh.promotions.coldView()).facts;
    assert.equal(f.seen?.max, 4, 'a lower report never lowers it');
    assert.equal(f.epoch_new, 5);
    // Junk every 50 ms doesn't stop a device's report (the limit is per device, after the checks).
    let on = true;
    const junk = (async () => { while (on) { await post({ nothing: true }).catch(() => {}); await sleep(50); } })();
    await sleep(1100);
    const kept = (await post(as(a, real))).kept;
    on = false; await junk;
    assert.equal(kept, true, 'a real report is kept while junk arrives');
    // Three reports from one device count one device.
    for (let i = 0; i < 2; i++) { await sleep(1050); await post(as(a, real)); }
    assert.equal((await p.b.core.mesh.promotions.coldView()).facts.seen?.count, 1);
  } finally {
    await stop(p);
  }
});

test('R11 (p11): a tie: the winner goes one epoch higher at once, devices follow it, and the loser keeps what it took in a checkpoint naming only real changes', { timeout: 90_000 }, async () => {
  const p = await pair({});
  try {
    await p.a.closeCore();
    const pr = await p.b.api('POST', '/mesh/promote', { confirm: true });
    assert.equal(pr.body.epoch, 2);
    const rosterB = p.b.core.mesh.devices.roster();
    const device = { pinned: rosterKeys(rosterB.roster), epoch: 2, current: rosterB.roster.hub.public_key };
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await p.b.api('POST', '/memory', { kind: 'fact', content: `Change ${i} on B, the live hub.` })).body.id);
    const db = new DatabaseSync(join(p.a.home, 'nova.db'));
    db.prepare('UPDATE mesh_state SET epoch = 2 WHERE id = 1').run();
    db.close();
    p.a.make().start();
    const mine = new Map<string, string[]>([['b', ids], ['a', []]]);
    for (let i = 0; i < 2; i++) { const r = await p.a.api('POST', '/memory', { kind: 'fact', content: `Change ${i} on A, back as a hub at the same epoch.` }); if (r.status === 201) mine.get('a')!.push(r.body.id); }
    const ida = p.a.core.mesh.identity.id;
    const idb = p.b.core.mesh.identity.id;
    const [win, lose] = ida < idb ? [p.a, p.b] : [p.b, p.a];
    for (let i = 0; i < 3; i++) { await win.core.mesh.role.fence(); await lose.core.mesh.role.fence(); await sleep(200); }
    assert.equal(win.core.mesh.role.role(), 'hub');
    assert.equal(lose.core.mesh.role.role(), 'standby');
    assert.equal(win.core.mesh.devices.state().epoch, 3, 'the winner went one higher');
    // A computer that followed B (at 2) follows the winner now, by the agent's own rules.
    const w = win.core.mesh.devices.roster();
    assert.equal(epochVerdict(3, w.roster.hub.public_key, { known: device.epoch, current: device.current }).ok, true);
    assert.equal(acceptRoster(w, { pinned: device.pinned, epoch: device.epoch, hubKey: w.roster.hub.public_key, currentHub: device.current }).ok, true);
    // The loser's own changes are kept, and the kept list names them, not seed data.
    const theirs = mine.get(lose === p.a ? 'a' : 'b')!;
    assert.ok(theirs.length > 0, 'the loser took changes as a hub');
    const said = problems(lose.core).find((m) => /never reached the other node/.test(m)) ?? '';
    for (const id of theirs) assert.ok(said.includes(id), `names ${id}: ${said}`);
    assert.doesNotMatch(said, /decision template|extension records/, 'no seed rows in the list');
    const cps = readdirSync(join(lose.home, 'checkpoints')).filter((x) => /changes-/.test(x));
    assert.equal(cps.length, 1);
  } finally {
    await stop(p);
  }
});

test('R12 (p12): a cancel during a split; once the links heal and it settles, the stable name leads to the hub', { timeout: 120_000 }, async () => {
  const p = await pair({ links: true, promotion: { windowS: 600, probeMs: 150 } });
  try {
    let cut = false;
    p.b.core.mesh.role.on('promoted', () => { if (!cut) { cut = true; p.toB!.point(null); p.toA!.point(null); } });
    await promote(p);
    await until(() => p.a.core.mesh.promotions.record()?.told ?? [], (t) => t.includes('unknown'), 60_000);
    assert.equal((await p.a.api('POST', '/mesh/promotion/cancel', { confirm: true })).status, 200);
    assert.ok(p.name.moves().some((x: { address: string }) => x.address === p.b.mesh), 'the name went to B, which took the role');
    const phone = (await p.b.api('POST', '/memory', { kind: 'fact', content: 'A phone’s change through the name, during the split.' })).body.id as string;
    p.toB!.point(p.b.mesh); p.toA!.point(p.a.mesh);
    await p.b.core.mesh.role.fence();
    await until(() => p.b.core.mesh.role.role(), (r) => r === 'standby', 30_000);
    const lead = await until(async () => (await call(p.name.url, 'GET', '/api/v1/mesh/hello').catch(() => ({ body: null }))).body?.id, (id) => id === p.a.core.mesh.identity.id, 20_000);
    assert.equal(lead, p.a.core.mesh.identity.id, 'the name leads to the hub once it settles');
    assert.equal(await takes(p.a), true, 'and the hub it leads to takes changes');
    assert.equal(await takes(p.b), false);
    // What B took meanwhile is kept and named, and the list is only real changes.
    const said = problems(p.b.core).find((m) => /never reached the other node/.test(m)) ?? '';
    assert.ok(said.includes(phone), said);
    assert.doesNotMatch(said, /decision template|extension records/);
  } finally {
    await stop(p);
  }
});

test('R13 (p13): a replayed “unhealthy” answer is refused: every signed answer is bound to the request it answers, and a used request stays used across a restart', { timeout: 90_000 }, async () => {
  const p = await pair({ links: true, promotion: { windowS: 3600, probeMs: 150 } });
  const m = { unhealthy: null as string | null, replay: 0 };
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (req.url!.endsWith('/promotion/health') && m.replay > 0 && m.unhealthy) { m.replay--; res.writeHead(200, { 'content-type': 'application/json' }); res.end(m.unhealthy); return; }
    try {
      const r = await fetch(`${p.b.mesh}${req.url}`, { method: req.method, headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const text = await r.text();
      // Only one honest "unhealthy" gets through (more in a row would be a real roll-back).
      if (req.url!.endsWith('/promotion/health')) { try { if (JSON.parse(text).body?.ok === false) { if (m.unhealthy) { res.writeHead(502); res.end(); return; } m.unhealthy = text; } } catch { /* not json */ } }
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(text);
    } catch { res.writeHead(502); res.end(); }
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  p.toB!.point(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  try {
    await promote(p);
    await verifying(p);
    await sleep(600);
    // One unhealthy answer, honestly given (the name leads elsewhere for a moment), captured on the way.
    p.name.point(p.a.mesh);
    await until(() => m.unhealthy, (x) => !!x, 20_000);
    p.name.point(p.b.mesh);
    assert.ok(m.unhealthy, 'an unhealthy answer was captured');
    await until(() => p.a.core.mesh.promotions.record()!.probes.at(-1)?.result, (x) => x === 'ok', 10_000);
    const before = p.a.core.mesh.promotions.record()!.probes.length;
    m.replay = 5;
    await until(() => m.replay, (x) => x === 0, 10_000);
    await sleep(500);
    const after = p.a.core.mesh.promotions.record()!.probes.slice(before);
    assert.ok(!after.some((x) => x.result === 'unhealthy'), `a replayed answer counted: ${after.map((x) => x.result).join(',')}`);
    assert.equal(p.a.core.mesh.role.role(), 'standby');
    assert.equal(p.b.core.mesh.role.role(), 'hub');
    assert.ok(!p.b.core.mesh.role.held(), 'no stand-down was asked on replayed answers');
    // The binding itself: an answer is taken only for the request it names.
    const ans = JSON.parse(m.unhealthy!);
    assert.equal(answers('health', ans, p.b.core.mesh.identity.publicKey, ans.body.req), true);
    assert.equal(answers('health', ans, p.b.core.mesh.identity.publicKey, { nonce: 'another', time: ans.body.req.time }), false);
  } finally {
    proxy.closeAllConnections(); proxy.close();
    await stop(p);
  }
  // A request already taken is refused after a restart too.
  const q = await pair({});
  try {
    const body = signCall(q.a.core.mesh.identity, 'ready', q.standbyId, q.a.core.mesh.devices.state().epoch, {}, nowS());
    assert.equal((await call(q.b.mesh, 'POST', '/api/v1/mesh/promotion/ready', body)).status, 200);
    await q.b.closeCore();
    q.b.make().start();
    const again = await call(q.b.mesh, 'POST', '/api/v1/mesh/promotion/ready', body);
    assert.equal(again.status, 403);
    assert.match(again.body.error, /already used/);
  } finally {
    await stop(q);
  }
});

test('R14 (p14): a take-back while the stable name can’t be moved; once the links heal and it settles, the name leads to the hub', { timeout: 120_000 }, async () => {
  const p = await pair({ links: true, promotion: { windowS: 3600, probeMs: 150 } });
  try {
    await promote(p);
    await verifying(p);
    await sleep(600);
    p.toB!.point(null); p.toA!.point(null);
    p.name.stuck(true);
    await until(() => p.a.core.mesh.promotions.record()?.told ?? [], (t) => t.includes('unreachable'), 20_000);
    assert.equal((await p.a.api('POST', '/mesh/promotion/take-back', { confirm: true })).status, 200);
    await until(() => problems(p.a.core), (m) => m.some((x) => /couldn’t point .* at /.test(x)), 10_000);
    assert.ok(problems(p.a.core).some((x) => /couldn’t point .* at /.test(x)), 'a name that can’t be moved is a problem, said plainly');
    p.toB!.point(p.b.mesh); p.toA!.point(p.a.mesh); p.name.stuck(false);
    await p.b.core.mesh.role.fence();
    await until(() => p.b.core.mesh.role.role(), (r) => r === 'standby', 30_000);
    const lead = await until(async () => (await call(p.name.url, 'GET', '/api/v1/mesh/hello').catch(() => ({ body: null }))).body?.id, (id) => id === p.a.core.mesh.identity.id, 20_000);
    assert.equal(lead, p.a.core.mesh.identity.id);
  } finally {
    await stop(p);
  }
});

test('R15 (p15): a computer away through five planned promotions follows the chain of hand-overs; a chain with a forged link doesn’t', { timeout: 180_000 }, async () => {
  const p = await pair({ promotion: { windowS: 1, probeMs: 150 } });
  try {
    const r1 = p.a.core.mesh.devices.roster();
    const laptop = { pinned: rosterKeys(r1.roster), epoch: r1.roster.epoch, current: r1.roster.hub.public_key };
    const nodes = [p.a, p.b];
    let hub = 0;
    for (let i = 0; i < 5; i++) {
      const from = nodes[hub]!; const to = nodes[1 - hub]!;
      const path = `/backups-of-a-test/nova-backup-${randomUUID()}`;
      from.core.db.run(`INSERT INTO backup_run (id, seq, at, target, path, ok, bytes, files) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM backup_run), ?, '/backups-of-a-test', ?, 1, 0, 0)`, randomUUID(), new Date().toISOString(), path);
      from.core.db.run(`INSERT INTO backup_drill (id, at, backup_id, ok, checks) VALUES (?, ?, ?, 1, '[]')`, randomUUID(), new Date().toISOString(), path);
      await until(() => from.core.mesh.role.lag().rows, (x) => x === 0, 10_000);
      const s = await from.api('POST', '/mesh/promotions', { device_id: to.core.mesh.identity.id, confirm: true });
      assert.equal(s.status, 202, JSON.stringify(s.body));
      await until(() => from.core.mesh.promotions.record()?.state, (x) => x === 'verified', 30_000);
      hub = 1 - hub;
    }
    const live = nodes[hub]!;
    const st = live.core.mesh.devices.state();
    assert.equal(st.epoch, 6);
    const key = live.core.mesh.identity.publicKey;
    assert.equal(epochVerdict(6, key, { known: 1, current: laptop.current }).ok, false, 'the +3 rule alone strands it');
    const links = (await call(live.mesh, 'GET', '/api/v1/mesh/roster/chain')).body.links as SignedLink[];
    assert.ok(links.length >= 5, `the chain: ${links.length} links`);
    assert.equal(chainLeads(links, { key: laptop.current, epoch: 1 }, { key, epoch: 6 }), true);
    assert.equal(epochVerdict(6, key, { known: 1, current: laptop.current, chained: true }).ok, true);
    assert.equal(acceptRoster(live.core.mesh.devices.roster(), { pinned: laptop.pinned, epoch: 1, hubKey: key, currentHub: laptop.current, chained: true }).ok, true);
    // A forged first link (not signed by the hub the laptop knows) breaks the chain.
    const k = generateDeviceKeys();
    const forged = links.map((l, i) => (i === 0 ? { link: { ...l.link, by_key: k.ed25519.publicKey }, signature: signMessage(k.ed25519.privateKey, linkMessage({ ...l.link, by_key: k.ed25519.publicKey })) } : l));
    assert.equal(chainLeads(forged, { key: laptop.current, epoch: 1 }, { key, epoch: 6 }), false);
    assert.equal(epochVerdict(2 ** 31, key, { known: 1, current: laptop.current, chained: true }).ok, false, 'the ceiling holds even with a chain');
  } finally {
    await stop(p);
  }
});

test('minor: the name token never reaches the agent and is a secret to diagnostics; epochs are never made past the ceiling', async () => {
  const env = agentEnv({ NOVA_MESH_NAME_TOKEN: 'a-test-token-for-the-stable-name', PATH: '/bin' } as never) as Record<string, string>;
  assert.equal(env.NOVA_MESH_NAME_TOKEN, undefined);
  assert.equal(env.PATH, '/bin');
  const s = knownSecrets({ vault: { list: () => [], get: () => null, keyForStandby: () => null } } as never, { home: '/nonexistent', env: { NOVA_MESH_NAME_TOKEN: 'a-test-token-for-the-stable-name' } });
  assert.ok(s.secrets.includes('a-test-token-for-the-stable-name'));
  // A kept list names saved secrets by name, never by value.
  const said = summarize([{ tbl: 'vault', pk: 'row-1', op: 'upsert' }, { tbl: 'memory', pk: 'm-1', op: 'upsert' }], ['GITHUB_TOKEN']);
  assert.match(said, /1 saved secret \(GITHUB_TOKEN\)/);
  assert.match(said, /1 memory record \(m-1\)/);
  const p = await pair({});
  try {
    p.a.core.db.run('UPDATE mesh_state SET epoch = ? WHERE id = 1', 2 ** 31 - 2);
    assert.throws(() => p.a.core.mesh.role.raiseEpoch(2), /highest Nova uses/);
    // Nor does a promotion, planned or emergency, make one past it.
    await p.a.closeCore();
    p.b.core.db.run('UPDATE mesh_state SET epoch = ? WHERE id = 1', 2 ** 31 - 1);
    const pr = await p.b.api('POST', '/mesh/promote', { confirm: true });
    assert.equal(pr.status, 409, JSON.stringify(pr.body));
    assert.match(pr.body.error, /highest Nova uses/);
    assert.ok((await p.b.core.mesh.promotions.coldView()).reasons.some((x: string) => /highest Nova uses/.test(x)));
    void prober;
    void DatabaseSync;
    void (null as unknown as DeviceKeys);
    void signRoster;
  } finally {
    await stop(p);
  }
});
