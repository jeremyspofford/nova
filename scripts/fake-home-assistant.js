// A stand-in for Home Assistant, for tests, screenshots and the M5 gate. Everything in it is made
// up. It speaks the parts of Home Assistant's real APIs that Nova uses:
//   REST       GET /api/, /api/config, /api/states, /api/states/<entity>;
//              POST /api/services/<domain>/<service> (changes the entity, answers the changed states);
//              Authorization: Bearer <long-lived token>, 401 otherwise.
//   WebSocket  /api/websocket: auth_required → auth {access_token} → auth_ok | auth_invalid;
//              subscribe_events {event_type: state_changed} → result, then event messages;
//              auth/delete_refresh_token {refresh_token_id} → result, and the token stops working.
// Node has a WebSocket client but no server, so this carries a minimal RFC 6455 server: the
// handshake, text frames (masked from the client, unmasked from here), ping/pong and close.
//
//   startFakeHomeAssistant({ token? }) → { base, token, state, setState(entity, value), dropSockets(), sockets(), close() }
// `node scripts/fake-home-assistant.js` runs one on a free port and prints its address and token.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// A long-lived token shaped like Home Assistant's: a JWT whose issuer is the refresh token's id.
export function makeToken(id = randomBytes(16).toString('hex')) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return { id, token: `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: id, iat: 1_790_000_000, exp: 2_105_000_000 })}.${randomBytes(32).toString('base64url')}` };
}

export function sampleEntities(now = new Date().toISOString()) {
  const e = (entity_id, state, friendly_name) => ({ entity_id, state, attributes: { friendly_name }, last_changed: now, last_updated: now, context: { id: randomBytes(8).toString('hex') } });
  return [
    e('light.kitchen', 'off', 'Kitchen light'),
    e('light.hallway', 'on', 'Hallway light'),
    e('switch.fan', 'off', 'Fan'),
    e('binary_sensor.front_door', 'off', 'Front door'),
    e('sensor.living_room_temperature', '21.5', 'Living room temperature'),
    e('lock.back_door', 'locked', 'Back door lock'),
  ];
}

// What a service leaves an entity showing.
const RESULT = { turn_on: 'on', turn_off: 'off', lock: 'locked', unlock: 'unlocked', open_cover: 'open', close_cover: 'closed' };

// ---- RFC 6455, the server side, as little as Home Assistant's API needs ------------------------

function frame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len])
    : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  return Buffer.concat([head, payload]);
}

