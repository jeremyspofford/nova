// Hub promotion (M10g, docs/plans/M10g.md), with two cores in this process talking over real HTTP on
// loopback and a stand-in stable name (scripts/stand-ins/stable-name.js): the pre-checks refusing each
// reason, the planned hand-over end to end with every step a ledger task, the automatic roll-back at
// epoch + 2 when the new hub fails its checks (and the new hub stepping down to copy the old one),
// writes held during the transfer, the drain, the signed calls and the handover, and trust widened
// to every pinned candidate, safely. The two-process drill is tests/acceptance/m10g-drill.test.ts.
// Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCore, generateDeviceKeys, handoverMessage, loadIdentity, prechecks, signCall, signRoster, verifyCall, verifyHandover, writeRole,
  coldSheet, CONNECTOR_WORDS, LOST_WORDS, DEVICE_WORDS,
  type CandidateFacts, type Core, type Device, type DeviceKeys, type Handover, type HubFacts, type Listener, type RoleFile,
} from '../../src/core/index.ts';
import { acceptRoster, bundleKeys, checkProof, rosterKeys } from '../../src/device/trust.ts';
import { candidates } from '../../src/device/boot.ts';
import { Joiner, call, enroll, hub as plainHub } from './mesh-support.ts';
import { startStableName } from '../../scripts/stand-ins/stable-name.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(50); v = await read(); }
  return v;
}

const GIB = 1024 ** 3;

// A Nova core behind a console and a mesh listener on loopback. Its mesh info is shared by
// reference, as server.js does, so the address is filled in once the listener is bound.
async function node(o: { home?: string; version?: string; name: string; hardware?: () => { free_disk: number | null; memory: number } }) {
  const home = o.home ?? mkdtempSync(join(tmpdir(), 'nova-promo-'));
  const info = { publicUrl: o.name, transport: 'network' as const, address: null as string | null };
  let core: Core | null = null;
  const handler = (listener: Listener) => async (req: IncomingMessage, res: ServerResponse) => {
    if (!core) { res.writeHead(503); res.end(); return; }
    const url = new URL(req.url!, 'http://nova.local');
    const p = core.gate(req, res, url, listener);
    if (!p) return;
    if (await core.handle(req, res, url, p, listener)) return;
    res.writeHead(404);
    res.end();
  };
  const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
  const c = createServer(handler('console'));
  const m = createServer(handler('mesh'));
  const consoleBase = await listen(c);
  const meshBase = await listen(m);
  info.address = meshBase;
  const n = {
    home, info, console: consoleBase, mesh: meshBase,
    get core() { return core!; },
    make() {
      core = createCore({
        home, version: o.version ?? '0.1.0', trustedOrigin: () => true, mesh: info,
        promotion: { windowS: 2, probeMs: 150, catchupMs: 10_000, drainMs: 1000, commitMs: 2000, hardware: o.hardware ?? (() => ({ free_disk: 500 * GIB, memory: 16 * GIB })) },
      });
      return core;
    },
    api: (method: string, path: string, body?: unknown) => call(consoleBase, method, `/api/v1${path}`, body),
    async close() {
      for (const s of [c, m]) { s.closeAllConnections(); s.close(); }
      await core?.close();
    },
  };
  return n;
}

// A backup and a passed drill, as records only: the pre-check reads them (the real backup and drill
// run in the acceptance drill).
function backedUp(core: Core, at = new Date()) {
  const path = '/backups-of-a-test/nova-backup-000001';
  core.db.run(`INSERT INTO backup_run (id, seq, at, target, path, ok, bytes, files) VALUES ('nova-backup-000001', 1, ?, '/backups-of-a-test', ?, 1, 0, 0)`, at.toISOString(), path);
  core.db.run(`INSERT INTO backup_drill (id, at, backup_id, ok, checks) VALUES (?, ?, ?, 1, '[]')`, crypto.randomUUID(), at.toISOString(), path);
}

