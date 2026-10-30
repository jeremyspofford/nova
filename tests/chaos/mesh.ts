// A hub and a standby in this process (M4c's way), with the standby reaching the hub through a
// TCP proxy the test controls: it can cut the link (a partition) or slow it (a slow link). The
// clock is the test's. Everything listens on loopback; nothing here reaches anywhere else.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcp, connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, loadIdentity, writeRole, type Core, type DeviceKeys, type Listener, type RoleFile } from '../../src/core/index.ts';
import { Joiner, call, hub } from '../core/mesh-support.ts';

// A proxy to `target` (host:port). cut(): every open connection dropped and new ones refused;
// heal(): open again; delayMs: each chunk held that long, each way.
export async function proxy(target: () => number) {
  const open = new Set<Socket>();
  const st = { cut: false, delayMs: 0 };
  const server = createTcp((c) => {
    if (st.cut) { c.destroy(); return; }
    const u = connect(target(), '127.0.0.1');
    open.add(c); open.add(u);
    const pipe = (from: Socket, to: Socket) => from.on('data', (d) => {
      if (!st.delayMs) { to.write(d); return; }
      from.pause();
      setTimeout(() => { if (!to.destroyed) to.write(d); from.resume(); }, st.delayMs);
    });
    pipe(c, u); pipe(u, c);
    const end = () => { c.destroy(); u.destroy(); open.delete(c); open.delete(u); };
    c.on('close', end); u.on('close', end); c.on('error', end); u.on('error', end);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cut() { st.cut = true; for (const s of open) s.destroy(); open.clear(); },
    heal() { st.cut = false; },
    slow(ms: number) { st.delayMs = ms; },
    close() { st.cut = true; for (const s of open) s.destroy(); server.close(); },
  };
}

export async function serve(core: Core) {
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

// A hub with a standby enrolled the way the plan says; the standby's role file names the proxy
// as the hub's address.
export async function pair(o: { failoverAfterS?: number } = {}) {
  const h = await hub();
  const link = await proxy(() => Number(new URL(h.mesh).port));
  const home = mkdtempSync(join(tmpdir(), 'nova-chaos-standby-'));
  const id = loadIdentity(home);
  const keys = { ed25519: { publicKey: id.publicKey, privateKey: id.signer() }, x25519: { publicKey: id.x25519PublicKey, privateKey: null } } as unknown as DeviceKeys;
  if (o.failoverAfterS) assert.equal((await h.c('PUT', '/profile/mesh/auto_failover_after_s', { value: o.failoverAfterS, confirm: true })).status, 200);
  const code = (await h.c('POST', '/mesh/pairings')).body.code;
  const dev = new Joiner(h.mesh, h.nowS, { name: 'Standby', platform: 'test', kind: 'standby', capabilities: [], address: 'http://127.0.0.1:1' }, keys);
  assert.equal((await dev.join(code)).status, 201);
  assert.equal((await dev.reveal()).status, 200);
  assert.equal((await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
  const signed = (await dev.poll()).body.roster;
  const role: RoleFile = {
    version: 1, role: 'standby', device_id: dev.deviceId, epoch: signed.roster.epoch, roster: signed,
    hub: { id: signed.roster.hub.id, url: link.url, public_key: signed.roster.hub.public_key, x25519_public_key: signed.roster.hub.x25519_public_key, name: 'Hub' },
    raw: { joined_at: '2026-10-29T10:00:00.000Z', pinned: [signed.roster.hub.public_key] },
  };
  writeRole(home, role);
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, now: () => new Date(h.clock.t), mesh: { publicUrl: 'http://standby.example:4321', transport: 'network' } });
  const s = await serve(core);
  h.core.db.run('UPDATE device SET address = ? WHERE id = ?', s.console, dev.deviceId);
  return {
    h, link, home, core, s,
    api: (method: string, path: string, body?: unknown) => call(s.console, method, `/api/v1${path}`, body),
    async stop() { link.close(); s.close(); await core.close(); await h.stop().catch(() => {}); },
  };
}
