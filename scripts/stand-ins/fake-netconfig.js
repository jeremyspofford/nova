#!/usr/bin/env node
// A stand-in network target (M10d), for tests only: a loopback HTTP server whose "configuration" (a
// router's, a DNS server's, a firewall's, a tailnet's policy) is a JSON file in a temp folder. It
// changes nothing on any real network. It speaks the shape Nova's `http-config` adapter speaks:
//
//   GET /config   → 200, the configuration as JSON, with ETag: "<version>"
//   PUT /config   → If-Match: "<version>" required; 412 if the configuration changed since; 200 with
//                   the new ETag
//
// Both need Authorization: Bearer <token>. Every request is kept (`hits`), never its token. A PUT is
// kept byte for byte as it was sent (a real target that re-serialised would hide what a client did to
// the text). Variants: `stamp: 'revision'` sets that field itself on every write (re-serialising), as
// many config APIs do, and `etagOnPut: false` answers a PUT without an ETag.
// Used as a module (startNetconfig) or on its own: node fake-netconfig.js --file F --token T [--port N].
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const version = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** @param {{ file: string, token: string, initial?: unknown, port?: number, stamp?: string | null, etagOnPut?: boolean }} o */
export async function startNetconfig({ file, token, initial = null, port = 0, stamp = null, etagOnPut = true }) {
  let rev = 0;
  if (initial !== null) writeFileSync(file, `${JSON.stringify(initial, null, 2)}\n`);
  const hits = [];
  const read = () => readFileSync(file, 'utf8');
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    hits.push({ method: req.method, path: req.url, at: Date.now(), ifMatch: req.headers['if-match'] ?? null });
    const send = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    if (req.url !== '/config') return send(404, { error: 'not found' });
    const now = read();
    if (req.method === 'GET') return send(200, now, { etag: `"${version(now)}"` });
    if (req.method === 'PUT') {
      const want = String(req.headers['if-match'] ?? '').replace(/^"|"$/g, '');
      if (!want) return send(428, { error: 'If-Match is required' });
      if (want !== version(now)) return send(412, { error: 'the configuration changed since that version' });
      let parsed;
      try { parsed = JSON.parse(body); } catch { return send(400, { error: 'not JSON' }); }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return send(400, { error: 'a configuration is an object' });
      let text = body;
      if (stamp) { parsed[stamp] = ++rev; text = `${JSON.stringify(parsed, null, 2)}\n`; }
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
      return etagOnPut ? send(200, { version: version(text) }, { etag: `"${version(text)}"` }) : send(200, { ok: true });
    }
    return send(405, { error: 'GET or PUT' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const p = server.address().port;
  return {
    url: `http://127.0.0.1:${p}/config`, port: p, file, hits,
    config: () => JSON.parse(read()),
    text: read,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const s = await startNetconfig({ file: arg('--file'), token: arg('--token'), port: Number(arg('--port') ?? 0) });
  process.stdout.write(`${s.url}\n`);
}