// A hub and its standby, enrolled through the front door with the standby's own identity keys, both
// with the stable name (a stand-in forwarder) as their public address, and the name's driver set.
async function pair(o: { standbyVersion?: string; standbyHardware?: () => { free_disk: number | null; memory: number } } = {}) {
  const name = await startStableName();
  process.env.NOVA_MESH_NAME_CONTROL = name.control;
  const a = await node({ name: name.url });
  const b = await node({ name: name.url, ...(o.standbyVersion ? { version: o.standbyVersion } : {}), ...(o.standbyHardware ? { hardware: o.standbyHardware } : {}) });
  name.point(a.mesh);
  const ac = a.make();
  ac.start();
  const id = loadIdentity(b.home);
  const keys = { ed25519: { publicKey: id.publicKey, privateKey: id.signer() }, x25519: { publicKey: id.x25519PublicKey, privateKey: null } } as unknown as DeviceKeys;
  const code = (await a.api('POST', '/mesh/pairings')).body.code;
  const dev = new Joiner(a.mesh, () => Math.floor(Date.now() / 1000), { name: 'Standby', platform: 'test', kind: 'standby', capabilities: [], address: b.mesh }, keys);
  assert.equal((await dev.join(code)).status, 201);
  assert.equal((await dev.reveal()).status, 200);
  assert.equal((await a.api('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
  const signed = (await dev.poll()).body.roster;
  const role: RoleFile = {
    version: 1, role: 'standby', device_id: dev.deviceId, epoch: signed.roster.epoch, roster: signed, address: b.mesh,
    hub: { id: signed.roster.hub.id, url: a.mesh, public_key: signed.roster.hub.public_key, x25519_public_key: signed.roster.hub.x25519_public_key, name: 'Hub' },
    raw: { joined_at: new Date().toISOString() },
  };
  writeRole(b.home, role);
  const bc = b.make();
  bc.start();
  return { name, a, b, standbyId: dev.deviceId };
}

const synced = (p: Awaited<ReturnType<typeof pair>>) => until(() => p.b.core.mesh.sync.cursor() >= p.a.core.mesh.sync.head() && p.a.core.mesh.role.lag().rows === 0, (x) => x);

async function stop(p: Awaited<ReturnType<typeof pair>>) {
  await p.b.close();
  await p.a.close();
  await p.name.close();
  delete process.env.NOVA_MESH_NAME_CONTROL;
}

function rowsOf(dbPath: string, sql: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return createHash('sha256').update(JSON.stringify(db.prepare(sql).all())).digest('hex'); } finally { db.close(); }
}

// ---- pure ---------------------------------------------------------------------------------------

const dev = (o: Partial<Device> = {}): Device => ({
  id: 'cand', name: 'Spare', platform: 'linux', kind: 'standby', role: 'standby', public_key: 'k', x25519_public_key: 'x', fingerprint: 'f', capabilities: [],
  purposes: ['hub-candidate'], trust: 'trusted', can_approve: false, address: 'http://127.0.0.1:9', created_at: '', approved_at: '', revoked_at: null, revoked_reason: null, last_seen: null, ...o,
});
const facts = (o: Partial<CandidateFacts> = {}): CandidateFacts => ({ id: 'cand', role: 'standby', epoch: 4, hub_id: 'hub', version: '1.0.0', schema: 20, free_disk: 100 * GIB, memory: 8 * GIB, cursor: 9, demoted: false, ...o });
const hubFacts = (o: Partial<HubFacts> = {}): HubFacts => ({ id: 'hub', epoch: 4, version: '1.0.0', schema: 20, home_bytes: GIB, backup: { at: new Date(Date.now() - 3600_000).toISOString(), path: '/b', drilled: true }, now: new Date(), ...o });

test('pre-checks: each reason refuses, in words, and a good candidate passes every one', () => {
  const ok = prechecks({ device: dev(), standbyId: 'cand', candidate: facts(), hub: hubFacts() });
  assert.deepEqual(ok.map((c) => c.name), ['role', 'follows', 'disk', 'memory', 'version', 'schema', 'backup']);
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  const refused = (r: ReturnType<typeof prechecks>, name: string, words: RegExp) => {
    const c = r.find((x) => x.name === name);
    assert.ok(c && !c.ok, `${name} refuses: ${JSON.stringify(r)}`);
    assert.match(c!.said, words);
  };
  refused(prechecks({ device: null, standbyId: 'cand', candidate: facts(), hub: hubFacts() }), 'role', /no such device/);
  refused(prechecks({ device: dev({ trust: 'revoked' }), standbyId: 'cand', candidate: facts(), hub: hubFacts() }), 'role', /revoked/);
  refused(prechecks({ device: dev({ id: 'hub' }), standbyId: 'cand', candidate: facts(), hub: hubFacts() }), 'role', /is the hub already/);
  refused(prechecks({ device: dev({ kind: 'phone', purposes: ['thin-client'] }), standbyId: 'cand', candidate: facts(), hub: hubFacts() }), 'role', /a phone: a screen onto Nova/);
  refused(prechecks({ device: dev({ kind: 'computer', purposes: ['compute'] }), standbyId: 'cand', candidate: facts(), hub: hubFacts() }), 'role', /isn’t a hub candidate/);
  refused(prechecks({ device: dev({ kind: 'computer' }), standbyId: 'other', candidate: facts(), hub: hubFacts() }), 'role', /not the standby.*Make it the standby first/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: null, unreachable: 'ECONNREFUSED', hub: hubFacts() }), 'reach', /couldn’t reach.*ECONNREFUSED/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts({ epoch: 3 }), hub: hubFacts() }), 'follows', /epoch 3/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts({ demoted: true }), hub: hubFacts() }), 'follows', /stepped down/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts({ free_disk: 2 * GIB }), hub: hubFacts() }), 'disk', /needs at least 3\.0 GB \(3 times/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts({ free_disk: null }), hub: hubFacts() }), 'disk', /couldn’t say/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts({ memory: GIB }), hub: hubFacts() }), 'memory', /needs at least 2\.0 GB/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts({ version: '0.9.0' }), hub: hubFacts() }), 'version', /release 0\.9\.0/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts({ schema: 19 }), hub: hubFacts() }), 'schema', /version 19/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts(), hub: hubFacts({ backup: null }) }), 'backup', /no backup/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts(), hub: hubFacts({ backup: { at: new Date(Date.now() - 25 * 3600_000).toISOString(), path: '/b', drilled: true } }) }), 'backup', /more than 24 hours/);
  refused(prechecks({ device: dev(), standbyId: 'cand', candidate: facts(), hub: hubFacts({ backup: { at: new Date().toISOString(), path: '/b', drilled: false } }) }), 'backup', /hasn’t passed a restore drill/);
});

