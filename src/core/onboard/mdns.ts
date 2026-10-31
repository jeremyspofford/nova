// A minimal DNS-SD over multicast DNS codec (RFC 6762, RFC 6763): enough to ask "who offers this
// service here?" and read the answers (PTR, SRV, TXT, A, AAAA), with name compression. No
// dependency. Discovery (discover.ts) sends one query and reads what comes back; the tests' fake
// responders use `encodeResponse` to answer on 127.0.0.1, so no test sends multicast.
export const TYPE = Object.freeze({ A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 } as const);

export interface Question { name: string; type: number }
export type Answer =
  | { type: 1; name: string; ttl: number; address: string }
  | { type: 28; name: string; ttl: number; address: string }
  | { type: 12; name: string; ttl: number; target: string }
  | { type: 16; name: string; ttl: number; txt: Record<string, string> }
  | { type: 33; name: string; ttl: number; target: string; port: number; priority: number; weight: number };
export interface Message { id: number; response: boolean; questions: Question[]; answers: Answer[] }

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').filter(Boolean);
  const bufs = parts.map((p) => {
    const b = Buffer.from(p, 'utf8');
    if (b.length > 63) throw new Error(`The label “${p}” is too long for DNS.`);
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

// A legacy unicast query (RFC 6762 §6.7): sent from an ephemeral port, so responders answer
// straight back to it. Class IN with the unicast-response bit, one question per name.
export function encodeQuery(names: readonly string[], id = 0): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(names.length, 4);
  const qs = names.map((n) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(TYPE.PTR, 0);
    tail.writeUInt16BE(0x8001, 2);
    return Buffer.concat([encodeName(n), tail]);
  });
  return Buffer.concat([head, ...qs]);
}

function readName(buf: Buffer, at: number, depth = 0): { name: string; next: number } {
  const labels: string[] = [];
  let i = at;
  let next = -1;
  for (let hops = 0; hops < 64; hops++) {
    if (i >= buf.length) throw new Error('A name runs past the end of the message.');
    const len = buf[i]!;
    if (len === 0) { i += 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (i + 1 >= buf.length || depth > 16) throw new Error('A compressed name points nowhere.');
      if (next < 0) next = i + 2;
      i = ((len & 0x3f) << 8) | buf[i + 1]!;
      depth++;
      continue;
    }
    if (i + 1 + len > buf.length) throw new Error('A label runs past the end of the message.');
    labels.push(buf.subarray(i + 1, i + 1 + len).toString('utf8'));
    i += 1 + len;
  }
  return { name: labels.join('.'), next: next >= 0 ? next : i };
}

function readTxt(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < data.length;) {
    const len = data[i]!;
    const s = data.subarray(i + 1, i + 1 + len).toString('utf8');
    i += 1 + len;
    const eq = s.indexOf('=');
    if (eq > 0) out[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1).slice(0, 200);
    else if (s) out[s.toLowerCase()] = '';
  }
  return out;
}

