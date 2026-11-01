// Shared by the review tests of M10g (tests/acceptance/m10g-review*.test.ts): two cores in this
// process over real HTTP on loopback, with loopback forwarders between them (the stable-name stand-in
// used as a plain link) so a link can be cut one way. Temp homes only.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, loadIdentity, writeRole, type Core, type DeviceKeys, type Listener } from '../../src/core/index.ts';
import { Joiner, call } from '../core/mesh-support.ts';
import { startStableName } from '../../scripts/stand-ins/stable-name.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) { await sleep(50); v = await read(); }
  return v;
}
export const GIB = 1024 ** 3;
export const TOKEN = 'a-test-token-for-the-stable-name';
export const dirs: string[] = [];

export async function node(o: { name: string; promotion?: Record<string, unknown>; skew?: { ms: number } }) {
  const home = mkdtempSync(join(tmpdir(), 'nova-review-'));
  dirs.push(home);
  const info = { publicUrl: o.name, transport: 'network' as const, address: null as string | null };
  let c0: Core | null = null;
  const handler = (listener: Listener) => async (req: IncomingMessage, res: ServerResponse) => {
    if (!c0) { res.writeHead(503); res.end(); return; }
    const url = new URL(req.url!, 'http://nova.local');
    const p = c0.gate(req, res, url, listener);
    if (!p) return;
    if (await c0.handle(req, res, url, p, listener)) return;
    res.writeHead(404); res.end();
  };
  const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
  const c = createServer(handler('console'));
  const m = createServer(handler('mesh'));
  const consoleBase = await listen(c);
  const meshBase = await listen(m);
  info.address = meshBase;
  const skew = o.skew ?? { ms: 0 };
  const n = {
    home, info, console: consoleBase, mesh: meshBase, skew,
    get core() { return c0!; },
    make() {
      c0 = createCore({ home, version: '0.1.0', trustedOrigin: () => true, mesh: info, now: () => new Date(Date.now() + skew.ms),
        promotion: { windowS: 2, probeMs: 150, catchupMs: 10_000, drainMs: 1000, commitMs: 2000, hardware: () => ({ free_disk: 500 * GIB, memory: 16 * GIB }), ...(o.promotion ?? {}) } });
      return c0;
    },
    api: (method: string, path: string, body?: unknown) => call(consoleBase, method, `/api/v1${path}`, body),
    async closeCore() { const x = c0; c0 = null; await x?.close().catch(() => {}); },
    async close() { for (const s of [c, m]) { s.closeAllConnections(); s.close(); } await c0?.close().catch(() => {}); },
  };
  return n;
}

export function backedUp(c: Core) {
  const at = new Date().toISOString();
  const path = '/backups-of-a-test/nova-backup-000001';
  c.db.run(`INSERT INTO backup_run (id, seq, at, target, path, ok, bytes, files) VALUES ('nova-backup-000001', 1, ?, '/backups-of-a-test', ?, 1, 0, 0)`, at, path);
  c.db.run(`INSERT INTO backup_drill (id, at, backup_id, ok, checks) VALUES (?, ?, ?, 1, '[]')`, crypto.randomUUID(), at, path);
}

// A hub (a) and its standby (b). With `links`, each node reaches the other through a forwarder the
// test can cut: a's view of b's address, and b's view of a's (a's own address, its role file's hub).
export async function pair(o: { promotion?: Record<string, unknown>; links?: boolean; skewA?: { ms: number } } = {}) {
  const name = await startStableName({ token: TOKEN });
  process.env.NOVA_MESH_NAME_CONTROL = name.control;
  process.env.NOVA_MESH_NAME_TOKEN = TOKEN;
  const a = await node({ name: name.url, ...(o.promotion ? { promotion: o.promotion } : {}), ...(o.skewA ? { skew: o.skewA } : {}) });
  const b = await node({ name: name.url, ...(o.promotion ? { promotion: o.promotion } : {}) });
  const toA = o.links ? await startStableName({ target: a.mesh }) : null;
  const toB = o.links ? await startStableName({ target: b.mesh }) : null;
  if (toA) a.info.address = toA.url;
  name.point(a.mesh);
  a.make().start();
  const id = loadIdentity(b.home);
  const keys = { ed25519: { publicKey: id.publicKey, privateKey: id.signer() }, x25519: { publicKey: id.x25519PublicKey, privateKey: null } } as unknown as DeviceKeys;
  const code = (await a.api('POST', '/mesh/pairings')).body.code;
  const dev = new Joiner(a.mesh, () => Math.floor(Date.now() / 1000), { name: 'Standby', platform: 'test', kind: 'standby', capabilities: [], address: toB ? toB.url : b.mesh }, keys);
  assert.equal((await dev.join(code)).status, 201);
  assert.equal((await dev.reveal()).status, 200);
  assert.equal((await a.api('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true })).status, 200);
  const signed = (await dev.poll()).body.roster;
  writeRole(b.home, {
    version: 1, role: 'standby', device_id: dev.deviceId, epoch: signed.roster.epoch, roster: signed, address: b.mesh,
    hub: { id: signed.roster.hub.id, url: toA ? toA.url : a.mesh, public_key: signed.roster.hub.public_key, x25519_public_key: signed.roster.hub.x25519_public_key, name: 'Hub' },
    raw: { joined_at: new Date().toISOString() },
  });
  b.make().start();
  const p = { name, a, b, standbyId: dev.deviceId, toA, toB };
  await until(() => p.b.core.mesh.sync.cursor() >= p.a.core.mesh.sync.head() && p.a.core.mesh.role.lag().rows === 0, (x) => x);
  backedUp(p.a.core);
  return p;
}

export async function stop(p: Awaited<ReturnType<typeof pair>>) {
  await p.b.close();
  await p.a.close();
  for (const l of [p.name, p.toA, p.toB]) await l?.close().catch(() => {});
  delete process.env.NOVA_MESH_NAME_CONTROL;
  delete process.env.NOVA_MESH_NAME_TOKEN;
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* left */ } }
}

// Whether a node's write gate takes a change (a profile section that doesn't exist: nothing changes).
export const takes = async (n: { api: (m: string, p: string, b?: unknown) => Promise<{ status: number }> }) => (await n.api('PUT', '/profile/drill/probe', { value: '1' }).catch(() => ({ status: 0 }))).status === 400;
export function prober(p: Awaited<ReturnType<typeof pair>>) {
  const t = { n: 0, both: 0, a: 0, b: 0 };
  let on = true;
  const run = (async () => { while (on) { const [x, y] = await Promise.all([takes(p.a), takes(p.b)]); t.n++; if (x) t.a++; if (y) t.b++; if (x && y) t.both++; await sleep(20); } })();
  return { t, stop: async () => { on = false; await run; return t; } };
}
export const problems = (c: Core) => c.log.problems().map((x) => x.message);
export const promote = (p: Awaited<ReturnType<typeof pair>>) => p.a.api('POST', '/mesh/promotions', { device_id: p.standbyId, confirm: true });
export const verifying = (p: Awaited<ReturnType<typeof pair>>) => until(() => p.a.core.mesh.promotions.record()?.state, (s) => s === 'verifying', 30_000);