test('trust widened to every pinned candidate, and only there: agents accept a candidate’s roster at a higher epoch, never an unpinned key, never a lower epoch; runtime bundles stay hub and standby', () => {
  const hubK = generateDeviceKeys();
  const standbyK = generateDeviceKeys();
  const candK = generateDeviceKeys();
  const strangerK = generateDeviceKeys();
  const m = (id: string, k: DeviceKeys, url: string) => ({ id, url, public_key: k.ed25519.publicKey, x25519_public_key: k.x25519.publicKey });
  const r = { epoch: 5, hub: m('hub', hubK, 'http://hub.test'), standby: m('sb', standbyK, 'http://sb.test'), candidates: [m('cand', candK, 'http://cand.test')], issued_at: 't' };
  const pinned = rosterKeys(r);
  assert.deepEqual(pinned, [hubK.ed25519.publicKey, standbyK.ed25519.publicKey, candK.ed25519.publicKey], 'hub, standby and every candidate (Decision 2)');
  assert.deepEqual(bundleKeys(r), [hubK.ed25519.publicKey, standbyK.ed25519.publicKey], 'a candidate never signs a runtime bundle before it is hub');
  assert.ok(candidates({ hub_url: 'http://name.test', join_url: 'http://name.test', roster: { roster: r, signature: '' } } as never).includes('http://cand.test'), 'agents look at candidates’ addresses too');
  // A cold promotion onto the candidate: a roster at a higher epoch, signed by its own key.
  const next = signRoster({ epoch: 6, hub: m('cand', candK, 'http://cand.test'), issued_at: 't' }, candK.ed25519.privateKey);
  assert.deepEqual(acceptRoster(next, { pinned, epoch: 5, hubKey: candK.ed25519.publicKey }), { ok: true });
  // Before M10g the same roster was refused: the candidate's key wasn't pinned.
  assert.equal(acceptRoster(next, { pinned: bundleKeys(r), epoch: 5, hubKey: candK.ed25519.publicKey }).ok, false);
  // A key that isn't pinned can't take the role, even with a valid signature.
  const forged = signRoster({ epoch: 9, hub: m('stranger', strangerK, 'http://x.test'), issued_at: 't' }, strangerK.ed25519.privateKey);
  assert.match((acceptRoster(forged, { pinned, epoch: 5 }) as { reason: string }).reason, /isn’t signed by a key this device pinned/);
  assert.match((checkProof({ id: 'stranger', role: 'hub', epoch: 9, public_key: strangerK.ed25519.publicKey, signature: 'x' }, 'c', pinned) as { reason: string }).reason, /isn’t one this device pinned/);
  // Never a lower epoch, even from a pinned key.
  const old = signRoster({ epoch: 4, hub: m('cand', candK, 'http://cand.test'), issued_at: 't' }, candK.ed25519.privateKey);
  assert.match((acceptRoster(old, { pinned, epoch: 5 }) as { reason: string }).reason, /lower than the one this device knows/);
});