// Reads a message; throws on one that isn't well formed (a reply that can't be read is ignored).
export function decodeMessage(buf: Buffer): Message {
  if (buf.length < 12) throw new Error('Too short for a DNS message.');
  const id = buf.readUInt16BE(0);
  const response = (buf.readUInt16BE(2) & 0x8000) !== 0;
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let at = 12;
  const questions: Question[] = [];
  for (let q = 0; q < qd; q++) {
    const n = readName(buf, at);
    questions.push({ name: n.name, type: buf.readUInt16BE(n.next) });
    at = n.next + 4;
  }
  const answers: Answer[] = [];
  for (let r = 0; r < total && at < buf.length; r++) {
    const n = readName(buf, at);
    at = n.next;
    if (at + 10 > buf.length) throw new Error('A record runs past the end of the message.');
    const type = buf.readUInt16BE(at);
    const ttl = buf.readUInt32BE(at + 4);
    const len = buf.readUInt16BE(at + 8);
    const start = at + 10;
    if (start + len > buf.length) throw new Error('A record’s data runs past the end of the message.');
    const data = buf.subarray(start, start + len);
    if (type === TYPE.A && len === 4) answers.push({ type: 1, name: n.name, ttl, address: [...data].join('.') });
    else if (type === TYPE.AAAA && len === 16) answers.push({ type: 28, name: n.name, ttl, address: Array.from({ length: 8 }, (_, i) => data.readUInt16BE(i * 2).toString(16)).join(':') });
    else if (type === TYPE.PTR) answers.push({ type: 12, name: n.name, ttl, target: readName(buf, start).name });
    else if (type === TYPE.TXT) answers.push({ type: 16, name: n.name, ttl, txt: readTxt(data) });
    else if (type === TYPE.SRV && len >= 7) answers.push({ type: 33, name: n.name, ttl, priority: data.readUInt16BE(0), weight: data.readUInt16BE(2), port: data.readUInt16BE(4), target: readName(buf, start + 6).name });
    at = start + len;
  }
  return { id, response, questions, answers };
}

// A response carrying `answers`, uncompressed (for stand-in responders in tests).
export function encodeResponse(answers: readonly Answer[], id = 0): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(0x8400, 2);
  head.writeUInt16BE(answers.length, 6);
  const recs = answers.map((a) => {
    let data: Buffer;
    if (a.type === 1) data = Buffer.from(a.address.split('.').map(Number));
    else if (a.type === 28) { data = Buffer.alloc(16); a.address.split(':').forEach((g, i) => data.writeUInt16BE(parseInt(g || '0', 16), i * 2)); }
    else if (a.type === 12) data = encodeName(a.target);
    else if (a.type === 16) data = Buffer.concat(Object.entries(a.txt).map(([k, v]) => { const s = Buffer.from(v ? `${k}=${v}` : k, 'utf8'); return Buffer.concat([Buffer.from([s.length]), s]); }));
    else { const fixed = Buffer.alloc(6); fixed.writeUInt16BE(a.priority, 0); fixed.writeUInt16BE(a.weight, 2); fixed.writeUInt16BE(a.port, 4); data = Buffer.concat([fixed, encodeName(a.target)]); }
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(a.type, 0);
    meta.writeUInt16BE(0x0001, 2);
    meta.writeUInt32BE(a.ttl, 4);
    meta.writeUInt16BE(data.length, 8);
    return Buffer.concat([encodeName(a.name), meta, data]);
  });
  return Buffer.concat([head, ...recs]);
}

export interface Instance { service: string; name: string; host: string | null; port: number | null; addresses: string[]; txt: Record<string, string> }

// The service instances in a set of replies: each PTR for an asked-for service type, with its SRV,
// TXT and addresses wherever in the replies they came.
export function instances(messages: readonly Message[], services: readonly string[]): Instance[] {
  const all = messages.flatMap((m) => (m.response ? m.answers : []));
  const lower = (s: string) => s.toLowerCase();
  const out = new Map<string, Instance>();
  for (const a of all) {
    if (a.type !== 12 || !services.map(lower).includes(lower(a.name))) continue;
    const srv = all.find((x): x is Extract<Answer, { type: 33 }> => x.type === 33 && lower(x.name) === lower(a.target));
    const txt = all.find((x): x is Extract<Answer, { type: 16 }> => x.type === 16 && lower(x.name) === lower(a.target));
    const host = srv?.target ?? null;
    const addresses = host ? [...new Set(all.filter((x): x is Extract<Answer, { type: 1 | 28 }> => (x.type === 1 || x.type === 28) && lower(x.name) === lower(host)).map((x) => x.address))] : [];
    const name = a.target.endsWith(`.${a.name}`) ? a.target.slice(0, -(a.name.length + 1)) : a.target;
    out.set(lower(a.target), { service: a.name, name, host, port: srv?.port ?? null, addresses, txt: txt?.txt ?? {} });
  }
  return [...out.values()];
}
