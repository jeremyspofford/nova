#!/usr/bin/env node
// A stand-in n8n: one workflow behind a Webhook node. It takes Nova's brief, checks Nova's
// HMAC-SHA256 signature (x-nova-signature: t=<seconds>,v1=<hex of "<t>.<raw body>">), answers 200,
// and then calls Nova back the way a real workflow would be built to: POST to the callback path
// the brief names, with the hook token (x-nova-hook-token) and its own signature over the canonical
// JSON of what it sends (keys sorted at every level, no spaces). It never reaches anything but Nova.
//
// As a module (tests):
//   const n = await startFakeN8n({ secret, nova: 'http://127.0.0.1:<port>', token, behavior: 'done' });
//   n.url (the webhook), n.received (briefs, with whether their signature held), n.callbacks, n.close()
// behavior: done | failed | silent (never calls back) | bad-signature | wrong-task | no-confirmation
// From the command line (the gate):
//   node scripts/stand-ins/fake-n8n.js --secret S --nova http://127.0.0.1:4317 --token T [--behavior done]
//   It prints "fake-n8n webhook at <url>".
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
};
const sign = (secret, body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
function verify(secret, header, body) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header ?? ''));
  if (!m) return false;
  const want = createHmac('sha256', secret).update(`${m[1]}.${body}`).digest();
  return timingSafeEqual(want, Buffer.from(m[2], 'hex')) && Math.abs(Date.now() / 1000 - Number(m[1])) < 300;
}

/**
 * @param {{ secret: string, nova: string, token: string, behavior?: string, delayMs?: number }} opts
 * @returns {Promise<{ url: string, port: number, received: { headers: Record<string, any>, raw: string, body: any, signed: boolean }[], callbacks: { body: any, status: number, answer: string }[], close: () => Promise<void> }>}
 */
export function startFakeN8n({ secret, nova, token, behavior = 'done', delayMs = 20 }) {
  const received = [];
  const callbacks = [];
  let executions = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.method !== 'POST' || !req.url.startsWith('/webhook/')) { res.writeHead(404); return res.end(); }
    const signed = verify(secret, req.headers['x-nova-signature'], raw);
    let brief = null;
    try { brief = JSON.parse(raw); } catch { /* recorded as is */ }
    received.push({ headers: req.headers, raw, body: brief, signed });
    if (!signed) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'signature check failed' }));
    }
    const execution = `exec-${++executions}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Workflow was started', executionId: execution }));
    if (behavior === 'silent') return;
    setTimeout(async () => {
      const body = {
        task_id: behavior === 'wrong-task' ? '00000000-0000-4000-8000-000000000000' : brief.task_id,
        status: behavior === 'failed' ? 'failed' : 'done',
        summary: behavior === 'failed' ? 'The workflow’s last step failed.' : `The workflow ran: ${brief.brief.goal}`,
        ...(behavior === 'no-confirmation' || behavior === 'failed' ? {} : { confirmation: { id: execution } }),
      };
      const text = canonical(body);
      const r = await fetch(`${nova}${brief.callback.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nova-hook-token': token, 'x-nova-signature': behavior === 'bad-signature' ? sign('not-the-secret', text) : sign(secret, text) },
        body: text,
      }).catch((e) => ({ status: 0, text: async () => e.message }));
      callbacks.push({ body, status: r.status, answer: await r.text() });
    }, delayMs);
  });
  return new Promise((resolveStart) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({ url: `http://127.0.0.1:${port}/webhook/nova-brief`, port, received, callbacks, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
  const n = await startFakeN8n({ secret: arg('--secret'), nova: arg('--nova', 'http://127.0.0.1:4317'), token: arg('--token'), behavior: arg('--behavior', 'done') });
  console.log(`fake-n8n webhook at ${n.url}`);
}