test('the hub’s calls to the candidate and the handover are signed, fresh, used once, and carry no key', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-promo-id-'));
  const hubId = loadIdentity(home);
  const other = loadIdentity(mkdtempSync(join(tmpdir(), 'nova-promo-id-')));
  const nowS = Math.floor(Date.now() / 1000);
  const seen = new Map<string, number>();
  const body = signCall(hubId, 'transfer', 'cand', 3, { x: 1 }, nowS);
  const opts = { hubId: hubId.id, hubKey: hubId.publicKey, me: 'cand', nowS, seen };
  assert.equal(verifyCall('transfer', body, opts).ok, true);
  assert.match((verifyCall('transfer', body, opts) as { why: string }).why, /already used/, 'once only');
  assert.match((verifyCall('ready', signCall(hubId, 'transfer', 'cand', 3, {}, nowS), { ...opts, seen: new Map() }) as { why: string }).why, /isn’t signed by the hub’s key/, 'bound to its step');
  assert.match((verifyCall('transfer', signCall(other, 'transfer', 'cand', 3, {}, nowS), { ...opts, seen: new Map() }) as { why: string }).why, /isn’t from this node’s hub/);
  assert.match((verifyCall('transfer', signCall(hubId, 'transfer', 'cand', 3, {}, nowS - 600), { ...opts, seen: new Map() }) as { why: string }).why, /too far/);
  assert.match((verifyCall('transfer', signCall(hubId, 'transfer', 'someone-else', 3, {}, nowS), { ...opts, seen: new Map() }) as { why: string }).why, /isn’t for this node/);
  const tampered = signCall(hubId, 'transfer', 'cand', 3, { x: 1 }, nowS) as { auth: unknown; payload: Record<string, unknown> };
  tampered.payload.x = 2;
  assert.match((verifyCall('transfer', tampered, { ...opts, seen: new Map() }) as { why: string }).why, /isn’t signed/);
  const h: Handover = { v: 1, id: 'p', parent: null, from: hubId.id, to: 'cand', epoch: 4, last_seq: 99, from_address: 'http://127.0.0.1:1', name: 'http://name.test', at: 't' };
  const signed = { handover: h, signature: hubId.sign(handoverMessage(h)) };
  assert.equal(verifyHandover(signed, hubId.publicKey), true);
  assert.equal(verifyHandover({ ...signed, handover: { ...h, epoch: 9 } }, hubId.publicKey), false);
  assert.equal(verifyHandover(signed, other.publicKey), false);
  // Nothing in them is a private key.
  const file = JSON.parse((await import('node:fs')).readFileSync(hubId.file, 'utf8'));
  const text = JSON.stringify({ body, signed });
  for (const k of [file.ed25519.private, file.x25519.private]) assert.ok(!text.includes(k), 'no private key in a call or the handover');
});

