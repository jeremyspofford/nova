// Helpers for the mesh tests: a hub (the core behind a console listener and a mesh listener, both
// on loopback, with a clock the test moves), and a device that enrolls the way the plan says.
// Neutral placeholders only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createCore, generateDeviceKeys, newPairingNonce, pairingCommitment, pairingConfirmationV2, revealMessage, sessionMessage, signMessage,
  statusMessage, x25519Statement, type Core, type CoreOptions, type DeviceKeys, type Listener,
} from '../../src/core/index.ts';

export const PUBLIC_URL = 'http://hub.example:4320';

export interface Res { status: number; body: any; headers: Headers }

export async function call(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-nova': '1' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

// The core with both listeners, like src/server.js but without Era 2: anything the core doesn't
// answer is "static".
export async function hub(o: { mesh?: boolean; core?: Partial<CoreOptions> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-mesh-'));
  const clock = { t: Date.parse('2026-10-29T10:00:00.000Z') };
  const core: Core = createCore({
    home, version: '0.1.0', trustedOrigin: (h) => /^(127\.0\.0\.1|localhost|hub\.example)(:\d+)?$/.test(h), now: () => new Date(clock.t),
    mesh: o.mesh === false ? null : { publicUrl: PUBLIC_URL, transport: 'network' },
    ...o.core,
  });
  const handler = (listener: Listener) => async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://nova.local');
    const p = core.gate(req, res, url, listener);
    if (!p) return;
    if (await core.handle(req, res, url, p, listener)) return;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('static');
  };
  const listen = async (s: Server) => { await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };
  const consoleServer = createServer(handler('console'));
  const meshServer = createServer(handler('mesh'));
  const consoleBase = await listen(consoleServer);
  const meshBase = await listen(meshServer);
  return {
    home, core, clock, console: consoleBase, mesh: meshBase,
    nowS: () => Math.floor(clock.t / 1000),
    tick: (ms: number) => { clock.t += ms; },
    // The console, at the hub's own screen.
    c: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => call(consoleBase, method, `/api/v1${path}`, body, headers),
    async stop() {
      consoleServer.closeAllConnections();
      meshServer.closeAllConnections();
      consoleServer.close();
      meshServer.close();
      await core.close();
    },
  };
}

// A device that joins: its own keys, a nonce it commits to, and the signed calls.
export class Joiner {
  keys: DeviceKeys;
  nonce: string;
  base: string;
  claims: Record<string, unknown>;
  now: () => number;
  requestId = '';
  pairingId = '';
  hubNonce = '';
  hubFingerprint = '';
  code = '';
  deviceId = '';
  #last = 0;

  constructor(base: string, now: () => number, claims: Record<string, unknown> = {}, keys: DeviceKeys = generateDeviceKeys()) {
    this.base = base;
    this.now = now;
    this.keys = keys;
    this.nonce = newPairingNonce();
    this.claims = { name: 'Test phone', platform: 'test', kind: 'phone', capabilities: ['notify'], ...claims };
  }

  // A signed time newer than the last one this device used.
  time(): number {
    this.#last = Math.max(this.now(), this.#last + 1);
    return this.#last;
  }

  joinBody(code: string, over: Record<string, unknown> = {}) {
    return {
      code, public_key: this.keys.ed25519.publicKey, x25519_public_key: this.keys.x25519.publicKey,
      x25519_sig: signMessage(this.keys.ed25519.privateKey, x25519Statement(this.keys.x25519.publicKey)),
      claims: this.claims, commitment: pairingCommitment(this.keys.ed25519.publicKey, this.nonce), ...over,
    };
  }

  async join(code: string, over: Record<string, unknown> = {}): Promise<Res> {
    this.code = code;
    const r = await call(this.base, 'POST', '/api/v1/mesh/join', this.joinBody(code, over));
    if (r.status === 201) Object.assign(this, { requestId: r.body.request_id, pairingId: r.body.pairing_id, hubNonce: r.body.hub_nonce, hubFingerprint: r.body.hub_fingerprint });
    return r;
  }

  revealBody(time = this.time(), key = this.keys.ed25519.privateKey) {
    return { device_nonce: this.nonce, time, signature: signMessage(key, revealMessage(this.requestId, time)) };
  }

  reveal(body = this.revealBody()): Promise<Res> {
    return call(this.base, 'POST', `/api/v1/mesh/join/${this.requestId}/reveal`, body);
  }

  // The digits this device computes itself.
  digits(): string {
    return pairingConfirmationV2({ hubFingerprint: this.hubFingerprint, pairingId: this.pairingId, publicKey: this.keys.ed25519.publicKey, code: this.code, deviceNonce: this.nonce, hubNonce: this.hubNonce });
  }

  async poll(time = this.time()): Promise<Res> {
    const sig = signMessage(this.keys.ed25519.privateKey, statusMessage(this.requestId, time));
    const r = await call(this.base, 'GET', `/api/v1/mesh/join/${this.requestId}?time=${time}&signature=${sig}`);
    if (r.body?.device_id) this.deviceId = r.body.device_id;
    return r;
  }

  session(o: { cookie?: boolean; time?: number; base?: string } = {}): Promise<Res> {
    const time = o.time ?? this.time();
    return call(o.base ?? this.base, 'POST', '/api/v1/mesh/session', { device_id: this.deviceId, time, signature: signMessage(this.keys.ed25519.privateKey, sessionMessage(this.deviceId, time)), ...(o.cookie ? { cookie: true } : {}) });
  }
}

// The whole front door, approved at the console: returns the joined device and its bearer token.
export async function enroll(h: Awaited<ReturnType<typeof hub>>, claims: Record<string, unknown> = {}): Promise<{ dev: Joiner; token: string }> {
  const code = (await h.c('POST', '/mesh/pairings')).body.code;
  const dev = new Joiner(h.mesh, h.nowS, claims);
  const j = await dev.join(code);
  if (j.status !== 201) throw new Error(`join: ${JSON.stringify(j.body)}`);
  const r = await dev.reveal();
  if (r.status !== 200) throw new Error(`reveal: ${JSON.stringify(r.body)}`);
  const a = await h.c('POST', `/mesh/requests/${dev.requestId}/approve`, { confirm: true });
  if (a.status !== 200) throw new Error(`approve: ${JSON.stringify(a.body)}`);
  await dev.poll();
  const s = await dev.session();
  if (s.status !== 200) throw new Error(`session: ${JSON.stringify(s.body)}`);
  return { dev, token: s.body.token };
}
