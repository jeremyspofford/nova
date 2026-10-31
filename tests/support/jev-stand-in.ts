// A stand-in for TypeSafe's System One API, for CI: nothing in Nova's tests calls TypeSafe. It
// follows the documented contract (api.typesafe.ai/openapi.json, the models page and the request
// rules, read 2026-10-31):
//   POST /v1/systemone with `Authorization: Bearer <key>` (401 without);
//   answers carry the `model` that answered; Noul {noul}, Choice {choice, probabilities,
//   confidence}, Score {score, probabilities, confidence}, Box {box, confidence};
//   assets and Box questions need `TypeSafe-Danger-Zone-Images: true` (400 without), Box needs
//   jev-1.14 or later, and every asset must be referenced (400);
//   64k tokens per request and 32k per question (400 max_tokens_exceeded), here counted as one
//   token per four bytes; a body over 32 MiB → 413.
// Its "model" is functions of the content, so tests decide what it says. Loopback only.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface JevRequest { headers: Record<string, string | string[] | undefined>; body: { model: string; state: unknown; questions: Record<string, { type: string; instructions?: unknown; criteria?: unknown }>; assets?: Record<string, { type: string; format: string; data_base64: string }> } }
export interface JevStandInOptions {
  key?: string;
  // The model id the answers say answered (to test the pin); default: the one asked.
  answerModel?: string;
  noul?: (content: string, question: string) => number;
  choice?: (content: string, question: string, options: string[]) => string;
  status?: number;
}

export async function startJevStandIn(o: JevStandInOptions = {}) {
  const requests: JevRequest[] = [];
  const key = o.key ?? 'test-key-not-secret';
  const read = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const parts: Buffer[] = []; req.on('data', (c: Buffer) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url !== '/v1/systemone' || req.method !== 'POST') return send(404, { detail: 'not found' });
    const raw = await read(req);
    if (raw.length > 32 * 1024 * 1024) return send(413, { detail: 'body over 32 MiB' });
    if (req.headers.authorization !== `Bearer ${key}`) return send(401, { detail: 'invalid API key' });
    let j: JevRequest['body'];
    try { j = JSON.parse(raw.toString('utf8')); } catch { return send(400, { detail: 'invalid JSON' }); }
    requests.push({ headers: req.headers, body: j });
    if (o.status) return send(o.status, { detail: 'stand-in failure' });
    const qs = j.questions ?? {};
    const names = Object.keys(qs);
    if (!names.length) return send(422, { detail: 'questions: at least one' });
    const hasBox = names.some((n) => qs[n]!.type === 'box');
    const assets = j.assets ?? {};
    if ((hasBox || Object.keys(assets).length) && req.headers['typesafe-danger-zone-images'] !== 'true') return send(400, { detail: 'images and box questions need TypeSafe-Danger-Zone-Images: true' });
    if (hasBox && !/^jev-(?:1\.(?:1[4-9]|[2-9]\d)|[2-9])/.test(j.model)) return send(400, { detail: 'box questions need jev-1.14' });
    const text = JSON.stringify(j.state) + JSON.stringify(qs);
    for (const ref of Object.keys(assets)) if (!text.includes(ref)) return send(400, { detail: `asset ${ref} is not referenced` });
    const tokens = (s: string) => Math.ceil(Buffer.byteLength(s) / 4);
    const st = tokens(JSON.stringify(j.state));
    if (st + names.reduce((a, n) => a + tokens(JSON.stringify(qs[n])), 0) > 64_000 || names.some((n) => st + tokens(JSON.stringify(qs[n])) > 32_000)) return send(400, { detail: 'max_tokens_exceeded' });
    const content = JSON.stringify(j.state);
    const answers: Record<string, unknown> = {};
    for (const n of names) {
      const q = qs[n]!;
      if (q.type === 'noul') answers[n] = { type: 'noul', noul: o.noul?.(content, n) ?? 0.05 };
      else if (q.type === 'choice') {
        const opts = Object.keys(q.criteria as object);
        const pick = o.choice?.(content, n, opts) ?? opts[0]!;
        const probabilities = Object.fromEntries(opts.map((x) => [x, x === pick ? 0.9 : 0.1 / (opts.length - 1)]));
        answers[n] = { type: 'choice', choice: pick, probabilities, confidence: 0.8 };
      } else if (q.type === 'score') {
        const levels = (q.criteria as unknown[]).length;
        const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === 0 ? 0.9 : 0.1 / (levels - 1)]));
        answers[n] = { type: 'score', score: 0.2, probabilities, confidence: 0.8 };
      } else answers[n] = { type: 'box', box: { top: 0.25, bottom: 0.82, left: 0.44, right: 0.84 }, confidence: 0.92 };
    }
    return send(200, { model: o.answerModel ?? j.model, answers, usage: { input_tokens: tokens(text), output_tokens: names.length } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, key, requests, close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