test('the drain: nothing new starts but what is kept; running work gets the bound, then is handed over; work past its commit point is never cut', async () => {
  const p = await plainHub({ mesh: false });
  try {
    const ledger = p.core.ledger;
    let release: () => void = () => {};
    ledger.workers.set('slow', { id: 'slow', name: 'Slow', about: 'x', egress: 'none', evidence: [], health: () => ({ ok: true }), run: (_b: unknown, signal?: AbortSignal) => new Promise((_, fail) => { signal?.addEventListener('abort', () => fail(new Error('stopped'))); }) } as never);
    ledger.workers.set('committed', { id: 'committed', name: 'Committed', about: 'x', egress: 'none', evidence: [], health: () => ({ ok: true }), uncancellable: () => 'past its commit point', run: (b: { task_id: string }) => new Promise((r) => { release = () => r({ envelope: '1', task_id: b.task_id, status: 'failed', summary: 'finished after its commit point', evidence: [], artifacts: [], blockers: [], usage: { duration_ms: 0 }, follow_up_suggestions: [] }); }) } as never);
    const mk = (owner: string, title: string) => ledger.create({ title, owner, goal: 'x', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation', note: 'x' }], approval_tier: 0 });
    const slow = mk('slow', 'Slow work');
    await until(() => ledger.get(slow.id).state, (s) => s === 'active', 3000);
    const d = await ledger.drain({ boundMs: 200, commitMs: 200, keep: (t) => t.owner === 'mesh-promotion' });
    assert.deepEqual(d, { finished: [], handed: [slow.id], stuck: [] });
    await sleep(100);
    assert.equal(ledger.get(slow.id).state, 'active', 'handed over: still active, for the next hub’s recovery to requeue');
    const later = mk('slow', 'Queued during the drain');
    await sleep(200);
    assert.equal(ledger.get(later.id).state, 'queued', 'nothing new starts while it drains');
    ledger.resume();
    await until(() => ledger.get(later.id).state, (s) => s === 'active', 3000);
    ledger.cancel(later.id);
    const c = mk('committed', 'Past its commit point');
    await until(() => ledger.get(c.id).state, (s) => s === 'active', 3000);
    const d2 = await ledger.drain({ boundMs: 100, commitMs: 200, keep: () => false });
    assert.deepEqual(d2.stuck, [c.id], 'never cut: the hand-over stops instead');
    release();
    ledger.resume();
    assert.equal(await until(() => ledger.get(c.id).state, (s) => s !== 'active', 3000), 'failed', 'it ran to its end, uncut');
  } finally {
    await p.stop();
  }
});

test('fencing covers every pinned hub candidate: a candidate computer’s higher epoch, proven with its key, makes the hub step down', async () => {
  const h = await plainHub();
  const k = generateDeviceKeys();
  const { dev: pc } = await enroll(h, { kind: 'computer', name: 'Spare computer', platform: 'linux', capabilities: [] });
  void k;
  const s = createServer((_req, res) => {
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const roster = signRoster({ epoch: 7, hub: { id: pc.deviceId, url, public_key: pc.keys.ed25519.publicKey, x25519_public_key: pc.keys.x25519.publicKey }, issued_at: new Date().toISOString() }, pc.keys.ed25519.privateKey);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: pc.deviceId, role: 'hub', epoch: 7, name: 'Spare computer', roster }));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  try {
    h.core.db.run('UPDATE device SET address = ? WHERE id = ?', `http://127.0.0.1:${(s.address() as AddressInfo).port}`, pc.deviceId);
    assert.equal((await h.core.mesh.role.fence()).demoted, false, 'not a candidate: refused, as before M10g');
    h.core.db.run(`UPDATE device SET purposes = '["hub-candidate"]' WHERE id = ?`, pc.deviceId);
    assert.ok(h.core.mesh.devices.roster().roster.candidates?.some((c) => c.id === pc.deviceId), 'its key is pinned in the roster');
    assert.equal((await h.core.mesh.role.fence()).demoted, true, 'a pinned candidate is a possible successor (Decision 2)');
    assert.equal(h.core.mesh.role.role(), 'standby');
    assert.equal((await h.c('POST', '/memory', { kind: 'fact', content: 'x' })).status, 409, 'and it can’t act as hub');
  } finally {
    s.closeAllConnections();
    s.close();
    await h.stop();
  }
});

// ---- two cores --------------------------------------------------------------------------------------

test('pre-checks through the hub: a phone, a computer that is no candidate, a candidate that isn’t the standby, a hub with no fresh backup, a candidate short of disk and memory, another release', async () => {
  let hw = { free_disk: 500 * GIB as number | null, memory: 16 * GIB };
  const p = await pair({ standbyHardware: () => hw });
  try {
    await synced(p);
    const check = async (id: string) => (await p.a.api('POST', '/mesh/promotions/check', { device_id: id })).body;
    const phone = await enroll({ c: (m: string, path: string, b?: unknown) => p.a.api(m, path, b), mesh: p.a.mesh, nowS: () => Math.floor(Date.now() / 1000) } as never, { kind: 'phone' });
    const pc = await enroll({ c: (m: string, path: string, b?: unknown) => p.a.api(m, path, b), mesh: p.a.mesh, nowS: () => Math.floor(Date.now() / 1000) } as never, { kind: 'computer', name: 'Desk', platform: 'linux', capabilities: [] });
    let r = await check(phone.dev.deviceId);
    assert.equal(r.ok, false);
    assert.match(r.checks[0].said, /phone: a screen onto Nova, never a hub/);
    r = await check(pc.dev.deviceId);
    assert.match(r.checks[0].said, /isn’t a hub candidate/);
    p.a.core.db.run(`UPDATE device SET purposes = '["hub-candidate"]' WHERE id = ?`, pc.dev.deviceId);
    r = await check(pc.dev.deviceId);
    assert.match(r.checks[0].said, /not the standby/);
    r = await check(p.standbyId);
    assert.equal(r.checks.find((c: any) => c.name === 'backup').ok, false, 'no backup yet');
    backedUp(p.a.core);
    r = await check(p.standbyId);
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    hw = { free_disk: 1024, memory: GIB };
    r = await check(p.standbyId);
    assert.deepEqual(r.checks.filter((c: any) => !c.ok).map((c: any) => c.name), ['disk', 'memory']);
    // Refused at tier 3 too, every time, and recorded as the chain's first task.
    assert.equal((await p.a.api('POST', '/mesh/promotions', { device_id: p.standbyId })).status, 400, 'tier 3: confirm every time');
    const refused = await p.a.api('POST', '/mesh/promotions', { device_id: p.standbyId, confirm: true });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Nova didn’t promote “Standby”: Only/);
    const t = await until(() => p.a.core.ledger.list().find((x) => x.title.startsWith('Promotion pre-checks')), (x) => !!x && x.state === 'failed');
    assert.equal(t!.state, 'failed');
    assert.equal(p.a.core.mesh.role.role(), 'hub', 'nothing changed');
  } finally {
    await stop(p);
  }
  const q = await pair({ standbyVersion: '0.2.0' });
  try {
    await synced(q);
    backedUp(q.a.core);
    const r = (await q.a.api('POST', '/mesh/promotions/check', { device_id: q.standbyId })).body;
    assert.deepEqual(r.checks.filter((c: any) => !c.ok).map((c: any) => c.name), ['version']);
    assert.match(r.checks.find((c: any) => c.name === 'version').said, /release 0\.2\.0, and this hub 0\.1\.0/);
  } finally {
    await stop(q);
  }
});

