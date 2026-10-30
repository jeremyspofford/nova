// A factory reset and the mesh (M7 amendment §2.4): before the wipe the hub tells every paired
// device it can reach. The standby wipes its copy of the hub's data and reports back; a computer
// hears it in its next heartbeat; a phone with its stream open hears it there; each one's session
// ends. One that can't be reached is named beforehand and in the result. Two cores in this process
// over real HTTP on loopback, throwaway homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESET_MARKER, REPLICATED, createCore, finishReset, loadIdentity, writeRole, type Core, type DeviceKeys, type Listener, type RoleFile,
} from '../../src/core/index.ts';
import { Joiner, call, enroll, hub } from './mesh-support.ts';

const CONSOLE = { principal: { kind: 'console' as const }, listener: 'console' as const, address: '127.0.0.1' };
const WORDS = 'The gate code is four four two one';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

async function serve(core: Core) {
  const handler = (listener: Listener) => async (req: IncomingMessage, res: ServerResponse) => {
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
  await listen(m);
  return { console: consoleBase, close() { for (const s of [c, m]) { s.closeAllConnections(); s.close(); } } };
}

// A hub with a standby enrolled as the boot agent would (as in mesh-sync.test.ts).
async function pair() {
  const h = await hub({ core: { reset: { tellMs: 5000 } } });
  const home = mkdtempSync(join(tmpdir(), 'nova-standby-'));
  const id = loadIdentity(home);
  const keys = { ed25519: { publicKey: id.publicKey, privateKey: id.signer() }, x25519: { publicKey: id.x25519PublicKey, privateKey: null } } as unknown as DeviceKeys;
  const code = (await h.c('POST', '/mesh/pairings')).body.code;
  const dev = new Joiner(h.mesh, h.nowS, { name: 'Standby', platform: 'test', kind: 'standby', capabilities: [], address: 'http://127.0.0.1:1' }, keys);
  assert.equal((await dev.join(code)).status, 201);
  assert.equal((await dev.reveal()).status, 200);
  assert.equal((await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
  const signed = (await dev.poll()).body.roster;
  const role: RoleFile = {
    version: 1, role: 'standby', device_id: dev.deviceId, epoch: signed.roster.epoch, roster: signed,
    hub: { id: signed.roster.hub.id, url: h.mesh, public_key: signed.roster.hub.public_key, x25519_public_key: signed.roster.hub.x25519_public_key, name: 'Hub' },
    raw: { joined_at: '2026-10-29T10:00:00.000Z', pinned: [signed.roster.hub.public_key] },
  };
  writeRole(home, role);
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(h.clock.t), mesh: { publicUrl: 'http://standby.example:4321', transport: 'network' } });
  const s = await serve(core);
  h.core.db.run('UPDATE device SET address = ? WHERE id = ?', s.console, dev.deviceId);
  return { h, home, core, s, dev };
}

const rows = (dbPath: string) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(Object.keys(REPLICATED).map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
  } finally {
    db.close();
  }
};

// An event stream held open by a paired phone, collecting what arrives.
function stream(base: string, token: string) {
  const got: string[] = [];
  const req = request(`${base}/api/v1/events`, { headers: { authorization: `Bearer ${token}` } }, (res) => res.on('data', (c: Buffer) => got.push(c.toString('utf8'))));
  req.on('error', () => {});
  req.end();
  return { got, close: () => req.destroy() };
}

test('the hub tells its devices before the wipe: the standby wipes its copy and reports back, a computer hears it at its heartbeat, a phone on its stream; one that can’t be reached is named', async () => {
  const p = await pair();
  const { h, core } = p;
  let phoneStream: ReturnType<typeof stream> | null = null;
  let closed = false;
  try {
    h.core.memory.remember({ kind: 'fact', content: WORDS, recorded_by: 'person' });
    h.core.vault.put('provider/API_KEY', 'sk-placeholder-0123456789');
    core.start();
    await until(() => core.mesh.sync.cursor(), (c) => c >= h.core.mesh.sync.head());
    assert.equal(core.memory.list()[0]?.content, WORDS, 'the standby has a copy');
    assert.ok(existsSync(join(p.home, 'vault', 'secrets.json')), 'and of the vault');

    // A computer heard from just now, a phone with its stream open, and one with nothing open.
    const desk = await enroll(h, { name: 'Desk computer', kind: 'computer', capabilities: [] });
    const beat = () => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', {}, { authorization: `Bearer ${desk.token}` });
    assert.equal((await beat()).status, 200);
    const phone = await enroll(h, { name: 'Pocket phone' });
    phoneStream = stream(h.mesh, phone.token);
    await enroll(h, { name: 'Drawer tablet', kind: 'browser' });
    await until(() => h.core.mesh.access.isLive(phone.dev.deviceId), (v) => v);

    const pre = h.core.reset.preview();
    assert.deepEqual(pre.devices.can_tell.map((d) => d.name).sort(), ['Desk computer', 'Pocket phone', 'Standby']);
    assert.deepEqual(pre.devices.cant_tell.map((d) => d.name), ['Drawer tablet']);
    assert.match(pre.devices.cant_tell_said, /stays on that device/);

    const s = await h.core.reset.stage({ confirm: true, who: CONSOLE });
    // The computer's next heartbeat carries the news.
    const told = await until(() => beat(), (r) => !!r.body?.hub_reset);
    assert.match(told.body.hub_reset.said, /reset/i);
    const r = await s.done;
    // Nothing is wiped on the hub yet: telling comes first.
    assert.ok(existsSync(join(h.home, 'nova.db')));

    // The standby wiped its copy, then reported back.
    assert.deepEqual(Object.values(rows(join(p.home, 'nova.db'))).filter((n) => n > 0), [], 'no replicated row is left on the standby');
    assert.ok(!existsSync(join(p.home, 'vault', 'secrets.json')), 'nor the vault');
    assert.ok(!readFileSync(join(p.home, 'nova.db')).includes(Buffer.from(WORDS)), 'nor the words, in the database file');
    assert.ok(existsSync(join(p.home, RESET_MARKER)), 'the rest of it finishes at its next start');
    const standby = r.told.find((d) => d.name === 'Standby');
    assert.match(standby?.said ?? '', /wiped its copy/);
    assert.deepEqual(r.told.map((d) => d.name).sort(), ['Desk computer', 'Pocket phone', 'Standby']);
    assert.deepEqual(r.not_told.map((d) => d.name), ['Drawer tablet']);
    assert.ok(phoneStream.got.join('').includes('event: reset'), 'the phone heard it on its stream');
    // Told, and asked to forget what it kept; Nova doesn't claim it did.
    assert.match(r.told.find((d) => d.name === 'Pocket phone')!.said, /asked to forget .* Nova can’t confirm it did/);
    // Every session has ended.
    assert.equal((await beat()).status, 401);
    // The marker carries who was told into the report the new home keeps.
    const marker = JSON.parse(readFileSync(join(h.home, RESET_MARKER), 'utf8'));
    assert.deepEqual(marker.devices.not_told.map((d: { name: string }) => d.name), ['Drawer tablet']);

    // The standby's next start finishes its own reset: it no longer claims a hub that is gone.
    p.s.close();
    await core.close();
    closed = true;
    finishReset(p.home, { vault: { mode: 'file', keychain: null } });
    assert.ok(!existsSync(join(p.home, 'mesh', 'role.json')));
    assert.ok(!existsSync(join(p.home, 'nova.db')));
  } finally {
    phoneStream?.close();
    if (!closed) { p.s.close(); await core.close(); }
    await h.stop();
  }
});
