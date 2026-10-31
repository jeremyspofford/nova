// A stand-in for Ollama's decision-model endpoint, for CI (which has no Ollama). It speaks the API
// as documented (docs.ollama.com/api/systemone; plan docs/plans/tev1.md) with its real limits:
//   GET /api/version, GET /api/tags,
//   POST /v1/systemone {model, state, questions} → {model, answers: {<name>: {type:'noul', noul}}, usage}
//   1–64 questions (400 otherwise); text and schema over 64 KiB → 413 with Ollama's words; a prompt
//   over the context → 400; an unknown model → 404; GET → 405.
// Its "model" is a function of the state and the question, so tests decide what it sees. It listens
// on loopback only, on a port of its own.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StandInRequest { model: string; state: unknown; questions: Record<string, { type: string; instructions: unknown; criteria?: unknown }>; bytes: number }
export interface StandInOptions {
  version?: string;
  models?: { name: string; digest: string; size?: number }[];
  // P(true) for one question about one state.
  score?: (content: string, question: string) => number;
  // The server's own context check, in bytes of state + questions JSON (a stand-in for tokens).
  contextBytes?: number;
  // Answer this many requests with a broken body first (to test strict reading).
  broken?: number;
}

export const MARK = 'CANARY-INSTRUCTION-7F3A';

export async function startTev1StandIn(o: StandInOptions = {}) {
  const requests: StandInRequest[] = [];
  const models = o.models ?? [{ name: 'tev1:4b', digest: 'sha256:aaaa4b', size: 4_610_582_112 }, { name: 'tev1:0.8b', digest: 'sha256:bbbb08', size: 833_594_080 }];
  const score = o.score ?? ((content: string) => (content.includes(MARK) ? 0.97 : 0.03));
  let broken = o.broken ?? 0;
  const read = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const parts: Buffer[] = []; req.on('data', (c: Buffer) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/version') return send(200, { version: o.version ?? '0.40.4' });
    if (req.url === '/api/tags') return send(200, { models: models.map((m) => ({ name: m.name, model: m.name, digest: m.digest, size: m.size ?? 1, details: { family: 'qwen35' } })) });
    if (req.url !== '/v1/systemone') return send(404, { error: 'not found' });
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' }); return res.end('405 method not allowed'); }
    const raw = await read(req);
    let j: { model?: string; state?: unknown; questions?: Record<string, { type: string; instructions: unknown }> };
    try { j = JSON.parse(raw.toString('utf8')); } catch { return send(400, { error: 'invalid JSON' }); }
    if (!j.model) return send(400, { error: 'model is required' });
    if (!models.some((m) => m.name === j.model)) return send(404, { error: `model "${j.model}" not found, try pulling it first` });
    const names = Object.keys(j.questions ?? {});
    if (!names.length || names.length > 64) return send(400, { error: `questions must have 1 to 64 entries, got ${names.length}` });
    const textAndSchema = Buffer.byteLength(JSON.stringify({ state: j.state, questions: j.questions }), 'utf8');
    if (textAndSchema > 64 * 1024 || raw.length > 64 * 1024) return send(413, { error: 'text and schema must not exceed 64 KiB' });
    if (o.contextBytes && textAndSchema > o.contextBytes) return send(400, { error: 'rendered prompt exceeds the loaded context window' });
    requests.push({ model: j.model, state: j.state, questions: j.questions!, bytes: raw.length });
    if (broken > 0) { broken--; return send(200, { model: j.model, answers: { [names[0]!]: { type: 'noul', noul: 'high' } }, usage: { input_tokens: 1, output_tokens: 1 } }); }
    const content = typeof j.state === 'string' ? j.state : JSON.stringify(j.state);
    const answers = Object.fromEntries(names.map((n) => [n, { type: 'noul', noul: score(content, n) }]));
    return send(200, { model: j.model, answers, usage: { input_tokens: Math.ceil(textAndSchema / 4), output_tokens: names.length } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