test('a planned promotion end to end: catch-up, drain, writes held, transfer, the old hub a live standby, the window passed, every step a ledger task', async () => {
  const p = await pair();
  try {
    const mem = p.a.core.memory.remember({ kind: 'fact', content: 'The spare key is with the neighbour.', recorded_by: 'person' });
    await p.a.api('PUT', '/profile/user/name', { value: 'Sam' });
    backedUp(p.a.core);
    await synced(p);
    const sheet = (await p.a.api('POST', '/mesh/promotions/check', { device_id: p.standbyId })).body;
    assert.equal(sheet.ok, true, JSON.stringify(sheet.checks));
    assert.ok(sheet.sheet.some((f: any) => f.label === 'Why it asks' && /tier 3/.test(f.text)));
    // Writes held while the hub hands over: watched from outside, as a person would see it.
    const held: number[] = [];
    let watching = true;
    const watch = (async () => { while (watching) { const r = await p.a.api('PUT', '/profile/user/drill_probe', { value: String(Date.now()) }); held.push(r.status); if (r.status === 409 && /handing the hub over/.test(r.body.error)) break; await sleep(20); } })();
    const started = await p.a.api('POST', '/mesh/promotions', { device_id: p.standbyId, confirm: true });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await until(() => p.b.core.mesh.role.role(), (r) => r === 'hub');
    watching = false;
    await watch;
    assert.ok(held.includes(409), 'a change was refused while the hub handed over');
    assert.equal(p.b.core.mesh.role.role(), 'hub');
    assert.equal(p.b.core.mesh.devices.state().epoch, 2);
    await until(() => p.a.core.mesh.role.role(), (r) => r === 'standby');
    assert.equal(p.name.target(), p.b.mesh, 'the new hub pointed the stable name at itself');
    // No data lost: the memory and the profile, row for row.
    for (const sql of [`SELECT * FROM memory WHERE id = '${mem.id}'`, `SELECT * FROM profile WHERE section = 'user'`]) assert.equal(rowsOf(join(p.b.home, 'nova.db'), sql), rowsOf(join(p.a.home, 'nova.db'), sql));
    // The old hub is the new hub's live standby, and refuses changes.
    assert.equal((await p.a.api('POST', '/memory', { kind: 'fact', content: 'x' })).status, 409);
    const fresh = (await p.b.api('POST', '/memory', { kind: 'fact', content: 'Written on the new hub.' })).body;
    await until(() => p.a.core.db.get('SELECT 1 FROM memory WHERE id = ?', fresh.id), (x) => !!x);
    assert.ok(p.a.core.db.get('SELECT 1 FROM memory WHERE id = ?', fresh.id), 'the old hub copies the new one');
    // The window passes, and the new hub records it.
    const rec = await until(() => p.a.core.mesh.promotions.record(), (r) => r?.state === 'verified');
    assert.equal(rec!.state, 'verified', JSON.stringify(rec));
    const chain = await until(() => p.b.core.ledger.list().filter((t) => t.id === rec!.parent || t.parent_id === rec!.parent), (ts) => ts.length >= 6 && ts.every((t) => t.state === 'done'));
    assert.deepEqual(chain.map((t) => t.title).sort(), ['Checks of this node as the hub', 'Copied to the candidate', 'Hub handed over to this node', 'Promotion pre-checks for “Standby”', 'Running work finished or handed over', '“Hub” is the standby now'].sort(), JSON.stringify(chain.map((t) => [t.title, t.state, t.reason])));
    assert.ok(chain.every((t) => t.state === 'done'), JSON.stringify(chain.map((t) => [t.title, t.state, t.reason])));
    // Exactly one hub.
    assert.deepEqual([p.a.core.mesh.role.role(), p.b.core.mesh.role.role()], ['standby', 'hub']);
  } finally {
    await stop(p);
  }
});

