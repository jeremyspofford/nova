// A stand-in mesh node for the device agent's tests: it answers exactly the routes the boot and
// runtime agents use (the challenge, sessions, the roster, the runtime bundle, heartbeats, reports,
// the inbox), with keys and rosters the test makes and signs itself. It is how the device's side
// of failover and the epoch rules is tested before promotion exists (M4c). Loopback only.
// Neutral placeholders only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  exportDeviceKeys, generateDeviceKeys, helloProofMessage, runtimeManifest, runtimeManifestMessage, sessionMessage, signMessage, signRoster,
  verifyDeviceSignature, type DeviceKeys, type Roster, type SignedRoster,
} from '../../src/core/index.ts';
import { rosterKeys } from '../../src/device/trust.ts';
import { paths, type DeviceFile } from '../../src/device/boot.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!done(v) && Date.now() < end) {
    await sleep(25);
    v = await read();
  }
  return v;
}

export interface Bundle { manifest: ReturnType<typeof runtimeManifest>; signature: string; signer: string; files: Record<string, string> }

// A bundle of `files`, signed by `keys` (pinned or not: the test decides).
export function bundle(files: Record<string, string>, keys: DeviceKeys, version?: string): Bundle {
  const raw = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  const draft = runtimeManifest('', raw);
  const manifest = { ...draft, version: version ?? `test+${draft.sha256.slice(0, 12)}` };
  return { manifest, signature: signMessage(keys.ed25519.privateKey, runtimeManifestMessage(manifest)), signer: keys.ed25519.publicKey, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
}

export interface Received { key: string; kind: string; body: Record<string, unknown> }

export class FakeNode {
  keys = generateDeviceKeys();
  id = crypto.randomUUID();
  role: 'hub' | 'standby' = 'hub';
  epoch = 1;
  roster: SignedRoster | null = null;
  bundle: Bundle | null = null;
  devices = new Map<string, string>();
  revoked = new Set<string>();
  sessions = new Map<string, string>();
  inbox = new Map<string, { key: string; kind: string; status: string; ref: string }>();
  received: Received[] = [];
  heartbeats: Array<Record<string, unknown>> = [];
  reports: Array<Record<string, unknown>> = [];
  sessionsStarted = 0;
  url = '';
  #server: Server | null = null;
  #port = 0;

  constructor(o: { port?: number } = {}) {
    this.#port = o.port ?? 0;
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server!.listen(this.#port, '127.0.0.1', r));
    this.#port = (this.#server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.#port}`;
    return this;
  }

  // Down: nothing answers at its address (the same port comes back on start()).
  async stop(): Promise<void> {
    const s = this.#server;
    this.#server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }

  member() {
    return { id: this.id, url: this.url, public_key: this.keys.ed25519.publicKey, x25519_public_key: this.keys.x25519.publicKey };
  }

  // Signs a roster with this node's key.
  sign(r: Omit<Roster, 'issued_at'>): SignedRoster {
    return signRoster({ ...r, issued_at: new Date().toISOString() }, this.keys.ed25519.privateKey);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://node.local');
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const device = this.sessions.get(token);
    const path = url.pathname.replace('/api/v1', '');
    if (req.method !== 'GET' && req.headers['x-nova'] !== '1') return send(403, { error: 'Missing X-Nova header.' });
    if (path === '/mesh/hello/proof') {
      const challenge = url.searchParams.get('challenge') ?? '';
      const claim = { id: this.id, role: this.role, epoch: this.epoch, public_key: this.keys.ed25519.publicKey };
      return send(200, { ...claim, signature: signMessage(this.keys.ed25519.privateKey, helloProofMessage(challenge, claim)) });
    }
    if (path === '/mesh/session' && req.method === 'POST') {
      this.sessionsStarted++;
      const key = this.devices.get(body.device_id);
      if (!key || this.revoked.has(body.device_id) || !verifyDeviceSignature(key, sessionMessage(body.device_id, body.time), body.signature)) {
        return send(401, { error: 'This device can’t start a session. If it was revoked, it needs to be added again with a new key.' });
      }
      const t = `nvs_${randomBytes(32).toString('base64url')}`;
      this.sessions.set(t, body.device_id);
      return send(200, { device_id: body.device_id, kind: 'computer', expires_at: new Date(Date.now() + 12 * 3600_000).toISOString(), token: t });
    }
    if (!device || this.revoked.has(device)) return send(401, { error: 'No session.' });
    if (path === '/mesh/roster') return send(200, this.roster);
    if (path === '/mesh/runtime') return this.bundle ? send(200, this.bundle) : send(404, { error: 'none' });
    if (path === '/mesh/devices/me/heartbeat') {
      this.heartbeats.push(body);
      return send(200, { ok: true, epoch: this.epoch, runtime: { version: this.bundle?.manifest.version ?? 'none' } });
    }
    if (path === '/mesh/devices/me/report') { this.reports.push(body); return send(200, { ok: true }); }
    if (path === '/mesh/inbox') {
      const results = (body.items as Received[]).map((it) => {
        const seen = this.inbox.get(it.key);
        if (seen) return { ...seen, duplicate: true };
        this.received.push(it);
        const r = { key: it.key, kind: it.kind, status: 'accepted', ref: `ref-${this.received.length}` };
        this.inbox.set(it.key, r);
        return { ...r, duplicate: false };
      });
      return send(200, { results });
    }
    send(404, { error: 'Not found.' });
  }
}

// A device home that has already joined: its keys, and the roster `signer` signed, pinned. The
// nodes learn the device's key, as an approval would have done.
export function joinedHome(o: { roster: SignedRoster; hub: FakeNode; nodes: FakeNode[]; name?: string }) {
  const home = mkdtempSync(join(tmpdir(), 'nova-device-'));
  const p = paths(home);
  for (const d of [p.boot, p.runtime, p.state]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const keys = generateDeviceKeys();
  const deviceId = crypto.randomUUID();
  writeFileSync(p.keys, JSON.stringify(exportDeviceKeys(keys)), { mode: 0o600 });
  const d: DeviceFile = {
    version: 1, device_id: deviceId, name: o.name ?? 'Test computer', kind: 'computer', hub_url: o.hub.url, join_url: o.hub.url, roster: o.roster,
    pinned: rosterKeys(o.roster.roster), epoch: o.roster.roster.epoch, joined_at: new Date().toISOString(),
  };
  writeFileSync(p.device, JSON.stringify(d), { mode: 0o600 });
  writeFileSync(p.bootState, JSON.stringify({ safe_mode: false }), { mode: 0o600 });
  for (const n of o.nodes) n.devices.set(deviceId, keys.ed25519.publicKey);
  return { home, p, keys, deviceId };
}

export const FAST = { NOVA_DEVICE_HEARTBEAT_MS: '150', NOVA_DEVICE_TICK_MS: '100', NOVA_DEVICE_RETRY_MS: '150', NOVA_DEVICE_BACKOFF_MS: '50', TZ: 'UTC' };