class Socket {
  constructor(sock, onText, onClose) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.open = true;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.read(onText); });
    sock.on('close', () => { this.open = false; onClose(this); });
    sock.on('error', () => {});
  }

  read(onText) {
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let at = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); at = 10; }
      const mask = masked ? this.buf.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (this.buf.length < at + len) return;
      const payload = Buffer.from(this.buf.subarray(at, at + len));
      this.buf = this.buf.subarray(at + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.raw(frame(0xA, payload)); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        this.parts.push(payload);
        if (fin) { const text = Buffer.concat(this.parts).toString('utf8'); this.parts = []; onText(this, text); }
      }
    }
  }

  raw(b) { if (this.open) this.sock.write(b); }
  send(obj) { this.raw(frame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'))); }
  close() { if (!this.open) return; this.raw(frame(0x8, Buffer.from([0x03, 0xe8]))); this.open = false; this.sock.end(); }
  // A dropped connection, as when the network goes: no close frame.
  drop() { this.open = false; this.sock.destroy(); }
}

export function startFakeHomeAssistant({ port = 0, host = '127.0.0.1', token = null, entities = sampleEntities(), locationName = 'Home' } = {}) {
  const issued = token ? { id: null, token } : makeToken();
  const state = {
    tokens: new Map([[issued.token, issued.id]]),   // token → refresh token id
    revoked: [],                                    // refresh token ids deleted over the WebSocket
    entities: new Map(entities.map((x) => [x.entity_id, x])),
    calls: [],                                      // every service call, in order
    subscriptions: 0,
    auths: 0,
  };
  const sockets = new Set();

  const authorized = (t) => state.tokens.has(t);
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((ok) => { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { ok({}); } }); });

  function setState(entity_id, value, attributes) {
    const old = state.entities.get(entity_id) ?? null;
    const at = new Date().toISOString();
    const next = { entity_id, state: String(value), attributes: { ...(old?.attributes ?? {}), ...(attributes ?? {}) }, last_changed: old?.state === String(value) ? old.last_changed : at, last_updated: at, context: { id: randomBytes(8).toString('hex') } };
    state.entities.set(entity_id, next);
    const event = { event_type: 'state_changed', data: { entity_id, old_state: old, new_state: next }, origin: 'LOCAL', time_fired: at };
    for (const s of sockets) if (s.subscribed !== undefined) s.send({ id: s.subscribed, type: 'event', event });
    return next;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://ha.local');
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!authorized(bearer)) return send(res, 401, { message: 'Unauthorized' });
    if (req.method === 'GET' && url.pathname === '/api/') return send(res, 200, { message: 'API running.' });
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, { location_name: locationName, version: '2026.10.0', unit_system: { temperature: '°C' } });
    if (req.method === 'GET' && url.pathname === '/api/states') return send(res, 200, [...state.entities.values()]);
    const one = /^\/api\/states\/([a-z_0-9]+\.[a-z_0-9]+)$/.exec(url.pathname);
    if (req.method === 'GET' && one) {
      const e = state.entities.get(one[1]);
      return e ? send(res, 200, e) : send(res, 404, { message: 'Entity not found.' });
    }
    const svc = /^\/api\/services\/([a-z_0-9]+)\/([a-z_0-9]+)$/.exec(url.pathname);
    if (req.method === 'POST' && svc) {
      const body = await readBody(req);
      const [, domain, service] = svc;
      state.calls.push({ domain, service, data: body });
      const ids = [body.entity_id].flat().filter(Boolean);
      const changed = [];
      for (const id of ids) {
        const e = state.entities.get(id);
        if (!e) continue;
        const to = service === 'toggle' ? (e.state === 'on' ? 'off' : 'on') : RESULT[service];
        if (to) changed.push(setState(id, to));
      }
      return send(res, 200, changed);
    }
    send(res, 404, { message: 'Not found' });
  });

  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (new URL(req.url, 'http://ha.local').pathname !== '/api/websocket' || !key) { sock.destroy(); return; }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new Socket(sock, (s, text) => {
      let m;
      try { m = JSON.parse(text); } catch { return; }
      if (!s.authed) {
        if (m.type === 'auth' && authorized(m.access_token)) { s.authed = m.access_token; state.auths++; s.send({ type: 'auth_ok', ha_version: '2026.10.0' }); }
        else { s.send({ type: 'auth_invalid', message: 'Invalid access token or password' }); s.close(); }
        return;
      }
      if (m.type === 'subscribe_events' && (m.event_type === 'state_changed' || !m.event_type)) {
        s.subscribed = m.id;
        state.subscriptions++;
        s.send({ id: m.id, type: 'result', success: true, result: null });
      } else if (m.type === 'auth/delete_refresh_token') {
        const owner = [...state.tokens].find(([, id]) => id && id === m.refresh_token_id);
        if (!owner) return s.send({ id: m.id, type: 'result', success: false, error: { code: 'invalid_format', message: 'Refresh token not found' } });
        state.tokens.delete(owner[0]);
        state.revoked.push(m.refresh_token_id);
        s.send({ id: m.id, type: 'result', success: true, result: {} });
        // Home Assistant ends every session the token held.
        for (const other of sockets) if (other.authed === owner[0]) other.close();
      } else if (m.type === 'ping') s.send({ id: m.id, type: 'pong' });
      else s.send({ id: m.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command.' } });
    }, (s) => sockets.delete(s));
    sockets.add(ws);
    ws.send({ type: 'auth_required', ha_version: '2026.10.0' });
  });

  return new Promise((ok) => {
    server.listen(port, host, () => {
      const { port: p } = server.address();
      ok({
        base: `http://${host}:${p}`, token: issued.token, tokenId: issued.id, state, server, setState,
        sockets: () => [...sockets].filter((s) => s.open),
        // Every WebSocket goes, without a close frame: what Nova sees when the network drops.
        dropSockets: () => { for (const s of sockets) s.drop(); sockets.clear(); },
        close: () => new Promise((r) => { for (const s of sockets) s.drop(); server.closeAllConnections?.(); server.close(r); }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ha = await startFakeHomeAssistant({ port: Number(process.env.PORT ?? 0) });
  console.log(`Fake Home Assistant at ${ha.base}\nToken: ${ha.token}`);
}