test('the new hub fails its checks (the stable name didn’t move): the old hub takes the role back by itself at epoch + 2, and the new one steps down to copy it', async () => {
  const p = await pair();
  try {
    backedUp(p.a.core);
    await synced(p);
    p.name.stuck(true);
    // Both nodes asked to take a change at the same moment, all through: never both (a profile section
    // that doesn't exist, so the gate decides and nothing changes: 400 taken, 409 refused).
    const ticks = { n: 0, both: 0, a: 0, b: 0 };
    let probing = true;
    const takes = async (n: typeof p.a) => (await n.api('PUT', '/profile/drill/probe', { value: '1' }).catch(() => ({ status: 0 }))).status === 400;
    const prober = (async () => { while (probing) { const [x, y] = await Promise.all([takes(p.a), takes(p.b)]); ticks.n++; if (x) ticks.a++; if (y) ticks.b++; if (x && y) ticks.both++; await sleep(5); } })();
    const started = await p.a.api('POST', '/mesh/promotions', { device_id: p.standbyId, confirm: true });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await until(() => p.b.core.mesh.role.role(), (r) => r === 'hub');
    assert.equal(p.b.core.mesh.devices.state().epoch, 2);
    const rec = await until(() => p.a.core.mesh.promotions.record(), (r) => r?.state === 'rolled-back');
    assert.equal(rec!.state, 'rolled-back', JSON.stringify(rec));
    assert.equal(p.a.core.mesh.role.role(), 'hub');
    assert.equal(p.a.core.mesh.devices.state().epoch, 3, 'epoch + 2 from where it started: epochs only rise');
    assert.ok(p.a.core.log.problems().some((x) => /didn’t pass its checks after it became the hub/.test(x.message)), 'tier 1: Nova acts and reports');
    // The new hub sees it (asked to look now), steps down, and copies the old one afresh.
    await until(() => p.b.core.mesh.role.role(), (r) => r === 'standby');
    assert.deepEqual([p.a.core.mesh.role.role(), p.b.core.mesh.role.role()], ['hub', 'standby'], 'one hub');
    assert.equal(p.b.core.mesh.promotions.record()!.state, 'stepped-down');
    const m = (await p.a.api('POST', '/memory', { kind: 'fact', content: 'Written after the roll-back.' })).body;
    await until(() => p.b.core.db.get('SELECT 1 FROM memory WHERE id = ?', m.id), (x) => !!x);
    assert.ok(p.b.core.db.get('SELECT 1 FROM memory WHERE id = ?', m.id), 'a live copy of the hub again');
    const titles = await until(() => p.a.core.ledger.list().filter((t) => t.parent_id === rec!.parent).map((t) => `${t.title}: ${t.state}`), (ts) => ts.some((t) => t.startsWith('Promotion rolled back')) && ts.some((t) => /^Checks of/.test(t)));
    assert.ok(titles.includes('Promotion rolled back: this node is the hub again: done'), titles.join('\n'));
    assert.ok(titles.includes('Checks of “Standby” as the hub: failed'), titles.join('\n'));
    probing = false;
    await prober;
    assert.ok(ticks.a > 0 && ticks.b > 0, JSON.stringify(ticks));
    assert.equal(ticks.both, 0, `two hubs took a change at the same moment: ${JSON.stringify(ticks)}`);
    const said = p.a.core.ledger.list().find((t) => t.title === 'Checks of “Standby” as the hub')!.brief.inputs!.stood as string;
    assert.match(said, /stopped taking changes first/);
  } finally {
    await stop(p);
  }
});

