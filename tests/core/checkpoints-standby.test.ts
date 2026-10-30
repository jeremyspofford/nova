// A restore on a hub with a standby (M7 amendment §1): the hub's epoch goes up past both now and
// the checkpoint, and the standby, seeing its own hub at a higher epoch, copies it afresh: what the
// restore undid is gone from the standby too, and fencing never turns against the restored hub.
// Two cores in this process over real HTTP, the hub started again on the same ports as the server
// would. Neutral placeholders; throwaway homes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, loadIdentity, stagedPending, writeRole, type Core, type DeviceKeys, type Listener, type RoleFile } from '../../src/core/index.ts';
import { Joiner, PUBLIC_URL, call } from './mesh-support.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(25); v = await read(); }
  return v;
}

// A core behind a console and a mesh listener whose core can be started again on the same ports.
async function node(home: string, clock: { t: number }, publicUrl: string) {
  const make = () => createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(clock.t), mesh: { publicUrl, transport: 'network' } });
  let core: Core = make();
  const handler = (listener: Listener) => async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://nova.local');
    const p = core.gate(req, res, url, listener);
    if (!p) return;
    if (await core.handle(req, res, url, p, listener)) return;
    res.writeHead(404);
    res.end();
  };
  const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
  const servers = [createServer(handler('console')), createServer(handler('mesh'))];
  const [consoleBase, meshBase] = [await listen(servers[0]!), await listen(servers[1]!)];
  return {
    home, get core() { return core; }, console: consoleBase!, mesh: meshBase!,
    c: (method: string, path: string, body?: unknown) => call(consoleBase!, method, `/api/v1${path}`, body),
    async restart() { await core.close(); core = make(); core.start(); },
    async stop() { for (const s of servers) { s.closeAllConnections(); s.close(); } await core.close(); },
  };
}

test('a restore on the hub: the epoch goes up, and the standby copies the hub afresh', { timeout: 60_000 }, async () => {
  const clock = { t: Date.parse('2026-10-29T10:00:00.000Z') };
  const h = await node(mkdtempSync(join(tmpdir(), 'nova-cp-hub-')), clock, PUBLIC_URL);
  h.core.start();
  const home = mkdtempSync(join(tmpdir(), 'nova-cp-standby-'));
  const id = loadIdentity(home);
  const keys = { ed25519: { publicKey: id.publicKey, privateKey: id.signer() }, x25519: { publicKey: id.x25519PublicKey, privateKey: null } } as unknown as DeviceKeys;
  const code = (await h.c('POST', '/mesh/pairings')).body.code;
  const dev = new Joiner(h.mesh, () => Math.floor(clock.t / 1000), { name: 'Standby', platform: 'test', kind: 'standby', capabilities: [], address: 'http://127.0.0.1:1' }, keys);
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
  const s = await node(home, clock, 'http://standby.example:4321');
  try {
    h.core.db.run('UPDATE device SET address = ? WHERE id = ?', s.console, dev.deviceId);
    s.core.start();
    const synced = () => until(() => s.core.mesh.sync.cursor(), (c) => c >= h.core.mesh.sync.head());
    const standbyMemories = () => s.core.db.all<{ content: string }>('SELECT content FROM memory ORDER BY content').map((r) => r.content);

    h.core.memory.remember({ kind: 'fact', content: 'Kept through the restore.', recorded_by: 'person' });
    await synced();
    const cp = (await h.c('POST', '/resilience/checkpoints', { name: 'With the standby' })).body;
    h.core.memory.remember({ kind: 'fact', content: 'Undone by the restore.', recorded_by: 'person' });
    await synced();
    assert.deepEqual(standbyMemories(), ['Kept through the restore.', 'Undone by the restore.']);
    const epochBefore = h.core.mesh.devices.state().epoch;

    h.core.restarter.attach(async () => ({}), { exec: () => {} });
    const r = await h.c('POST', `/resilience/checkpoints/${cp.id}/restore`, { confirm: true });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.ok(stagedPending(h.home));
    await h.restart();

    const epoch = h.core.mesh.devices.state().epoch;
    assert.equal(epoch, epochBefore + 1);
    const task = await until(() => h.core.ledger.list({ limit: 20 }).find((t) => t.owner === 'checkpoints'), (t) => !!t);
    assert.equal((task!.brief.inputs as { carried: { standby_resync: boolean } }).carried.standby_resync, true, 'the standby is kept, and told to copy afresh');
    assert.equal(h.core.mesh.devices.state().standby_id, dev.deviceId);
    const copied = await until(standbyMemories, (m) => m.length === 1);
    assert.deepEqual(copied, ['Kept through the restore.'], 'what the restore undid is gone from the standby too');
    assert.equal(await until(() => s.core.mesh.devices.state().epoch, (e) => e === epoch), epoch, 'the standby knows the new epoch');
    // Fencing: the restored hub stays the hub; nobody claims a higher epoch.
    const fenced = await h.core.mesh.role.fence();
    assert.equal(fenced.demoted, false);
    // And it keeps up afterwards.
    h.core.memory.remember({ kind: 'fact', content: 'Written after the restore.', recorded_by: 'person' });
    assert.deepEqual(await until(standbyMemories, (m) => m.length === 2), ['Kept through the restore.', 'Written after the restore.']);
  } finally {
    await s.stop();
    await h.stop();
  }
});
