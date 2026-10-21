// A small IMAP client: one connection per piece of work, commands in order,
// responses parsed into atoms, strings and lists. Enough for Gmail; not a
// general-purpose library. Literals ({n}) are read byte-exact as latin1.
import { connect as tcp } from 'node:net';
import { connect as tls } from 'node:tls';

export class ImapError extends Error {
  constructor(message, { code = 'imap', status, text } = {}) { super(message); this.code = code; this.status = status; this.text = text; }
}

// "imaps://imap.gmail.com:993" → TLS; "imap://127.0.0.1:1143" → plain (tests only).
export function openImap(url, { timeoutMs = 20_000 } = {}) {
  const u = new URL(url);
  const secure = u.protocol === 'imaps:';
  const port = Number(u.port) || (secure ? 993 : 143);
  return new Promise((resolve, reject) => {
    const socket = secure ? tls({ host: u.hostname, port, servername: u.hostname }) : tcp({ host: u.hostname, port });
    const fail = (e) => reject(new ImapError(e.message, { code: 'unreachable' }));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timed out')));
    socket.once('error', fail);
    const client = new ImapClient(socket, timeoutMs);
    client.greeting.then(() => { socket.off('error', fail); resolve(client); }, reject);
  });
}

class ImapClient {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buf = '';
    this.n = 0;
    this.waiting = null; // { tag, untagged, resolve, reject, onContinue }
    this.closed = false;
    socket.setEncoding('latin1');
    this.greeting = new Promise((resolve, reject) => { this.waiting = { greeting: true, resolve, reject, untagged: [] }; });
    socket.on('data', (d) => { this.buf += d; this.drain(); });
    socket.on('error', (e) => this.fail(new ImapError(e.message, { code: 'unreachable' })));
    socket.on('close', () => { this.closed = true; this.fail(new ImapError('The connection closed.', { code: 'unreachable' })); });
  }

  fail(e) {
    const w = this.waiting;
    this.waiting = null;
    w?.reject(e);
  }

  // One response unit: a line, plus any literals it announces.
  takeUnit() {
    let at = 0;
    for (;;) {
      const eol = this.buf.indexOf('\r\n', at);
      if (eol < 0) return null;
      const lit = this.buf.slice(at, eol).match(/\{(\d+)\+?\}$/);
      if (!lit) {
        const unit = this.buf.slice(0, eol);
        this.buf = this.buf.slice(eol + 2);
        return unit;
      }
      const end = eol + 2 + Number(lit[1]);
      if (this.buf.length < end) return null;
      at = end;
    }
  }

  drain() {
    let unit;
    while ((unit = this.takeUnit()) !== null) {
      const w = this.waiting;
      if (!w) continue;
      if (w.greeting) {
        this.waiting = null;
        if (/^\* (OK|PREAUTH)/i.test(unit)) w.resolve(unit);
        else w.reject(new ImapError(unit, { code: 'refused' }));
        continue;
      }
      if (unit.startsWith('+')) { w.onContinue?.(); continue; }
      if (unit.startsWith('* ')) { w.untagged.push(parse(unit.slice(2))); continue; }
      if (unit.startsWith(`${w.tag} `)) {
        this.waiting = null;
        const [, status, text] = unit.slice(w.tag.length + 1).match(/^(\w+)\s?(.*)$/) ?? [, 'BAD', unit];
        if (status.toUpperCase() === 'OK') w.resolve({ untagged: w.untagged, text });
        else w.reject(new ImapError(text, { status: status.toUpperCase(), text }));
      }
    }
  }

  // parts: strings sent as-is, and { literal: Buffer|string } sent as a
  // synchronizing literal once the server says to go ahead.
  command(...parts) {
    if (this.closed) return Promise.reject(new ImapError('The connection closed.', { code: 'unreachable' }));
    const tag = `N${++this.n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(new ImapError('Gmail took too long to answer.', { code: 'unreachable' })); }, this.timeoutMs);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      const queue = [...parts];
      let line = `${tag} `;
      const sendNext = () => {
        while (queue.length) {
          const p = queue.shift();
          if (typeof p === 'string') { line += p; continue; }
          const data = Buffer.isBuffer(p.literal) ? p.literal : Buffer.from(p.literal, 'latin1');
          this.socket.write(`${line}{${data.length}}\r\n`, 'latin1');
          line = '';
          this.waiting.onContinue = () => { this.waiting.onContinue = null; this.socket.write(data); sendNext(); };
          return;
        }
        this.socket.write(`${line}\r\n`, 'latin1');
      };
      this.waiting = { tag, untagged: [], resolve: done(resolve), reject: done(reject) };
      sendNext();
    });
  }

  async logout() {
    try { await this.command('LOGOUT'); } catch {}
    this.socket.destroy();
  }
}

// IMAP quoted string.
export const quote = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

// An untagged response → nested arrays of strings (atoms, quoted strings,
// literals) and null (NIL). Atoms keep bracketed sections whole:
// BODY[HEADER.FIELDS (FROM SUBJECT)] is one atom.
export function parse(s) {
  let i = 0;
  const list = (close) => {
    const out = [];
    for (;;) {
      while (s[i] === ' ') i++;
      if (i >= s.length) return out;
      const c = s[i];
      if (c === close) { i++; return out; }
      if (c === '(') { i++; out.push(list(')')); continue; }
      if (c === '"') {
        let v = '';
        i++;
        while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; v += s[i++]; }
        i++;
        out.push(v);
        continue;
      }
      const lit = s.slice(i).match(/^\{(\d+)\+?\}\r\n/);
      if (lit) {
        i += lit[0].length;
        out.push(s.slice(i, i + Number(lit[1])));
        i += Number(lit[1]);
        continue;
      }
      let v = '';
      let depth = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '[') depth++;
        if (ch === ']') depth--;
        if (depth <= 0 && (ch === ' ' || ch === ')' || ch === '(' || ch === close)) break;
        v += ch;
        i++;
      }
      out.push(v === 'NIL' ? null : v);
    }
  };
  return list(null);
}

// A FETCH response's item list → { UID: '12', 'X-GM-LABELS': [...], 'BODY[]': '...' }
export function fetchItems(untagged) {
  const out = [];
  for (const u of untagged) {
    if (u[1]?.toUpperCase?.() !== 'FETCH' || !Array.isArray(u[2])) continue;
    const items = {};
    for (let k = 0; k < u[2].length; k += 2) items[String(u[2][k]).toUpperCase().replace(/<\d+>$/, '')] = u[2][k + 1];
    out.push(items);
  }
  return out;
}

// Mailbox names travel in modified UTF-7 (RFC 3501 5.1.3): "Caf&AOk-".
export function encodeMailbox(name) {
  return String(name).replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, (run) => {
    const b = Buffer.alloc(run.length * 2);
    for (let k = 0; k < run.length; k++) b.writeUInt16BE(run.charCodeAt(k), k * 2);
    return `&${b.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  });
}

export function decodeMailbox(name) {
  return String(name).replace(/&([^-]*)-/g, (_, b64) => {
    if (!b64) return '&';
    const b = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let k = 0; k + 1 < b.length; k += 2) out += String.fromCharCode(b.readUInt16BE(k));
    return out;
  });
}