test('the emergency sheet says the backup’s time, what was lost and that connectors sign in again; a hub or a live standby is sent elsewhere', async () => {
  const sheet = coldSheet({ backup: { path: '/b', id: 'nova-backup-000004', seq: 4, at: '2026-10-31T03:00:00.000Z', nova_version: '0.1.0', schema_version: 20, sealed: true }, epoch_now: 5, epoch_backup: 4, epoch_new: 6, pinned: true, lost: LOST_WORDS('2026-10-31T03:00:00.000Z'), connectors: CONNECTOR_WORDS, devices: DEVICE_WORDS }, { name: 'http://name.test' });
  const text = sheet.map((f) => `${f.label}: ${f.text}`).join('\n');
  assert.match(text, /Backup 4, made 2026-10-31T03:00:00\.000Z/);
  assert.match(text, /Everything written after 2026-10-31T03:00:00\.000Z/);
  assert.match(text, /Connectors need signing in again\..*never their key, and Nova keeps no copy of that key anywhere/);
  assert.match(text, /epoch 6/);
  assert.match(text, /tier 3/);
  const p = await pair();
  try {
    await synced(p);
    const onHub = (await p.a.api('GET', '/mesh/promotion/cold')).body;
    assert.equal(onHub.eligible, false);
    assert.ok(onHub.reasons.includes('This node is the hub.'));
    const onStandby = (await p.b.api('GET', '/mesh/promotion/cold')).body;
    assert.equal(onStandby.eligible, false);
    assert.ok(onStandby.reasons.some((r: string) => /live copy of the hub: use “Make this the hub”/.test(r)));
    assert.ok(onStandby.reasons.some((r: string) => /A hub answers at/.test(r)), 'a hub that answers is no case for a cold promotion');
    assert.equal((await p.b.api('POST', '/mesh/promotion/cold', {})).status, 400, 'tier 3 every time');
  } finally {
    await stop(p);
  }
});

test('writes held: every change refused with the reason, the mesh’s own calls still pass, hello says so', async () => {
  const h = await plainHub();
  try {
    const { dev } = await enroll(h, { kind: 'phone' });
    h.core.mesh.role.hold('Nova is handing the hub over to “Spare”, so changes wait a moment.');
    const r = await h.c('POST', '/memory', { kind: 'fact', content: 'x' });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /handing the hub over/);
    assert.equal((await call(h.mesh, 'GET', '/api/v1/mesh/hello')).body.held, true);
    assert.equal((await dev.session()).status, 200, 'a device still signs in');
    h.core.mesh.role.release();
    assert.equal((await h.c('POST', '/memory', { kind: 'fact', content: 'x' })).status, 201);
  } finally {
    await h.stop();
  }
});
